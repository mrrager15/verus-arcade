/**
 * Fase 8: het manifest van een game (zonder I/O, unit-testbaar).
 *
 * Het manifest staat op `Arcade@` onder `Arcade::game.<slug>.manifest.v1` en
 * zegt welke regels bij een game-versie horen: de sha256 van `rules.mjs` (met
 * LF-regeleinden, zodat de hash op Windows en in git gelijk is). De
 * ontwikkelaar tekent een vast bericht met de hash van het manifest; `Arcade@`
 * publiceert het getekende manifest (= opname in het register).
 */
import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { rulesPath } from '../shared/games/index.mjs';

export const MANIFEST_SCHEMA = 'arcade-game-manifest';
export const MANIFEST_VERSION = 1;
export const MANIFEST_MESSAGE_TITLE = 'Verus Arcade game manifest v1';
export const TESTNET_SYSTEM_ID = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';

const MANIFEST_KEYS = ['schema', 'version', 'slug', 'name', 'gameVersion', 'contract', 'maxActions', 'rulesPath', 'rulesSha256', 'developer'];
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export class GameManifestError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_GAME_MANIFEST';
  }
}
const fail = (message) => { throw new GameManifestError(message); };
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** VDXF-sleutelnaam van het manifest van een game. */
export function manifestKeyName(slug) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug ?? '')) fail('Invalid game slug');
  return `Arcade::game.${slug}.manifest.v1`;
}

/** sha256 (hex) van het regelbestand, met LF-regeleinden. */
export function rulesSha256(rulesText) {
  if (typeof rulesText !== 'string' || rulesText.length === 0) fail('Rules text is empty');
  return sha256Hex(rulesText.replace(/\r\n/g, '\n'));
}

/** Het (ongetekende) manifest van een game-versie. */
export function buildGameManifest({ rules, rulesText, developer }) {
  if (!I_ADDRESS.test(developer ?? '')) fail('Developer must be an i-address');
  const { slug, version, name, maxActions, contract } = rules.meta;
  return {
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    slug,
    name,
    gameVersion: version,
    contract,
    maxActions,
    rulesPath: rulesPath(slug, version),
    rulesSha256: rulesSha256(rulesText),
    developer,
  };
}

function validateUnsigned(manifest) {
  if (
    !manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
    Object.keys(manifest).length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((k) => !(k in manifest)) ||
    manifest.schema !== MANIFEST_SCHEMA || manifest.version !== MANIFEST_VERSION ||
    !/^[a-z][a-z0-9-]{1,30}$/.test(manifest.slug ?? '') || !/^\d+\.\d+\.\d+$/.test(manifest.gameVersion ?? '') ||
    typeof manifest.name !== 'string' || manifest.name.length === 0 || manifest.name.length > 60 ||
    manifest.contract !== 1 || !Number.isSafeInteger(manifest.maxActions) || manifest.maxActions < 1 ||
    manifest.rulesPath !== rulesPath(manifest.slug, manifest.gameVersion) ||
    !HEX64.test(manifest.rulesSha256 ?? '') || !I_ADDRESS.test(manifest.developer ?? '')
  ) {
    fail('Manifest does not match schema v1');
  }
  return manifest;
}

/** sha256 (hex) van de canonieke JSON van het ongetekende manifest. */
export function manifestSha256(manifest) {
  return sha256Hex(canonicalJson(validateUnsigned(manifest)));
}

/** Het bericht dat de ontwikkelaar tekent (vier regels, vast profiel). */
export function manifestMessage(manifest) {
  return `${MANIFEST_MESSAGE_TITLE}\ngame:${manifest.slug}@${manifest.gameVersion}\ndeveloper:${manifest.developer}\nmanifest:sha256:${manifestSha256(manifest)}`;
}

/** Hash die in de handtekening van de ontwikkelaar staat: sha256 van het bericht. */
export function manifestSignatureHash(manifest) {
  return sha256Hex(manifestMessage(manifest));
}

/**
 * Hangt de handtekening van de ontwikkelaar aan het manifest. `signaturedata`
 * in de vorm van `signdata` (identityid, signaturehash, signature, …).
 */
export function attachDeveloperSignature(manifest, { signaturedata, signatureheight }) {
  const sd = signaturedata ?? {};
  if (sd.identityid !== manifest.developer) fail('Signed by a different identity than the developer');
  if (sd.signaturehash !== manifestSignatureHash(manifest)) fail('Signature does not cover this manifest');
  if (sd.systemid !== TESTNET_SYSTEM_ID || Number(sd.hashtype) !== 5 || Number(sd.signaturetype) !== 1) fail('Unsupported signature');
  if (!Number.isSafeInteger(signatureheight) || signatureheight < 1) fail('Invalid signature height');
  return { ...validateUnsigned(manifest), developerSignature: { signaturedata: { ...sd }, signatureheight } };
}

/**
 * Controleert de vorm van een getekend manifest en dat de handtekening over
 * precies dit manifest gaat. De cryptografische controle (sleutels van de
 * ontwikkelaar op tekenhoogte) doet de aanroeper met de chain.
 */
export function readSignedManifest(signed) {
  if (!signed || typeof signed !== 'object' || !signed.developerSignature) fail('Manifest is not signed');
  const { developerSignature, ...manifest } = signed;
  if (Object.keys(developerSignature).length !== 2) fail('Invalid developer signature');
  attachDeveloperSignature(manifest, developerSignature);
  return { manifest, developerSignature, message: manifestMessage(manifest) };
}
