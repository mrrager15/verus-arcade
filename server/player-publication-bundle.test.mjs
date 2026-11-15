/**
 * Fase 5 stap 4d: de publicatieservice en de soort 'bundle' (actie-bundel,
 * versleuteld naar het adres van de ronde). De andere soorten staan in
 * player-publication-service.test.mjs.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { actionBundleKeyId, parseActionBundle, verifyBundleReceipt } from '../shared/action-bundle.mjs';
import { VRSCTEST_CHAIN_ID } from '../shared/chain-reader.mjs';
import { roundKeyFromSalt } from '../shared/round-key.mjs';
import { testIdentity, testKey } from '../shared/testing/bundle-receipt.mjs';
import { mobileRecord, sealedRecord, transactionWithEvidence } from '../shared/testing/mobile-record.mjs';
import { DailyService } from './daily-service.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { PlayerPublicationService } from './player-publication-service.mjs';
import { VerusRequestError } from './verus/requests.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client');

const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PRINCIPAL = Object.freeze({ chain: 'vrsctest', iAddress: PLAYER, friendlyName: 'poc@' });
const ROUND_ID = 'word-grid:1.0.0:2026-10-20';
const SALT = 'ab'.repeat(32);
const ADDRESS = roundKeyFromSalt(SALT).address;
const KEY_ID = actionBundleKeyId({ roundId: ROUND_ID, serviceId: ARCADE });
const RECEIPT_TXID = 'd'.repeat(64);
const UPDATE_TXID = 'e'.repeat(64);
const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:1');
const arcadeKey = testKey();

/** Nep-VerusRequests; tekent ontvangstbewijzen echt (testsleutel), zodat de onafhankelijke controle ze kan nakijken. */
function fakeVerus({ tip = 1000 } = {}) {
  const state = { tip, created: [], verified: [], signed: 0, chainValues: [], chainHistory: [], transactions: new Map(), receiptStatus: null, chainDown: false };
  return {
    state,
    serviceId: ARCADE,
    async tip() { return state.tip; },
    async serviceState() { return { height: state.tip, state: { current: { fullyqualifiedname: 'Arcade.VRSCTEST@' } } }; },
    async loadIdentity({ identityId }) {
      return { currentActive: true, current: { identity: { name: 'arcade-storage-poc', parent: VRSCTEST_CHAIN_ID, identityaddress: identityId } } };
    },
    async signMmrRoot(hashHex) {
      state.signed += 1;
      const signaturedata = { version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: hashHex, identityid: ARCADE, signaturetype: 1 };
      const digest = P.SignatureData.fromJson({ ...signaturedata, signature: '' }).getIdentityHash({ version: 2, hash_type: 5, height: state.tip });
      const signature = await sdk.signHash(ARCADE, digest, arcadeKey.toWIF(), testIdentity(ARCADE, arcadeKey, state.tip), state.tip, VRSCTEST_CHAIN_ID);
      return { signaturedata: { ...signaturedata, signature }, signatureheight: state.tip };
    },
    async createPlayerResultRequest(input) {
      state.created.push(input);
      return { requestHex: 'aa'.repeat(40), requestHashHex: 'bb'.repeat(32), walletUri: `verus://x/${input.requestIdHex}`, height: state.tip, expiryHeight: state.tip + input.ttlBlocks };
    },
    async verifyPlayerResultResponse(input) {
      state.verified.push(input);
      return { identityId: PLAYER, txid: RECEIPT_TXID, signingHeight: state.tip, expiryHeight: state.tip + 60 };
    },
    async identityContentName() { return 'arcade-storage-poc.VRSCTEST@'; },
    async readIdentityContent({ identityId, keyId }) {
      if (state.chainDown) throw new VerusRequestError('CHAIN_UNAVAILABLE', 'rpc');
      const values = keyId === KEY_ID ? state.chainValues : [];
      return {
        tip: state.tip,
        content: { identity: { identityaddress: identityId, contentmultimap: values.length ? { [keyId]: values } : {} } },
        history: keyId === KEY_ID ? state.chainHistory : [],
      };
    },
    async transaction(txid) {
      if (!state.transactions.has(txid)) throw new VerusRequestError('CHAIN_UNAVAILABLE', 'no such transaction');
      return state.transactions.get(txid);
    },
    async transactionStatus() { return state.receiptStatus; },
    async decryptDataDescriptor() { return null; },
  };
}

