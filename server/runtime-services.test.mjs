import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeServices } from './runtime-services.mjs';

test('runtime services migrate storage and expose the Daily service', () => {
  const services = createRuntimeServices({ databasePath: ':memory:' });
  try {
    assert.equal(
      services.database
        .prepare('SELECT MAX(version) version FROM schema_migrations')
        .get().version,
      5,
    );
    assert.equal(services.dailyService.getCurrentRound(), null);
  } finally {
    services.close();
  }
});
