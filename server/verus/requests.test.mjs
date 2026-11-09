import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  P, TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY, VerusRequestError, VerusRequests,
  rawId, compact, compactId, requestId, nativeHeight, signatureWrapper, exactParse, parseConf,
  createVerusRequestsFromEnv, parseStoredSignRequest,
  parseStoredPublishRequest, assertContentOnlyIdentityUpdate, walletCompatibleIdentity,
} from './requests.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const ARCADE_R = 'R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp';
const REQUEST_HEX = '00112233445566778899aabbccddeeff00112233';

/** Een geldige native handtekening van 73 bytes op een gegeven hoogte (inhoud verder nul). */
function fakeNative(height, { version = 2, hashType = 5, count = 1, length = 65, recovery = 27 } = {}) {
  const b = Buffer.alloc(73);
  b[0] = version; b[1] = hashType; b.writeUInt32LE(height, 2); b[6] = count; b[7] = length; b[8] = recovery;
  return b;
}

function fakeWrapper(height, { version = 1, flags = 0, systemId = TESTNET_SYSTEM_ID, identityId = ARCADE } = {}) {
  return new P.VerifiableSignatureData({
    version: new P.BigNumber(version),
    flags: new P.BigNumber(flags),
    systemID: compact(systemId),
    identityID: compact(identityId),
    signatureAsVch: fakeNative(height),
    hashType: new P.BigNumber(5),
    signatureVersion: new P.BigNumber(2),
  });
}

function identityRecord({ id = ARCADE, height = 1000, status = 'active', flags = 0, minsigs = 1, primary = [ARCADE_R], systemid = TESTNET_SYSTEM_ID, version = 3, name = 'Arcade' } = {}) {
  return {
    blockheight: height, status,
    identity: { identityaddress: id, systemid, version, flags, minimumsignatures: minsigs, primaryaddresses: primary, name },
  };
}

function fakeClient({ tip = 2000, records = {}, info } = {}) {
  return {
    interface: {
      async getInfo() { return { result: info ?? { chainid: TESTNET_SYSTEM_ID, name: 'VRSCTEST', testnet: true, blocks: tip } }; },
      async getIdentity(id, height) {
        const key = `${id}@${height ?? 'now'}`;
        const record = records[key] ?? records[`${id}@*`];
        return record ? { result: record } : { error: { message: 'not found' } };
      },
      async getBlock(height) { return { result: { time: 1_700_000_000 + Number(height) } }; },
    },
    async signHash() { return 'sig'; },
    async verifyHash() { return true; },
  };
}

