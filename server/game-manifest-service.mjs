/**
 * Fase 8: manifesten van games maken, laten tekenen en controleren.
 *
 * - `signAsService`: `Arcade@` is zelf de ontwikkelaar (Word Grid); de server
 *   tekent met de service-WIF.
 * - `createDeveloperRequest` + `acceptResponse`: een externe ontwikkelaar tekent
 *   het vaste manifestbericht met Verus Mobile (zelfde soort verzoek als het
 *   tekenen van een poging in fase 1). Het antwoord komt binnen op
 *   `/api/v1/manifest-jobs/:id/response`.
 * - `verifySigned`: vorm, regels-hash en handtekening (sleutels op tekenhoogte).
 * Publiceren op `Arcade@` doet scripts/operator/game-manifest.mjs via het journaal.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DailyServiceError } from './daily-service.mjs';
import { RepositoryConflictError } from './db/repository.mjs';
import { gameRules, rulesPath } from '../shared/games/index.mjs';
import {
  GameManifestError,
  TESTNET_SYSTEM_ID,
  attachDeveloperSignature,
  buildGameManifest,
  manifestMessage,
  readSignedManifest,
  rulesSha256,
} from './game-manifest.mjs';
import { VerusRequestError } from './verus/requests.mjs';

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export class GameManifestService {
  constructor({ repository, verusRequests, origin, responseMode = 'redirect', ttlBlocks = 60, repoRoot = process.cwd(), clock = () => Date.now(), createRequestIdHex = () => crypto.randomBytes(20).toString('hex') }) {
    this.repository = repository;
    this.verus = verusRequests;
    this.origin = String(origin).replace(/\/$/, '');
    this.responseMode = responseMode;
    this.ttlBlocks = ttlBlocks;
    this.repoRoot = repoRoot;
    this.clock = clock;
    this.createRequestIdHex = createRequestIdHex;
  }

  callbackUrl(requestIdHex) {
    return `${this.origin}/api/v1/manifest-jobs/${requestIdHex}/response`;
  }

  rulesText(slug, version) {
    return fs.readFileSync(path.join(this.repoRoot, rulesPath(slug, version)), 'utf8');
  }

  /** Het ongetekende manifest en het te tekenen bericht. */
  build({ slug, version, developer }) {
    const rules = gameRules(slug, version);
    const manifest = buildGameManifest({ rules, rulesText: this.rulesText(slug, version), developer });
    return { manifest, message: manifestMessage(manifest) };
  }

  /** `Arcade@` als ontwikkelaar: tekenen met de service-WIF. */
  async signAsService({ slug, version }) {
    const { manifest, message } = this.build({ slug, version, developer: this.verus.serviceId });
    const now = this.clock();
    this.repository.saveGameManifestRequest({ slug, gameVersion: version, developer: manifest.developer, manifest, message, now });
    const { signaturedata, signatureheight } = await this.verus.signMmrRoot(sha256Hex(message));
    const signed = attachDeveloperSignature(manifest, { signaturedata, signatureheight });
    await this.verifySigned(signed);
    return this.repository.markGameManifestSigned({ slug, gameVersion: version, signed, now });
  }

  /** Tekenverzoek (QR/deeplink) voor een externe ontwikkelaar. */
  async createDeveloperRequest({ slug, version, developer }) {
    const { manifest, message } = this.build({ slug, version, developer });
    const requestIdHex = this.createRequestIdHex();
    const built = await this.verus.createSignRequest({
      message, requestIdHex, responseMode: this.responseMode, callbackUrl: this.callbackUrl(requestIdHex),
    });
    return this.repository.saveGameManifestRequest({
      slug, gameVersion: version, developer, manifest, message, requestIdHex,
      requestHex: built.requestHex, walletUri: built.walletUri, expiresHeight: built.height + this.ttlBlocks, now: this.clock(),
    });
  }

  /** Antwoord van de wallet (zelfde vorm als fase 1). */
  async acceptResponse({ requestIdHex, body }) {
    try {
      const row = this.repository.getGameManifestByRequest(String(requestIdHex));
      if (!row) throw new DailyServiceError('MANIFEST_REQUEST_NOT_FOUND', 'Manifest signing request does not exist', 404);
      if (row.status === 'signed') return { replayed: true, status: 'signed', manifest: row.signed };
      const verified = await this.verus.verifySignResponse({
        body, requestHex: row.requestHex, message: row.message, requestIdHex: row.requestIdHex, expectedSigner: row.developer,
      });
      const signaturedata = {
        version: 1, systemid: TESTNET_SYSTEM_ID, hashtype: 5, signaturehash: sha256Hex(row.message),
        identityid: verified.identityId, signaturetype: 1, signature: verified.nativeSignature,
      };
      const signed = attachDeveloperSignature(row.manifest, { signaturedata, signatureheight: verified.signingHeight });
      await this.verifySigned(signed);
      const stored = this.repository.markGameManifestSigned({ slug: row.slug, gameVersion: row.gameVersion, signed, now: this.clock() });
      return { replayed: false, status: 'signed', manifest: stored.signed };
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Controleert een getekend manifest: vorm, regels-hash tegen het regelbestand
   * (standaard het lokale) en de handtekening van de ontwikkelaar op de chain.
   */
  async verifySigned(signed, { rulesText } = {}) {
    const { manifest, developerSignature } = readSignedManifest(signed);
    const text = rulesText ?? this.rulesText(manifest.slug, manifest.gameVersion);
    const rulesMatch = rulesSha256(text) === manifest.rulesSha256;
    if (!rulesMatch) throw new GameManifestError('The rules file does not match the manifest');
    const signature = await this.verus.verifyHashSignature(developerSignature);
    return { valid: true, rulesMatch, developer: signature.identityId, signatureHeight: signature.signatureHeight };
  }
}

function translate(error) {
  if (error instanceof DailyServiceError) return error;
  if (error instanceof GameManifestError) return new DailyServiceError(error.code, error.message, 422);
  if (error instanceof VerusRequestError) {
    const unavailable = ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error.code);
    return new DailyServiceError(error.code, error.message, unavailable ? 503 : 422);
  }
  if (error instanceof RepositoryConflictError) return new DailyServiceError(error.code, error.message, 409);
  return error;
}
