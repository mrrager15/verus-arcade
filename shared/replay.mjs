/**
 * Fase 8: een resultaatrecord naspelen met de regels van de game.
 *
 * Na de reveal is de puzzel openbaar; met de zetten uit het record en het
 * regelbestand (waarvan de hash in het manifest staat) kan iedereen nagaan
 * dat status en aantal zetten kloppen. Werkt voor resultaatschema 1/2 (Word
 * Grid, `guesses`) en 3 (elke game, `actions`). Gedeeld sinds fase 4.
 */
import { gameRules } from './games/index.mjs';

/**
 * @param {any} record  het bewezen resultaatrecord (schema 1, 2 of 3)
 * @param {any} puzzle  de onthulde puzzel in de vorm van het gamecontract
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function replayResultRecord(record, puzzle) {
  try {
    const rules = gameRules(record.gameId, record.gameVersion);
    const values = record.schemaVersion === 3 ? record.actions.map((/** @type {any} */ a) => a.value) : record.guesses.map((/** @type {any} */ g) => g.word);
    let state = rules.newState(puzzle);
    for (const value of values) state = rules.applyAction(state, value).state;
    const score = rules.score(state);
    if (score.actionsUsed !== values.length) return { ok: false, reason: 'action count differs' };
    const expected = record.status === 'abandoned' ? 'unsolved' : record.status;
    if (score.status !== expected) return { ok: false, reason: `replay gives ${score.status}, record says ${record.status}` };
    if (record.status === 'unsolved' && !rules.isTerminal(state)) return { ok: false, reason: 'unsolved but the game was not over' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
