/**
 * Verus-requests: de basislaag voor alles wat met Verus Mobile praat.
 *
 * Dit bestand bevat de hulpfuncties die fase 1 (speler tekent), fase 2 (speler
 * publiceert) en fase 2b (attestaties) delen. Het doet drie dingen:
 *   1. Adressen en request-ID's valideren en omzetten (compact, requestId).
 *   2. Bytes van de wallet byte-exact parsen (exactParse) en de handtekening-
 *      envelop controleren (signatureWrapper).
 *   3. Identiteiten laden op de tekenhoogte én nu (loadIdentity), zodat een
 *      handtekening getoetst wordt aan de sleutels die toen golden.
 *
 * Ontwerpregels (zie Arcade v2/notes/vatermark-review.md):
 *   - Alleen VRSCTEST tot de mainnet-fase. Elke andere chain is een fout.
 *   - Fail closed: een RPC-fout is CHAIN_UNAVAILABLE, nooit "geldig".
 *   - Geen SDK-, HTTP- of RPC-foutobjecten doorgeven: die kunnen config lekken.
 *   - Eén gedeelde instantie van verus-typescript-primitives (instanceof!).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

// De SDK's zijn CommonJS. Eén gedeelde primitives-instantie is verplicht:
// serializers en validators gebruiken instanceof.
const require = createRequire(import.meta.url);
const { VerusIdInterface } = require('verusid-ts-client');
export const P = require('verus-typescript-primitives');

export const TESTNET_SYSTEM_ID = P.TESTNET_VERUS_CHAINID;
export const GENERIC_RESPONSE_QUERY_KEY = P.GENERIC_RESPONSE_DEEPLINK_VDXF_KEY.vdxfid;
const ID_ADDRESS_VERSION = 102; // i-adres
const R_ADDRESS_VERSION = 60; // R-adres (primair adres)
const MAX_CALLBACK_BYTES = 65_536;

/** @typedef {'INVALID_SIGNATURE'|'SIGNER_MISMATCH'|'UNSUPPORTED_NETWORK'|'CHAIN_UNAVAILABLE'|'SERVICE_UNAVAILABLE'} VerusRequestErrorCode */

export class VerusRequestError extends Error {
  /** @param {VerusRequestErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'VerusRequestError';
    this.code = code;
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest();

/** Gooit INVALID_SIGNATURE als de voorwaarde niet klopt. */
export function check(ok, message) {
  if (!ok) throw new VerusRequestError('INVALID_SIGNATURE', message);
}

/** Constante-tijd vergelijking van twee buffers. */
export function same(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
}

/** Decodeert een base58check-adres en eist de verwachte versie (102 = i-adres, 60 = R-adres). */
export function rawId(address, version = ID_ADDRESS_VERSION) {
  let decoded;
  try { decoded = P.fromBase58Check(address); } catch { check(false, 'Unsupported address encoding.'); }
  check(decoded.version === version && decoded.hash.length === 20, 'Unsupported address encoding.');
  return decoded.hash;
}

/** CompactIAddressObject voor een i-adres, met VRSCTEST als rootsysteem. */
export function compact(address) {
  rawId(address);
  return new P.CompactIAddressObject({
    type: P.CompactIAddressObject.TYPE_I_ADDRESS,
    address,
    rootSystemName: 'VRSCTEST',
  });
}

/** Haalt het i-adres uit een CompactIAddressObject en valideert het. */
export function compactId(value) {
  check(value && value.version?.eqn(1) && value.isIaddress(), 'Expected a typed identity address.');
  rawId(value.address);
  return value.address;
}

/** Request-ID: 20 bytes hex → i-adres-vorm, zoals de wallet het verwacht. */
export function requestId(hex) {
  check(typeof hex === 'string' && /^[0-9a-f]{40}$/.test(hex), 'Invalid request identifier.');
  return compact(P.toBase58Check(Buffer.from(hex, 'hex'), ID_ADDRESS_VERSION));
}

/**
 * Valideert een native Verus-handtekening volledig (73 bytes, versie 2,
 * hashtype 5, één handtekening van 65 bytes) en geeft de blokhoogte terug.
 */
export function nativeHeight(bytes) {
  check(
    Buffer.isBuffer(bytes) && bytes.length === 73
      && bytes[0] === 2 && bytes[1] === 5 && bytes[6] === 1 && bytes[7] === 65
      && bytes[8] >= 27 && bytes[8] <= 34,
    'Requires one native Verus v2/SHA256 compact signature.',
  );
  return bytes.readUInt32LE(2);
}

/**
 * Controleert de handtekening-envelop (VerifiableSignatureData) en geeft het
 * tekenende i-adres en de blokhoogte terug.
 *
 * Huidige Verus Mobile-builds laten de versie van de buitenste envelop weg en
 * serialiseren daardoor 0. Dat accepteren we alleen op callbacks (mobileOuter)
 * en alleen met flags 16; verzoeken en binnenste handtekeningen eisen versie 1.
 */
export function signatureWrapper(signature, mobileOuter = false) {
  const supported = signature
    && (signature.version.eqn(1) || (mobileOuter && signature.version.eqn(0) && signature.flags.eqn(16)));
  check(supported && signature.signatureVersion.eqn(2) && signature.hashType.eqn(5), 'Unsupported signature wrapper.');
  check([0, 16].includes(signature.flags.toNumber()), 'Unsupported signature context.');
  check(
    !signature.vdxfKeys?.length && !signature.vdxfKeyNames?.length
      && !signature.boundHashes?.length && !signature.statements?.length,
    'Unexpected signature context.',
  );
  if (compactId(signature.systemID) !== TESTNET_SYSTEM_ID) {
    throw new VerusRequestError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported.');
  }
  return { identityId: compactId(signature.identityID), height: nativeHeight(signature.signatureAsVch) };
}

/**
 * Parseert bytes in een SDK-object en eist dat her-serialisatie byte-identiek
 * is. Vangt afgekapte, aangevulde en niet-canonieke payloads.
 */
export function exactParse(value, bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_CALLBACK_BYTES, 'Invalid callback size.');
  let consumed;
  try { consumed = value.fromBuffer(bytes, 0); } catch { check(false, 'Malformed callback data.'); }
  check(consumed === bytes.length, 'Trailing or truncated callback data.');
  check(value.toBuffer().equals(bytes), 'Noncanonical callback encoding.');
  return value;
}

