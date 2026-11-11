/**
 * Start de gewone server (`server/auth.mjs`), maar op de TESTDATABASE
 * (server/test-rounds.mjs): `npm run server:test`. Zelfde poort, zelfde login;
 * je ziet alleen testrondes. Terug naar de echte Daily: stoppen en `npm run server`.
 */
import { applyTestRoundEnvironment } from './test-rounds.mjs';

process.env.ARCADE_TEST_ROUNDS = '1';
const { databasePath } = applyTestRoundEnvironment();
console.log(`[arcade] TESTRONDES — database ${databasePath}`);
await import('./auth.mjs');
