import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DailyService } from '../../server/daily-service.mjs';
import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';

const ACK = 'CHECK_VRSCTEST_DAILY_UI_READINESS';
const ROUND_ID = 'word-grid:1.0.0:2026-07-27';
const COMMITMENT_TXID =
  'b06d005b08ffb4f2d8bf91d83b0352db84117582623271c8bd8cf480b33a0113';

if (process.env.VERUS_DAILY_UI_ACK !== ACK) {
  throw new Error(`Set VERUS_DAILY_UI_ACK=${ACK} to inspect the durable VRSCTEST round`);
}

const databasePath = path.resolve(
  'server',
  'data',
  'vrsctest-round-lifecycle.sqlite',
);
const database = new DatabaseSync(databasePath);
try {
  database.exec('PRAGMA foreign_keys = ON;');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const service = new DailyService({ repository });
  const beforeAttempts = Number(
    database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
  );
  const round = service.getCurrentRound();
  if (
    !round ||
    round.id !== ROUND_ID ||
    round.commitment.transaction.txid !== COMMITMENT_TXID
  ) {
    throw new Error('Current Daily round does not match confirmed VRSCTEST evidence');
  }
  const proof = service.getRoundProof({ roundId: ROUND_ID });
  const privateDefinition = repository.getRoundPrivateDefinition(ROUND_ID);
  const serializedProof = JSON.stringify(proof);
  if (
    serializedProof.includes(privateDefinition.answer) ||
    serializedProof.includes(privateDefinition.salt) ||
    serializedProof.includes(privateDefinition.puzzleSeed)
  ) {
    throw new Error('Public pre-start response leaked hidden round data');
  }
  const existingAttempt = service.getRoundAttempt({
    principal: {
      chain: 'vrsctest',
      iAddress: 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN',
    },
    roundId: ROUND_ID,
  });
  const leaderboard = service.getLeaderboard({ roundId: ROUND_ID });
  const afterAttempts = Number(
    database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
  );
  if (afterAttempts !== beforeAttempts) {
    throw new Error('Readiness checks changed Daily eligibility');
  }
  console.log(
    JSON.stringify(
      {
        operation: 'vrsctest-daily-ui-readiness',
        roundId: round.id,
        availability: round.availability,
        commitmentStatus: round.commitment.transaction.status,
        commitmentTxid: round.commitment.transaction.txid,
        existingAttempt: existingAttempt?.id ?? null,
        attemptsCreated: afterAttempts - beforeAttempts,
        leaderboardState: leaderboard.state,
        leaderboardEntries: leaderboard.entries.length,
        hiddenFieldsExposed: false,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
