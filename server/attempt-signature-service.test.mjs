import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { AttemptSignatureService } from './attempt-signature-service.mjs';
import { DailyService } from './daily-service.mjs';
import { createDailyRouter } from './daily-router.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { parseAttemptMessage, actionsSha256 } from './verus/attempt-message.mjs';
import { verifyInclusionProof } from './result-set.mjs';
import { GENERIC_RESPONSE_QUERY_KEY, VerusRequestError } from './verus/requests.mjs';

const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const OTHER = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PRINCIPAL = Object.freeze({ chain: 'vrsctest', iAddress: PLAYER, friendlyName: 'poc@' });
const ROUND_ID = 'word-grid:1.0.0:2026-10-20';
const TOKEN = 'a'.repeat(43);

/** Nep-VerusRequests: geen chain, geen crypto. Gedrag instelbaar per test. */
function fakeVerus({ tip = 1000 } = {}) {
  const state = {
    tip,
    created: [],
    verify: async ({ body }) => ({ identityId: PLAYER, nativeSignature: body.toString('base64'), signingHeight: state.tip, name: 'poc' }),
  };
  return {
    state,
    async tip() { return state.tip; },
    async createSignRequest(input) {
      state.created.push(input);
      return { requestHex: 'aa'.repeat(40), requestHashHex: 'bb'.repeat(32), walletUri: `verus://x/${input.requestIdHex}`, height: state.tip };
    },
    async verifySignResponse(input) { return state.verify(input); },
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
  const service = new AttemptSignatureService({
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

test('alleen een afgeronde poging van de speler zelf kan getekend worden', async () => {
  const ctx = setup();
  await assert.rejects(ctx.service.createSignRequest({ principal: null, attemptId: 'x' }), (e) => e.httpStatus === 401);
  await assert.rejects(ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId: 'bestaat-niet' }), (e) => e.httpStatus === 404);
  const { attempt } = ctx.daily.reserveAttempt({ principal: PRINCIPAL, roundId: 'round-1' });
  await assert.rejects(ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId: attempt.id }), (e) => e.code === 'ATTEMPT_NOT_COMPLETED');
  ctx.database.close();
});

test('createSignRequest bouwt het bericht uit de echte gokken en is idempotent', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const first = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(first.created, true);
  assert.equal(first.signature.status, 'pending');
  assert.equal(first.signature.expiresHeight, 1060);
  assert.match(first.signature.walletUri, /^verus:\/\//);
  const parsed = parseAttemptMessage(first.signature.message);
  assert.equal(parsed.roundId, ROUND_ID);
  assert.equal(parsed.playerIAddress, PLAYER);
  assert.equal(parsed.actionsSha256, actionsSha256([{ sequence: 1, word: 'slate' }, { sequence: 2, word: 'crane' }]));
  assert.equal(ctx.verus.state.created[0].callbackUrl, `http://127.0.0.1:8100/api/v1/sign-jobs/${first.signature.requestId}/response`);
  assert.equal(ctx.verus.state.created[0].responseMode, 'redirect');

  const second = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(second.created, false);
  assert.equal(second.signature.requestId, first.signature.requestId);
  assert.equal(ctx.verus.state.created.length, 1);
  ctx.database.close();
});

test('een verlopen verzoek wordt vervangen door een nieuw', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const first = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  ctx.verus.state.tip = 1061;
  const status = await ctx.service.getSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(status.signature.status, 'expired');
  assert.equal(status.signature.walletUri, null);
  const again = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(again.created, true);
  assert.notEqual(again.signature.requestId, first.signature.requestId);
  assert.equal(again.signature.expiresHeight, 1121);
  ctx.database.close();
});

test('acceptResponse verifieert, slaat op, en is idempotent', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const { signature } = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: 'f'.repeat(40), body: Buffer.from('x') }), (e) => e.httpStatus === 404);
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.alloc(0) }), (e) => e.code === 'INVALID_CALLBACK');

  const body = Buffer.from('wallet-bytes');
  const accepted = await ctx.service.acceptResponse({ requestIdHex: signature.requestId, body });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.signature.status, 'signed');
  assert.equal(accepted.signature.signer, PLAYER);
  assert.equal(accepted.signature.signingHeight, 1000);

  const replay = await ctx.service.acceptResponse({ requestIdHex: signature.requestId, body });
  assert.equal(replay.replayed, true);

  // een andere handtekening op hetzelfde verzoek is een conflict
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('other-bytes') }), (e) => e.code === 'ATTEMPT_SIGNATURE_CONFLICT');

  const status = await ctx.service.getSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(status.signature.status, 'signed');
  assert.equal(status.signature.walletUri, null);
  // een getekende poging krijgt geen nieuw verzoek meer
  const again = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  assert.equal(again.created, false);
  assert.equal(again.signature.status, 'signed');
  ctx.database.close();
});

test('acceptResponse vertaalt verificatiefouten en bewaakt het hoogtevenster', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const { signature } = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  ctx.verus.state.verify = async () => { throw new VerusRequestError('INVALID_SIGNATURE', 'nee'); };
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') }), (e) => e.code === 'INVALID_SIGNATURE' && e.httpStatus === 422);
  ctx.verus.state.verify = async () => { throw new VerusRequestError('CHAIN_UNAVAILABLE', 'rpc'); };
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') }), (e) => e.httpStatus === 503);
  ctx.verus.state.verify = async () => ({ identityId: PLAYER, nativeSignature: 'sig', signingHeight: 999, name: 'poc' });
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') }), (e) => e.code === 'SIGN_REQUEST_EXPIRED');
  ctx.verus.state.verify = async () => ({ identityId: PLAYER, nativeSignature: 'sig', signingHeight: 1061, name: 'poc' });
  await assert.rejects(ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') }), (e) => e.code === 'SIGN_REQUEST_EXPIRED');
  // verwachte speler wordt aan de verifier doorgegeven
  let seen;
  ctx.verus.state.verify = async (input) => { seen = input.expectedSigner; return { identityId: PLAYER, nativeSignature: 'sig', signingHeight: 1000, name: 'poc' }; };
  await ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') });
  assert.equal(seen, PLAYER);
  ctx.database.close();
});