/**
 * Parseert een eerder opgeslagen, getekend DataPacket-verzoek en controleert
 * dat het exact bij de verwachte boodschap en het verwachte request-ID hoort.
 */
export function parseStoredSignRequest(hex, expectedMessage, expectedId) {
  check(typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/.test(hex), 'Invalid stored request.');
  const req = exactParse(new P.GenericRequest(), Buffer.from(hex, 'hex'));
  check(req.version.eqn(1) && req.flags.toNumber() === (1 | 2 | 4 | 16 | 128 | 512), 'Unsupported request envelope.');
  signatureWrapper(req.signature);
  check(compactId(req.requestID) === expectedId && req.details.length === 1, 'Stored request identifier mismatch.');
  const ordinal = req.details[0];
  check(ordinal instanceof P.DataPacketRequestOrdinalVDXFObject && ordinal.version.eqn(1), 'Unsupported request details.');
  const detail = ordinal.data;
  check(
    detail.version.eqn(1) && detail.flags.toNumber() === 9 && compactId(detail.requestID) === expectedId
      && detail.signableObjects.length === 1 && detail.signableObjects[0] === expectedMessage,
    'Stored signing message mismatch.',
  );
  return req;
}

/** Vlaggen van IdentityUpdateRequestDetails: signdata + expires + request-ID + systeem. */
const IDENTITY_UPDATE_REQUEST_FLAGS = 1 | 2 | 4 | 8;
/** PartialIdentity.contains voor "alleen naam en ouder": nooit adressen of autoriteiten. */
const IDENTITY_CONTAINS_NAME_AND_PARENT_ONLY = 3;

/**
 * Controleert dat een IdentityUpdateRequestDetails ALLEEN content toevoegt aan
 * de identiteit van de speler: één signdata-entry onder onze key, geen
 * primaire adressen, geen revocation- of recovery-autoriteit, geen
 * contentmultimap-waarden buiten signdata. Mobile toont de speler wat er
 * verandert, maar wij dwingen het zelf af.
 */
export function assertContentOnlyIdentityUpdate(detail, { playerId, keyId, recordBytes, expiryHeight }) {
  check(detail instanceof P.IdentityUpdateRequestDetails, 'Unsupported identity update details.');
  check(detail.flags.toNumber() === IDENTITY_UPDATE_REQUEST_FLAGS, 'Unsupported identity update flags.');
  check(detail.identity?.contains?.toNumber() === IDENTITY_CONTAINS_NAME_AND_PARENT_ONLY, 'Identity update may only carry name and parent.');
  check(detail.getIdentityAddress(true) === playerId, 'Identity update targets a different identity.');
  check(detail.containsSignData() && detail.signDataMap?.size === 1, 'Identity update must carry exactly one signdata entry.');
  const plainContent = detail.identity.toJson?.().contentmultimap ?? {};
  check(Object.keys(plainContent).length === 0, 'Identity update must not carry plain content.');
  const [[compactKey, partial]] = [...detail.signDataMap.entries()];
  check(compactKey.toAddress() === keyId, 'Identity update writes to an unexpected key.');
  check(partial.createMMR === true && partial.hashType?.eqn(5) && Buffer.isBuffer(partial.data) && partial.data.equals(recordBytes), 'Identity update data differs from the record.');
  check(detail.containsSystem() && detail.systemID?.toAddress?.() === TESTNET_SYSTEM_ID, 'Identity update is not for VRSCTEST.');
  if (expiryHeight !== undefined) check(detail.expiryHeight?.eqn(expiryHeight), 'Identity update expiry mismatch.');
  return { expiryHeight: detail.expiryHeight.toNumber(), keyName: detail.getContentMultiMapKeys()[0] };
}

/**
 * Verus Mobile (dev/master, okt 2026) controleert bij een identity-update dat
 * `toIAddress(fullyqualifiedname)` uit `getidentitycontent` gelijk is aan het
 * i-adres, zonder testnet als root mee te geven. De VRSCTEST-daemon laat
 * `.VRSCTEST` weg bij sub-ID's van een namespace (bv. `testerrr.Verus Arcade@`),
 * waardoor Mobile een mainnet-adres berekent en het verzoek weigert met
 * "Unable to parse response identityaddress". Top-level testnet-ID's
 * (`naam.VRSCTEST@`) slagen wel. Zelfde berekening als Mobile, zodat we vooraf
 * kunnen waarschuwen.
 */
