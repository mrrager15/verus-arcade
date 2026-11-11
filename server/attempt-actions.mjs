/**
 * Zetten van een poging, in de vorm van het resultaatrecord (fase 8).
 *
 * Rondes met definitieschema 1 (Word Grid, sinds v1) krijgen resultaatschema 2
 * met `guesses: [{ sequence, word }]`; rondes met definitieschema 2 (elke game)
 * krijgen schema 3 met `actions: [{ sequence, value }]`. In de database staat
 * de zet als `{ type: 'guess', payload: { word } }` of `{ type: 'action',
 * payload: { value } }`.
 */

/** Maakt deze ronde resultaten in schema 3? (definitie schema 2) */
export function usesGenericRecords(definition) {
  return definition?.schemaVersion === 2;
}

/** De canonieke zet uit een opgeslagen actie (beide vormen). */
export function storedActionValue(action) {
  return action?.payload?.value ?? action?.payload?.word ?? action?.guess;
}

/** Zetten van een poging zoals ze in het resultaatrecord (en het tekenbericht) staan. */
export function recordActions(entries, definition) {
  return usesGenericRecords(definition)
    ? entries.map((entry) => ({ sequence: entry.sequence, value: storedActionValue(entry.action) }))
    : entries.map((entry) => ({ sequence: entry.sequence, word: storedActionValue(entry.action) }));
}
