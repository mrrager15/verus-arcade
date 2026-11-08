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