export function walletCompatibleIdentity({ identityId, contentFqn }) {
  try {
    return P.toIAddress(contentFqn) === identityId;
  } catch {
    return false;
  }
}

/**
 * Parseert een eerder opgeslagen, getekend IdentityUpdate-verzoek en controleert
 * dat het exact bij het verwachte record, de key en de speler hoort.
 */
export function parseStoredPublishRequest(hex, { expectedId, playerId, keyId, recordBytes }) {
  check(typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/.test(hex), 'Invalid stored request.');
  const req = exactParse(new P.GenericRequest(), Buffer.from(hex, 'hex'));
  check(req.version.eqn(1) && req.flags.toNumber() === (1 | 2 | 4 | 16 | 128 | 512), 'Unsupported request envelope.');
  signatureWrapper(req.signature);
  check(compactId(req.requestID) === expectedId && req.details.length === 1, 'Stored request identifier mismatch.');
  const ordinal = req.details[0];
  check(ordinal instanceof P.IdentityUpdateRequestOrdinalVDXFObject && ordinal.version.eqn(1), 'Unsupported request details.');
  check(compactId(ordinal.data.requestID) === expectedId, 'Stored request identifier mismatch.');
  const { expiryHeight } = assertContentOnlyIdentityUpdate(ordinal.data, { playerId, keyId, recordBytes });
  return { request: req, expiryHeight };
}

/**
 * Maakt een SDK-client. `rpcUrl` is een publieke RPC (api.verustest.net) of je
 * eigen daemon; voor de daemon geef je `rpcAuth: { username, password }` mee.
 */
export function createClient({ rpcUrl, rpcAuth, timeoutMilliseconds = 15_000 }) {
  const config = { timeout: timeoutMilliseconds };
  if (rpcAuth) config.auth = rpcAuth;
  return new VerusIdInterface('VRSCTEST', rpcUrl, config);
}

/**
 * Leest de chain en tekent lokaal met de service-WIF. Geen wallet-RPC's.
 */
export class VerusRequests {
  /**
   * @param {{ client?: object, rpcUrl?: string, rpcAuth?: {username:string,password:string}, serviceId?: string, serviceWif?: string, now?: () => number }} options
   */
  constructor(options) {
    this.client = options.client ?? createClient(options);
    this.serviceId = options.serviceId;
    this.serviceWif = options.serviceWif;
    this.now = options.now ?? (() => Date.now());
  }

  /** Voert een chain-call uit; elke fout wordt CHAIN_UNAVAILABLE zonder details. */
  async chain(call) {
    try {
      const reply = await call();
      if (reply?.error || reply?.result == null) throw new Error('RPC failed');
      return reply.result;
    } catch {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service could not supply the required data.');
    }
  }

  /** Huidige blokhoogte; eist dat de RPC echt VRSCTEST is. */
  async tip() {
    const info = await this.chain(() => this.client.interface.getInfo());
    if (info.chainid !== TESTNET_SYSTEM_ID || info.name !== 'VRSCTEST' || info.testnet !== true) {
      throw new VerusRequestError('UNSUPPORTED_NETWORK', 'The configured RPC endpoint is not VRSCTEST.');
    }
    const height = info.blocks;
    if (!Number.isSafeInteger(height) || height < 1 || height > 0xffff_ffff) {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid height.');
    }
    return height;
  }

  /**
   * Fase 2: huidige content (onder één key, of alles als `keyId` ontbreekt) én de
   * geschiedenis van een identiteit, plus de hoogte waarop gelezen is. Alleen lezen.
   */
  async readIdentityContent({ identityId, keyId }) {
    rawId(identityId);
    if (keyId !== undefined) rawId(keyId);
    const tip = await this.tip();
    const [content, history] = await Promise.all([
      this.chain(() => this.client.interface.getIdentityContent(identityId, 0, tip, false, tip, ...(keyId ? [keyId] : []))),
      this.chain(() => this.client.interface.request({ cmd: 'getidentityhistory', getParams: () => [identityId, 0, tip, false] })),
    ]);
    if (content?.identity?.identityaddress !== identityId) {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned mismatched identity content.');
    }
    const entries = Array.isArray(history?.history) ? history.history : Array.isArray(history) ? history : null;
    if (!entries) throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned no identity history.');
    return { tip, content, history: entries };
  }

  /**
   * De `fullyqualifiedname` zoals `getidentitycontent` hem teruggeeft (gefilterd
   * op één key zodat het antwoord klein blijft). Verus Mobile leidt hier het
   * i-adres van af met mainnet als standaard; zie walletCompatibleIdentity.
   */
  async identityContentName({ identityId, keyId }) {
    rawId(identityId);
    rawId(keyId);
    const tip = await this.tip();
    const content = await this.chain(() => this.client.interface.getIdentityContent(identityId, 0, tip, false, tip, keyId));
    if (content?.identity?.identityaddress !== identityId || typeof content?.fullyqualifiedname !== 'string') {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned mismatched identity content.');
    }
    return content.fullyqualifiedname;
  }

