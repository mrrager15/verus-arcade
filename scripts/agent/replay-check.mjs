/**
 * Alleen lezen: inclusiebewijs van een speler uit de database, onthulde puzzel,
 * en naspelen met de regels van de game (fase 8).
 *   node scripts/agent/replay-check.mjs <ronde-id> <speler-i-adres>
 */
const { applyTestRoundEnvironment } = await import('../../server/test-rounds.mjs');
const mode = applyTestRoundEnvironment();
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { verifyInclusionProof } = await import('../../server/result-set.mjs');
const { definitionPuzzle } = await import('../../server/round-proof.mjs');
const { replayResultRecord } = await import('../../server/replay.mjs');

const [roundId, player] = process.argv.slice(2);
if (!roundId || !player) throw new Error('Gebruik: replay-check.mjs <ronde-id> <speler-i-adres>');
const services = createRuntimeServices({ databasePath: mode.databasePath });
try {
  const { repository } = services;
  const round = repository.getRound(roundId);
  if (!round) throw new Error(`Ronde ${roundId} bestaat niet`);
  const proof = repository.getResultProof({ roundRecordId: round.id, playerIAddress: player });
  const reveal = repository.getRoundReveal(round.id);
  const puzzle = reveal?.hiddenDefinition ? definitionPuzzle(reveal.hiddenDefinition) : null;
  console.log(JSON.stringify({
    roundId,
    definitionSchema: reveal?.hiddenDefinition?.schemaVersion ?? null,
    puzzle,
    record: proof?.record ?? null,
    inclusionValid: proof ? verifyInclusionProof(proof) : false,
    root: proof?.rootSha256 ?? null,
    replay: proof && puzzle ? replayResultRecord(proof.record, puzzle) : null,
  }, null, 2));
} finally {
  services.close();
}