function setup({ commitmentSchema = 2 } = {}) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const daily = new DailyService({ repository, clock: () => 5_000, createId: () => 'attempt-1' });
  repository.createRound({
    id: 'round-1', chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', roundId: ROUND_ID, commitmentHash: 'h',
    privateDefinition: { answer: 'crane', salt: SALT }, opensAt: 1_000, closesAt: 10_000, now: 500, commitmentSchema,
  });
  repository.openRound({ id: 'round-1', commitmentTxid: 'a'.repeat(64) });
  const verus = fakeVerus();
  const time = { now: 5_000 };
  let counter = 0;
  const service = new PlayerPublicationService({
    repository, verusRequests: verus, origin: 'http://127.0.0.1:8100/', responseMode: 'redirect', ttlBlocks: 60,
    clock: () => time.now, createRequestIdHex: () => (++counter).toString(16).padStart(40, '0'),
  });
  return { database, repository, daily, verus, service, time };
}

function play(daily, words = ['slate', 'crane']) {
  const { attempt } = daily.reserveAttempt({ principal: PRINCIPAL, roundId: 'round-1' });
  words.forEach((word, i) => daily.submitAction({
    principal: PRINCIPAL, attemptId: attempt.id,
    action: { type: 'guess', actionId: `action-${i + 1}xxxx`, sequence: i + 1, gameVersion: '1.0.0', payload: { word } },
  }));
  return attempt.id;
}

/** Zet een waarde onder de bundel-key op de nagebootste chain, in transactie UPDATE_TXID. */
function publishOnChain(verus, record, { height = 1010 } = {}) {
  verus.state.chainValues = [record.value];
  verus.state.chainHistory = [{ height, output: { txid: UPDATE_TXID, voutnum: 0 }, identity: { identityaddress: PLAYER, contentmultimap: { [KEY_ID]: [record.value] } } }];
  verus.state.transactions.set(UPDATE_TXID, transactionWithEvidence(UPDATE_TXID, record.evidenceHex, { confirmations: 3, height }));
}

const bundle = (ctx, attemptId) => ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId, kind: 'bundle' });

test('bundel: mag tijdens de ronde, zodra de poging klaar is, zonder result-root', async () => {
  const ctx = setup();
  const attemptId = play(ctx.daily);
  // Resultaat publiceren kan nog niet (de ronde loopt), de bundel wel.
  await assert.rejects(ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }), (e) => e.code === 'RESULT_ROOT_UNPUBLISHED');
  const created = await bundle(ctx, attemptId);
  assert.equal(created.created, true);
  const pub = created.publication;
  assert.deepEqual([pub.kind, pub.status, pub.encryptToAddress], ['bundle', 'pending', ADDRESS]);
  assert.equal(pub.contentKey, KEY_ID);
  assert.equal(pub.contentKeyName, `Arcade.VRSCTEST.::arcade.player.bundle.${ROUND_ID}`);
  assert.deepEqual([pub.record.round, pub.record.player, pub.record.actions, pub.record.ackHeight], [ROUND_ID, PLAYER, ['slate', 'crane'], 1000]);

  // Het wallet-verzoek versleutelt naar het adres van de ronde.
  const [sent] = ctx.verus.state.created;
  assert.deepEqual([sent.playerId, sent.keyId, sent.encryptToAddress], [PLAYER, KEY_ID, ADDRESS]);
  // Wat de speler publiceert is een geldige bundel met een ontvangstbewijs dat onafhankelijk klopt.
  const parsed = parseActionBundle(sent.recordJson);
  assert.deepEqual(verifyBundleReceipt({ bundle: parsed, serviceId: ARCADE, identityAtHeight: testIdentity(ARCADE, arcadeKey, 1000) }), { valid: true, reason: null });
  assert.equal(ctx.repository.getPlayerPublication(attemptId, 'bundle').encryptToAddress, ADDRESS);

  // Nogmaals vragen: hetzelfde verzoek, niet opnieuw getekend, geen tweede QR.
  const again = await bundle(ctx, attemptId);
  assert.deepEqual([again.created, again.publication.requestId, ctx.verus.state.created.length, ctx.verus.state.signed], [false, pub.requestId, 1, 1]);
  const polled = await ctx.service.getPublishRequest({ principal: PRINCIPAL, attemptId, kind: 'bundle' });
  assert.equal(polled.publication.walletUri, pub.walletUri);
  ctx.database.close();
});