test('constanten komen overeen met Vatermark en de SDK', () => {
  assert.equal(TESTNET_SYSTEM_ID, 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq');
  assert.equal(GENERIC_RESPONSE_QUERY_KEY, 'i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC');
});

test('rawId accepteert i-adressen en R-adressen met de juiste versie', () => {
  assert.equal(rawId(ARCADE).length, 20);
  assert.equal(rawId(ARCADE_R, 60).length, 20);
  assert.throws(() => rawId(ARCADE_R), /Unsupported address encoding/);
  assert.throws(() => rawId('niet-een-adres'), /Unsupported address encoding/);
});

test('compact en compactId zijn elkaars inverse', () => {
  const c = compact(ARCADE);
  assert.equal(c.address, ARCADE);
  assert.equal(compactId(c), ARCADE);
  assert.throws(() => compact(ARCADE_R), /Unsupported address encoding/);
  assert.throws(() => compactId(undefined), /typed identity address/);
});

test('requestId eist 40 hex-tekens en levert een i-adres', () => {
  const id = requestId(REQUEST_HEX);
  assert.ok(id.address.startsWith('i'));
  assert.equal(rawId(id.address).toString('hex'), REQUEST_HEX);
  assert.throws(() => requestId('abc'), /Invalid request identifier/);
  assert.throws(() => requestId(REQUEST_HEX.toUpperCase()), /Invalid request identifier/);
});

test('nativeHeight valideert de hele vector', () => {
  assert.equal(nativeHeight(fakeNative(123_456)), 123_456);
  assert.throws(() => nativeHeight(fakeNative(1, { version: 1 })), /native Verus/);
  assert.throws(() => nativeHeight(fakeNative(1, { hashType: 1 })), /native Verus/);
  assert.throws(() => nativeHeight(fakeNative(1, { count: 2 })), /native Verus/);
  assert.throws(() => nativeHeight(fakeNative(1, { recovery: 26 })), /native Verus/);
  assert.throws(() => nativeHeight(Buffer.alloc(72)), /native Verus/);
});

test('signatureWrapper: versie 1 overal, versie 0 alleen op callbacks met flags 16', () => {
  assert.deepEqual(signatureWrapper(fakeWrapper(500)), { identityId: ARCADE, height: 500 });
  assert.throws(() => signatureWrapper(fakeWrapper(500, { version: 0, flags: 16 })), /Unsupported signature wrapper/);
  assert.deepEqual(signatureWrapper(fakeWrapper(500, { version: 0, flags: 16 }), true), { identityId: ARCADE, height: 500 });
  // De SDK zet flags op 16 zodra er een systemID is; 'versie 0 met flags 0' is dus niet
  // construeerbaar via de constructor. We controleren die normalisatie expliciet.
  assert.equal(fakeWrapper(500, { version: 0, flags: 0 }).flags.toNumber(), 16);
  assert.throws(() => signatureWrapper(undefined), /Unsupported signature wrapper/);
});

test('signatureWrapper weigert mainnet', () => {
  const mainnet = P.VERUS_CHAINID ?? 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
  assert.throws(() => signatureWrapper(fakeWrapper(500, { systemId: mainnet })), (e) => e instanceof VerusRequestError && e.code === 'UNSUPPORTED_NETWORK');
});

test('exactParse eist byte-identieke her-serialisatie', () => {
  const original = fakeWrapper(777);
  const bytes = original.toBuffer();
  const parsed = exactParse(new P.VerifiableSignatureData(), bytes);
  assert.equal(signatureWrapper(parsed).height, 777);
  assert.throws(() => exactParse(new P.VerifiableSignatureData(), bytes.subarray(0, bytes.length - 3)), /Malformed|Trailing or truncated/);
  assert.throws(() => exactParse(new P.VerifiableSignatureData(), Buffer.concat([bytes, Buffer.from([0])])), /Trailing or truncated/);
  assert.throws(() => exactParse(new P.VerifiableSignatureData(), Buffer.alloc(0)), /Invalid callback size/);
  assert.throws(() => exactParse(new P.VerifiableSignatureData(), Buffer.alloc(65_537)), /Invalid callback size/);
});

test('tip eist VRSCTEST', async () => {
  const ok = new VerusRequests({ client: fakeClient({ tip: 4242 }) });
  assert.equal(await ok.tip(), 4242);
  const mainnet = new VerusRequests({ client: fakeClient({ info: { chainid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', name: 'VRSC', testnet: false, blocks: 1 } }) });
  await assert.rejects(mainnet.tip(), (e) => e.code === 'UNSUPPORTED_NETWORK');
});

test('loadIdentity laadt historisch en huidig en meldt intrekking', async () => {
  const records = {
    [`${ARCADE}@1000`]: identityRecord({ height: 990 }),
    [`${ARCADE}@now`]: identityRecord({ height: 1500, flags: 0x8000, status: 'revoked' }),
  };
  const vr = new VerusRequests({ client: fakeClient({ tip: 2000, records }) });
  const state = await vr.loadIdentity({ identityId: ARCADE, signingHeight: 1000 });
  assert.equal(state.revokedAtSigning, false);
  assert.equal(state.currentActive, false);
  assert.deepEqual(state.primaryAddresses, [ARCADE_R]);
  assert.equal(state.name, 'Arcade');
});

test('loadIdentity faalt gesloten', async () => {
  const base = { [`${ARCADE}@1000`]: identityRecord({ height: 990 }), [`${ARCADE}@now`]: identityRecord({ height: 1500 }) };
  // tekenhoogte in de toekomst
  await assert.rejects(new VerusRequests({ client: fakeClient({ tip: 900, records: base }) }).loadIdentity({ identityId: ARCADE, signingHeight: 1000 }), (e) => e.code === 'CHAIN_UNAVAILABLE');
  // RPC geeft niets terug
  await assert.rejects(new VerusRequests({ client: fakeClient({ records: {} }) }).loadIdentity({ identityId: ARCADE, signingHeight: 1000 }), (e) => e.code === 'CHAIN_UNAVAILABLE');
  // antwoord hoort bij ander ID
  await assert.rejects(new VerusRequests({ client: fakeClient({ records: { [`${ARCADE}@1000`]: identityRecord({ id: 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN', height: 990 }), [`${ARCADE}@now`]: base[`${ARCADE}@now`] } }) }).loadIdentity({ identityId: ARCADE, signingHeight: 1000 }), (e) => e.code === 'CHAIN_UNAVAILABLE');
  // multisig-identiteit
  await assert.rejects(new VerusRequests({ client: fakeClient({ records: { [`${ARCADE}@1000`]: identityRecord({ height: 990, minsigs: 2 }), [`${ARCADE}@now`]: base[`${ARCADE}@now`] } }) }).loadIdentity({ identityId: ARCADE, signingHeight: 1000 }), (e) => e.code === 'INVALID_SIGNATURE');
  // primair adres is geen R-adres
  await assert.rejects(new VerusRequests({ client: fakeClient({ records: { [`${ARCADE}@1000`]: identityRecord({ height: 990, primary: [ARCADE] }), [`${ARCADE}@now`]: base[`${ARCADE}@now`] } }) }).loadIdentity({ identityId: ARCADE, signingHeight: 1000 }), (e) => e.code === 'INVALID_SIGNATURE');
  // ongeldige hoogte
  await assert.rejects(new VerusRequests({ client: fakeClient({ records: base }) }).loadIdentity({ identityId: ARCADE, signingHeight: 0 }), /Invalid signing height/);
});

test('status zonder WIF is uitgeschakeld met reden; met WIF tekent en verifieert', async () => {
  const records = { [`${ARCADE}@2000`]: identityRecord({ height: 1990 }), [`${ARCADE}@now`]: identityRecord({ height: 1990 }) };
  const off = new VerusRequests({ client: fakeClient({ records }) });
  assert.deepEqual(await off.status(), { enabled: false, reason: 'Signing needs a configured service identity and secret WIF.' });
  const on = new VerusRequests({ client: fakeClient({ records }), serviceId: ARCADE, serviceWif: 'Uxxx' });
  assert.deepEqual(await on.status(), { enabled: true, height: 2000 });
  const bad = fakeClient({ records }); bad.verifyHash = async () => false;
  assert.equal((await new VerusRequests({ client: bad, serviceId: ARCADE, serviceWif: 'Uxxx' }).status()).enabled, false);
});

test('blockTime geeft de tijd van een blok', async () => {
  const vr = new VerusRequests({ client: fakeClient() });
  assert.equal(await vr.blockTime(10), 1_700_000_010);
});

test('parseConf en createVerusRequestsFromEnv', () => {
  const conf = parseConf('# commentaar\nrpcuser=u\nrpcpassword=p\nrpcport=18843\n\nserver=1\n');
  assert.deepEqual(conf, { rpcuser: 'u', rpcpassword: 'p', rpcport: '18843', server: '1' });
  const fromConf = createVerusRequestsFromEnv({ env: {}, confText: 'rpcuser=u\nrpcpassword=p\nrpcport=18843' });
  assert.equal(fromConf.client.interface.instance.defaults.baseURL, 'http://127.0.0.1:18843');
  assert.deepEqual(fromConf.client.interface.instance.defaults.auth, { username: 'u', password: 'p' });
  const fromUrl = createVerusRequestsFromEnv({ env: { VERUS_RPC_URL: 'https://api.verustest.net', ARCADE_SERVICE_ID: ARCADE } });
  assert.equal(fromUrl.client.interface.instance.defaults.baseURL, 'https://api.verustest.net');
  assert.equal(fromUrl.serviceId, ARCADE);
  assert.throws(() => createVerusRequestsFromEnv({ env: {} }), (e) => e.code === 'CHAIN_UNAVAILABLE');
});

// ---------- fase 1: createSignRequest / verifySignResponse ----------

const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const PLAYER_R = 'RDj4ePxriVANbxdyBapJUjf23LkBYsVxa7';
const MESSAGE = 'Verus Arcade attempt v1\nround:word-grid:1.0.0:2026-10-20\nplayer:' + PLAYER + '\nactions:sha256:' + '0'.repeat(64);
const NOW_MS = 1_800_000_000_000;

/** Nep-client die tekent door een geldige 73-bytes vector te zetten en alles cryptografisch goedkeurt. */
function signingClient({ tip = 2000, records, verifyResponse = true, verifyInner = true } = {}) {
  const c = fakeClient({ tip, records: records ?? {
    [`${ARCADE}@${tip}`]: identityRecord({ height: tip - 1 }), [`${ARCADE}@now`]: identityRecord({ height: tip - 1 }),
    [`${PLAYER}@1500`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R], name: 'arcade-storage-poc' }),
    [`${PLAYER}@now`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R], name: 'arcade-storage-poc' }),
  } });
  c.signGenericRequest = async (req, _wif, _hist, height) => { req.signature.signatureAsVch = fakeNative(height); return req; };
  c.verifyGenericRequest = async () => true;
  c.verifyGenericResponse = async () => verifyResponse;
  c.getSignatureInfo = async () => ({ version: 2, hashtype: 5, height: 1500 });
  c.verifyHash = async () => verifyInner;
  return c;
}

function service(client) {
  return new VerusRequests({ client, serviceId: ARCADE, serviceWif: 'Uxxx', now: () => NOW_MS });
}

/** Bouwt een wallet-antwoord zoals Mobile het zou maken, met instelbare afwijkingen. */
function walletResponse(request, { signer = PLAYER, message = MESSAGE, height = 1500, outerHeight = 1500, requestIdHex = REQUEST_HEX, requestHash, handledBy = true, outerVersion = 0, descriptorFlags = 0 } = {}) {
  const id = requestId(requestIdHex);
  const sig = new P.SignatureData({
    version: new P.BigNumber(1), systemID: TESTNET_SYSTEM_ID, hashType: new P.BigNumber(5),
    signatureHash: createHashSha(message), identityID: signer, sigType: new P.BigNumber(1),
    vdxfKeys: [], vdxfKeyNames: [], boundHashes: [], signatureAsVch: fakeNative(height),
  });
  const uni = new P.VdxfUniValue({ values: [{ [P.SignatureDataKey.vdxfid]: sig }] });
  const descriptor = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(descriptorFlags), objectdata: uni.toBuffer() });
  const detail = new P.DataResponseDetails({ flags: new P.BigNumber(1), requestID: id, data: descriptor });
  const envelope = {
    version: new P.BigNumber(1),
    requestID: id,
    createdAt: new P.BigNumber(Math.floor(NOW_MS / 1000)),
    requestHash: requestHash ?? request.getRawDataSha256(),
    requestHashType: new P.BigNumber(5),
    signature: fakeWrapper(outerHeight, { version: outerVersion, flags: 16, identityId: signer }),
    details: [new P.DataResponseOrdinalVDXFObject({ data: detail })],
  };
  if (handledBy) envelope.handledBy = P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID;
  const response = new P.GenericResponse(envelope);
  response.flags = new P.BigNumber(handledBy ? 407 : 151);
  return response;
}

function createHashSha(text) { return createHash('sha256').update(text).digest(); }

async function makeRequest(client = signingClient(), overrides = {}) {
  const vr = service(client);
  const built = await vr.createSignRequest({ message: MESSAGE, callbackUrl: 'http://192.168.1.10:8100/api/v1/sign-jobs/x/response', requestIdHex: REQUEST_HEX, responseMode: 'redirect', ...overrides });
  const request = new P.GenericRequest(); request.fromBuffer(Buffer.from(built.requestHex, 'hex'), 0);
  return { vr, built, request };
}

test('createSignRequest bouwt een getekend DataPacketRequest met één transport', async () => {
  const { built, request } = await makeRequest();
  assert.equal(built.height, 2000);
  assert.match(built.requestHashHex, /^[0-9a-f]{64}$/);
  assert.ok(built.walletUri.includes('://'));
  assert.equal(request.details.length, 1);
  assert.equal(request.details[0].data.signableObjects[0], MESSAGE);
  assert.equal(request.details[0].data.flags.toNumber(), 9);
  assert.equal(request.responseURIs.length, 1);
  assert.equal(compactId(request.signature.identityID), ARCADE);
  // byte-exact opnieuw parseerbaar via parseStoredSignRequest
  assert.doesNotThrow(() => parseStoredSignRequest(built.requestHex, MESSAGE, requestId(REQUEST_HEX).toIAddress()));
  assert.throws(() => parseStoredSignRequest(built.requestHex, MESSAGE + 'x', requestId(REQUEST_HEX).toIAddress()), /message mismatch/);
});

test('createSignRequest: POST vereist https, redirect mag http; geen hash/credentials in URL', async () => {
  await assert.rejects(makeRequest(signingClient(), { responseMode: 'post' }), /require HTTPS/);
  await assert.doesNotReject(makeRequest(signingClient(), { responseMode: 'post', callbackUrl: 'https://arcade.example/api/cb' }));
  await assert.rejects(makeRequest(signingClient(), { callbackUrl: 'http://u:p@host/cb' }), /Invalid callback URL/);
  await assert.rejects(makeRequest(signingClient(), { callbackUrl: 'http://host/cb#frag' }), /Invalid callback URL/);
  await assert.rejects(makeRequest(signingClient(), { responseMode: 'sms' }), /response mode/);
});

test('createSignRequest zonder service-WIF is SERVICE_UNAVAILABLE', async () => {
  const vr = new VerusRequests({ client: signingClient() });
  await assert.rejects(vr.createSignRequest({ message: MESSAGE, callbackUrl: 'http://h/cb', requestIdHex: REQUEST_HEX, responseMode: 'redirect' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
});

test('verifySignResponse accepteert een correct wallet-antwoord', async () => {
  const { vr, built, request } = await makeRequest();
  const body = walletResponse(request).toBuffer();
  const result = await vr.verifySignResponse({ body, requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX, expectedSigner: PLAYER });
  assert.equal(result.identityId, PLAYER);
  assert.equal(result.signingHeight, 1500);
  assert.equal(result.name, 'arcade-storage-poc');
  assert.equal(Buffer.from(result.nativeSignature, 'base64').length, 73);
  // zonder handledBy (flags 151) ook goed
  const body151 = walletResponse(request, { handledBy: false }).toBuffer();
  await assert.doesNotReject(vr.verifySignResponse({ body: body151, requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX }));
});

test('verifySignResponse weigert elke afwijking van de binding', async () => {
  const { vr, built, request } = await makeRequest();
  const run = (body, extra = {}) => vr.verifySignResponse({ body, requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX, expectedSigner: PLAYER, ...extra });
  // andere request-hash
  await assert.rejects(run(walletResponse(request, { requestHash: Buffer.alloc(32, 7) }).toBuffer()), /different request/);
  // ander request-ID in het antwoord
  await assert.rejects(run(walletResponse(request, { requestIdHex: 'ff'.repeat(20) }).toBuffer()), /different request/);
  // andere boodschap getekend
  await assert.rejects(run(walletResponse(request, { message: MESSAGE.replace('0'.repeat(64), '1'.repeat(64)) }).toBuffer()), /message mismatch/);
  // ander ID dan verwacht (wel consistent binnen/buiten)
  await assert.rejects(run(walletResponse(request, { signer: ARCADE }).toBuffer()), (e) => e.code === 'SIGNER_MISMATCH' && /different identity/.test(e.message));
  // versleutelde descriptor
  await assert.rejects(run(walletResponse(request, { descriptorFlags: 1 }).toBuffer()), /encrypted response data/);
  // afgekapte bytes
  const bytes = walletResponse(request).toBuffer();
  await assert.rejects(run(bytes.subarray(0, bytes.length - 5)), (e) => e.code === 'INVALID_SIGNATURE');
  // verkeerde opgeslagen request-hex
  // verkeerde opgeslagen request-hex: één byte in het midden omgedraaid (de staart is in de nep-handtekening al nul)
  const mid = Math.floor(built.requestHex.length / 4) * 2;
  const flipped = (parseInt(built.requestHex.slice(mid, mid + 2), 16) ^ 0xff).toString(16).padStart(2, '0');
  await assert.rejects(run(bytes, { requestHex: built.requestHex.slice(0, mid) + flipped + built.requestHex.slice(mid + 2) }), (e) => e.code === 'INVALID_SIGNATURE');
});

test('verifySignResponse faalt bij cryptografische afwijzing en bij ingetrokken ID', async () => {
  // envelop-handtekening ongeldig
  { const { vr, built, request } = await makeRequest(signingClient({ verifyResponse: false }));
    await assert.rejects(vr.verifySignResponse({ body: walletResponse(request).toBuffer(), requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX }), /Invalid wallet response signature/); }
  // binnenste handtekening ongeldig
  { const { vr, built, request } = await makeRequest(signingClient({ verifyInner: false }));
    await assert.rejects(vr.verifySignResponse({ body: walletResponse(request).toBuffer(), requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX }), /Invalid signature/); }
  // speler intussen ingetrokken
  { const tip = 2000;
    const records = {
      [`${ARCADE}@${tip}`]: identityRecord({ height: tip - 1 }), [`${ARCADE}@now`]: identityRecord({ height: tip - 1 }),
      [`${PLAYER}@1500`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R] }),
      [`${PLAYER}@now`]: identityRecord({ id: PLAYER, height: 1900, primary: [PLAYER_R], status: 'revoked', flags: 0x8000 }),
    };
    const { vr, built, request } = await makeRequest(signingClient({ records }));
    await assert.rejects(vr.verifySignResponse({ body: walletResponse(request).toBuffer(), requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX }), /revoked or inactive/); }
});

test('verifySignResponse weigert een antwoord uit de toekomst en van een vreemde handler', async () => {
  const { vr, built, request } = await makeRequest();
  const late = walletResponse(request); late.createdAt = new P.BigNumber(Math.floor(NOW_MS / 1000) + 600);
  await assert.rejects(vr.verifySignResponse({ body: late.toBuffer(), requestHex: built.requestHex, message: MESSAGE, requestIdHex: REQUEST_HEX }), /timestamp/);
});

// ── Fase 2: IdentityUpdateRequest / -Response ──────────────────────────────────

const PUBLISH_ID_HEX = 'aa'.repeat(20);
const KEY_FQN = 'Arcade.VRSCTEST.::arcade.player.result.word-grid:1.0.0:2026-11-08';
const KEY_ID = P.getDataKey('arcade.player.result.word-grid:1.0.0:2026-11-08', ARCADE, TESTNET_SYSTEM_ID).id;
const RECORD_JSON = '{"schema":"arcade-player-result","version":1,"x":1}';
const PUBLISH_INPUT = {
  playerId: PLAYER, playerName: 'arcade-storage-poc', playerParent: TESTNET_SYSTEM_ID, keyFqn: KEY_FQN, keyId: KEY_ID,
  recordJson: RECORD_JSON, callbackUrl: 'http://192.168.1.10:8100/api/v1/publish-jobs/x/response', requestIdHex: PUBLISH_ID_HEX, responseMode: 'redirect',
};

async function makePublishRequest(client = signingClient(), overrides = {}) {
  const vr = service(client);
  const built = await vr.createPlayerResultRequest({ ...PUBLISH_INPUT, ...overrides });
  const request = new P.GenericRequest(); request.fromBuffer(Buffer.from(built.requestHex, 'hex'), 0);
  return { vr, built, request };
}

/** Wallet-antwoord op een IdentityUpdateRequest, zoals Mobile het zou maken. */
function publishResponse(request, { signer = PLAYER, height = 1500, requestIdHex = PUBLISH_ID_HEX, requestHash, txid = Buffer.alloc(32, 9), withRequestId = true, handledBy = true } = {}) {
  const id = requestId(requestIdHex);
  // De SDK herberekent de vlaggen bij serialisatie uit de aanwezige velden.
  const detail = new P.IdentityUpdateResponseDetails({ flags: new P.BigNumber(withRequestId ? 3 : 1), ...(withRequestId ? { requestID: id } : {}), txid });
  const envelope = {
    version: new P.BigNumber(1),
    requestID: id,
    createdAt: new P.BigNumber(Math.floor(NOW_MS / 1000)),
    requestHash: requestHash ?? request.getRawDataSha256(),
    requestHashType: new P.BigNumber(5),
    signature: fakeWrapper(height, { version: 0, flags: 16, identityId: signer }),
    details: [new P.IdentityUpdateResponseOrdinalVDXFObject({ data: detail })],
  };
  if (handledBy) envelope.handledBy = P.VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID;
  const response = new P.GenericResponse(envelope);
  response.flags = new P.BigNumber(handledBy ? 407 : 151);
  return response;
}

test('createPlayerResultRequest bouwt een alleen-content IdentityUpdateRequest voor de speler', async () => {
  const { built, request } = await makePublishRequest();
  assert.equal(built.height, 2000);
  assert.equal(built.expiryHeight, 2060);
  assert.match(built.requestHashHex, /^[0-9a-f]{64}$/);
  assert.equal(request.details.length, 1);
  const detail = request.details[0].data;
  assert.ok(detail instanceof P.IdentityUpdateRequestDetails);
  assert.equal(detail.getIdentityAddress(true), PLAYER);
  assert.equal(detail.identity.contains.toNumber(), 3);
  assert.equal(detail.signDataMap.size, 1);
  assert.deepEqual(detail.getContentMultiMapKeys(), [KEY_FQN]);
  const [[signKey, signData]] = [...detail.signDataMap.entries()];
  assert.equal(signKey.toAddress(), KEY_ID);
  assert.equal(signData.data.toString('utf8'), RECORD_JSON);
  assert.equal(request.responseURIs.length, 1);
  assert.equal(compactId(request.signature.identityID), ARCADE);
  assert.doesNotThrow(() => parseStoredPublishRequest(built.requestHex, { expectedId: requestId(PUBLISH_ID_HEX).toIAddress(), playerId: PLAYER, keyId: KEY_ID, recordBytes: Buffer.from(RECORD_JSON) }));
});

test('createPlayerResultRequest weigert verkeerde invoer en POST zonder HTTPS', async () => {
  await assert.rejects(makePublishRequest(undefined, { playerParent: ARCADE }), /different identity/, 'naam+ouder moet het i-adres van de speler geven');
  await assert.rejects(makePublishRequest(undefined, { keyId: ARCADE }), /unexpected key/);
  await assert.rejects(makePublishRequest(undefined, { recordJson: 'x'.repeat(2049) }), /record payload/);
  await assert.rejects(makePublishRequest(undefined, { playerName: 'met.punt' }), /identity name/);
  await assert.rejects(makePublishRequest(undefined, { responseMode: 'post' }), /HTTPS/);
  await assert.rejects(makePublishRequest(undefined, { keyFqn: 'Arcade::x' }), /content key name/, 'zonder expliciete punt geen namespace-zekerheid');
});

test('assertContentOnlyIdentityUpdate weigert adressen, autoriteiten en platte content', () => {
  const base = { name: 'arcade-storage-poc', parent: TESTNET_SYSTEM_ID, contentmultimap: { [KEY_FQN]: { data: { message: RECORD_JSON, createmmr: true, hashtype: 'sha256' } } } };
  const opts = { requestid: requestId(PUBLISH_ID_HEX).toJson(), systemid: TESTNET_SYSTEM_ID, expiryheight: '2060' };
  const expect = { playerId: PLAYER, keyId: KEY_ID, recordBytes: Buffer.from(RECORD_JSON), expiryHeight: 2060 };
  assert.doesNotThrow(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson(base, opts), expect));
  assert.throws(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson({ ...base, primaryaddresses: [PLAYER_R] }, opts), expect), /name and parent/);
  assert.throws(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson({ ...base, revocationauthority: ARCADE }, opts), expect), /name and parent/);
  assert.throws(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson({ ...base, contentmultimap: { ...base.contentmultimap, [KEY_ID]: ['0102'] } }, opts), expect), /plain content|name and parent/);
  assert.throws(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson(base, { ...opts, expiryheight: '2061' }), expect), /expiry/);
  assert.throws(() => assertContentOnlyIdentityUpdate(P.IdentityUpdateRequestDetails.fromCLIJson(base, { ...opts, systemid: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'.replace('iJh', 'i5m') }), expect), /./);
});

test('verifyPlayerResultResponse aanvaardt een geldig antwoord en geeft de txid als ontvangstbewijs', async () => {
  const { vr, built, request } = await makePublishRequest();
  const body = publishResponse(request).toBuffer();
  const result = await vr.verifyPlayerResultResponse({ body, requestHex: built.requestHex, requestIdHex: PUBLISH_ID_HEX, playerId: PLAYER, keyId: KEY_ID, recordJson: RECORD_JSON });
  assert.equal(result.identityId, PLAYER);
  assert.equal(result.txid, '09'.repeat(32));
  assert.equal(result.signingHeight, 1500);
  assert.equal(result.expiryHeight, 2060);
});

test('verifyPlayerResultResponse weigert elke afwijking', async () => {
  const { vr, built, request } = await makePublishRequest();
  const run = (body, extra = {}) => vr.verifyPlayerResultResponse({ body, requestHex: built.requestHex, requestIdHex: PUBLISH_ID_HEX, playerId: PLAYER, keyId: KEY_ID, recordJson: RECORD_JSON, ...extra });
  await assert.rejects(run(publishResponse(request, { requestHash: Buffer.alloc(32, 7) }).toBuffer()), /different request/);
  await assert.rejects(run(publishResponse(request, { requestIdHex: 'ff'.repeat(20) }).toBuffer()), /different request/);
  await assert.rejects(run(publishResponse(request, { signer: ARCADE }).toBuffer()), (e) => e.code === 'SIGNER_MISMATCH');
  await assert.rejects(run(publishResponse(request, { withRequestId: false }).toBuffer()), /txid and request ID/);
  await assert.rejects(run(publishResponse(request, { txid: Buffer.alloc(32, 0) }).toBuffer()), /Invalid transaction ID/);
  // getekend ná de vervaldatum van het verzoek
  const fresh = signingClient({ records: {
    [`${ARCADE}@2000`]: identityRecord({ height: 1999 }), [`${ARCADE}@now`]: identityRecord({ height: 1999 }),
    [`${PLAYER}@1500`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R] }), [`${PLAYER}@now`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R] }),
    [`${PLAYER}@3000`]: identityRecord({ id: PLAYER, height: 1490, primary: [PLAYER_R] }),
  } });
  const far = await makePublishRequest(fresh);
  await assert.rejects(far.vr.verifyPlayerResultResponse({ body: publishResponse(far.request, { height: 3000 }).toBuffer(), requestHex: far.built.requestHex, requestIdHex: PUBLISH_ID_HEX, playerId: PLAYER, keyId: KEY_ID, recordJson: RECORD_JSON }), /CHAIN_UNAVAILABLE|expired|not yet available/);
  // opgeslagen verzoek voor een ander record
  await assert.rejects(run(publishResponse(request).toBuffer(), { recordJson: '{"ander":1}' }), /differs from the record/);
  // envelop-handtekening afgekeurd door de SDK
  const bad = await makePublishRequest(signingClient({ verifyResponse: false }));
  await assert.rejects(bad.vr.verifyPlayerResultResponse({ body: publishResponse(bad.request).toBuffer(), requestHex: bad.built.requestHex, requestIdHex: PUBLISH_ID_HEX, playerId: PLAYER, keyId: KEY_ID, recordJson: RECORD_JSON }), /Invalid wallet response signature/);
  // afgekapt
  const bytes = publishResponse(request).toBuffer();
  await assert.rejects(run(bytes.subarray(0, bytes.length - 3)), (e) => e.code === 'INVALID_SIGNATURE');
});

test('walletCompatibleIdentity rekent zoals Verus Mobile (mainnet-root als standaard)', () => {
  // Live gezien op 9 nov: getidentitycontent geeft deze namen terug.
  assert.equal(walletCompatibleIdentity({ identityId: 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g', contentFqn: 'mrrager.VRSCTEST@' }), true);
  assert.equal(walletCompatibleIdentity({ identityId: 'iQZGcAzSXaeciUhoh3ZbkmcgJHmdy3seBK', contentFqn: 'testerrr.Verus Arcade@' }), false);
  assert.equal(walletCompatibleIdentity({ identityId: 'iQZGcAzSXaeciUhoh3ZbkmcgJHmdy3seBK', contentFqn: 'testerrr.Verus Arcade.VRSCTEST@' }), true);
  assert.equal(walletCompatibleIdentity({ identityId: ARCADE, contentFqn: '' }), false);
});
