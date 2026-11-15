// Fase 5 stap 9: de echte Daily van Number Target krijgt een versleuteladres
// (commitment-schema 2); Word Grid, bestaande rondes en de nachtcyclus blijven zoals ze zijn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { roundKeyFromSalt } from '../shared/round-key.mjs';
import { validateCommitment } from '../shared/round-proof.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { DailyService } from './daily-service.mjs';
import {
  createDailyHiddenDefinition,
  dailyRoundSchedule,
  SEALED_DAILY_GAMES,
  withEncryptionAddressFor,
} from './daily-round-schedule.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { dailyGames } from './games/generators.mjs';
import { publicCommitment, RoundCoordinator } from './round-coordinator.mjs';

const COMMITMENT_KEY = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const TXID = 'c'.repeat(64);
const NUMBER_TARGET = Object.freeze({ gameId: 'number-target', gameVersion: '1.0.0' });
const WORD_GRID = Object.freeze({ gameId: 'word-grid', gameVersion: '1.0.0' });
// De avond vóór de nachtcyclus van 16 nov; de ronde van 17 nov is dan "overmorgen".
const NOW = Date.parse('2026-11-15T12:00:00.000Z');

/** Vast toeval, zodat de definitie (en dus de salt) voorspelbaar is. */
function fixedRandom(seed) {
  let call = 0;
  return {
    bytes: (n) => Buffer.alloc(n, (seed + call++) & 0xff),
    int: (max) => (seed + call++) % max,
  };
}

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const published = [];
  const gateway = {
    async prepareIdentityUpdate(input) {
      published.push(input);
      return { created: true, entry: { state: 'signed', txid: TXID, operation_key: input.operationKey } };
    },
    async submit() {
      return { submitted: true, entry: { state: 'submitted', txid: TXID } };
    },
    async reconcile() {
      return { confirmed: true, entry: { state: 'confirmed', txid: TXID } };
    },
  };
  const coordinator = new RoundCoordinator({ repository, gateway, commitmentVdxfKey: COMMITMENT_KEY, clock: () => NOW });
  return { database, repository, coordinator, published };
}

/** Doet wat `round-lifecycle.mjs round-create` voor een echte Daily doet (zonder gateway). */
async function createRealDaily(context, game, date, seed = 7) {
  const schedule = dailyRoundSchedule({ date, now: NOW });
  const hiddenDefinition = createDailyHiddenDefinition({ schedule, game, random: fixedRandom(seed) });
  const withEncryptionAddress = withEncryptionAddressFor({ game, testMode: false });
  const prepared = await context.coordinator.prepare({ hiddenDefinition, withEncryptionAddress });
  const [hex] = context.published.at(-1).changes[COMMITMENT_KEY];
  return { hiddenDefinition, prepared, onChain: Buffer.from(hex, 'hex').toString('utf8') };
}

test('schakelaar: testrondes altijd, echte Daily alleen Number Target', () => {
  assert.deepEqual([...SEALED_DAILY_GAMES], ['number-target']);
  assert.equal(withEncryptionAddressFor({ game: NUMBER_TARGET, testMode: false }), true);
  assert.equal(withEncryptionAddressFor({ game: { gameId: 'number-target', gameVersion: '2.0.0' }, testMode: false }), true);
  assert.equal(withEncryptionAddressFor({ game: WORD_GRID, testMode: false }), false);
  assert.equal(withEncryptionAddressFor({ game: { gameId: 'nieuwe-game', gameVersion: '1.0.0' }, testMode: false }), false, 'standaard uit');
  assert.equal(withEncryptionAddressFor({ game: WORD_GRID, testMode: true }), true);
  assert.equal(withEncryptionAddressFor({ game: NUMBER_TARGET, testMode: true }), true);
  assert.throws(() => withEncryptionAddressFor({ game: NUMBER_TARGET, testMode: undefined }), /testMode/);
  assert.throws(() => withEncryptionAddressFor({ game: NUMBER_TARGET, testMode: 'false' }), /testMode/);
  assert.equal(Object.isFrozen(SEALED_DAILY_GAMES), true);
});

test('nachtcyclus: zelfde games in dezelfde volgorde; alleen Number Target krijgt een adres', () => {
  const games = dailyGames();
  assert.deepEqual(games.map((g) => `${g.gameId}@${g.gameVersion}`), ['number-target@1.0.0', 'word-grid@1.0.0']);
  assert.deepEqual(games.map((game) => withEncryptionAddressFor({ game, testMode: false })), [true, false]);
});

