import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AttemptSignatureService } from './attempt-signature-service.mjs';
import { DailyService } from './daily-service.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { createVerusRequestsFromEnv } from './verus/requests.mjs';

/**
 * Bouwt de wallet-request-laag (fase 1+) uit de omgeving. Geeft null als de
 * service-identiteit niet geconfigureerd is: de app draait dan zonder
 * handtekeningverzoeken, precies zoals v1.
 */
export function createAttemptSignatureService({ repository, runtime, env = process.env }) {
  if (!env.ARCADE_SERVICE_ID || !env.ARCADE_SERVICE_WIF) return null;
  const confText = env.VERUS_RPC_URL ? undefined : fs.readFileSync(runtime.confPath, 'utf8');
  const verusRequests = createVerusRequestsFromEnv({ env, confText });
  const responseMode = (env.WALLET_RESPONSE_MODE ?? 'redirect').trim();
  if (!['redirect', 'post'].includes(responseMode)) {
    throw new Error('WALLET_RESPONSE_MODE must be redirect or post');
  }
  const ttlBlocks = Number(env.REQUEST_TTL_BLOCKS ?? 60);
  if (!Number.isSafeInteger(ttlBlocks) || ttlBlocks < 1 || ttlBlocks > 10_000) {
    throw new Error('REQUEST_TTL_BLOCKS must be an integer between 1 and 10000');
  }
  return new AttemptSignatureService({
    repository, verusRequests, origin: runtime.origin, responseMode, ttlBlocks,
  });
}

export function createRuntimeServices({
  databasePath = process.env.ARCADE_DATABASE_PATH ??
    path.resolve('server', 'data', 'arcade.sqlite'),
  runtime = null,
  env = process.env,
} = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const attemptSignatureService = runtime
    ? createAttemptSignatureService({ repository, runtime, env })
    : null;
  return {
    database,
    repository,
    dailyService: new DailyService({ repository }),
    attemptSignatureService,
    close() {
      database.close();
    },
  };
}
