/**
 * Fase 8: een resultaatrecord naspelen met de regels van de game.
 *
 * Na de reveal is de puzzel openbaar; met de zetten uit het record en het
 * regelbestand (waarvan de hash in het manifest staat) kan iedereen nagaan
 * dat status en aantal zetten kloppen. Werkt voor resultaatschema 1/2 (Word
 * Grid, `guesses`) en 3 (elke game, `actions`).
 */
import { gameRules } from '../shared/games/index.mjs';

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function replayResultRecord(record, puzzle) {
  try {
    const rules = gameRules(record.gameId, record.gameVersion);
    const values = record.schemaVersion === 3 ? record.actions.map((a) => a.value) : record.guesses.map((g) => g.word);
    let state = rules.newState(puzzle);
    for (const value of values) state = rules.applyAction(state, value).state;
    const score = rules.score(state);
    if (score.actionsUsed !== values.length) return { ok: false, reason: 'action count differs' };
    const expected = record.status === 'abandoned' ? 'unsolved' : record.status;
    if (score.status !== expected) return { ok: false, reason: `replay gives ${score.status}, record says ${record.status}` };
    if (record.status === 'unsolved' && !rules.isTerminal(state)) return { ok: false, reason: 'unsolved but the game was not over' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