test('bundel: alleen voor een klare poging in een ronde met versleuteladres, en niet meer na de reveal', async () => {
  const old = setup({ commitmentSchema: 1 });
  const oldAttempt = play(old.daily);
  await assert.rejects(bundle(old, oldAttempt), (e) => e.code === 'BUNDLE_NOT_AVAILABLE' && e.httpStatus === 409);
  assert.equal(old.verus.state.signed, 0, 'geen ontvangstbewijs voor een ronde zonder adres');
  old.database.close();

  const busy = setup();
  const unfinished = play(busy.daily, ['slate']);
  await assert.rejects(bundle(busy, unfinished), (e) => e.code === 'ATTEMPT_NOT_COMPLETED');
  await assert.rejects(busy.service.createPublishRequest({ principal: PRINCIPAL, attemptId: unfinished, kind: 'iets' }), (e) => e.code === 'INVALID_PUBLICATION_KIND');
  busy.database.close();

  const late = setup();
  const attemptId = play(late.daily);
  late.database.prepare("UPDATE rounds SET status = 'revealed' WHERE id = 'round-1'").run();
  await assert.rejects(bundle(late, attemptId), (e) => e.code === 'ROUND_ALREADY_REVEALED');
  assert.equal(late.verus.state.signed, 0);
  late.database.close();
});

test('bundel: antwoord van de wallet wordt tegen het adres nagekeken; teruglezen met de sleutel uit de salt → published', async () => {
  const ctx = setup();
  const attemptId = play(ctx.daily);
  const { publication } = await bundle(ctx, attemptId);
  const accepted = await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('01', 'hex') });
  assert.deepEqual([accepted.accepted, accepted.publication.status, accepted.publication.receiptTxid], [true, 'receipt', RECEIPT_TXID]);
  assert.equal(ctx.verus.state.verified[0].encryptToAddress, ADDRESS);

  // Nog niets op de chain en de ontvangst-tx onbevestigd: blijft 'receipt'.
  const [waiting] = await ctx.service.reconcile();
  assert.deepEqual([waiting.kind, waiting.after], ['bundle', 'receipt']);
  // Na een ontvangstbewijs komt er geen nieuw verzoek meer (een verzoek kan anders twee keer goedgekeurd worden).
  const again = await bundle(ctx, attemptId);
  assert.deepEqual([again.created, again.publication.status, again.publication.walletUri, ctx.verus.state.created.length], [false, 'receipt', null, 1]);

  // De wallet zette exact onze bundel, verzegeld, in de ID van de speler.
  const recordJson = ctx.verus.state.created[0].recordJson;
  publishOnChain(ctx.verus, sealedRecord(recordJson, ADDRESS));
  const [done] = await ctx.service.reconcile();
  assert.deepEqual([done.after, done.txid, done.height, done.kinds], ['published', UPDATE_TXID, 1010, ['sealed']]);
  assert.equal(ctx.repository.getPlayerPublication(attemptId, 'bundle').status, 'published');
  ctx.database.close();
});

const status = (ctx, attemptId) => ctx.service.getPublishRequest({ principal: PRINCIPAL, attemptId, kind: 'bundle' });

test('bundel: antwoord van de wallet kwam nooit aan, maar de bundel staat op de chain → published (stap 5)', async () => {
  const ctx = setup();
  const attemptId = play(ctx.daily);
  const { publication } = await bundle(ctx, attemptId);
  const recordJson = ctx.verus.state.created[0].recordJson;

  // Nog niets op de chain: blijft wachten, de QR blijft geldig. Binnen 15 s leest de server niet opnieuw.
  assert.equal((await status(ctx, attemptId)).publication.status, 'pending');
  publishOnChain(ctx.verus, sealedRecord(recordJson, ADDRESS));
  assert.equal((await status(ctx, attemptId)).publication.status, 'pending', 'hooguit om de 15 s per publicatie');

  ctx.time.now += 15_000;
  const found = (await status(ctx, attemptId)).publication;
  assert.deepEqual(
    [found.status, found.receiptTxid, found.publishedTxid, found.publishedHeight, found.walletUri],
    ['published', UPDATE_TXID, UPDATE_TXID, 1010, null],
  );
  assert.equal(ctx.verus.state.verified.length, 0, 'zonder wallet-antwoord: de chain is het bewijs');

  // Komt het antwoord daarna toch nog binnen (hier van een tweede goedkeuring, andere txid), dan verandert er niets.
  const late = await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('01', 'hex') });
  assert.deepEqual([late.accepted, late.replayed, late.publication.status, late.publication.publishedTxid], [true, true, 'published', UPDATE_TXID]);
  // En er komt geen nieuw verzoek meer.
  const again = await bundle(ctx, attemptId);
  assert.deepEqual([again.created, again.publication.status, ctx.verus.state.created.length], [false, 'published', 1]);
  ctx.database.close();
});

