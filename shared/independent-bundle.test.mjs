import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { actionBundleKeyId, serializeActionBundle } from './action-bundle.mjs';
import { createChainReader, VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { BUNDLE_VERDICT, verifyPlayerBundleIndependently } from './independent-bundle.mjs';
import { roundKeyFromSalt } from './round-key.mjs';
import { signReceipt, testIdentity, testKey } from './testing/bundle-receipt.mjs';
import { mobileRecord, sealedRecord, transactionWithEvidence } from './testing/mobile-record.mjs';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/round-reveal-vectors.json', import.meta.url), 'utf8'));
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const OTHER_PLAYER = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const ROUND = 'number-target:1.0.0:2026-11-13';
const real = vectors.cases.find((c) => c.name === `echt: ${ROUND}`);
const definition = real.reveal.hiddenDefinition; // doel 350, oplossing 2*(75+100)
const ADDRESS = roundKeyFromSalt(definition.salt).address;
const KEY_ID = actionBundleKeyId({ roundId: ROUND, serviceId: ARCADE });
const ACTIONS = ['75+100', '2*(75+100)'];
const arcadeKey = testKey();

// Hoogtes: commitment 1000, ontvangstbewijs 1490, bundel 1500, reveal 2000, tip 2100.
const H = { commitment: 1000, ack: 1490, bundle: 1500, reveal: 2000, tip: 2100 };
const txid = (n) => n.toString(16).padStart(64, '0');

/** De ronde zoals de onafhankelijke rondecontrole haar teruggeeft (alleen wat de bundelcontrole gebruikt). */
function roundResult({ verdict = 'verified', schema = 2, address = ADDRESS, revealed = true } = {}) {
  const commitment = schema === 2 ? { ...real.commitment, schemaVersion: 2, roundEncryptionAddress: address } : real.commitment;
  return {
    verdict,
    parts: {
      commitment: { value: commitment, height: H.commitment },
      reveal: revealed ? { value: real.reveal, height: H.reveal } : { value: null, height: null },
    },
  };
}

const officialRecord = (actions = ACTIONS, status = 'solved') => ({
  schemaVersion: 3, roundId: ROUND, playerIAddress: PLAYER, status, actions: actions.map((value, i) => ({ sequence: i + 1, value })),
});

/** Bundeltekst met een ontvangstbewijs van `key` (standaard de sleutel van Arcade@ in deze test). */
async function bundleText({ actions = ACTIONS, player = PLAYER, round = ROUND, key = arcadeKey, ackHeight = H.ack } = {}) {
  const signed = await signReceipt({ round, player, actions, key, height: ackHeight });
  return serializeActionBundle({ round, player, actions, ...signed });
}

/**
 * Nagebootste chain. `published`: [{ record: { value, evidenceHex }, height }] in de ID van PLAYER,
 * elk in een eigen update-transactie (latere updates nemen eerdere waarden niet mee, zoals Mobile).
 */
function chain({ published = [], down = false } = {}) {
  const updates = published.map((p, i) => ({ ...p, txid: txid(100 + i) }));
  const calls = [];
  const methods = {
    getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: H.tip, VRSCversion: '1.2.18' }),
    getidentity: ([id, height]) => testIdentity(id, arcadeKey, height),
    getidentitycontent: ([id, , , , , key]) => ({ identity: { identityaddress: id, contentmultimap: key === KEY_ID && updates.length ? { [KEY_ID]: updates.map((u) => u.record.value) } : {} } }),
    getidentityhistory: ([id, from, to]) => ({
      history: updates.filter((u) => u.height >= from && u.height <= to)
        .map((u) => ({ height: u.height, blockhash: 'x', output: { txid: u.txid, voutnum: 0 }, identity: { identityaddress: id, contentmultimap: { [KEY_ID]: [u.record.value] } } })),
    }),
    getrawtransaction: ([t]) => {
      const update = updates.find((u) => u.txid === t);
      if (!update) throw Object.assign(new Error('No information'), { rpcCode: -5 });
      return transactionWithEvidence(t, update.record.evidenceHex, { confirmations: H.tip - update.height + 1, height: update.height });
    },
  };
  const fetch = async (url, init) => {
    if (down) throw new TypeError('fetch failed');
    const { method, params, id } = JSON.parse(init.body);
    calls.push(method);
    try {
      return new Response(JSON.stringify({ id, result: await methods[method](params), error: null }));
    } catch (error) {
      return new Response(JSON.stringify({ id, result: null, error: { code: error.rpcCode ?? -1, message: error.message } }), { status: 500 });
    }
  };
  return { reader: createChainReader({ fetch, limits: { timeMs: 30_000 } }), calls };
}

