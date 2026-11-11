import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { discloseAttestation, expandSealedRecord, readAttestationDisclosure } from './attestation.mjs';
import { AttestationService, createRoundAttestations, sealedAttestationRecord } from './attestation-service.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { P } from './verus/requests.mjs';
import { DailyService } from './daily-service.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';

const A = 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g';
const B = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const SERVICE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-08T00:00:00Z');
const roundId = (n) => `word-grid:1.0.0:2026-11-${String(8 + n).padStart(2, '0')}`;
const principal = (iAddress) => ({ chain: 'vrsctest', iAddress, friendlyName: `${iAddress.slice(0, 4)}@` });

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const calls = [];
  const signer = {
    serviceId: SERVICE,
    async signMmrRoot(root) {
      calls.push(root);
      return { signaturedata: { version: 1, systemid: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', hashtype: 5, signaturehash: root, identityid: SERVICE, signaturetype: 1, signature: 'sig' }, signatureheight: 1000 + calls.length };
    },
  };
  return { database, repository, signer, calls };
}

/** Ronde n (0 = 8 nov) aanmaken en openen. */
function round(repository, n) {
  const id = `round-${n}`;
  repository.createRound({
    id, chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', roundId: roundId(n),
    commitmentHash: `h${n}`, privateDefinition: { answer: 'crane', salt: `s${n}` }, opensAt: T0 + n * DAY, closesAt: T0 + (n + 1) * DAY, now: T0 + n * DAY - 1,
  });
  repository.openRound({ id, commitmentTxid: String(n).repeat(64).slice(0, 64) });
  return id;
}

let seq = 0;
/** Speler speelt ronde n uit (opgelost), optioneel getekend. */
function play(repository, n, player, { sign = true } = {}) {
  const daily = new DailyService({ repository, clock: () => T0 + n * DAY + 1000, createId: () => `attempt-${n}-${player.slice(0, 6)}` });
  const { attempt } = daily.reserveAttempt({ principal: principal(player), roundId: `round-${n}` });
  ['slate', 'crane'].forEach((word, i) => daily.submitAction({
    principal: principal(player), attemptId: attempt.id,
    action: { type: 'guess', actionId: `action-${++seq}xxxxxxxx`, sequence: i + 1, gameVersion: '1.0.0', payload: { word } },
  }));
  if (sign) {
    repository.createAttemptSignature({
      attemptId: attempt.id, requestIdHex: String(seq).padStart(40, '0'), requestHex: 'aa', requestHashHex: 'bb'.repeat(32),
      message: 'm', walletUri: 'verus://x', responseMode: 'redirect', createdHeight: 1, expiresHeight: 61, now: T0 + n * DAY + 2000,
    });
    repository.markAttemptSignatureSigned({ attemptId: attempt.id, signerIAddress: player, signingHeight: 2, nativeSignature: Buffer.alloc(73, n + 1).toString('base64'), now: T0 + n * DAY + 3000 });
  }
  return attempt.id;
}

function close(repository, n, { confirm = true } = {}) {
  repository.finalizeRoundResults({ roundRecordId: `round-${n}`, now: T0 + (n + 1) * DAY });
  if (confirm) repository.confirmRoundResults({ roundRecordId: `round-${n}`, resultsTxid: String.fromCharCode(97 + n).repeat(64) });
}

test('attestaties: pas na bevestigde result-root; alleen getekende pogingen; idempotent', async () => {
  const { repository, signer, calls, database } = setup();
  round(repository, 0);
  play(repository, 0, A);
  play(repository, 0, B, { sign: false });
  await assert.rejects(createRoundAttestations({ repository, signer, roundRecordId: 'round-0', now: T0 + 1000 }), (e) => e.code === 'ROUND_NOT_CLOSED');
  close(repository, 0, { confirm: false });
  await assert.rejects(createRoundAttestations({ repository, signer, roundRecordId: 'round-0', now: T0 + DAY }), (e) => e.code === 'RESULT_ROOT_UNPUBLISHED');
  repository.confirmRoundResults({ roundRecordId: 'round-0', resultsTxid: 'a'.repeat(64) });
  const first = await createRoundAttestations({ repository, signer, roundRecordId: 'round-0', now: T0 + DAY });
  assert.deepEqual(first.created.map((c) => [c.player, c.streak, c.rounds, c.solved, c.prevRoot]), [[A, 1, 1, 1, null]]);
  assert.equal(calls.length, 1);
  const again = await createRoundAttestations({ repository, signer, roundRecordId: 'round-0', now: T0 + DAY });
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.skipped.map((s) => s.reason), ['exists']);
  assert.equal(calls.length, 1);
  database.close();
});