test('bundel: een verlopen verzoek wordt eerst op de chain nagekeken, ook vóór er een nieuw komt', async () => {
  // Verloopt terwijl de bundel er staat: published, niet expired (ook binnen de 15 s).
  const ctx = setup();
  const attemptId = play(ctx.daily);
  await bundle(ctx, attemptId);
  await status(ctx, attemptId);
  publishOnChain(ctx.verus, sealedRecord(ctx.verus.state.created[0].recordJson, ADDRESS));
  ctx.verus.state.tip = 1061;
  assert.equal((await status(ctx, attemptId)).publication.status, 'published');
  ctx.database.close();

  // Verlopen zonder iets op de chain: expired. Staat de bundel er later toch, dan geen tweede verzoek.
  const gone = setup();
  const second = play(gone.daily);
  await bundle(gone, second);
  gone.verus.state.tip = 1061;
  assert.equal((await status(gone, second)).publication.status, 'expired');
  publishOnChain(gone.verus, sealedRecord(gone.verus.state.created[0].recordJson, ADDRESS), { height: 1055 });
  const again = await bundle(gone, second);
  assert.deepEqual(
    [again.created, again.publication.status, again.publication.publishedHeight, gone.verus.state.created.length, gone.verus.state.signed],
    [false, 'published', 1055, 1, 1],
  );
  gone.database.close();

  // Verlopen en echt niets op de chain: een nieuw verzoek, met een nieuw ontvangstbewijs.
  const fresh = setup();
  const third = play(fresh.daily);
  await bundle(fresh, third);
  fresh.verus.state.tip = 1061;
  const renewed = await bundle(fresh, third);
  assert.deepEqual([renewed.created, renewed.publication.status, fresh.verus.state.created.length], [true, 'pending', 2]);
  fresh.database.close();
});

test('bundel: zonder wallet-antwoord telt alleen een verzegelde waarde met exact ons record; reconcile kijkt ook wachtende bundels na', async () => {
  for (const [name, make] of [
    ['publiek leesbaar', (json) => mobileRecord(json)],
    ['andere inhoud', () => sealedRecord('{"iets":"anders"}', ADDRESS)],
    ['ander adres', (json) => sealedRecord(json, roundKeyFromSalt('cd'.repeat(32)).address)],
  ]) {
    const ctx = setup();
    const attemptId = play(ctx.daily);
    await bundle(ctx, attemptId);
    publishOnChain(ctx.verus, make(ctx.verus.state.created[0].recordJson));
    ctx.time.now += 15_000;
    const seen = (await status(ctx, attemptId)).publication;
    assert.deepEqual([seen.status, Boolean(seen.walletUri)], ['pending', true], name);
    ctx.database.close();
  }

  // Chain niet leesbaar: geen oordeel, de QR blijft staan.
  const down = setup();
  const downAttempt = play(down.daily);
  await bundle(down, downAttempt);
  down.verus.state.chainDown = true;
  down.time.now += 15_000;
  assert.equal((await status(down, downAttempt)).publication.status, 'pending');
  down.database.close();

  // De operator-reconcile vindt een bundel waarvan de speler de app al sloot.
  const ctx = setup();
  const attemptId = play(ctx.daily);
  await bundle(ctx, attemptId);
  assert.deepEqual((await ctx.service.reconcile()).map((r) => [r.kind, r.before, r.after]), [['bundle', 'pending', 'pending']]);
  publishOnChain(ctx.verus, sealedRecord(ctx.verus.state.created[0].recordJson, ADDRESS));
  assert.deepEqual((await ctx.service.reconcile()).map((r) => [r.kind, r.before, r.after]), [['bundle', 'pending', 'published']]);
  assert.deepEqual(await ctx.service.reconcile(), []);
  ctx.database.close();
});

