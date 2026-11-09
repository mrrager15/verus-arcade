import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { DailyService } from './daily-service.mjs';
import { createDailyRouter } from './daily-router.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { PlayerPublicationService } from './player-publication-service.mjs';
import { validatePlayerResultRecord } from './verus/player-result.mjs';
import { P } from './verus/requests.mjs';
import { GENERIC_RESPONSE_QUERY_KEY, VerusRequestError } from './verus/requests.mjs';

const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PRINCIPAL = Object.freeze({ chain: 'vrsctest', iAddress: PLAYER, friendlyName: 'poc@' });
const ROUND_ID = 'word-grid:1.0.0:2026-10-20';
const RESULTS_TXID = 'c'.repeat(64);
const RECEIPT_TXID = 'd'.repeat(64);
const TOKEN = 'a'.repeat(43);

/** Nep-VerusRequests: geen chain, geen crypto. Gedrag instelbaar per test. */
function fakeVerus({ tip = 1000 } = {}) {
  const state = {
    tip,
    created: [],
    serviceFqn: 'Arcade.VRSCTEST@',
    playerActive: true,
    verify: async () => ({ identityId: PLAYER, txid: RECEIPT_TXID, signingHeight: state.tip, expiryHeight: state.tip + 60 }),
  };
  return {
    state,
    serviceId: ARCADE,
    async tip() { return state.tip; },
    async serviceState() { return { height: state.tip, state: { current: { fullyqualifiedname: state.serviceFqn } } }; },
    async loadIdentity({ identityId }) {
      return { currentActive: state.playerActive, current: { identity: { name: 'arcade-storage-poc', parent: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', identityaddress: identityId } } };
    },
    async createPlayerResultRequest(input) {
      state.created.push(input);
      return { requestHex: 'aa'.repeat(40), requestHashHex: 'bb'.repeat(32), walletUri: `verus://x/${input.requestIdHex}`, height: state.tip, expiryHeight: state.tip + input.ttlBlocks };
    },
    async verifyPlayerResultResponse(input) { return state.verify(input); },
    async identityContentName() { return state.contentFqn ?? 'arcade-storage-poc.VRSCTEST@'; },
    async readIdentityContent({ identityId, keyId }) {
      if (state.chainDown) throw new VerusRequestError('CHAIN_UNAVAILABLE', 'rpc');
      const values = state.chainValues?.(keyId) ?? [];
      return {
        tip: state.tip,
        content: { identity: { identityaddress: identityId, contentmultimap: values.length ? { [keyId]: values } : {} } },
        history: state.chainHistory?.(keyId) ?? [],
      };
    },
    async transactionStatus() { return state.receiptStatus ?? null; },
    async decryptDataDescriptor({ descriptor, txid }) { return state.decrypt ? state.decrypt(descriptor, txid) : null; },
  };
}

function setup({ tip = 1000, now = 5_000 } = {}) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const daily = new DailyService({ repository, clock: () => now, createId: () => 'attempt-1' });
  repository.createRound({
    id: 'round-1', chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', roundId: ROUND_ID,
    commitmentHash: 'h', privateDefinition: { answer: 'crane', salt: 's' }, opensAt: 1_000, closesAt: 10_000, now: 500,
  });
  repository.openRound({ id: 'round-1', commitmentTxid: 'a'.repeat(64) });
  const verus = fakeVerus({ tip });
  let counter = 0;
  const service = new PlayerPublicationService({
    repository, verusRequests: verus, origin: 'http://127.0.0.1:8100/', responseMode: 'redirect', ttlBlocks: 60,
    clock: () => now, createRequestIdHex: () => (++counter).toString(16).padStart(40, '0'),
  });
  return { database, repository, daily, verus, service };
}

function completeAttempt(daily, words = ['slate', 'crane']) {
  const { attempt } = daily.reserveAttempt({ principal: PRINCIPAL, roundId: 'round-1' });
  words.forEach((word, i) => daily.submitAction({
    principal: PRINCIPAL, attemptId: attempt.id,
    action: { type: 'guess', actionId: `action-${i + 1}xxxx`, sequence: i + 1, gameVersion: '1.0.0', payload: { word } },
  }));
  return attempt.id;
}

/** Ronde afsluiten en result-root als bevestigd markeren (wat de operator normaal doet). */
function finalizeAndConfirm(repository, { confirm = true } = {}) {
  repository.finalizeRoundResults({ roundRecordId: 'round-1', now: 20_000 });
  if (confirm) repository.confirmRoundResults({ roundRecordId: 'round-1', resultsTxid: RESULTS_TXID });
}

test('publiceren kan pas als de result-root van de ronde bevestigd is', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  await assert.rejects(ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }), (e) => e.code === 'RESULT_ROOT_UNPUBLISHED' && e.httpStatus === 409);
  finalizeAndConfirm(ctx.repository, { confirm: false });
  await assert.rejects(ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }), (e) => e.code === 'RESULT_ROOT_UNPUBLISHED');
  ctx.repository.confirmRoundResults({ roundRecordId: 'round-1', resultsTxid: RESULTS_TXID });
  const created = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(created.created, true);
  assert.equal(created.publication.status, 'pending');
  ctx.database.close();
});

