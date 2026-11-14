/**
 * Fase 5: de actie-bundel van een speler.
 *
 * Meteen na zijn poging zet de speler zijn zetten in zijn eigen VerusID,
 * versleuteld naar het adres van de ronde (shared/round-key.mjs). Na de reveal
 * kan iedereen ze lezen, naspelen en vergelijken met het officiële resultaat.
 *
 *   { "schema": "arcade-action-bundle", "version": 1,
 *     "round": "number-target:1.0.0:2026-11-20", "player": "i…",
 *     "actions": ["(25+3)*4", "100+7"],
 *     "ack": "<handtekening van Arcade@, base64>", "ackHeight": 1320000 }
 *
 * - Alleen de INVOER van de speler; de uitkomst rekent de verifier zelf na.
 * - `player` moet de ID zijn waarin de bundel staat: een gekopieerde verwijzing
 *   naar andermans bundel gaat zo niet door voor een eigen bundel.
 * - `ack` is het ONTVANGSTBEWIJS: Arcade@ tekent sha256 van
 *     Verus Arcade receipt v1 / round:… / player:… / bundle:sha256:<hash van de bundel zonder ack>
 *   Daarmee is een bundel die ontbreekt of afwijkt in het officiële resultaat een
 *   bewijs tegen de operator, en kan niemand een bundel verzinnen die Arcade nooit zag.
 * - De speler tekent niet apart: de transactie in zijn eigen ID is zijn handtekening.
 *
 * Gedeeld: browser, server en losse verifier. Geen Node-imports, geen SDK.
 */
import { sha256 } from '@noble/hashes/sha2';

import { canonicalJson } from './canonical-json.mjs';
import { VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { gameRules } from './games/index.mjs';
import { isCanonicalBase64 } from './result-set.mjs';
import { vdxfDataKey } from './vdxf-key.mjs';
import { SignatureCheckError, verifyIdentitySignature } from './verus-signature.mjs';

export const ACTION_BUNDLE_SCHEMA = 'arcade-action-bundle';
export const ACTION_BUNDLE_VERSION = 1;
export const RECEIPT_TITLE = 'Verus Arcade receipt v1';
/** Ruim onder de deeplinkgrens van Verus Mobile (2045 tekens ≈ 1100 bytes record). */
export const ACTION_BUNDLE_MAX_BYTES = 1024;
/** Een VerusID-handtekening van één sleutel (versie 2, sha256) is 73 bytes. */
const ACK_BYTES = 73;
const MAX_ACTIONS = 32;
const MAX_ACTION_LENGTH = 120;

const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
// Daily `…:JJJJ-MM-DD`, testronde `…:JJJJ-MM-DDTUUMM` (server/test-rounds.mjs).
const ROUND_PARTS = /^([a-z0-9][a-z0-9-]{0,40}):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2}(?:T\d{4})?)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BODY_KEYS = ['schema', 'version', 'round', 'player', 'actions'];
const BUNDLE_KEYS = [...BODY_KEYS, 'ack', 'ackHeight'];

export class ActionBundleError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ActionBundleError';
    this.code = code;
  }
}

/** @param {string} message @returns {never} */
const fail = (message) => { throw new ActionBundleError('INVALID_ACTION_BUNDLE', message); };

/** @param {Uint8Array} bytes */
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** sha256 (hex) van een UTF-8-tekst. @param {string} text */
const sha256Hex = (text) => toHex(sha256(new TextEncoder().encode(text)));

/**
 * `number-target:1.0.0:2026-11-20` → game en versie; gooit bij een ongeldige ronde-ID.
 * @param {unknown} roundId
 */
export function bundleRoundParts(roundId) {
  const match = typeof roundId === 'string' ? ROUND_PARTS.exec(roundId) : null;
  if (!match) return fail('Invalid round ID');
  return { gameId: match[1], gameVersion: match[2] };
}

/** Korte naam van de key voor de bundel van een ronde, zonder namespace. @param {string} roundId */
export function actionBundleKeyName(roundId) {
  bundleRoundParts(roundId);
  return `arcade.player.bundle.${roundId}`;
}