  /**
   * `decryptdata` voor een DataDescriptor die zijn eigen viewing key (ivk) bevat,
   * met `retrieve: true` zodat de daemon de verwezen data uit de transactie haalt.
   * Alleen lezen; geen wallet-sleutels nodig.
   */
  async decryptDataDescriptor({ descriptor, txid }) {
    check(descriptor && typeof descriptor === 'object' && typeof descriptor.ivk === 'string', 'Descriptor carries no viewing key.');
    check(typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid), 'Invalid transaction ID.');
    return this.chain(() => this.client.interface.request({
      cmd: 'decryptdata',
      getParams: () => [{ datadescriptor: descriptor, txid, retrieve: true }],
    }));
  }

  /** Bevestigingen van een transactie, of null als de daemon ze (nog) niet kent. */
  async transactionStatus(txid) {
    check(typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid), 'Invalid transaction ID.');
    const result = await this.chain(() => this.client.interface.getRawTransaction(txid, 1));
    if (!result || typeof result !== 'object') return null;
    const confirmations = Number(result.confirmations ?? 0);
    const height = Number.isSafeInteger(result.height) ? result.height : null;
    return { confirmations: Number.isSafeInteger(confirmations) ? confirmations : 0, height };
  }

  /** Controleert dat een getidentity-antwoord bij het gevraagde ID en de gevraagde hoogte hoort. */
  validateRecord(record, id, height) {
    const identity = record?.identity;
    if (!identity || identity.identityaddress !== id || identity.systemid !== TESTNET_SYSTEM_ID
      || !Number.isSafeInteger(record.blockheight) || record.blockheight < 0
      || (height !== undefined && record.blockheight > height)) {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned mismatched identity state.');
    }
    if (![1, 2, 3].includes(identity.version ?? 0) || typeof identity.flags !== 'number'
      || !Number.isSafeInteger(identity.flags) || identity.flags < 0 || identity.flags > 0xffff_ffff
      || typeof record.status !== 'string') {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned unsupported identity state.');
    }
  }

  /**
   * Laadt een identiteit op de tekenhoogte (voor de sleutels die toen golden)
   * en nu (voor intrekking). Eist één handtekening en geldige R-adressen.
   *
   * @param {{ identityId: string, signingHeight: number }} query
   */
  async loadIdentity({ identityId, signingHeight }) {
    rawId(identityId);
    check(Number.isSafeInteger(signingHeight) && signingHeight >= 1 && signingHeight <= 0xffff_ffff, 'Invalid signing height.');
    const height = await this.tip();
    if (signingHeight > height) {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The signing height is not yet available from the chain service.');
    }
    const [historical, current] = await Promise.all([
      this.chain(() => this.client.interface.getIdentity(identityId, signingHeight)),
      this.chain(() => this.client.interface.getIdentity(identityId)),
    ]);
    this.validateRecord(historical, identityId, signingHeight);
    this.validateRecord(current, identityId);
    const authority = historical.identity;
    check(
      authority.minimumsignatures === 1 && Array.isArray(authority.primaryaddresses) && authority.primaryaddresses.length > 0,
      'This compact format requires a one-signature identity.',
    );
    try { authority.primaryaddresses.forEach((a) => rawId(a, R_ADDRESS_VERSION)); } catch {
      throw new VerusRequestError('INVALID_SIGNATURE', 'Identity uses an unsupported primary address.');
    }
    const revokedThen = historical.status !== 'active' || (authority.flags & 0x8000) !== 0;
    const currentActive = current.status === 'active' && (current.identity.flags & 0x8000) === 0;
    return {
      identityId,
      name: current.identity.name || identityId,
      signingHeight,
      minimumSignatures: authority.minimumsignatures,
      primaryAddresses: [...authority.primaryaddresses],
      revokedAtSigning: revokedThen,
      currentActive,
      historical,
      current,
    };
  }

  /** Controleert dat de service-identiteit geconfigureerd, geldig en actief is. */
  async serviceState() {
    if (!this.serviceId || !this.serviceWif) {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'Signing needs a configured service identity and secret WIF.');
    }
    try { rawId(this.serviceId); } catch {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The configured service identity is invalid.');
    }
    const height = await this.tip();
    const state = await this.loadIdentity({ identityId: this.serviceId, signingHeight: height });
    if (!state.currentActive || state.revokedAtSigning) {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The service identity is not active.');
    }
    return { height, historical: state.historical, state };
  }

  /**
   * Fase 2b: tekent de wortel van een attestatie-MMR met de service-identiteit
   * (Arcade@), in dezelfde vorm als `signdata` met `createmmr`: VerusID-
   * handtekening versie 2, sha256, over de wortel zoals in `mmrroot`. Geen
   * transactie, geen daemon-sleutel nodig. Controleert de eigen handtekening.
   * @param {string} rootHex
   * @returns {Promise<{ signaturedata: object, signatureheight: number }>}
   */
  async signMmrRoot(rootHex) {
    check(typeof rootHex === 'string' && /^[0-9a-f]{64}$/.test(rootHex), 'Invalid MMR root.');
    const { height, historical } = await this.serviceState();
    const signaturedata = {
      version: 1, systemid: TESTNET_SYSTEM_ID, hashtype: 5, signaturehash: rootHex,
      identityid: this.serviceId, signaturetype: 1,
    };
    const digest = P.SignatureData.fromJson({ ...signaturedata, signature: '' }).getIdentityHash({ version: 2, hash_type: 5, height });
    const signature = await this.client.signHash(this.serviceId, digest, this.serviceWif, historical, height, TESTNET_SYSTEM_ID);
    check(await this.client.verifyHash(this.serviceId, signature, digest, historical, TESTNET_SYSTEM_ID), 'The service key cannot sign for the service identity.');
    return { signaturedata: { ...signaturedata, signature }, signatureheight: height };
  }

  /** Blocktijd van een hoogte; nodig om GenericRequest/Response te verifiëren. */
  async blockTime(height) {
    const block = await this.chain(() => this.client.interface.getBlock(String(height)));
    const time = block?.time;
    if (!Number.isSafeInteger(time)) {
      throw new VerusRequestError('CHAIN_UNAVAILABLE', 'The chain service returned an invalid block time.');
    }
    return time;
  }


  /**
   * Bouwt en tekent een DataPacketRequest: "teken deze tekst met je ID".
   * De wallet toont de tekst; de speler keurt goed. Geen transactie.
   *
   * @param {{ message: string, callbackUrl: string, requestIdHex: string, responseMode?: 'redirect'|'post' }} input
   * @returns {Promise<{ requestHex: string, requestHashHex: string, walletUri: string, height: number }>}
   */
  async createSignRequest({ message, callbackUrl, requestIdHex, responseMode = 'post' }) {
    check(typeof message === 'string' && message.length > 0 && message.length <= 4096, 'Invalid signing message.');
    let url;
    try { url = new URL(callbackUrl); } catch { check(false, 'Invalid callback URL.'); }
    check(responseMode === 'redirect' || responseMode === 'post', 'Unsupported wallet response mode.');
    check(
      url.protocol === 'https:' || (responseMode === 'redirect' && url.protocol === 'http:'),
      responseMode === 'post' ? 'Wallet POST callbacks require HTTPS.' : 'Wallet redirects require HTTP or HTTPS.',
    );
    check(!url.username && !url.password && !url.hash, 'Invalid callback URL.');
    const id = requestId(requestIdHex);
    const { height, historical } = await this.serviceState();
    const req = new P.GenericRequest({
      version: P.GenericRequest.VERSION_CURRENT,
      flags: P.GenericRequest.FLAG_IS_TESTNET,
      requestID: id,
      createdAt: new P.BigNumber(Math.floor(this.now() / 1000)),
      preferredHandler: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      // Mobile kiest POST als beide aanwezig zijn: adverteer precies één transport.
      responseURIs: [P.ResponseURI.fromUriString(callbackUrl,
        responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST)],
      signature: new P.VerifiableSignatureData({
        version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
        systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(this.serviceId),
      }),
      details: [new P.DataPacketRequestOrdinalVDXFObject({ data: new P.DataPacketRequestDetails({
        flags: P.DataPacketRequestDetails.FLAG_FOR_USERS_SIGNATURE, requestID: id, signableObjects: [message],
      }) })],
    });
    let signed;
    try { signed = await this.client.signGenericRequest(req, this.serviceWif, historical, height); } catch {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The service signing key is invalid or unauthorized.');
    }
    signatureWrapper(signed.signature);
    const time = await this.blockTime(height);
    if (!await this.client.verifyGenericRequest(signed, historical, TESTNET_SYSTEM_ID, time)) {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The service identity signature could not be verified.');
    }
    return {
      requestHex: signed.toBuffer().toString('hex'),
      requestHashHex: signed.getRawDataSha256().toString('hex'),
      walletUri: signed.toWalletDeeplinkUri(),
      height,
    };
  }

  /**
   * Fase 2. Bouwt en tekent een IdentityUpdateRequest: "zet dit record in je
   * eigen VerusID onder de Arcade-key". De speler keurt goed en betaalt de fee;
   * Mobile maakt de transactie en antwoordt met de txid.
   *
   * @param {{ playerId: string, playerName: string, playerParent: string, keyFqn: string, keyId: string,
   *           recordJson: string, callbackUrl: string, requestIdHex: string, responseMode?: 'redirect'|'post', ttlBlocks?: number }} input
   * @returns {Promise<{ requestHex: string, requestHashHex: string, walletUri: string, height: number, expiryHeight: number }>}
   */
  async createPlayerResultRequest({
    playerId, playerName, playerParent, keyFqn, keyId, recordJson, callbackUrl, requestIdHex, responseMode = 'post', ttlBlocks = 60,
  }) {
    rawId(playerId);
    check(typeof playerName === 'string' && /^[^@.:\s]{1,64}$/.test(playerName), 'Invalid player identity name.');
    rawId(playerParent);
    check(typeof keyFqn === 'string' && /^[^\s]+\.::[^\s]+$/.test(keyFqn), 'Invalid content key name.');
    rawId(keyId);
    check(typeof recordJson === 'string' && recordJson.length > 0 && Buffer.byteLength(recordJson, 'utf8') <= 2048, 'Invalid record payload.');
    check(Number.isSafeInteger(ttlBlocks) && ttlBlocks >= 1 && ttlBlocks <= 10_000, 'Invalid request lifetime.');
    let url;
    try { url = new URL(callbackUrl); } catch { check(false, 'Invalid callback URL.'); }
    check(responseMode === 'redirect' || responseMode === 'post', 'Unsupported wallet response mode.');
    check(
      url.protocol === 'https:' || (responseMode === 'redirect' && url.protocol === 'http:'),
      responseMode === 'post' ? 'Wallet POST callbacks require HTTPS.' : 'Wallet redirects require HTTP or HTTPS.',
    );
    check(!url.username && !url.password && !url.hash, 'Invalid callback URL.');
    const id = requestId(requestIdHex);
    const { height, historical } = await this.serviceState();
    const expiryHeight = height + ttlBlocks;
    const recordBytes = Buffer.from(recordJson, 'utf8');

    const detail = P.IdentityUpdateRequestDetails.fromCLIJson({
      name: playerName,
      parent: playerParent,
      contentmultimap: { [keyFqn]: { data: { message: recordJson, createmmr: true, hashtype: 'sha256' } } },
    }, { requestid: id.toJson(), systemid: TESTNET_SYSTEM_ID, expiryheight: String(expiryHeight) });
    // Fail closed: wat we naar de wallet sturen, voldoet aan dezelfde eisen als wat we later terugparsen.
    assertContentOnlyIdentityUpdate(detail, { playerId, keyId, recordBytes, expiryHeight });

    const req = new P.GenericRequest({
      version: P.GenericRequest.VERSION_CURRENT,
      flags: P.GenericRequest.FLAG_IS_TESTNET,
      requestID: id,
      createdAt: new P.BigNumber(Math.floor(this.now() / 1000)),
      preferredHandler: P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      responseURIs: [P.ResponseURI.fromUriString(callbackUrl,
        responseMode === 'redirect' ? P.ResponseURI.TYPE_REDIRECT : P.ResponseURI.TYPE_POST)],
      signature: new P.VerifiableSignatureData({
        version: P.VerifiableSignatureData.TYPE_VERUSID_DEFAULT, isTestnet: true,
        systemID: compact(TESTNET_SYSTEM_ID), identityID: compact(this.serviceId),
      }),
      details: [new P.IdentityUpdateRequestOrdinalVDXFObject({ data: detail })],
    });
    let signed;
    try { signed = await this.client.signGenericRequest(req, this.serviceWif, historical, height); } catch {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The service signing key is invalid or unauthorized.');
    }
    signatureWrapper(signed.signature);
    const time = await this.blockTime(height);
    if (!await this.client.verifyGenericRequest(signed, historical, TESTNET_SYSTEM_ID, time)) {
      throw new VerusRequestError('SERVICE_UNAVAILABLE', 'The service identity signature could not be verified.');
    }
    const requestHex = signed.toBuffer().toString('hex');
    parseStoredPublishRequest(requestHex, { expectedId: id.toIAddress(), playerId, keyId, recordBytes });
    return {
      requestHex,
      requestHashHex: signed.getRawDataSha256().toString('hex'),
      walletUri: signed.toWalletDeeplinkUri(),
      height,
      expiryHeight,
    };
  }

  /**
   * Fase 2. Verifieert het antwoord van de wallet op een IdentityUpdateRequest.
   * De txid is een ONTVANGSTBEWIJS: publicatie wordt apart bewezen door de
   * chain terug te lezen (reconcile).
   *
   * @param {{ body: Buffer, requestHex: string, requestIdHex: string, playerId: string, keyId: string, recordJson: string }} input
   * @returns {Promise<{ identityId: string, txid: string, signingHeight: number, expiryHeight: number }>}
   */
  async verifyPlayerResultResponse({ body, requestHex, requestIdHex, playerId, keyId, recordJson }) {
    try {
      return await this.#verifyParsedPublishResponse({ body, requestHex, requestIdHex, playerId, keyId, recordJson });
    } catch (error) {
      if (error instanceof VerusRequestError) throw error;
      throw new VerusRequestError('INVALID_SIGNATURE', 'Malformed or invalid wallet response.');
    }
  }

  async #verifyParsedPublishResponse({ body, requestHex, requestIdHex, playerId, keyId, recordJson }) {
    const expectedId = requestId(requestIdHex).toIAddress();
    const recordBytes = Buffer.from(recordJson, 'utf8');
    // 1. Opgeslagen verzoek klopt en is alleen-content voor deze speler, key en record.
    const { request, expiryHeight } = parseStoredPublishRequest(requestHex, { expectedId, playerId, keyId, recordBytes });
    // 2. Antwoord byte-exact, versie 1, testnet, bekende flags, tijdstip.
    const response = exactParse(new P.GenericResponse(), body);
    check(response.version.eqn(1), 'Unsupported response version.');
    if (!response.isTestnet()) throw new VerusRequestError('UNSUPPORTED_NETWORK', 'Only VRSCTEST responses are supported.');
    check([151, 407].includes(response.flags.toNumber()), 'Unsupported response flags or encrypted layout.');
    check(
      response.createdAt && response.createdAt.gtn(0) && response.createdAt.lte(new P.BigNumber(Math.floor(this.now() / 1000) + 300)),
      'Invalid response timestamp.',
    );
    check(response.handledBy == null || response.handledBy === P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, 'Unsupported wallet handler.');
    // 3. Antwoord hoort bij dit verzoek.
    check(
      compactId(response.requestID) === expectedId && response.requestHashType?.eqn(5) && same(response.requestHash, request.getRawDataSha256()),
      'Response belongs to a different request.',
    );
    // 4. Buitenste envelop: de speler zelf tekende het antwoord.
    const outer = signatureWrapper(response.signature, true);
    if (outer.identityId !== playerId) {
      throw new VerusRequestError('SIGNER_MISMATCH', 'Signed by a different identity than the player who made this attempt.');
    }
    // 5. Precies één IdentityUpdateResponse met txid én request-ID.
    check(response.details.length === 1, 'Expected exactly one identity update response.');
    const ordinal = response.details[0];
    check(ordinal instanceof P.IdentityUpdateResponseOrdinalVDXFObject && ordinal.version.eqn(1), 'Unexpected response details.');
    const detail = ordinal.data;
    check(detail.flags?.toNumber() === 3 && detail.containsTxid() && detail.containsRequestID(), 'Identity update response must carry txid and request ID.');
    check(compactId(detail.requestID) === expectedId, 'Identity update response request identifier mismatch.');
    check(Buffer.isBuffer(detail.txid) && detail.txid.length === 32, 'Identity update response has no transaction ID.');
    const txid = detail.getTxidString();
    check(/^[0-9a-f]{64}$/.test(txid) && !/^0{64}$/.test(txid), 'Invalid transaction ID.');
    // 6. Verzoek nog geldig op de tekenhoogte.
    check(outer.height <= expiryHeight, 'The publish request had expired when it was signed.');
    // 7. Spelersidentiteit op tekenhoogte: actief, niet ingetrokken.
    const state = await this.loadIdentity({ identityId: playerId, signingHeight: outer.height });
    check(!state.revokedAtSigning && state.currentActive, 'The signing identity is revoked or inactive.');
    // 8. Cryptografische verificatie van de envelop.
    const time = await this.blockTime(outer.height);
    check(await this.client.verifyGenericResponse(response, state.historical, TESTNET_SYSTEM_ID, time), 'Invalid wallet response signature.');
    return { identityId: playerId, txid, signingHeight: outer.height, expiryHeight };
  }

  /**
   * Verifieert het antwoord van de wallet op een DataPacketRequest.
   * Negen controles, in deze volgorde; elke stap sluit een aanvalsroute.
   *
   * @param {{ body: Buffer, requestHex: string, message: string, requestIdHex: string, expectedSigner?: string }} input
   * @returns {Promise<{ identityId: string, nativeSignature: string, signingHeight: number, name: string }>}
   */
  async verifySignResponse(input) {
    try { return await this.#verifyParsedSignResponse(input); } catch (error) {
      if (error instanceof VerusRequestError) throw error;
      // Nooit SDK-parserfouten doorgeven.
      throw new VerusRequestError('INVALID_SIGNATURE', 'Malformed or invalid wallet response.');
    }
  }

  async #verifyParsedSignResponse({ body, requestHex, message, requestIdHex, expectedSigner }) {
    const expectedId = requestId(requestIdHex).toIAddress();
    // 1. Opgeslagen verzoek klopt (envelop, handtekening, ID, boodschap).
    const request = parseStoredSignRequest(requestHex, message, expectedId);
    // 2. Antwoord byte-exact, versie 1, testnet, verwachte flags, tijdstip.
    const response = exactParse(new P.GenericResponse(), body);
    check(response.version.eqn(1), 'Unsupported response version.');
    if (!response.isTestnet()) throw new VerusRequestError('UNSUPPORTED_NETWORK', 'Only VRSCTEST responses are supported.');
    check([151, 407].includes(response.flags.toNumber()), 'Unsupported response flags or encrypted layout.');
    check(
      response.createdAt && response.createdAt.gtn(0) && response.createdAt.lte(new P.BigNumber(Math.floor(this.now() / 1000) + 300)),
      'Invalid response timestamp.',
    );
    check(response.handledBy == null || response.handledBy === P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID, 'Unsupported wallet handler.');
    // 3. Antwoord hoort bij dit verzoek: ID én hash van het verzoek.
    check(
      compactId(response.requestID) === expectedId && response.requestHashType?.eqn(5) && same(response.requestHash, request.getRawDataSha256()),
      'Response belongs to a different request.',
    );
    // 4. Buitenste envelop: wie tekende het antwoord, op welke hoogte.
    const outer = signatureWrapper(response.signature, true);
    // 5. Precies één DataResponse met één SignatureData.
    check(response.details.length === 1, 'Expected exactly one data response.');
    const ordinal = response.details[0];
    check(ordinal instanceof P.DataResponseOrdinalVDXFObject && ordinal.version.eqn(1), 'Unexpected response details.');
    const detail = ordinal.data;
    check(detail.flags?.eqn(1) && compactId(detail.requestID) === expectedId, 'Data response request identifier mismatch.');
    const descriptor = detail.data;
    check(descriptor.version.eqn(1) && descriptor.flags.eqn(0), 'Unsupported or encrypted response data.');
    const data = exactParse(new P.VdxfUniValue(), descriptor.objectdata);
    check(data.version.eqn(1) && data.values.length === 1, 'Expected exactly one signature.');
    const value = data.values[0];
    check(Object.keys(value).length === 1, 'Unexpected data entries.');
    const sig = value[P.SignatureDataKey.vdxfid];
    check(sig instanceof P.SignatureData && sig.version.eqn(1) && sig.sigType.eqn(1) && sig.hashType.eqn(5), 'Unsupported inner signature wrapper.');
    check(!sig.vdxfKeys.length && !sig.vdxfKeyNames.length && !sig.boundHashes.length, 'Unexpected inner signature context.');
    if (sig.systemID !== TESTNET_SYSTEM_ID) throw new VerusRequestError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported.');
    // 6. Binnenste handtekening: zelfde ID als buiten, over exact deze boodschap, en (optioneel) de verwachte speler.
    check(sig.identityID === outer.identityId && same(sig.signatureHash, sha256(message)), 'Signer or signed message mismatch.');
    // Eigen code: de wallet stelt vaak een andere ID voor dan de ingelogde speler (live gezien op 8 nov).
    if (expectedSigner !== undefined && sig.identityID !== expectedSigner) {
      throw new VerusRequestError('SIGNER_MISMATCH', 'Signed by a different identity than the player who made this attempt.');
    }
    // 7. Identiteit op tekenhoogte: niet ingetrokken, actief, één handtekening.
    const height = nativeHeight(sig.signatureAsVch);
    const innerState = await this.loadIdentity({ identityId: sig.identityID, signingHeight: height });
    check(!innerState.revokedAtSigning && innerState.currentActive, 'The signing identity is revoked or inactive.');
    const outerState = height === outer.height ? innerState : await this.loadIdentity({ identityId: outer.identityId, signingHeight: outer.height });
    check(!outerState.revokedAtSigning && outerState.currentActive, 'The response signing identity is revoked or inactive.');
    // 8. Cryptografische verificatie van de envelop.
    const time = await this.blockTime(outer.height);
    check(await this.client.verifyGenericResponse(response, outerState.historical, TESTNET_SYSTEM_ID, time), 'Invalid wallet response signature.');
    // 9. Cryptografische verificatie van de binnenste handtekening.
    //    Mobile hasht de ruwe UTF-8; verifyMessage gebruikt een ander, length-prefixed formaat.
    const nativeSignature = sig.signatureAsVch.toString('base64');
    const info = await this.client.getSignatureInfo(sig.identityID, nativeSignature, TESTNET_SYSTEM_ID);
    const digest = sig.getIdentityHash({ version: info.version, hash_type: info.hashtype, height: info.height });
    check(await this.client.verifyHash(sig.identityID, nativeSignature, digest, innerState.historical, TESTNET_SYSTEM_ID), 'Invalid signature.');
    return { identityId: sig.identityID, nativeSignature, signingHeight: height, name: innerState.name };
  }

  /**
   * Zelftest: tekent een vaste hash met de service-WIF en verifieert die tegen
   * de sleutels van de service-identiteit op de chain.
   * @returns {Promise<{ enabled: boolean, height?: number, reason?: string }>}
   */
  async status() {
    try {
      const { height, historical } = await this.serviceState();
      const proof = sha256('Verus Arcade service key authorization check');
      const signature = await this.client.signHash(this.serviceId, proof, this.serviceWif, historical, height, TESTNET_SYSTEM_ID);
      const ok = await this.client.verifyHash(this.serviceId, signature, proof, historical, TESTNET_SYSTEM_ID);
      if (!ok) throw new Error('Unauthorized key');
      return { enabled: true, height };
    } catch (error) {
      return {
        enabled: false,
        reason: error instanceof VerusRequestError ? error.message : 'The service signing key is invalid or unauthorized.',
      };
    }
  }
}