test('router: callbacks zonder sessie (POST octet-stream en GET redirect), sign-request met sessie', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const app = express();
  app.use('/api/v1', createDailyRouter({
    dailyService: ctx.daily,
    attemptSignatureService: ctx.service,
    resolveSession: (token) => (token === TOKEN ? { user: PRINCIPAL, expiresAt: 10_000 } : null),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const unauth = await fetch(`${base}/attempts/${attemptId}/sign-request`, { method: 'POST' });
    assert.equal(unauth.status, 401);
    const created = await fetch(`${base}/attempts/${attemptId}/sign-request`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(created.status, 201);
    const { signature } = await created.json();
    const again = await fetch(`${base}/attempts/${attemptId}/sign-request`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(again.status, 200);

    // GET redirect met ongeldige encoding → terug naar de app met een foutcode, nooit 500
    const bad = await fetch(`${base}/sign-jobs/${signature.requestId}/response?${GENERIC_RESPONSE_QUERY_KEY}=%%%`, { redirect: 'manual' });
    assert.equal(bad.status, 303);
    assert.match(bad.headers.get('location'), /returnError=INVALID_CALLBACK/);

    // GET redirect met geldig base64url
    const encoded = Buffer.from('wallet-bytes').toString('base64url');
    const ok = await fetch(`${base}/sign-jobs/${signature.requestId}/response?${GENERIC_RESPONSE_QUERY_KEY}=${encoded}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), new RegExp(`^/\\?walletReturn=${signature.requestId}&signed=1$`));
    assert.equal(ok.headers.get('cache-control'), 'no-store');

    // POST met hetzelfde antwoord: idempotent
    const post = await fetch(`${base}/sign-jobs/${signature.requestId}/response`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('wallet-bytes') });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { accepted: true, replayed: true, status: 'signed' });

    // POST zonder binair lichaam
    const empty = await fetch(`${base}/sign-jobs/${signature.requestId}/response`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(empty.status, 415);

    const status = await fetch(`${base}/attempts/${attemptId}/sign-request`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal((await status.json()).signature.status, 'signed');
  } finally {
    server.close();
    await once(server, 'close');
    ctx.database.close();
  }
});

test('een getekende poging krijgt zijn handtekening in het resultaatrecord (schema 2) en het bewijs verifieert', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const { signature } = await ctx.service.createSignRequest({ principal: PRINCIPAL, attemptId });
  const native = Buffer.alloc(73, 1).toString('base64');
  ctx.verus.state.verify = async () => ({ identityId: PLAYER, nativeSignature: native, signingHeight: 1000, name: 'poc' });
  await ctx.service.acceptResponse({ requestIdHex: signature.requestId, body: Buffer.from('x') });

  ctx.repository.finalizeRoundResults({ roundRecordId: 'round-1', now: 10_000 });
  const proof = ctx.repository.getResultProof({ roundRecordId: 'round-1', playerIAddress: PLAYER });
  assert.equal(proof.record.schemaVersion, 2);
  assert.deepEqual(proof.record.playerSignature, { height: 1000, signature: native });
  assert.deepEqual(proof.record.guesses, [{ sequence: 1, word: 'slate' }, { sequence: 2, word: 'crane' }]);
  assert.equal(verifyInclusionProof(proof), true);
  // het bericht dat getekend werd, is reconstrueerbaar uit het record alleen
  assert.equal(actionsSha256(proof.record.guesses), parseAttemptMessage(signature.message).actionsSha256);
  ctx.database.close();
});

test('een ongetekende poging krijgt playerSignature null in schema 2', async () => {
  const ctx = setup();
  completeAttempt(ctx.daily);
  ctx.repository.finalizeRoundResults({ roundRecordId: 'round-1', now: 10_000 });
  const proof = ctx.repository.getResultProof({ roundRecordId: 'round-1', playerIAddress: PLAYER });
  assert.equal(proof.record.schemaVersion, 2);
  assert.equal(proof.record.playerSignature, null);
  assert.equal(verifyInclusionProof(proof), true);
  ctx.database.close();
});

test('router: walletReturnPath met eigen query wordt met & aangevuld', async () => {
  const ctx = setup();
  const attemptId = completeAttempt(ctx.daily);
  const app = express();
  app.use('/api/v1', createDailyRouter({
    dailyService: ctx.daily,
    attemptSignatureService: ctx.service,
    resolveSession: (token) => (token === TOKEN ? { user: PRINCIPAL, expiresAt: 10_000 } : null),
    walletReturnPath: '/verus/wallet-return?kind=sign',
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const created = await fetch(`${base}/attempts/${attemptId}/sign-request`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    const { signature } = await created.json();
    const encoded = Buffer.from('wallet-bytes').toString('base64url');
    const ok = await fetch(`${base}/sign-jobs/${signature.requestId}/response?${GENERIC_RESPONSE_QUERY_KEY}=${encoded}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), `/verus/wallet-return?kind=sign&walletReturn=${signature.requestId}&signed=1`);
  } finally {
    server.close();
    ctx.database.close();
  }
});