test('attestaties: keten over rondes, gemiste ronde breekt de streak, volgorde verplicht', async () => {
  const { repository, signer, database } = setup();
  for (const n of [0, 1, 2, 3]) round(repository, n);
  play(repository, 0, A); close(repository, 0);
  play(repository, 1, A); close(repository, 1);
  close(repository, 2); // A mist ronde 2 (lege ronde)
  play(repository, 3, A); close(repository, 3);
  // ronde 1 vóór ronde 0: geweigerd
  await assert.rejects(createRoundAttestations({ repository, signer, roundRecordId: 'round-1', now: T0 + 5 * DAY }), (e) => e.code === 'ATTESTATION_GAP');
  const r0 = (await createRoundAttestations({ repository, signer, roundRecordId: 'round-0', now: T0 + 5 * DAY })).created[0];
  const r1 = (await createRoundAttestations({ repository, signer, roundRecordId: 'round-1', now: T0 + 5 * DAY })).created[0];
  assert.deepEqual([r1.streak, r1.rounds, r1.solved, r1.prevRoot], [2, 2, 2, r0.root]);
  const r2 = await createRoundAttestations({ repository, signer, roundRecordId: 'round-2', now: T0 + 5 * DAY });
  assert.deepEqual(r2.created, []);
  const r3 = (await createRoundAttestations({ repository, signer, roundRecordId: 'round-3', now: T0 + 5 * DAY })).created[0];
  assert.deepEqual([r3.streak, r3.rounds, r3.solved, r3.prevRoot], [1, 3, 3, r1.root]);
  // de opgeslagen descriptor levert een geldige openbaarmaking met de juiste waarden
  const stored = repository.getAttestation({ playerIAddress: A, roundRecordId: 'round-1' });
  const shown = readAttestationDisclosure(discloseAttestation(stored, ['streak', 'prev']));
  assert.deepEqual(shown.fields, { player: A, round: roundId(1), streak: '2', prev: r0.root });
  // verzegeld en compact: geen waarden of zouten; uitgepakt = wortel en handtekening van de attestatie
  const sealed = sealedAttestationRecord(stored, repository.getRound('round-1'));
  assert.deepEqual(Object.keys(sealed), ['schema', 'version', 'round', 'leaves', 'signature', 'height']);
  assert.equal(sealed.round, roundId(1));
  assert.doesNotMatch(JSON.stringify(sealed), /salt|streak/);
  assert.ok(Buffer.byteLength(JSON.stringify(sealed)) < 600);
  const expanded = expandSealedRecord(sealed, { serviceId: SERVICE, systemId: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq' });
  assert.equal(expanded.mmrdescriptor.mmrroot.objectdata, stored.root);
  assert.deepEqual(expanded.mmrdescriptor.mmrhashes, stored.descriptor.mmrhashes);
  assert.deepEqual(expanded.signaturedata, stored.signaturedata);
  assert.equal(expanded.signatureheight, stored.signatureHeight);
  // openbaarmaking = uitgepakte publieke vorm + de getoonde velden uit de privé-descriptor
  const fromChain = { ...expanded.mmrdescriptor, datadescriptors: discloseAttestation(stored, ['streak']).datadescriptors };
  assert.deepEqual(readAttestationDisclosure(fromChain).fields, { player: A, round: roundId(1), streak: '2' });
  // knoeien met de bladeren breekt de wortel
  const tampered = { ...sealed, leaves: Buffer.from(Buffer.from(sealed.leaves, 'base64').map((b, i) => (i === 70 ? b ^ 1 : b))).toString('base64') };
  assert.notEqual(expandSealedRecord(tampered, { serviceId: SERVICE, systemId: 'x' }).mmrdescriptor.mmrroot.objectdata, stored.root);
  assert.throws(() => expandSealedRecord({ ...sealed, leaves: sealed.leaves.slice(4) }, { serviceId: SERVICE, systemId: 'x' }), /Invalid leaves/);
  database.close();
});

test('attestaties: een handtekening over iets anders wordt geweigerd en niets opgeslagen', async () => {
  const { repository, database } = setup();
  round(repository, 0); play(repository, 0, A); close(repository, 0);
  const bad = { serviceId: SERVICE, async signMmrRoot() { return { signaturedata: { signaturehash: 'f'.repeat(64), identityid: SERVICE }, signatureheight: 1 }; } };
  await assert.rejects(createRoundAttestations({ repository, signer: bad, roundRecordId: 'round-0', now: T0 + DAY }), (e) => e.code === 'SIGNATURE_MISMATCH');
  assert.deepEqual(repository.listRoundAttestations('round-0'), []);
  database.close();
});

function chainValueFor(json) {
  const descriptor = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(0), objectdata: Buffer.from(json, 'utf8') });
  return new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: descriptor }] }).toBuffer().toString('hex');
}

