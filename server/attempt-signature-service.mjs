/**
 * Fase 1: de speler tekent zijn afgeronde poging met zijn VerusID.
 *
 * Flow:
 *   1. Speler rondt zijn Daily af (status 'completed').
 *   2. POST /attempts/:id/sign-request → server bouwt het bericht (profiel v1)
 *      en een getekend DataPacketRequest, slaat het op en geeft QR/deeplink.
 *   3. Speler scant, keurt goed in Verus Mobile.
 *   4. Mobile levert het antwoord af op /sign-jobs/:requestId/response
 *      (POST octet-stream, of GET-redirect met base64url in de query).
 *   5. Server verifieert in negen stappen en zet status 'signed'.
 *
 * Deze service kent geen HTTP; de router vertaalt. Fouten zijn DailyServiceError
 * zodat de bestaande foutafhandeling van de router ze oppakt.
 */
import crypto from 'node:crypto';
import { recordActions } from './attempt-actions.mjs';
import { DailyServiceError } from './daily-service.mjs';
import { RepositoryConflictError } from './db/repository.mjs';
import { actionsSha256, buildAttemptMessage } from './verus/attempt-message.mjs';
import { VerusRequestError } from './verus/requests.mjs';

const REQUEST_ID_HEX = /^[0-9a-f]{40}$/;

function publicSignature(signature, { tip } = {}) {
  const expired = signature.status === 'pending' && Number.isSafeInteger(tip) && tip > signature.expiresHeight;
  return {
    attemptId: signature.attemptId,
    requestId: signature.requestIdHex,
    status: expired ? 'expired' : signature.status,
    message: signature.message,
    walletUri: signature.status === 'pending' && !expired ? signature.walletUri : null,
    responseMode: signature.responseMode,
    createdHeight: signature.createdHeight,
    expiresHeight: signature.expiresHeight,
    signedAt: signature.signedAt,
    signer: signature.signerIAddress,
    signingHeight: signature.signingHeight,
  };
}

export class AttemptSignatureService {
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
    // Eén verwerking per request-ID tegelijk (dubbele callbacks komen voor).
    this.locks = new Map();
  }

  callbackUrl(requestIdHex) {
    return `${this.origin}/api/v1/sign-jobs/${requestIdHex}/response`;
  }

  #ownedCompletedAttempt(principal, attemptId) {
    if (!principal?.chain || !principal?.iAddress) {
      throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    }
    const attempt = this.repository.getAttemptForPlayer({ attemptId, chainId: principal.chain, playerIAddress: principal.iAddress });
    if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
    if (attempt.status !== 'completed') {
      throw new DailyServiceError('ATTEMPT_NOT_COMPLETED', 'Only a completed attempt can be signed', 409);
    }
    return attempt;
  }

  /** De zetten zoals ze in het resultaatrecord komen (schema 2: word, schema 3: value). */
  #guesses(attempt, round) {
    const definition = round ? this.repository.getRoundPrivateDefinition(round.id) : null;
    return recordActions(this.repository.listAttemptActions(attempt.id), definition);
  }

  #translate(error) {
    if (error instanceof DailyServiceError) return error;
    if (error instanceof VerusRequestError) {
      const unavailable = ['CHAIN_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(error.code);
      return new DailyServiceError(error.code, error.message, unavailable ? 503 : 422);
    }
    if (error instanceof RepositoryConflictError) return new DailyServiceError(error.code, error.message, 409);
    return error;
  }

  /** Maakt een handtekeningverzoek, of geeft het bestaande terug (idempotent). */
  async createSignRequest({ principal, attemptId }) {
    try {
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const round = this.repository.getRoundForAttempt(attempt);
      const tip = await this.verus.tip();
      const existing = this.repository.getAttemptSignature(attempt.id);
      if (existing?.status === 'signed') return { created: false, signature: publicSignature(existing) };
      if (existing?.status === 'pending' && tip <= existing.expiresHeight) {
        return { created: false, signature: publicSignature(existing, { tip }) };
      }
      if (existing?.status === 'pending') this.repository.markAttemptSignatureExpired(attempt.id);

      const message = buildAttemptMessage({
        roundId: round.round_id,
        playerIAddress: attempt.player_i_address,
        actionsSha256: actionsSha256(this.#guesses(attempt, round)),
      });
      const requestIdHex = this.createRequestIdHex();
      const built = await this.verus.createSignRequest({
        message, requestIdHex, responseMode: this.responseMode, callbackUrl: this.callbackUrl(requestIdHex),
      });
      const signature = this.repository.createAttemptSignature({
        attemptId: attempt.id, requestIdHex, requestHex: built.requestHex, requestHashHex: built.requestHashHex,
        message, walletUri: built.walletUri, responseMode: this.responseMode,
        createdHeight: built.height, expiresHeight: built.height + this.ttlBlocks, now: this.clock(),
      });
      return { created: true, signature: publicSignature(signature, { tip }) };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /** Status van het verzoek voor de eigenaar van de poging (voor polling). */
  async getSignRequest({ principal, attemptId }) {
    try {
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const existing = this.repository.getAttemptSignature(attempt.id);
      if (!existing) return { signature: null };
      let tip;
      if (existing.status === 'pending') {
        tip = await this.verus.tip();
        if (tip > existing.expiresHeight) this.repository.markAttemptSignatureExpired(attempt.id);
      }
      return { signature: publicSignature(this.repository.getAttemptSignature(attempt.id), { tip }) };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  /**
   * Verwerkt het antwoord van de wallet. Geen sessie nodig: de handtekening
   * zelf bewijst wie antwoordt. Idempotent: hetzelfde antwoord tweemaal geeft
   * hetzelfde resultaat; een ander antwoord op een al getekend verzoek faalt.
   */
  async acceptResponse({ requestIdHex, body }) {
    if (typeof requestIdHex !== 'string' || !REQUEST_ID_HEX.test(requestIdHex)) {
      throw new DailyServiceError('SIGN_REQUEST_NOT_FOUND', 'Unknown signature request', 404);
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
      const signature = this.repository.getAttemptSignatureByRequestId(requestIdHex);
      if (!signature) throw new DailyServiceError('SIGN_REQUEST_NOT_FOUND', 'Unknown signature request', 404);
      const attempt = this.repository.getAttemptForPlayerless?.(signature.attemptId)
        ?? this.repository.database.prepare('SELECT * FROM attempts WHERE id = ?').get(signature.attemptId);
      if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);

      const verified = await this.verus.verifySignResponse({
        body, requestHex: signature.requestHex, message: signature.message, requestIdHex,
        expectedSigner: attempt.player_i_address,
      });
      // De native handtekening draagt zijn eigen hoogte; die moet binnen de geldigheid vallen.
      if (verified.signingHeight < signature.createdHeight || verified.signingHeight > signature.expiresHeight) {
        throw new DailyServiceError('SIGN_REQUEST_EXPIRED', 'Signature height is outside the request validity window', 410);
      }
      if (signature.status === 'expired') {
        throw new DailyServiceError('SIGN_REQUEST_EXPIRED', 'Signature request has expired', 410);
      }
      const stored = this.repository.markAttemptSignatureSigned({
        attemptId: signature.attemptId, signerIAddress: verified.identityId,
        signingHeight: verified.signingHeight, nativeSignature: verified.nativeSignature, now: this.clock(),
      });
      return { accepted: true, replayed: !stored.created, signature: publicSignature(stored.signature) };
    } catch (error) {
      throw this.#translate(error);
    }
  }
}