test('echte Number Target-ronde: commitment-schema 2 met het adres uit haar eigen salt', async () => {
  const context = setup();
  const { hiddenDefinition, prepared, onChain } = await createRealDaily(context, NUMBER_TARGET, '2026-11-17');
  assert.equal(hiddenDefinition.roundId, 'number-target:1.0.0:2026-11-17');
  assert.equal(hiddenDefinition.schemaVersion, 2, 'de definitie zelf blijft schema 2 zoals sinds fase 8');
  const commitment = JSON.parse(onChain);
  assert.deepEqual(commitment, prepared.commitment);
  assert.equal(commitment.schemaVersion, 2);
  assert.equal(commitment.roundEncryptionAddress, roundKeyFromSalt(hiddenDefinition.salt).address);
  assert.match(commitment.roundEncryptionAddress, /^zs1/);
  assert.equal(commitment.salt, undefined, 'de salt blijft geheim tot de reveal');
  assert.equal(onChain.includes(hiddenDefinition.salt), false);
  validateCommitment(commitment);
  assert.equal(context.repository.getRound(hiddenDefinition.roundId).commitment_schema, 2);

  // Een andere ronde (andere salt) krijgt een ander adres.
  const other = await createRealDaily(context, NUMBER_TARGET, '2026-11-18', 9);
  assert.notEqual(JSON.parse(other.onChain).roundEncryptionAddress, commitment.roundEncryptionAddress);

  // Eens bevestigd en open: de API geeft het adres mee, dus de app toont "Seal my moves".
  await context.coordinator.submit({ operationKey: prepared.operationKey });
  await context.coordinator.reconcile({ recordId: prepared.recordId, operationKey: prepared.operationKey });
  const service = new DailyService({ repository: context.repository, clock: () => Date.parse('2026-11-17T09:00:00.000Z') });
  const current = service.getCurrentRound({ gameId: 'number-target' });
  assert.equal(current.roundId, 'number-target:1.0.0:2026-11-17');
  assert.equal(current.commitment.roundEncryptionAddress, commitment.roundEncryptionAddress);
  const proof = service.getRoundProof({ roundId: current.roundId });
  assert.equal(proof.commitment.schemaVersion, 2);
  assert.equal(proof.commitment.roundEncryptionAddress, commitment.roundEncryptionAddress);
  context.database.close();
});

test('echte Word Grid-ronde: commitment-schema 1, byte voor byte zoals altijd', async () => {
  const context = setup();
  const { hiddenDefinition, prepared, onChain } = await createRealDaily(context, WORD_GRID, '2026-11-17');
  assert.equal(hiddenDefinition.schemaVersion, 1, 'Word Grid 1.0.0 blijft definitieschema 1');
  // Dezelfde bytes als de code van vóór stap 9 (schema 1, zonder adres).
  assert.equal(onChain, canonicalJson(publicCommitment({
    definition: hiddenDefinition, hiddenDefinitionSha256: prepared.commitment.hiddenDefinitionSha256, schema: 1,
  })));
  assert.deepEqual(Object.keys(JSON.parse(onChain)), [
    'chainId', 'closesAt', 'date', 'gameId', 'gameVersion', 'hiddenDefinitionSha256', 'opensAt', 'roundId', 'schemaVersion',
  ]);
  assert.equal(JSON.parse(onChain).schemaVersion, 1);
  assert.equal(onChain.includes('roundEncryptionAddress'), false);
  assert.equal(context.repository.getRound(hiddenDefinition.roundId).commitment_schema, 1);

  await context.coordinator.submit({ operationKey: prepared.operationKey });
  await context.coordinator.reconcile({ recordId: prepared.recordId, operationKey: prepared.operationKey });
  const service = new DailyService({ repository: context.repository, clock: () => Date.parse('2026-11-17T09:00:00.000Z') });
  const current = service.getCurrentRound({ gameId: 'word-grid' });
  assert.equal(current.roundId, 'word-grid:1.0.0:2026-11-17');
  assert.equal('roundEncryptionAddress' in current.commitment, false, 'geen knop bij Word Grid');
  context.database.close();
});

test('bestaande Number Target-ronde met schema 1 blijft schema 1 (geen stille wissel)', async () => {
  const context = setup();
  // Zo staan de rondes van 15 en 16 nov in de echte database: aangemaakt vóór stap 9.
  const schedule = dailyRoundSchedule({ date: '2026-11-16', now: NOW });
  const hiddenDefinition = createDailyHiddenDefinition({ schedule, game: NUMBER_TARGET, random: fixedRandom(3) });
  await context.coordinator.prepare({ hiddenDefinition });
  const before = { ...context.repository.getRound(hiddenDefinition.roundId) };
  const commitmentBefore = context.published[0].changes[COMMITMENT_KEY][0];
  assert.equal(before.commitment_schema, 1);

  // Nog eens voorbereiden, nu met de schakelaar aan: geweigerd, niets veranderd.
  await assert.rejects(
    context.coordinator.prepare({ hiddenDefinition, withEncryptionAddress: withEncryptionAddressFor({ game: NUMBER_TARGET, testMode: false }) }),
    (error) => error.code === 'ROUND_DEFINITION_CONFLICT',
  );
  assert.deepEqual({ ...context.repository.getRound(hiddenDefinition.roundId) }, before);
  assert.equal(context.published.length, 1, 'geen tweede commitment voorbereid');
  assert.equal(context.published[0].changes[COMMITMENT_KEY][0], commitmentBefore);
  context.database.close();
});