/**
 * De content-key (i-adres) van de bundel van een ronde in de namespace van de service-ID.
 * @param {{ roundId: string, serviceId: string }} input
 */
export function actionBundleKeyId({ roundId, serviceId }) {
  if (typeof serviceId !== 'string' || !I_ADDRESS.test(serviceId)) fail('Service identity i-address is invalid');
  return vdxfDataKey(actionBundleKeyName(roundId), serviceId);
}

/**
 * De bundel zonder ontvangstbewijs, gecontroleerd. Over de canonieke JSON hiervan
 * gaat de hash in het ontvangstbewijs.
 * @param {{ round: unknown, player: unknown, actions: unknown }} input
 * @returns {{ schema: string, version: number, round: string, player: string, actions: string[] }}
 */
export function actionBundleBody({ round, player, actions }) {
  bundleRoundParts(round);
  if (typeof player !== 'string' || !I_ADDRESS.test(player)) fail('Invalid player');
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) fail('A bundle carries between 1 and 32 actions');
  for (const action of /** @type {unknown[]} */ (actions)) {
    // Zichtbare ASCII zonder aanhalingsteken of backslash: woorden en rekensommen, niets dat JSON moet ontsnappen.
    if (typeof action !== 'string' || action.length < 1 || action.length > MAX_ACTION_LENGTH || !/^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(action)) fail('Invalid action');
  }
  return { schema: ACTION_BUNDLE_SCHEMA, version: ACTION_BUNDLE_VERSION, round: /** @type {string} */ (round), player, actions: [.../** @type {string[]} */ (actions)] };
}

/** sha256 (hex) van de bundel zonder ontvangstbewijs. @param {{ round: unknown, player: unknown, actions: unknown }} input */
export function actionBundleHash(input) {
  return sha256Hex(canonicalJson(actionBundleBody(input)));
}

/**
 * Het bericht dat Arcade@ tekent als ontvangstbewijs (vast profiel, vier regels).
 * @param {{ round: string, player: string, bundleSha256: string }} input
 */
export function receiptMessage({ round, player, bundleSha256 }) {
  bundleRoundParts(round);
  if (typeof player !== 'string' || !I_ADDRESS.test(player)) fail('Invalid player');
  if (typeof bundleSha256 !== 'string' || !HEX64.test(bundleSha256)) fail('Invalid bundle hash');
  return `${RECEIPT_TITLE}\nround:${round}\nplayer:${player}\nbundle:sha256:${bundleSha256}`;
}

/**
 * De hash (hex) die Arcade@ tekent voor deze bundel: sha256 van het ontvangstbericht.
 * De server tekent die zoals een attestatiewortel (`signMmrRoot`).
 * @param {{ round: unknown, player: unknown, actions: unknown }} input
 */
export function receiptHash(input) {
  const body = actionBundleBody(input);
  return sha256Hex(receiptMessage({ round: body.round, player: body.player, bundleSha256: sha256Hex(canonicalJson(body)) }));
}

/**
 * De tekst die de speler in zijn ID zet (canonieke JSON), met ontvangstbewijs.
 * @param {{ round: unknown, player: unknown, actions: unknown, ack: unknown, ackHeight: unknown }} input
 */
export function serializeActionBundle({ round, player, actions, ack, ackHeight }) {
  const body = actionBundleBody({ round, player, actions });
  if (!isCanonicalBase64(ack, ACK_BYTES)) fail('Invalid receipt signature');
  if (!Number.isSafeInteger(ackHeight) || /** @type {number} */ (ackHeight) < 1) fail('Invalid receipt height');
  const text = canonicalJson({ ...body, ack, ackHeight });
  if (new TextEncoder().encode(text).length > ACTION_BUNDLE_MAX_BYTES) fail('Bundle too large');
  return text;
}

