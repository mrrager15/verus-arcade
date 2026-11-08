/**
 * Leest (alleen lezen) de handtekeningverzoeken van een ronde uit de database.
 *   node scripts/operator/attempt-signatures.mjs <ronde-id>
 * Toont per poging: speler, status, ondertekenaar, hoogte. Met --with-signature ook bericht
 * en handtekening (publiek), om ze los van de server te verifiëren met `verifysignature`.
 */
import path from 'node:path';

import { createRuntimeServices } from '../../server/runtime-services.mjs';

const roundRecordId = process.argv[2];
const withSignature = process.argv.includes('--with-signature'); // handtekening en bericht meeprinten (publieke data) voor onafhankelijke verificatie
if (!roundRecordId) throw new Error('Gebruik: node scripts/operator/attempt-signatures.mjs <ronde-id>');
const databasePath = process.env.ARCADE_DATABASE_PATH ?? path.resolve('server', 'data', 'arcade.sqlite');
const services = createRuntimeServices({ databasePath });
try {
  const round = services.repository.getRound(roundRecordId);
  if (!round) throw new Error('Ronde bestaat niet');
  const rows = services.repository.listRoundAttemptSignatures(round);
  const attempts = services.repository.listRoundAttempts(round);
  console.log(JSON.stringify({
    roundId: round.id,
    attempts: attempts.map((a) => ({ attemptId: a.id, player: a.player_i_address, name: a.friendly_name, status: a.status, solved: Number(a.solved) === 1, guessesUsed: Number(a.guesses_used) })),
    signatures: rows.map((s) => ({
      attemptId: s.attemptId,
      requestId: s.requestIdHex,
      status: s.status,
      signer: s.signerIAddress,
      signingHeight: s.signingHeight,
      createdHeight: s.createdHeight,
      expiresHeight: s.expiresHeight,
      ...(withSignature ? { message: s.message, nativeSignature: s.nativeSignature } : {}),
    })),
  }, null, 2));
} finally {
  services.close();
}