test('app: de ronde toont haar versleuteladres en het klassement het label "sealed" (alleen schema 2)', async () => {
  const ctx = setup();
  assert.equal(ctx.daily.getCurrentRound().commitment.roundEncryptionAddress, ADDRESS);
  const attemptId = play(ctx.daily);
  const sealedOf = () => ctx.daily.getLeaderboard({ roundId: 'round-1' }).entries.map((e) => [e.playerIAddress, e.sealed]);
  assert.deepEqual(sealedOf(), [[PLAYER, false]]);
  await bundle(ctx, attemptId);
  assert.deepEqual(sealedOf(), [[PLAYER, false]], 'een verzoek is nog geen bundel op de chain');
  publishOnChain(ctx.verus, sealedRecord(ctx.verus.state.created[0].recordJson, ADDRESS));
  ctx.time.now += 15_000;
  await status(ctx, attemptId);
  assert.deepEqual(sealedOf(), [[PLAYER, true]]);
  // De reveal komt later dan het teruglezen: het label blijft.
  const reveal = ctx.database.prepare('INSERT INTO round_reveals (round_record_id, definition_json, definition_sha256, commitment_txid, reveal_txid, confirmed_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
  reveal.run('round-1', '{}', 'c'.repeat(64), 'a'.repeat(64), 'f'.repeat(64), ctx.time.now + 1);
  assert.deepEqual(sealedOf(), [[PLAYER, true]]);
  ctx.database.close();

  // Pas ná de reveal teruggelezen: geen label van de server (de chain beslist, zie de onafhankelijke controle).
  const late = setup();
  const lateAttempt = play(late.daily);
  await bundle(late, lateAttempt);
  late.database.prepare('INSERT INTO round_reveals (round_record_id, definition_json, definition_sha256, commitment_txid, reveal_txid, confirmed_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run('round-1', '{}', 'c'.repeat(64), 'a'.repeat(64), 'f'.repeat(64), late.time.now + 1);
  publishOnChain(late.verus, sealedRecord(late.verus.state.created[0].recordJson, ADDRESS));
  late.time.now += 15_000;
  assert.equal((await status(late, lateAttempt)).publication.status, 'published');
  assert.deepEqual(late.daily.getLeaderboard({ roundId: 'round-1' }).entries.map((e) => e.sealed), [false]);
  late.database.close();

  // Een ronde zonder adres (schema 1) houdt haar oude vorm: geen adres, geen veld `sealed`.
  const old = setup({ commitmentSchema: 1 });
  play(old.daily);
  assert.equal('roundEncryptionAddress' in old.daily.getCurrentRound().commitment, false);
  assert.equal(old.daily.getLeaderboard({ roundId: 'round-1' }).entries.some((e) => 'sealed' in e), false);
  old.database.close();
});

test('bundel: publiek leesbaar, andere inhoud of ander adres telt niet → mismatch (nooit stil published)', async () => {
  const cases = [
    ['met de viewing key in de ID (publiek leesbaar)', (json) => mobileRecord(json), 'public'],
    ['verzegeld, maar andere inhoud', () => sealedRecord('{"iets":"anders"}', ADDRESS), 'sealed-other'],
    ['verzegeld naar een ander adres', (json) => sealedRecord(json, roundKeyFromSalt('cd'.repeat(32)).address), 'unreadable'],
  ];
  for (const [name, make, kind] of cases) {
    const ctx = setup();
    const attemptId = play(ctx.daily);
    const { publication } = await bundle(ctx, attemptId);
    await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('01', 'hex') });
    publishOnChain(ctx.verus, make(ctx.verus.state.created[0].recordJson));
    ctx.verus.state.receiptStatus = { confirmations: 2, height: 1010 };
    const [result] = await ctx.service.reconcile();
    assert.deepEqual([result.after, result.kinds], ['mismatch', [kind]], name);
    ctx.database.close();
  }
  // Chain niet leesbaar: geen oordeel, later opnieuw.
  const down = setup();
  const attemptId = play(down.daily);
  const { publication } = await bundle(down, attemptId);
  await down.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('01', 'hex') });
  down.verus.state.chainDown = true;
  const [result] = await down.service.reconcile();
  assert.deepEqual([result.after, result.error], ['receipt', 'CHAIN_UNAVAILABLE']);
  down.database.close();
});
