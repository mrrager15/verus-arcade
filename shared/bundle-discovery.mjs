/**
 * Fase 5: bij een verzegelde waarde in een spelers-ID de ronde terugvinden.
 *
 * Een bundel staat onder de key `arcade.player.bundle.<ronde-id>` (een hash van
 * die naam) en is tot de reveal niet te lezen. Uit de key zelf volgt de ronde dus
 * niet. Maar ronde-ID's zijn voorspelbaar: `<game>:<versie>:<datum>` voor een
 * Daily, en `…T<uumm>` voor een testronde. Met het tijdstip van het blok waarin
 * de waarde verscheen, proberen we de rondes die toen konden lopen en vergelijken
 * hun key met de gevonden key. Geen gegevens van de Arcade-server nodig.
 */
import { actionBundleKeyId } from './action-bundle.mjs';
import { registeredGames } from './games/index.mjs';

const DAY_MS = 86_400_000;
const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
const two = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * Zoekt rondes bij bundel-keys. Houdt de berekende keys per datum bij, zodat
 * meerdere waarden uit dezelfde dagen samen één keer rekenen.
 * @param {{ serviceId: string, games?: Array<{ slug: string, version: string }> }} input
 */
export function createBundleRoundFinder({ serviceId, games = registeredGames() }) {
  /** @type {Map<string, Map<string, string>>} */
  const dailyByDate = new Map();
  /** @type {Map<string, Map<string, string>>} */
  const testByDate = new Map();

  const keysFor = (/** @type {string[]} */ roundIds) => new Map(roundIds.map((roundId) => [actionBundleKeyId({ roundId, serviceId }), roundId]));
  const daily = (/** @type {string} */ date) => {
    if (!dailyByDate.has(date)) dailyByDate.set(date, keysFor(games.map((g) => `${g.slug}:${g.version}:${date}`)));
    return /** @type {Map<string, string>} */ (dailyByDate.get(date));
  };
  const tests = (/** @type {string} */ date) => {
    if (!testByDate.has(date)) {
      const ids = [];
      for (const g of games) for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) ids.push(`${g.slug}:${g.version}:${date}T${two(h)}${two(m)}`);
      testByDate.set(date, keysFor(ids));
    }
    return /** @type {Map<string, string>} */ (testByDate.get(date));
  };

  return {
    /**
     * De ronde-ID bij `keyId`, of null. `blockTimeMs`: het tijdstip van het blok
     * waarin de waarde in de ID verscheen. Een Daily loopt een dag en wordt enkele
     * uren (of, na een storing, een dag) later onthuld; een testronde duurt hooguit
     * enkele uren. Eerst de Daily's (goedkoop), dan pas de testrondes.
     * @param {{ keyId: string, blockTimeMs: number }} query
     * @returns {string | null}
     */
    find({ keyId, blockTimeMs }) {
      if (!Number.isFinite(blockTimeMs)) return null;
      for (const offset of [0, -1, -2, 1]) {
        const hit = daily(day(blockTimeMs + offset * DAY_MS)).get(keyId);
        if (hit) return hit;
      }
      for (const offset of [0, -1]) {
        const hit = tests(day(blockTimeMs + offset * DAY_MS)).get(keyId);
        if (hit) return hit;
      }
      return null;
    },
  };
}
