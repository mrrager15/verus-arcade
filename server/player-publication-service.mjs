/**
 * Fase 2: de speler publiceert zijn resultaat (met Merkle-bewijs) in zijn
 * eigen VerusID, onder de namespace van Arcade@.
 *
 * Flow:
 *   1. Operator finaliseert de ronde en publiceert de result-root (bestaand).
 *   2. POST /attempts/:id/publish-request → server bouwt het record uit het
 *      inclusiebewijs, maakt een getekend IdentityUpdateRequest (alleen content,
 *      nooit adressen of autoriteiten) en geeft QR/deeplink.
 *   3. Speler keurt goed in Verus Mobile; Mobile maakt de transactie en betaalt.
 *   4. Mobile levert het antwoord af op /publish-jobs/:requestId/response.
 *   5. Server verifieert en bewaart de txid als ONTVANGSTBEWIJS (status 'receipt').
 *   6. De reconcile-taak leest de chain terug; pas bij gelijke hash: 'published'.
 *
 * Geen HTTP hier; de router vertaalt. Fouten zijn DailyServiceError.
 */
import crypto from 'node:crypto';

import { DailyServiceError } from './daily-service.mjs';
import { RepositoryConflictError } from './db/repository.mjs';
import {
  PlayerResultError,
  buildPlayerResultRecord,
  playerResultContentKey,
  serializePlayerResultRecord,
} from './verus/player-result.mjs';
import { collectPlayerResults } from './verus/player-profile.mjs';
import { locatePublishedRecord } from './verus/player-result-reader.mjs';
import { rawId } from './verus/requests.mjs';
import { VerusRequestError, walletCompatibleIdentity } from './verus/requests.mjs';

const REQUEST_ID_HEX = /^[0-9a-f]{40}$/;

export function publicPublication(publication, { tip } = {}) {
  const expired = publication.status === 'pending' && Number.isSafeInteger(tip) && tip > publication.expiresHeight;
  return {
    attemptId: publication.attemptId,
    requestId: publication.requestIdHex,
    status: expired ? 'expired' : publication.status,
    contentKey: publication.contentKey,
    contentKeyName: publication.contentKeyFqn,
    recordSha256: publication.recordSha256,
    record: JSON.parse(publication.recordJson),
    walletUri: publication.status === 'pending' && !expired ? publication.walletUri : null,
    responseMode: publication.responseMode,
    createdHeight: publication.createdHeight,
    expiresHeight: publication.expiresHeight,
    receiptTxid: publication.receiptTxid,
    publishedTxid: publication.publishedTxid,
    publishedHeight: publication.publishedHeight,
  };
}

export class PlayerPublicationService {
  /**
   * @param {{
   *   repository: import('./db/repository.mjs').ArcadeRepository,
   *   verusRequests: import('./verus/requests.mjs').VerusRequests,
   *   origin: string,
   *   responseMode?: 'redirect'|'post',
   *   ttlBlocks?: number,
   *   clock?: () => number,
   *   createRequestIdHex?: () => string,
   * }} options
   */
  constructor({ repository, verusRequests, origin, responseMode = 'redirect', ttlBlocks = 60, clock = () => Date.now(), createRequestIdHex = () => crypto.randomBytes(20).toString('hex') }) {
    this.repository = repository;
    this.verus = verusRequests;
    this.origin = origin.replace(/\/$/, '');
    this.responseMode = responseMode;
    this.ttlBlocks = ttlBlocks;
    this.clock = clock;
    this.createRequestIdHex = createRequestIdHex;
    this.locks = new Map();
  }

  callbackUrl(requestIdHex) {
    return `${this.origin}/api/v1/publish-jobs/${requestIdHex}/response`;
  }

