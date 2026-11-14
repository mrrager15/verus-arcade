/**
 * Server-kant van de rondebewijzen. De logica staat sinds fase 4 in
 * `shared/round-proof.mjs` (één versie voor server, browser en losse verifier);
 * hier alleen de sha256 van Node erbij en de vertrouwde vorm (true/false).
 */
import crypto from 'node:crypto';

import { hiddenDefinitionText, verifyRoundRevealSync } from '../shared/round-proof.mjs';

export { definitionPuzzle, validateHiddenDefinition } from '../shared/round-proof.mjs';

/** @param {string} text */
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function hiddenDefinitionHash(definition) {
  return sha256Hex(hiddenDefinitionText(definition));
}

/** Klopt de reveal met de commitment? (true/false, zoals vóór fase 4) */
export function verifyRoundReveal({ commitment, reveal }) {
  return verifyRoundRevealSync({ commitment, reveal }, sha256Hex).valid;
}
