import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DailyService } from './daily-service.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';

export function createRuntimeServices({
  databasePath = process.env.ARCADE_DATABASE_PATH ??
    path.resolve('server', 'data', 'arcade.sqlite'),
} = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(database);
  const repository = new ArcadeRepository(database);
  return {
    database,
    repository,
    dailyService: new DailyService({ repository }),
    close() {
      database.close();
    },
  };
}