test('createPublishRequest bouwt record, key en alleen-content request voor de speler; idempotent', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const first = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  const pub = first.publication;
  assert.doesNotThrow(() => validatePlayerResultRecord(pub.record));
  assert.equal(pub.record.player, PLAYER);
  assert.equal(pub.record.round, ROUND_ID);
  assert.equal(pub.record.resultRootTxid, RESULTS_TXID);
  assert.equal(pub.record.guesses, 2);
  assert.equal(pub.contentKeyName, `Arcade.VRSCTEST.::arcade.player.result.${ROUND_ID}`);
  assert.match(pub.contentKey, /^i[1-9A-HJ-NP-Za-km-z]{20,40}$/);
  assert.equal(pub.walletUri, `verus://x/${'1'.padStart(40, '0')}`);
  assert.equal(pub.expiresHeight, 1060);
  const sent = ctx.verus.state.created[0];
  assert.equal(sent.playerId, PLAYER);
  assert.equal(sent.playerName, 'arcade-storage-poc');
  assert.equal(sent.keyId, pub.contentKey);
  assert.equal(sent.callbackUrl, `http://127.0.0.1:8100/api/v1/publish-jobs/${pub.requestId}/response`);
  assert.equal(sent.responseMode, 'redirect');
  JSON.parse(sent.recordJson);
  // Nogmaals: hetzelfde verzoek, geen nieuw request richting de wallet.
  const again = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(again.created, false);
  assert.equal(again.publication.requestId, pub.requestId);
  assert.equal(ctx.verus.state.created.length, 1);
  ctx.database.close();
});

test('verlopen verzoek wordt vervangen; inactieve spelersidentiteit en ontbrekende service-naam worden geweigerd', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const first = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  ctx.verus.state.tip = 1061;
  const status = await ctx.service.getPublishRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(status.publication.status, 'expired');
  const second = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(second.created, true);
  assert.notEqual(second.publication.requestId, first.publication.requestId);

  ctx.verus.state.tip = 1200;
  ctx.verus.state.playerActive = false;
  await assert.rejects(ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }), (e) => e.code === 'PLAYER_IDENTITY_UNAVAILABLE');
  ctx.verus.state.playerActive = true;
  ctx.verus.state.serviceFqn = undefined;
  await assert.rejects(ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }), (e) => e.code === 'SERVICE_UNAVAILABLE' && e.httpStatus === 503);
  ctx.database.close();
});

