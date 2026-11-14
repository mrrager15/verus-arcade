import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChainReadError, DEFAULT_RPC_URL, LIMITS, VRSCTEST_CHAIN_ID, createChainReader, decodeHexJson, firstUpdateWithValue, isUnavailable,
} from './chain-reader.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const KEY = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const OTHER_KEY = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';
const TIP = 1_300_000;
const T0 = 1_712_527_150;
// Blokken van ±60 s met vaste "ruis" van -20..+20 s: stijgend, maar niet gelijkmatig.
const blockTime = (h) => T0 + h * 60 + (((h * 7919) % 41) - 20);
const txid = (n) => n.toString(16).padStart(64, '0');
const hex = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('hex');

/**
 * Nep-RPC: beantwoordt de methodes van de lezer zoals de daemon, telt aanroepen
 * en kan per methode iets anders teruggeven (`overrides`).
 */
function fakeRpc({ overrides = {}, info = {} } = {}) {
  const calls = [];
  const history = [
    { height: 1000, txid: txid(1), cmm: { [KEY]: [hex({ round: 'a' })] } },
    { height: 1500, txid: txid(2), cmm: { [KEY]: [hex({ round: 'b' })], [OTHER_KEY]: [hex({ results: 'a' })] } },
    { height: 1200, txid: txid(3), cmm: { [KEY]: [hex({ round: 'a' })], [OTHER_KEY]: [] } },
  ];
  const methods = {
    getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: TIP, VRSCversion: '1.2.18', ...info }),
    getblock: ([h]) => ({ height: Number(h), time: blockTime(Number(h)) }),
    getidentitycontent: ([id, , , , , key]) => ({
      fullyqualifiedname: 'Arcade.VRSCTEST@',
      identity: { identityaddress: id, contentmultimap: { [key]: [hex({ round: 'a' }), hex({ round: 'b' })] } },
    }),
    getidentityhistory: ([id]) => ({
      history: history.map((e) => ({ height: e.height, blockhash: 'x', output: { txid: e.txid, voutnum: 0 }, identity: { identityaddress: id, contentmultimap: e.cmm } })),
    }),
    getrawtransaction: ([t]) => {
      if (t === txid(1)) return { txid: t, confirmations: 7, height: 1000 };
      if (t === txid(9)) return { txid: t };
      throw Object.assign(new Error('No information available about transaction'), { rpcCode: -5 });
    },
    getidentity: ([id, height]) => ({ identity: { identityaddress: id, systemid: VRSCTEST_CHAIN_ID }, blockheight: height ?? TIP, status: 'active' }),
    ...overrides,
  };
  const fetch = async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    calls.push({ url, method, params, contentType: init.headers['content-type'] });
    const handler = methods[method];
    if (!handler) return new Response(JSON.stringify({ id, result: null, error: { code: -32601, message: 'Method not found' } }));
    try {
      const result = await handler(params);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify({ id, result, error: null }));
    } catch (error) {
      return new Response(JSON.stringify({ id, result: null, error: { code: error.rpcCode ?? -1, message: error.message } }), { status: 500 });
    }
  };
  return { fetch, calls, count: (m) => calls.filter((c) => c.method === m).length };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e instanceof ChainReadError && e.code === code);