/**
 * Een bundel lezen zoals hij in een ID stond. Streng: exacte velden, canonieke
 * vorm (de tekst moet precies zijn wat `serializeActionBundle` zou schrijven).
 * @param {string | Uint8Array} input
 * @returns {{ round: string, player: string, actions: string[], ack: string, ackHeight: number, gameId: string, gameVersion: string }}
 */
export function parseActionBundle(input) {
  let text;
  try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { return fail('Bundle is not UTF-8 text'); }
  if (text.length > ACTION_BUNDLE_MAX_BYTES) fail('Bundle too large');
  let value;
  try { value = JSON.parse(text); } catch { return fail('Bundle is not JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Bundle is not an object');
  if (value.schema !== ACTION_BUNDLE_SCHEMA || value.version !== ACTION_BUNDLE_VERSION) fail('Not an Arcade action bundle (version 1)');
  if (Object.keys(value).length !== BUNDLE_KEYS.length || !BUNDLE_KEYS.every((key) => key in value)) fail('Unexpected bundle fields');
  if (serializeActionBundle(value) !== text) fail('Bundle is not in canonical form');
  return { round: value.round, player: value.player, actions: value.actions, ack: value.ack, ackHeight: value.ackHeight, ...bundleRoundParts(value.round) };
}

/**
 * Klopt het ontvangstbewijs? `identityAtHeight` is de service-ID (Arcade@) zoals
 * `getidentity <id> <ackHeight>` haar geeft. Zelfde controle als voor attestaties.
 * @param {{ bundle: { round: string, player: string, actions: string[], ack: string, ackHeight: number }, serviceId: string, identityAtHeight: any }} input
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function verifyBundleReceipt({ bundle, serviceId, identityAtHeight }) {
  try {
    const check = verifyIdentitySignature({
      signaturedata: {
        version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: receiptHash(bundle),
        identityid: serviceId, signaturetype: 1, signature: bundle.ack,
      },
      signatureheight: bundle.ackHeight,
      identityAtHeight,
    });
    return { valid: check.valid, reason: check.reason };
  } catch (error) {
    if (error instanceof SignatureCheckError || error instanceof ActionBundleError) return { valid: false, reason: error.message };
    throw error;
  }
}

/**
 * De zetten naspelen met de regels van de game tegen de onthulde puzzel.
 * @param {{ gameId: string, gameVersion: string, actions: string[] }} bundle
 * @param {any} puzzle  de onthulde puzzel in de vorm van het gamecontract
 * @returns {{ ok: true, status: string, actionsUsed: number, finished: boolean } | { ok: false, reason: string }}
 */
export function replayActionBundle(bundle, puzzle) {
  try {
    const rules = gameRules(bundle.gameId, bundle.gameVersion);
    let state = rules.newState(puzzle);
    for (const value of bundle.actions) state = rules.applyAction(state, value).state;
    const score = rules.score(state);
    if (score.actionsUsed !== bundle.actions.length) return { ok: false, reason: 'action count differs' };
    return { ok: true, status: score.status, actionsUsed: score.actionsUsed, finished: Boolean(rules.isTerminal(state)) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * De zetten uit een officieel resultaatrecord (schema 1/2: `guesses`, schema 3: `actions`).
 * @param {any} record
 * @returns {string[]}
 */
export function recordActionValues(record) {
  return record?.schemaVersion === 3
    ? record.actions.map((/** @type {any} */ a) => a.value)
    : record.guesses.map((/** @type {any} */ g) => g.word);
}

/**
 * Zegt de bundel hetzelfde als het officiële resultaat? Zelfde ronde, zelfde
 * speler, dezelfde zetten in dezelfde volgorde.
 * @param {{ round: string, player: string, actions: string[] }} bundle
 * @param {any} record  bewezen resultaatrecord
 */
export function bundleMatchesRecord(bundle, record) {
  let values;
  try { values = recordActionValues(record); } catch { return false; }
  return record?.roundId === bundle.round && record?.playerIAddress === bundle.player
    && values.length === bundle.actions.length && values.every((/** @type {string} */ v, /** @type {number} */ i) => v === bundle.actions[i]);
}