const verify = (c, extra = {}) => verifyPlayerBundleIndependently({ playerId: PLAYER, roundId: ROUND, round: roundResult(), reader: c.reader, officialRecord: officialRecord(), ...extra });
const sealed = async (options = {}, height = H.bundle, address = ADDRESS) => ({ record: sealedRecord(await bundleText(options), address), height });

test('bundel onafhankelijk: verzegeld vóór de reveal, ontvangstbewijs, nagespeeld, gelijk aan het resultaat → verified', async () => {
  const c = chain({ published: [await sealed()] });
  const r = await verify(c);
  assert.equal(r.verdict, BUNDLE_VERDICT.VERIFIED, r.problems.join('; '));
  assert.deepEqual(
    { keyId: r.keyId, txid: r.txid, height: r.height, revealHeight: r.revealHeight, sealed: r.sealed, sealedBeforeReveal: r.sealedBeforeReveal, actions: r.actions, receipt: r.receipt, replay: r.replay, matchesResult: r.matchesResult, duplicates: r.duplicates },
    { keyId: KEY_ID, txid: txid(100), height: H.bundle, revealHeight: H.reveal, sealed: true, sealedBeforeReveal: true, actions: ACTIONS, receipt: 'valid', replay: { status: 'solved', actionsUsed: 2, finished: true }, matchesResult: 'ok', duplicates: 0 },
  );
  assert.deepEqual(r.problems, []);
  assert.ok(c.calls.length <= 6, c.calls.join(','));
  // Zonder resultaatrecord om mee te vergelijken: nog altijd in orde, alleen niet vergeleken.
  const alone = await verify(chain({ published: [await sealed()] }), { officialRecord: undefined });
  assert.deepEqual([alone.verdict, alone.matchesResult], [BUNDLE_VERDICT.VERIFIED, 'not-checked']);
});

test('bundel onafhankelijk: pas na de reveal op de chain → late (bewijst geen tijdstip)', async () => {
  const r = await verify(chain({ published: [await sealed({ ackHeight: H.reveal + 5 }, H.reveal + 10)] }));
  assert.equal(r.verdict, BUNDLE_VERDICT.LATE, r.problems.join('; '));
  assert.equal(r.sealedBeforeReveal, false);
  // Precies in het blok van de reveal telt ook niet als "ervoor".
  assert.equal((await verify(chain({ published: [await sealed({}, H.reveal)] }))).verdict, BUNDLE_VERDICT.LATE);
});

test('bundel onafhankelijk: twee keer goedgekeurd → de oudste telt, de andere is dubbel', async () => {
  const r = await verify(chain({ published: [await sealed({}, H.bundle + 20), await sealed({}, H.bundle)] }));
  assert.equal(r.verdict, BUNDLE_VERDICT.VERIFIED, r.problems.join('; '));
  assert.deepEqual([r.valuesUnderKey, r.duplicates, r.height, r.txid], [2, 1, H.bundle, txid(101)]);
});

test('bundel onafhankelijk: operator nam andere zetten op, of liet de speler weg → invalid', async () => {
  // Het ontvangstbewijs is geldig, maar het officiële resultaat zegt iets anders.
  const altered = await verify(chain({ published: [await sealed()] }), { officialRecord: officialRecord(['2*(75+100)']) });
  assert.equal(altered.verdict, BUNDLE_VERDICT.INVALID);
  assert.deepEqual([altered.receipt, altered.matchesResult], ['valid', 'mismatch']);
  const status = await verify(chain({ published: [await sealed()] }), { officialRecord: officialRecord(ACTIONS, 'unsolved') });
  assert.deepEqual([status.verdict, status.matchesResult], [BUNDLE_VERDICT.INVALID, 'mismatch']);
  // De speler staat aantoonbaar niet in het resultaat, maar Arcade@ tekende wel voor ontvangst.
  const absent = await verify(chain({ published: [await sealed()] }), { officialRecord: null });
  assert.deepEqual([absent.verdict, absent.matchesResult], [BUNDLE_VERDICT.INVALID, 'absent']);
  assert.match(absent.problems.join(' '), /acknowledged/);
});