test('chain-lezer: standaard publieke RPC, text/plain, alleen VRSCTEST', async () => {
  const rpc = fakeRpc();
  const reader = createChainReader({ fetch: rpc.fetch });
  assert.equal(reader.url, DEFAULT_RPC_URL);
  assert.deepEqual(await reader.info(), { tip: TIP, chainId: VRSCTEST_CHAIN_ID, version: '1.2.18' });
  await reader.info();
  assert.equal(rpc.count('getinfo'), 1, 'getinfo één keer per lezer');
  assert.equal(rpc.calls[0].contentType, 'text/plain');

  const mainnet = createChainReader({ fetch: fakeRpc({ info: { name: 'VRSC', chainid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', testnet: false } }).fetch });
  await assert.rejects(mainnet.info(), (e) => e.code === 'WRONG_CHAIN' && !isUnavailable(e));
  assert.throws(() => createChainReader({ url: 'ftp://example' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => createChainReader({ url: 'geen url' }), (e) => e.code === 'INVALID_INPUT');
});

test('chain-lezer: hoogte bij een tijdstip in een handvol aanroepen, nooit erna', async () => {
  for (const target of [5, 400_000, 777_777, 1_299_000]) {
    const rpc = fakeRpc();
    const reader = createChainReader({ fetch: rpc.fetch });
    const at = blockTime(target);
    const found = await reader.heightAtTime(at);
    assert.ok(blockTime(found) < at, `blok ${found} ligt vóór het tijdstip (doel ${target})`);
    assert.ok(target - found <= 30, `binnen de tolerantie (doel ${target}, gevonden ${found})`);
    assert.ok(rpc.count('getblock') <= 14, `${rpc.count('getblock')} blokken opgevraagd voor doel ${target}`);
  }
  const exact = createChainReader({ fetch: fakeRpc().fetch });
  assert.equal(await exact.heightAtTime(blockTime(123_456), { tolerance: 1 }), 123_455);
  const edges = createChainReader({ fetch: fakeRpc().fetch });
  assert.equal(await edges.heightAtTime(T0 - 10_000), 1);
  assert.equal(await edges.heightAtTime(blockTime(TIP) + 3600), TIP);
});

test('chain-lezer: hoogtevenster rond een tijdsbereik, begrensd door de tip', async () => {
  const reader = createChainReader({ fetch: fakeRpc().fetch });
  const w = await reader.windowForTimes({ fromMs: blockTime(1_000_000) * 1000, toMs: blockTime(1_002_000) * 1000 });
  assert.ok(w.fromHeight <= 1_000_000 && w.fromHeight >= 1_000_000 - 30);
  assert.ok(w.toHeight >= 1_002_000 && w.toHeight <= 1_002_000 + 30);
  const late = await reader.windowForTimes({ fromMs: blockTime(TIP - 10) * 1000, toMs: (blockTime(TIP) + 86_400) * 1000 });
  assert.equal(late.toHeight, TIP);
  await rejectsWith(reader.windowForTimes({ fromMs: 10, toMs: 5 }), 'INVALID_INPUT');
});

test('chain-lezer: content onder één key, ontdubbeld, met grens van 32 verschillende waarden', async () => {
  const reader = createChainReader({ fetch: fakeRpc().fetch });
  const { values, rawCount, fullyQualifiedName } = await reader.identityContent({ identityId: ARCADE, keyId: KEY, fromHeight: 10, toHeight: 20 });
  assert.equal(values.length, 2);
  assert.equal(rawCount, 2);
  assert.deepEqual(decodeHexJson(values[1]), { round: 'b' });
  assert.equal(fullyQualifiedName, 'Arcade.VRSCTEST@');

  // Zoals de echte RPC: elke update herhaalt de waarden die ze meeneemt.
  const repeated = (count, distinct) => createChainReader({
    fetch: fakeRpc({ overrides: { getidentitycontent: ([id, , , , , key]) => ({ identity: { identityaddress: id, contentmultimap: { [key]: Array.from({ length: count }, (_, i) => hex({ n: i % distinct })) } } }) } }).fetch,
  });
  const dup = await repeated(100, 10).identityContent({ identityId: ARCADE, keyId: KEY, fromHeight: 0, toHeight: 1 });
  assert.deepEqual([dup.values.length, dup.rawCount], [10, 100]);
  assert.deepEqual(dup.values.map((v) => decodeHexJson(v).n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await assert.rejects(repeated(LIMITS.valuesPerKey + 1, LIMITS.valuesPerKey + 1).identityContent({ identityId: ARCADE, keyId: KEY, fromHeight: 0, toHeight: 1 }), (e) => e.code === 'LIMIT_EXCEEDED' && isUnavailable(e));

  const liar = createChainReader({ fetch: fakeRpc({ overrides: { getidentitycontent: () => ({ identity: { identityaddress: 'iOther', contentmultimap: {} } }) } }).fetch });
  await rejectsWith(liar.identityContent({ identityId: ARCADE, keyId: KEY, fromHeight: 0, toHeight: 1 }), 'UNAVAILABLE');
  await assert.rejects(reader.identityContent({ identityId: 'Arcade@', keyId: KEY, fromHeight: 0, toHeight: 1 }), (e) => e.code === 'INVALID_INPUT' && !isUnavailable(e));
  await rejectsWith(reader.identityContent({ identityId: ARCADE, keyId: KEY, fromHeight: 5, toHeight: 4 }), 'INVALID_INPUT');
});

test('chain-lezer: geschiedenis oudste eerst; eerste update met een waarde', async () => {
  const reader = createChainReader({ fetch: fakeRpc().fetch });
  const history = await reader.identityHistory({ identityId: ARCADE, fromHeight: 0, toHeight: 2000 });
  assert.deepEqual(history.map((e) => e.height), [1000, 1200, 1500]);
  assert.equal(firstUpdateWithValue(history, KEY, hex({ round: 'a' })).txid, txid(1));
  assert.equal(firstUpdateWithValue(history, KEY, hex({ round: 'b' })).txid, txid(2));
  assert.equal(firstUpdateWithValue(history, OTHER_KEY, hex({ results: 'a' })).height, 1500);
  assert.equal(firstUpdateWithValue(history, KEY, hex({ round: 'z' })), null);

  const big = createChainReader({ fetch: fakeRpc({ overrides: { getidentityhistory: () => ({ history: Array(LIMITS.historyEntries + 1).fill({}) }) } }).fetch });
  await rejectsWith(big.identityHistory({ identityId: ARCADE, fromHeight: 0, toHeight: 1 }), 'LIMIT_EXCEEDED');
  const broken = createChainReader({ fetch: fakeRpc({ overrides: { getidentityhistory: () => ({ history: [{ height: 1, output: { txid: 'nope' }, identity: { identityaddress: ARCADE } }] }) } }).fetch });
  await rejectsWith(broken.identityHistory({ identityId: ARCADE, fromHeight: 0, toHeight: 1 }), 'UNAVAILABLE');
  const empty = createChainReader({ fetch: fakeRpc({ overrides: { getidentityhistory: () => ({}) } }).fetch });
  await rejectsWith(empty.identityHistory({ identityId: ARCADE, fromHeight: 0, toHeight: 1 }), 'UNAVAILABLE');
});

test('chain-lezer: transactie bevestigd, in de mempool of onbekend', async () => {
  const reader = createChainReader({ fetch: fakeRpc().fetch });
  assert.deepEqual(await reader.transaction(txid(1)), { confirmations: 7, height: 1000 });
  assert.deepEqual(await reader.transaction(txid(9)), { confirmations: 0, height: null });
  assert.equal(await reader.transaction(txid(5)), null, 'onbekend (-5) = null, geen fout');
  const failing = createChainReader({ fetch: fakeRpc({ overrides: { getrawtransaction: () => { throw new Error('boom'); } } }).fetch });
  await assert.rejects(failing.transaction(txid(1)), (e) => e.code === 'RPC_ERROR' && e.rpcCode === -1 && isUnavailable(e));
  await rejectsWith(reader.transaction('xyz'), 'INVALID_INPUT');
});

test('chain-lezer: identiteit op een hoogte wordt nagekeken', async () => {
  const reader = createChainReader({ fetch: fakeRpc().fetch });
  assert.equal((await reader.identity({ identityId: ARCADE, height: 1234 })).blockheight, 1234);
  const future = createChainReader({ fetch: fakeRpc({ overrides: { getidentity: ([id]) => ({ identity: { identityaddress: id, systemid: VRSCTEST_CHAIN_ID }, blockheight: 99_999, status: 'active' }) } }).fetch });
  await rejectsWith(future.identity({ identityId: ARCADE, height: 1234 }), 'UNAVAILABLE');
  const mainnetId = createChainReader({ fetch: fakeRpc({ overrides: { getidentity: ([id]) => ({ identity: { identityaddress: id, systemid: 'iOther' }, blockheight: 1, status: 'active' }) } }).fetch });
  await rejectsWith(mainnetId.identity({ identityId: ARCADE }), 'UNAVAILABLE');
});

test('chain-lezer: netwerkfouten en vreemde antwoorden zijn "niet beschikbaar"', async () => {
  const down = createChainReader({ fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.info(), (e) => e.code === 'UNAVAILABLE' && isUnavailable(e));
  const html = createChainReader({ fetch: async () => new Response('<html>502</html>', { status: 502 }) });
  await rejectsWith(html.info(), 'UNAVAILABLE');
  const noResult = createChainReader({ fetch: async () => new Response(JSON.stringify({ id: 1 })) });
  await rejectsWith(noResult.info(), 'UNAVAILABLE');
  const timeout = createChainReader({ fetch: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  await rejectsWith(timeout.info(), 'TIMEOUT');
  // Een mislukte getinfo wordt niet onthouden.
  let first = true;
  const flaky = createChainReader({ fetch: async (url, init) => { if (first) { first = false; throw new TypeError('x'); } return fakeRpc().fetch(url, init); } });
  await rejectsWith(flaky.info(), 'UNAVAILABLE');
  assert.equal((await flaky.info()).tip, TIP);
});

test('chain-lezer: tijdsbudget voor de hele controle', async () => {
  let clock = 0;
  const rpc = fakeRpc();
  const reader = createChainReader({ fetch: async (url, init) => { clock += 5_000; return rpc.fetch(url, init); }, now: () => clock });
  await reader.info(); // start op 0 s
  await reader.blockTime(10); // start op 5 s
  await reader.blockTime(11); // start op 10 s: nog binnen 12 s
  await rejectsWith(reader.blockTime(12), 'TIMEOUT'); // zou op 15 s starten
  await rejectsWith(reader.blockTime(13), 'TIMEOUT');
  assert.equal(rpc.calls.length, 3, 'na het budget gaat er niets meer naar de RPC');
  assert.deepEqual(reader.stats(), { url: DEFAULT_RPC_URL, calls: 3, elapsedMs: 15_000, budgetMs: 12_000 });
});

test('decodeHexJson: alleen UTF-8-JSON in hex', () => {
  assert.deepEqual(decodeHexJson(hex({ a: 1, b: 'é' })), { a: 1, b: 'é' });
  assert.equal(decodeHexJson('zz'), null);
  assert.equal(decodeHexJson('abc'), null);
  assert.equal(decodeHexJson(''), null);
  assert.equal(decodeHexJson('ff'), null, 'geen geldige UTF-8');
  assert.equal(decodeHexJson(Buffer.from('geen json').toString('hex')), null);
  assert.equal(decodeHexJson({ objectdata: '00' }), null);
});