test('acceptResponse: ontvangstbewijs, idempotent, en fouten worden vertaald', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const { publication } = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: 'zz', body: Buffer.from('x') }), (e) => e.httpStatus === 404);
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.alloc(0) }), (e) => e.code === 'INVALID_CALLBACK');

  const accepted = await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('wallet') });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.publication.status, 'receipt');
  assert.equal(accepted.publication.receiptTxid, RECEIPT_TXID);
  assert.equal(accepted.publication.walletUri, null, 'na ontvangst geen QR meer');
  // De verifier kreeg speler, key en record mee om het antwoord aan te binden.
  const seen = await new Promise((resolve) => { ctx.verus.state.verify = async (input) => { resolve(input); return { identityId: PLAYER, txid: RECEIPT_TXID, signingHeight: 1000, expiryHeight: 1060 }; }; ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('wallet') }); });
  assert.equal(seen.playerId, PLAYER);
  assert.equal(seen.keyId, publication.contentKey);
  JSON.parse(seen.recordJson);
  const replay = await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('wallet') });
  assert.equal(replay.replayed, true);

  // Een ander antwoord (andere txid) op hetzelfde verzoek: conflict.
  ctx.verus.state.verify = async () => ({ identityId: PLAYER, txid: 'e'.repeat(64), signingHeight: 1000, expiryHeight: 1060 });
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('other') }), (e) => e.code === 'PLAYER_PUBLICATION_CONFLICT' && e.httpStatus === 409);
  // Verificatiefouten: 422 / 503 / SIGNER_MISMATCH.
  const ctx2 = setup();
  const attempt2 = completeAttempt(ctx2.daily);
  finalizeAndConfirm(ctx2.repository);
  const pub2 = (await ctx2.service.createPublishRequest({ principal: PRINCIPAL, attemptId: attempt2 })).publication;
  ctx2.verus.state.verify = async () => { throw new VerusRequestError('SIGNER_MISMATCH', 'nee'); };
  await assert.rejects(ctx2.service.acceptResponse({ requestIdHex: pub2.requestId, body: Buffer.from('x') }), (e) => e.code === 'SIGNER_MISMATCH' && e.httpStatus === 422);
  ctx2.verus.state.verify = async () => { throw new VerusRequestError('CHAIN_UNAVAILABLE', 'rpc'); };
  await assert.rejects(ctx2.service.acceptResponse({ requestIdHex: pub2.requestId, body: Buffer.from('x') }), (e) => e.httpStatus === 503);
  // Na ontvangst blijft de status 'receipt' tot de reconcile de chain heeft gelezen.
  assert.equal((await ctx.service.getPublishRequest({ principal: PRINCIPAL, attemptId })).publication.status, 'receipt');
  ctx.database.close();
  ctx2.database.close();
});