test('bundel onafhankelijk: verzonnen of gekopieerde bundel → invalid', async () => {
  // Ontvangstbewijs getekend door een andere sleutel dan die van Arcade@.
  const forged = await verify(chain({ published: [await sealed({ key: testKey() })] }));
  assert.deepEqual([forged.verdict, forged.receipt], [BUNDLE_VERDICT.INVALID, 'invalid']);
  // Zonder geldig ontvangstbewijs is "niet in het resultaat" geen bewijs tegen de operator, wel een ongeldige bundel.
  const forgedAbsent = await verify(chain({ published: [await sealed({ key: testKey() })] }), { officialRecord: null });
  assert.equal(forgedAbsent.verdict, BUNDLE_VERDICT.INVALID);
  assert.doesNotMatch(forgedAbsent.problems.join(' '), /acknowledged/);
  // De bundel van een andere speler (met diens geldige ontvangstbewijs) in deze ID.
  const copied = await verify(chain({ published: [await sealed({ player: OTHER_PLAYER })] }));
  assert.equal(copied.verdict, BUNDLE_VERDICT.INVALID);
  assert.match(copied.problems.join(' '), /another player/);
  // Ontvangstbewijs gedateerd ná de transactie waarin de bundel staat.
  const future = await verify(chain({ published: [await sealed({ ackHeight: H.bundle + 1 })] }));
  assert.deepEqual([future.verdict, future.receipt], [BUNDLE_VERDICT.INVALID, 'invalid']);
});

test('bundel onafhankelijk: publiek leesbaar opgeslagen (viewing key in de ID) → invalid', async () => {
  const r = await verify(chain({ published: [{ record: mobileRecord(await bundleText()), height: H.bundle }] }));
  assert.equal(r.verdict, BUNDLE_VERDICT.INVALID);
  assert.equal(r.sealed, false);
  assert.match(r.problems.join(' '), /publicly readable/);
});

test('bundel onafhankelijk: niets, onleesbaar, nog niet onthuld, ronde zonder adres, chain weg', async () => {
  assert.equal((await verify(chain())).verdict, BUNDLE_VERDICT.NOT_FOUND);
  // Versleuteld naar een ander adres dan dat van de ronde: de sleutel uit de salt opent het niet.
  const elsewhere = await verify(chain({ published: [await sealed({}, H.bundle, roundKeyFromSalt('ab'.repeat(32)).address)] }));
  assert.equal(elsewhere.verdict, BUNDLE_VERDICT.UNREADABLE);
  // Geen bundel maar iets anders onder de key.
  const junk = await verify(chain({ published: [{ record: sealedRecord('{"schema":"iets anders"}', ADDRESS), height: H.bundle }] }));
  assert.equal(junk.verdict, BUNDLE_VERDICT.UNREADABLE);
  // Vóór de reveal: we zien dat er iets staat (en sinds wanneer), meer niet.
  const pending = await verify(chain({ published: [await sealed()] }), { round: roundResult({ verdict: 'incomplete', revealed: false }) });
  assert.deepEqual([pending.verdict, pending.height, pending.actions, pending.valuesUnderKey], [BUNDLE_VERDICT.PENDING, H.bundle, null, 1]);
  // Een ronde die niet geldig onthuld is, levert geen sleutel.
  assert.equal((await verify(chain({ published: [await sealed()] }), { round: roundResult({ verdict: 'invalid' }) })).verdict, BUNDLE_VERDICT.PENDING);
  // Commitment-schema 1: deze ronde kent geen bundels; er wordt niets gelezen.
  const old = chain({ published: [await sealed()] });
  assert.equal((await verify(old, { round: roundResult({ schema: 1 }) })).verdict, BUNDLE_VERDICT.NOT_APPLICABLE);
  assert.deepEqual(old.calls, []);
  assert.equal((await verify(chain({ down: true }))).verdict, BUNDLE_VERDICT.UNAVAILABLE);
  await assert.rejects(verify(chain(), { playerId: 'speler@' }), (e) => e.code === 'INVALID_INPUT');
});
