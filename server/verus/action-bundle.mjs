/**
 * Fase 5: de actie-bundel van een poging MAKEN (server). Lezen en nakijken staat
 * in shared/action-bundle.mjs en shared/independent-bundle.mjs.
 *
 * De server kent de zetten en tekent als Arcade@ het ontvangstbewijs: de hash van
 * `Verus Arcade receipt v1 / round / player / bundle:sha256`. De speler zet de
 * bundel daarna zelf, versleuteld naar het adres van de ronde, in zijn VerusID.
 *
 * Nog nergens aangesloten (stap 4a); de publicatieservice gebruikt dit in stap 4d.
 */
import { createHash } from 'node:crypto';

import { actionBundleKeyName, parseActionBundle, receiptHash, serializeActionBundle } from '../../shared/action-bundle.mjs';
import { roundKeyFromSalt } from '../../shared/round-key.mjs';
import { serviceContentKey } from './player-result.mjs';

export { ActionBundleError, actionBundleKeyName } from '../../shared/action-bundle.mjs';

/**
 * De content-key voor de bundel van een ronde: via de korte naam én via de fqn
 * berekend (moeten gelijk zijn), zoals voor resultaat en attestatie.
 * @returns {{ name: string, fqn: string, keyId: string }}
 */
export function actionBundleContentKey({ roundId, serviceId, serviceFqn }) {
  return serviceContentKey({ name: actionBundleKeyName(roundId), serviceId, serviceFqn });
}

/**
 * De zetten van een poging als tekst, uit de vorm van het resultaatrecord
 * (`recordActions` in server/attempt-actions.mjs): `{ sequence, word }` of `{ sequence, value }`.
 */
export function bundleActionValues(recordActions) {
  if (!Array.isArray(recordActions)) throw new Error('actions must be an array');
  return recordActions.map((action, index) => {
    const value = action?.value ?? action?.word;
    if (typeof value !== 'string' || action.sequence !== index + 1) throw new Error(`invalid action at index ${index}`);
    return value;
  });
}

/** Het adres waarnaar de bundels van een ronde versleuteld worden (uit de salt van de definitie). */
export function roundEncryptionAddress(definition) {
  return roundKeyFromSalt(definition?.salt).address;
}

/**
 * Bouwt de bundel van een speler met het ontvangstbewijs van de service-ID.
 *
 * @param {{
 *   roundId: string, playerId: string, actions: string[], serviceId: string,
 *   signHash: (hashHex: string) => Promise<{ signaturedata: { signature: string, signaturehash: string, identityid: string }, signatureheight: number }>,
 * }} input  `signHash`: tekent een hash van 32 bytes als de service-ID (`VerusRequests.signMmrRoot`).
 * @returns {Promise<{ json: string, sha256: string, receiptHash: string, ackHeight: number }>}
 */
export async function buildSignedActionBundle({ roundId, playerId, actions, serviceId, signHash }) {
  const body = { round: roundId, player: playerId, actions };
  const hash = receiptHash(body);
  const { signaturedata, signatureheight } = await signHash(hash);
  if (signaturedata?.signaturehash !== hash || signaturedata?.identityid !== serviceId) {
    throw new Error('The receipt was signed for another hash or by another identity');
  }
  const json = serializeActionBundle({ ...body, ack: signaturedata.signature, ackHeight: signatureheight });
  // Fail closed: wat we de speler laten publiceren, leest de verifier ook precies zo terug.
  parseActionBundle(json);
  return { json, sha256: createHash('sha256').update(json, 'utf8').digest('hex'), receiptHash: hash, ackHeight: signatureheight };
}
