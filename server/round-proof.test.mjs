import assert from 'node:assert/strict';
import test from 'node:test';

import { hiddenDefinitionHash, verifyRoundReveal } from './round-proof.mjs';

const definition = Object.freeze({
  schemaVersion: 1,
  roundId: 'word-grid:1.0.0:2026-07-27',
  chainId: 'vrsctest',
  gameId: 'word-grid',
  gameVersion: '1.0.0',
  date: '2026-07-27',
  opensAt: '2026-07-27T00:00:00.000Z',
  closesAt: '2026-07-28T00:00:00.000Z',
  puzzleSeed: '11'.repeat(32),
  answer: 'crane',
  salt: '22'.repeat(32),
});

function fixture() {
  const commitment = {
    schemaVersion: 1,
    roundId: definition.roundId,
    chainId: definition.chainId,
    gameId: definition.gameId,
    gameVersion: definition.gameVersion,
    date: definition.date,
    opensAt: definition.opensAt,
    closesAt: definition.closesAt,
    hiddenDefinitionSha256: hiddenDefinitionHash(definition),
  };
  const reveal = {
    schemaVersion: 1,
    hiddenDefinition: definition,
    commitmentTxid: 'a'.repeat(64),
  };
  return { commitment, reveal };
}

test('independent verifier accepts the committed hidden definition', () => {
  assert.equal(verifyRoundReveal(fixture()), true);
});

test('independent verifier rejects changed answer, metadata, and receipt', () => {
  const changedAnswer = fixture();
  changedAnswer.reveal = {
    ...changedAnswer.reveal,
    hiddenDefinition: { ...definition, answer: 'slate' },
  };
  assert.equal(verifyRoundReveal(changedAnswer), false);

  const changedRound = fixture();
  changedRound.commitment = { ...changedRound.commitment, roundId: 'other' };
  assert.equal(verifyRoundReveal(changedRound), false);

  const invalidReceipt = fixture();
  invalidReceipt.reveal = { ...invalidReceipt.reveal, commitmentTxid: 'invalid' };
  assert.equal(verifyRoundReveal(invalidReceipt), false);
});