/** Leest key=value-regels uit een daemon-conf. */
export function parseConf(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Bouwt de VerusRequests uit omgevingsvariabelen:
 *   VERUS_RPC_URL        publieke RPC (geen auth), anders de daemon via conf
 *   ARCADE_SERVICE_ID    i-adres van Arcade@
 *   ARCADE_SERVICE_WIF   geheime sleutel van het primaire adres (alleen lokaal)
 *
 * @param {{ env?: NodeJS.ProcessEnv, confText?: string }} input
 */
export function createVerusRequestsFromEnv({ env = process.env, confText } = {}) {
  let rpcUrl = env.VERUS_RPC_URL;
  let rpcAuth;
  if (!rpcUrl) {
    if (!confText) throw new VerusRequestError('CHAIN_UNAVAILABLE', 'No VERUS_RPC_URL and no daemon conf available.');
    const conf = parseConf(confText);
    rpcUrl = `http://${conf.rpchost ?? '127.0.0.1'}:${conf.rpcport}`;
    rpcAuth = { username: conf.rpcuser, password: conf.rpcpassword };
  }
  return new VerusRequests({
    rpcUrl,
    rpcAuth,
    serviceId: env.ARCADE_SERVICE_ID,
    serviceWif: env.ARCADE_SERVICE_WIF,
  });
}