async function attestedSetup() {
  const ctx = setup();
  round(ctx.repository, 0); play(ctx.repository, 0, A); close(ctx.repository, 0);
  await createRoundAttestations({ repository: ctx.repository, signer: ctx.signer, roundRecordId: 'round-0', now: T0 + DAY });
  const chain = { values: [], signatureOk: true };
  const verus = {
    serviceId: SERVICE,
    async verifyMmrRootSignature({ signaturedata, signatureheight }) {
      if (!chain.signatureOk) throw Object.assign(new Error('Invalid signature.'), { code: 'INVALID_SIGNATURE' });
      return { valid: true, identityId: signaturedata.identityid, signatureHeight: signatureheight };
    },
    async serviceState() { return { state: { current: { fullyqualifiedname: 'Arcade.VRSCTEST@' } } }; },
    async readIdentityContent({ identityId, keyId }) {
      chain.lastKey = keyId;
      return { content: { identity: { identityaddress: identityId, contentmultimap: chain.values.length ? { [keyId]: chain.values } : {} } }, history: [] };
    },
    async decryptDataDescriptor() { return null; },
  };
  const service = new AttestationService({ repository: ctx.repository, verusRequests: verus });
  return { ...ctx, chain, service };
}

test('attestaties in de app: eigen lijst, deellink met gekozen velden, controle', async () => {
  const { service, chain, repository, database } = await attestedSetup();
  const me = { chain: 'vrsctest', iAddress: A };
  const list = service.listOwn({ principal: me });
  assert.deepEqual(list.attestations.map((a) => [a.round, a.streak]), [[roundId(0), 1]]);
  assert.throws(() => service.listOwn({ principal: null }), (e) => e.code === 'NOT_AUTHENTICATED');
  assert.throws(() => service.disclosure({ principal: { chain: 'vrsctest', iAddress: B }, roundRecordId: 'round-0', fields: ['streak'] }), (e) => e.code === 'ATTESTATION_NOT_FOUND');
  assert.throws(() => service.disclosure({ principal: me, roundRecordId: 'round-0', fields: ['rating'] }), (e) => e.code === 'INVALID_DISCLOSURE');

  const { link, fields } = service.disclosure({ principal: me, roundRecordId: 'round-0', fields: ['streak'] });
  assert.deepEqual(fields, ['player', 'round', 'streak']);
  assert.ok(link.length < 1500, `link ${link.length}`);
  const notOnChain = await service.verify({ link });
  assert.equal(notOnChain.valid, true);
  assert.deepEqual([notOnChain.player, notOnChain.round, notOnChain.fields], [A, roundId(0), { streak: '1' }]);
  assert.equal(notOnChain.inPlayerIdentity.found, false);

  // zodra precies dit verzegelde record in de ID van de speler staat
  const record = sealedAttestationRecord(repository.getAttestation({ playerIAddress: A, roundRecordId: 'round-0' }), repository.getRound('round-0'));
  chain.values = [chainValueFor(canonicalJson(record))];
  assert.equal((await service.verify({ link })).inPlayerIdentity.found, true);

  // foute handtekening → ongeldig, maar de rest wordt nog getoond
  chain.signatureOk = false;
  const bad = await service.verify({ link });
  assert.deepEqual([bad.valid, bad.signature.error], [false, 'INVALID_SIGNATURE']);
  chain.signatureOk = true;

  // geknoeide links
  const payload = JSON.parse(Buffer.from(link, 'base64url').toString());
  const relink = (p) => Buffer.from(JSON.stringify(p)).toString('base64url');
  const higher = structuredClone(payload); higher.fields[2][1] = '100';
  const otherRound = structuredClone(payload); otherRound.record.round = roundId(1);
  for (const broken of [relink(higher), relink(otherRound), 'not base64!', link.slice(0, -10), '']) {
    await assert.rejects(service.verify({ link: broken }), (e) => e.code === 'INVALID_DISCLOSURE', broken.slice(0, 20));
  }
  database.close();
});
