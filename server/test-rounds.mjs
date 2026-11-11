/**
 * Testrondes: korte rondes (minuten in plaats van een dag) om de hele cyclus
 * snel te testen, volledig gescheiden van de echte Daily.
 *
 * Eén schakelaar, `ARCADE_TEST_ROUNDS=1`, zet tegelijk:
 *  - een eigen database (`server/data/arcade-test.sqlite`), zodat testrondes
 *    nooit meetellen in streaks, klassementen of attestaties van de echte Daily;
 *  - een eigen operator-ID (`arcade-storage-poc@`), zodat commitments, resultaten
 *    en reveals van testrondes nooit botsen met identity-updates op `Arcade@`
 *    (twee onbevestigde updates op dezelfde ID spenderen dezelfde output);
 *  - ronde-ID's met tijdslot (`word-grid:1.0.0:JJJJ-MM-DDTUUMM`, UTC), zodat de
 *    sleutels in de ID van een speler nooit samenvallen met die van een echte Daily.
 * Zonder de schakelaar weigeren de operator-scripts testrondes, en omgekeerd.
 */
import path from 'node:path';

export const TEST_DATABASE_FILE = 'arcade-test.sqlite';
export const TEST_OPERATOR = Object.freeze({ name: 'arcade-storage-poc@', iAddress: 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN' });
export const REAL_OPERATOR = Object.freeze({ name: 'Arcade@', iAddress: 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp' });
const TEST_ROUND_ID = /^[a-z0-9][a-z0-9-]{0,40}:\d+\.\d+\.\d+:\d{4}-\d{2}-\d{2}T\d{4}$/;

export function isTestRoundId(roundId) {
  return typeof roundId === 'string' && TEST_ROUND_ID.test(roundId);
}

/**
 * Leest de schakelaar en zet `ARCADE_DATABASE_PATH` (altijd, ook als .env er
 * een heeft) zodat elk script en de server dezelfde testdatabase gebruiken.
 * @returns {{ testMode: boolean, databasePath: string, operator: { name: string, iAddress: string } }}
 */
export function applyTestRoundEnvironment(env = process.env, cwd = process.cwd()) {
  const testMode = env.ARCADE_TEST_ROUNDS === '1';
  if (env.ARCADE_TEST_ROUNDS !== undefined && !['0', '1'].includes(env.ARCADE_TEST_ROUNDS)) {
    throw new Error('ARCADE_TEST_ROUNDS moet 0 of 1 zijn');
  }
  if (testMode) env.ARCADE_DATABASE_PATH = path.resolve(cwd, 'server', 'data', TEST_DATABASE_FILE);
  const databasePath = env.ARCADE_DATABASE_PATH ?? path.resolve(cwd, 'server', 'data', 'arcade.sqlite');
  if (!testMode && path.basename(databasePath) === TEST_DATABASE_FILE) {
    throw new Error('De testdatabase hoort bij ARCADE_TEST_ROUNDS=1');
  }
  return { testMode, databasePath, operator: testMode ? TEST_OPERATOR : REAL_OPERATOR };
}

/** Weigert een ronde die niet bij de modus hoort (testronde zonder schakelaar of omgekeerd). */
export function assertRoundMatchesMode(roundId, testMode) {
  if (isTestRoundId(roundId) !== testMode) {
    throw new Error(testMode
      ? `${roundId} is geen testronde; zonder ARCADE_TEST_ROUNDS=1 uitvoeren`
      : `${roundId} is een testronde; voer uit met ARCADE_TEST_ROUNDS=1`);
  }
}