test('router: publish-request met sessie, callbacks zonder sessie (POST en GET-redirect)', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const app = express();
  app.use('/api/v1', createDailyRouter({
    dailyService: ctx.daily,
    playerPublicationService: ctx.service,
    resolveSession: (token) => (token === TOKEN ? { user: PRINCIPAL, expiresAt: 10_000 } : null),
    walletReturnPath: '/verus/wallet-return',
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    assert.equal((await fetch(`${base}/attempts/${attemptId}/publish-request`, { method: 'POST' })).status, 401);
    const created = await fetch(`${base}/attempts/${attemptId}/publish-request`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(created.status, 201);
    const { publication } = await created.json();
    const status = await fetch(`${base}/attempts/${attemptId}/publish-request`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal((await status.json()).publication.status, 'pending');

    const bad = await fetch(`${base}/publish-jobs/${publication.requestId}/response?${GENERIC_RESPONSE_QUERY_KEY}=%%%`, { redirect: 'manual' });
    assert.equal(bad.status, 303);
    assert.match(bad.headers.get('location'), /kind=publish&returnError=INVALID_CALLBACK/);

    const encoded = Buffer.from('wallet-bytes').toString('base64url');
    const ok = await fetch(`${base}/publish-jobs/${publication.requestId}/response?${GENERIC_RESPONSE_QUERY_KEY}=${encoded}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), `/verus/wallet-return?walletReturn=${publication.requestId}&kind=publish&signed=1`);

    const post = await fetch(`${base}/publish-jobs/${publication.requestId}/response`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('wallet-bytes') });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { accepted: true, replayed: true, status: 'receipt' });
  } finally {
    server.close();
    ctx.database.close();
  }
});

function chainValueFor(json) {
  const descriptor = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(0), objectdata: Buffer.from(json, 'utf8') });
  return new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: descriptor }] }).toBuffer().toString('hex');
}

test('reconcile: published bij gelijke hash, mismatch bij bevestigde tx zonder record, anders wachten', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const { publication } = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('wallet') });

  // 1. Nog niets op de chain en ontvangst-tx onbevestigd → blijft 'receipt'.
  ctx.verus.state.receiptStatus = { confirmations: 0, height: null };
  let [r] = await ctx.service.reconcile();
  assert.equal(r.after, 'receipt');
  assert.equal(r.valueCount, 0);

  // 2. Record staat op de chain, gekoppeld aan tx en hoogte via de geschiedenis → 'published'.
  const stored = ctx.repository.getPlayerPublication(attemptId);
  const hex = chainValueFor(stored.recordJson);
  ctx.verus.state.chainValues = () => [hex];
  ctx.verus.state.chainHistory = (keyId) => [{ height: 1003, output: { txid: RECEIPT_TXID }, identity: { contentmultimap: { [keyId]: [hex] } } }];
  [r] = await ctx.service.reconcile();
  assert.equal(r.after, 'published');
  assert.equal(r.txid, RECEIPT_TXID);
  assert.equal(r.height, 1003);
  assert.equal(ctx.repository.getPlayerPublication(attemptId).status, 'published');
  assert.deepEqual(await ctx.service.reconcile(), [], 'niets meer te doen');

  // 3. Andere poging: tx bevestigd maar een ánder record onder de key → 'mismatch'.
  const ctx2 = setup();
  const attempt2 = completeAttempt(ctx2.daily);
  finalizeAndConfirm(ctx2.repository);
  const pub2 = (await ctx2.service.createPublishRequest({ principal: PRINCIPAL, attemptId: attempt2 })).publication;
  await ctx2.service.acceptResponse({ requestIdHex: pub2.requestId, body: Buffer.from('wallet') });
  ctx2.verus.state.chainValues = () => [chainValueFor('{"vervalst":true}')];
  ctx2.verus.state.receiptStatus = { confirmations: 2, height: 1004 };
  [r] = await ctx2.service.reconcile();
  assert.equal(r.after, 'mismatch');
  assert.equal(ctx2.repository.getPlayerPublication(attempt2).status, 'mismatch');
  // Na mismatch mag de speler opnieuw (nieuw verzoek), nooit stil overschreven.
  assert.equal((await ctx2.service.createPublishRequest({ principal: PRINCIPAL, attemptId: attempt2 })).created, true);

  // 4. Chain onbereikbaar: gemeld, status ongewijzigd.
  const ctx3 = setup();
  const attempt3 = completeAttempt(ctx3.daily);
  finalizeAndConfirm(ctx3.repository);
  const pub3 = (await ctx3.service.createPublishRequest({ principal: PRINCIPAL, attemptId: attempt3 })).publication;
  await ctx3.service.acceptResponse({ requestIdHex: pub3.requestId, body: Buffer.from('wallet') });
  ctx3.verus.state.chainDown = true;
  [r] = await ctx3.service.reconcile();
  assert.equal(r.error, 'CHAIN_UNAVAILABLE');
  assert.equal(ctx3.repository.getPlayerPublication(attempt3).status, 'receipt');
  ctx.database.close(); ctx2.database.close(); ctx3.database.close();
});

test('sub-ID die Verus Mobile verkeerd oplost: duidelijke fout in plaats van een QR die faalt', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  // Zoals de VRSCTEST-daemon het teruggeeft voor een sub-ID: zonder .VRSCTEST → mainnet-adres in Mobile.
  ctx.verus.state.contentFqn = 'arcade-storage-poc@';
  await assert.rejects(
    ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId }),
    (e) => e.code === 'WALLET_UNSUPPORTED_IDENTITY' && e.httpStatus === 409 && /name\.VRSCTEST@/.test(e.message),
  );
  assert.equal(ctx.verus.state.created.length, 0, 'geen verzoek naar de wallet');
  ctx.verus.state.contentFqn = 'arcade-storage-poc.VRSCTEST@';
  assert.equal((await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId })).created, true);
  ctx.database.close();
});

test('reconcile leest de versleutelde verwijzing van Verus Mobile terug via het ontvangstbewijs', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  finalizeAndConfirm(ctx.repository);
  const { publication } = await ctx.service.createPublishRequest({ principal: PRINCIPAL, attemptId });
  await ctx.service.acceptResponse({ requestIdHex: publication.requestId, body: Buffer.from('wallet') });
  const stored = ctx.repository.getPlayerPublication(attemptId);
  const value = { [P.DataDescriptorKey.vdxfid]: { version: 1, flags: 13, objectdata: 'aa', epk: '8a'.repeat(32), ivk: '0d'.repeat(32) } };
  ctx.verus.state.chainValues = () => [value];
  ctx.verus.state.chainHistory = (keyId) => [{ height: 1003, output: { txid: RECEIPT_TXID }, identity: { contentmultimap: { [keyId]: [value] } } }];
  ctx.verus.state.decrypt = (_descriptor, txid) => (txid === RECEIPT_TXID
    ? [{ version: 1, flags: 2, objectdata: Buffer.from(stored.recordJson, 'utf8').toString('hex'), salt: '58'.repeat(32) }]
    : null);
  const [r] = await ctx.service.reconcile();
  assert.equal(r.after, 'published');
  assert.deepEqual(r.kinds, ['encrypted-ref']);
  assert.equal(r.height, 1003);
  ctx.database.close();
});