  #ownedCompletedAttempt(principal, attemptId) {
    if (!principal?.chain || !principal?.iAddress) {
      throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    }
    const attempt = this.repository.getAttemptForPlayer({ attemptId, chainId: principal.chain, playerIAddress: principal.iAddress });
    if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
    if (attempt.status !== 'completed') {
      throw new DailyServiceError('ATTEMPT_NOT_COMPLETED', 'Only a completed attempt can be published', 409);
    }
    return attempt;
  }

  #translate(error) {
    if (error instanceof DailyServiceError) return error;
    if (error instanceof VerusRequestError) {
      const unavailable = ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error.code);
      return new DailyServiceError(error.code, error.message, unavailable ? 503 : 422);
    }
    if (error instanceof PlayerResultError) return new DailyServiceError(error.code, error.message, 409);
    if (error instanceof RepositoryConflictError) return new DailyServiceError(error.code, error.message, 409);
    return error;
  }

  /** De service-identiteit (Arcade@) met haar volledig gekwalificeerde naam op de chain. */
  async #service() {
    const { height, state } = await this.verus.serviceState();
    const fqn = state.current?.fullyqualifiedname;
    if (typeof fqn !== 'string' || !fqn.endsWith('@')) {
      throw new DailyServiceError('SERVICE_UNAVAILABLE', 'Service identity name is unavailable', 503);
    }
    return { tip: height, serviceId: this.verus.serviceId, serviceFqn: fqn };
  }

  /** Naam en ouder van de spelersidentiteit, nodig voor het IdentityUpdateRequest. */
  async #playerIdentity(playerId, tip) {
    const state = await this.verus.loadIdentity({ identityId: playerId, signingHeight: tip });
    const identity = state.current?.identity;
    if (!state.currentActive || typeof identity?.name !== 'string' || typeof identity?.parent !== 'string') {
      throw new DailyServiceError('PLAYER_IDENTITY_UNAVAILABLE', 'Player identity is not active or incomplete', 409);
    }
    return { name: identity.name, parent: identity.parent };
  }

  /** Maakt een publicatieverzoek, of geeft het bestaande terug (idempotent). */
  async createPublishRequest({ principal, attemptId }) {
    try {
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const round = this.repository.getRoundForAttempt(attempt);
      const resultSet = round ? this.repository.getRoundResultSet(round.id) : null;
      if (!resultSet?.resultsTxid) {
        throw new DailyServiceError('RESULT_ROOT_UNPUBLISHED', 'The result root of this round is not confirmed on chain yet', 409);
      }
      const existing = this.repository.getPlayerPublication(attempt.id);
      const { tip, serviceId, serviceFqn } = await this.#service();
      if (existing && ['published', 'receipt'].includes(existing.status)) {
        return { created: false, publication: publicPublication(existing) };
      }
      if (existing?.status === 'pending' && tip <= existing.expiresHeight) {
        return { created: false, publication: publicPublication(existing, { tip }) };
      }
      if (existing?.status === 'pending') this.repository.markPlayerPublicationExpired(attempt.id);

      const proof = this.repository.getResultProof({ roundRecordId: round.id, playerIAddress: attempt.player_i_address });
      if (!proof) {
        throw new DailyServiceError('RESULT_COMPLETENESS_FAILURE', 'Final result set does not contain this attempt', 503);
      }
      const record = buildPlayerResultRecord({ round, proof, resultRootTxid: resultSet.resultsTxid });
      const serialized = serializePlayerResultRecord(record);
      const key = playerResultContentKey({ roundId: round.round_id, serviceId, serviceFqn });
      const player = await this.#playerIdentity(attempt.player_i_address, tip);
      // Vooraf de bekende Mobile-beperking herkennen in plaats van een QR te geven die faalt.
      const contentFqn = await this.verus.identityContentName({ identityId: attempt.player_i_address, keyId: key.keyId });
      if (!walletCompatibleIdentity({ identityId: attempt.player_i_address, contentFqn })) {
        throw new DailyServiceError(
          'WALLET_UNSUPPORTED_IDENTITY',
          `Verus Mobile cannot update ${contentFqn} yet: it resolves this sub-identity name to a different address. ` +
            'Play with a top-level testnet identity (name.VRSCTEST@) to store results in your identity.',
          409,
        );
      }
      const requestIdHex = this.createRequestIdHex();
      const built = await this.verus.createPlayerResultRequest({
        playerId: attempt.player_i_address, playerName: player.name, playerParent: player.parent,
        keyFqn: key.fqn, keyId: key.keyId, recordJson: serialized.json,
        callbackUrl: this.callbackUrl(requestIdHex), requestIdHex, responseMode: this.responseMode, ttlBlocks: this.ttlBlocks,
      });
      const publication = this.repository.createPlayerPublication({
        attemptId: attempt.id, contentKey: key.keyId, contentKeyFqn: key.fqn, recordJson: serialized.json, recordSha256: serialized.sha256,
        requestIdHex, requestHex: built.requestHex, walletUri: built.walletUri, responseMode: this.responseMode,
        createdHeight: built.height, expiresHeight: built.expiryHeight, now: this.clock(),
      });
      return { created: true, publication: publicPublication(publication, { tip }) };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /** Status voor de eigenaar (polling). */
  async getPublishRequest({ principal, attemptId }) {
    try {
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const existing = this.repository.getPlayerPublication(attempt.id);
      if (!existing) return { publication: null };
      let tip;
      if (existing.status === 'pending') {
        tip = await this.verus.tip();
        if (tip > existing.expiresHeight) this.repository.markPlayerPublicationExpired(attempt.id);
      }
      return { publication: publicPublication(this.repository.getPlayerPublication(attempt.id), { tip }) };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /**
   * Reconcile: voor elke publicatie met ontvangstbewijs de chain teruglezen.
   *   - record onder onze key met gelijke sha256 → 'published' (met tx en hoogte);
   *   - niets gevonden maar de ontvangst-tx is bevestigd → 'mismatch' (nooit stil);
   *   - anders: later opnieuw.
   * Eén chainfout stopt de rest niet; die publicatie wordt gemeld en overgeslagen.
   */
  async reconcile({ limit = 50 } = {}) {
    const results = [];
    for (const publication of this.repository.listPlayerPublicationsAwaitingConfirmation({ limit })) {
      const summary = { attemptId: publication.attemptId, requestId: publication.requestIdHex, before: publication.status };
      try {
        const attempt = this.repository.getAttemptById(publication.attemptId);
        if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
        const { tip, content, history } = await this.verus.readIdentityContent({ identityId: attempt.player_i_address, keyId: publication.contentKey });
        let located;
        try {
          located = locatePublishedRecord({ content, history, keyId: publication.contentKey, recordSha256: publication.recordSha256 });
        } catch (error) {
          throw new DailyServiceError('CHAIN_UNAVAILABLE', error.message, 503);
        }
        summary.valueCount = located.valueCount;
        summary.kinds = located.kinds;
        if (located.found) {
          const receipt = located.txid ? null : await this.verus.transactionStatus(publication.receiptTxid);
          const stored = this.repository.markPlayerPublicationPublished({
            attemptId: publication.attemptId,
            publishedTxid: located.txid ?? publication.receiptTxid,
            publishedHeight: located.height ?? receipt?.height ?? tip,
            now: this.clock(),
          });
          Object.assign(summary, { after: stored.status, txid: stored.publishedTxid, height: stored.publishedHeight });
        } else {
          const receipt = await this.verus.transactionStatus(publication.receiptTxid);
          if (receipt && receipt.confirmations >= 1) {
            const stored = this.repository.markPlayerPublicationMismatch({ attemptId: publication.attemptId, now: this.clock() });
            Object.assign(summary, { after: stored.status, receiptConfirmations: receipt.confirmations });
          } else {
            this.repository.touchPlayerPublicationChecked({ attemptId: publication.attemptId, now: this.clock() });
            Object.assign(summary, { after: 'receipt', receiptConfirmations: receipt?.confirmations ?? 0 });
          }
        }
      } catch (error) {
        const translated = this.#translate(error);
        Object.assign(summary, { after: publication.status, error: translated.code ?? 'INTERNAL_ERROR' });
      }
      results.push(summary);
    }
    return results;
  }

  /**
   * Publiek profiel: alle geldige Arcade-resultaten in de identiteit van een
   * speler, puur uit de chain (geen database, geen sessie).
   */
  async profile({ playerId }) {
    try {
      try { rawId(playerId); } catch { throw new DailyServiceError('INVALID_IDENTITY', 'Player identity must be an i-address', 400); }
      const { serviceId, serviceFqn } = await this.#service();
      const { tip, content, history } = await this.verus.readIdentityContent({ identityId: playerId });
      const collected = collectPlayerResults({ playerId, content, history, serviceId, serviceFqn });
      return {
        playerId,
        name: content?.fullyqualifiedname ?? content?.identity?.name ?? null,
        readAtHeight: tip,
        namespace: { serviceId, serviceFqn },
        results: collected.results,
        ignoredValues: collected.ignored,
      };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /** Verwerkt het wallet-antwoord: verifieert en bewaart de txid als ontvangstbewijs. */
  async acceptResponse({ requestIdHex, body }) {
    if (typeof requestIdHex !== 'string' || !REQUEST_ID_HEX.test(requestIdHex)) {
      throw new DailyServiceError('PUBLISH_REQUEST_NOT_FOUND', 'Unknown publish request', 404);
    }
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 65_536) {
      throw new DailyServiceError('INVALID_CALLBACK', 'Wallet response must be 1..65536 bytes', 400);
    }
    const previous = this.locks.get(requestIdHex) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#accept(requestIdHex, body));
    this.locks.set(requestIdHex, run);
    try { return await run; } finally { if (this.locks.get(requestIdHex) === run) this.locks.delete(requestIdHex); }
  }

  async #accept(requestIdHex, body) {
    try {
      const publication = this.repository.getPlayerPublicationByRequestId(requestIdHex);
      if (!publication) throw new DailyServiceError('PUBLISH_REQUEST_NOT_FOUND', 'Unknown publish request', 404);
      const attempt = this.repository.getAttemptById(publication.attemptId);
      if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
      if (publication.status === 'expired' || publication.status === 'mismatch') {
        throw new DailyServiceError('PUBLISH_REQUEST_EXPIRED', 'Publish request is no longer valid', 410);
      }
      const verified = await this.verus.verifyPlayerResultResponse({
        body, requestHex: publication.requestHex, requestIdHex,
        playerId: attempt.player_i_address, keyId: publication.contentKey, recordJson: publication.recordJson,
      });
      const stored = this.repository.markPlayerPublicationReceipt({
        attemptId: publication.attemptId, receiptTxid: verified.txid, now: this.clock(),
      });
      return { accepted: true, replayed: !stored.created, publication: publicPublication(stored.publication) };
    } catch (error) {
      throw this.#translate(error);
    }
  }
}
