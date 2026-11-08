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

/** @typedef {'INVALID_SIGNATURE'|'UNSUPPORTED_NETWORK'|'CHAIN_UNAVAILABLE'|'SERVICE_UNAVAILABLE'} VerusRequestErrorCode */

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
