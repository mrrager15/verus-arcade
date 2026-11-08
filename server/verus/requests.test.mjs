import test from 'node:test';
import assert from 'node:assert/strict';
import {
  P, TESTNET_SYSTEM_ID, GENERIC_RESPONSE_QUERY_KEY, VerusRequestError, VerusRequests,
  rawId, compact, compactId, requestId, nativeHeight, signatureWrapper, exactParse, parseConf,
  createVerusRequestsFromEnv,
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
