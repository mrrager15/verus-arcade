/**
 * Register van de games die dit platform kent (gamecontract v1).
 *
 * Elke game is een map `shared/games/<slug>/<versie>/` met `rules.mjs` (de regels,
 * zonder imports), `generator.mjs` (puzzel van de dag, alleen server) en
 * `vectors.json` (testgevallen). Statische imports, zodat de browser-build ze meeneemt.
 * Een game toevoegen = een regel hieronder; het platform zelf verandert niet.
 */
import * as numberTarget100 from './number-target/1.0.0/rules.mjs';
import * as wordGrid100 from './word-grid/1.0.0/rules.mjs';

/**
 * @typedef {{
 *   meta: { contract: number, slug: string, version: string, name: string, maxActions: number, inputHint: string },
 *   validatePuzzle: (puzzle: any) => any,
 *   publicPuzzle: (puzzle: any) => any,
 *   normalizeAction: (value: unknown) => string,
 *   newState: (puzzle: any) => any,
 *   applyAction: (state: any, action: unknown) => { state: any, feedback: any },
 *   isTerminal: (state: any) => boolean,
 *   score: (state: any) => { status: 'solved' | 'unsolved', actionsUsed: number },
 *   revealOnEnd: (puzzle: any) => any,
 * }} GameRules
 */

/** @type {Readonly<Record<string, Readonly<Record<string, GameRules>>>>} */
const REGISTRY = Object.freeze({
  'number-target': Object.freeze({ '1.0.0': numberTarget100 }),
  'word-grid': Object.freeze({ '1.0.0': wordGrid100 }),
});

/**
 * Pad van het regelbestand, relatief aan de repo (voor de hash in het manifest).
 * @param {string} slug
 * @param {string} version
 */
export function rulesPath(slug, version) {
  return `shared/games/${slug}/${version}/rules.mjs`;
}

export class GameNotRegisteredError extends Error {
  /**
   * @param {string} slug
   * @param {string} version
   */
  constructor(slug, version) {
    super(`Game ${slug}@${version} is not registered`);
    this.code = 'GAME_NOT_REGISTERED';
  }
}

/**
 * De regels van één game-versie; gooit als ze niet geregistreerd is.
 * @param {string} slug
 * @param {string} version
 * @returns {GameRules}
 */
export function gameRules(slug, version) {
  const rules = Object.hasOwn(REGISTRY, slug) && Object.hasOwn(REGISTRY[slug], version) ? REGISTRY[slug][version] : null;
  if (!rules) throw new GameNotRegisteredError(slug, version);
  return rules;
}

/** Alle geregistreerde game-versies, gesorteerd. */
export function registeredGames() {
  return Object.keys(REGISTRY).sort().flatMap((slug) =>
    Object.keys(REGISTRY[slug]).sort().map((version) => ({ slug, version, rules: REGISTRY[slug][version] })),
  );
}
