/**
 * Puzzelgeneratoren per game-versie (alleen server). Staat apart van het
 * register in shared/games/index.mjs zodat de browser-build geen woordenlijsten
 * meeneemt. De contracttest controleert dat elke geregistreerde game er één heeft.
 */
import * as numberTarget100 from '../../shared/games/number-target/1.0.0/generator.mjs';
import * as wordGrid100 from '../../shared/games/word-grid/1.0.0/generator.mjs';
import { gameRules, registeredGames } from '../../shared/games/index.mjs';

const GENERATORS = Object.freeze({
  'number-target@1.0.0': numberTarget100,
  'word-grid@1.0.0': wordGrid100,
});

export const DEFAULT_GAME = Object.freeze({ gameId: 'word-grid', gameVersion: '1.0.0' });

export function gameGenerator(gameId, gameVersion) {
  gameRules(gameId, gameVersion); // gooit als de game niet geregistreerd is
  const generator = GENERATORS[`${gameId}@${gameVersion}`];
  if (!generator) throw new Error(`Geen generator voor ${gameId}@${gameVersion}`);
  return generator;
}

/** `slug` of `slug@versie` → game; zonder versie de hoogste geregistreerde versie. */
export function parseGameOption(value) {
  const [gameId, gameVersion] = String(value).split('@');
  const versions = registeredGames().filter((g) => g.slug === gameId).map((g) => g.version);
  if (versions.length === 0) throw new Error(`Onbekende game: ${gameId} (bekend: ${[...new Set(registeredGames().map((g) => g.slug))].join(', ')})`);
  const version = gameVersion ?? versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  gameGenerator(gameId, version);
  return { gameId, gameVersion: version };
}

/** Alle games waarvoor dagelijks een ronde gemaakt wordt (elke slug, hoogste versie). */
export function dailyGames() {
  return [...new Set(registeredGames().map((g) => g.slug))].sort().map((slug) => parseGameOption(slug));
}
