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
 * Fase 2b: dezelfde flow voor de verzegelde attestatie (`kind: 'attestation'`):
 * ander record (compact, zonder waarden en zouten) onder een andere key
 * (`arcade.player.attestation.<ronde>`); hooguit één van elke soort per poging.
 * Wachten op bevestiging leest de chain zelf terug (hooguit om de 15 s), zodat de
 * speler niet op de operator-reconcile hoeft te wachten.
 *
 * Fase 5: een derde soort, de actie-bundel (`kind: 'bundle'`). Anders dan de
 * andere twee mag die al TIJDENS de ronde, zodra de poging klaar is: de zetten
 * staan dan op de chain vóór de operator de ronde afsluit. De bundel draagt een
 * ontvangstbewijs van Arcade@ en wordt versleuteld naar het adres van de ronde
 * (commitment-schema 2), zodat niemand hem leest vóór de reveal. Teruglezen doet
 * de server zelf met de sleutel uit de salt (shared/verus-decrypt.mjs).
 *
 * Geen HTTP hier; de router vertaalt. Fouten zijn DailyServiceError.
 */
import crypto from 'node:crypto';
import { definitionPuzzle } from './round-proof.mjs';

import { DailyServiceError } from './daily-service.mjs';
import { RepositoryConflictError } from './db/repository.mjs';
import {
  PlayerResultError,
  buildCompactPlayerResultRecord,
  buildPlayerResultRecord,
  playerResultContentKey,
  serializePlayerResultRecord,
} from './verus/player-result.mjs';
import { collectPlayerResults } from './verus/player-profile.mjs';
import { locatePublishedRecord } from './verus/player-result-reader.mjs';
import { sealedAttestationRecord } from './attestation-service.mjs';
import { AttestationError } from './attestation.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { attestationKeyName, serviceContentKey } from './verus/player-result.mjs';
import { roundKeyFromSalt } from '../shared/round-key.mjs';
import { DATA_DESCRIPTOR_KEY, readMobileRecord } from '../shared/verus-decrypt.mjs';
import { recordActions } from './attempt-actions.mjs';
import { ActionBundleError, actionBundleContentKey, buildSignedActionBundle, bundleActionValues, roundEncryptionAddress } from './verus/action-bundle.mjs';
import { firstAppearance } from './verus/player-result-reader.mjs';
import { rawId } from './verus/requests.mjs';
import { VerusRequestError, walletCompatibleIdentity } from './verus/requests.mjs';

const REQUEST_ID_HEX = /^[0-9a-f]{40}$/;
const KINDS = ['result', 'attestation', 'bundle'];
const RECHECK_MS = 15_000;

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new DailyServiceError('INVALID_PUBLICATION_KIND', 'kind must be result, attestation or bundle', 400);
  return kind;
}

export function publicPublication(publication, { tip } = {}) {
  const expired = publication.status === 'pending' && Number.isSafeInteger(tip) && tip > publication.expiresHeight;
  return {
    attemptId: publication.attemptId,
    kind: publication.kind ?? 'result',
    requestId: publication.requestIdHex,
    status: expired ? 'expired' : publication.status,
    contentKey: publication.contentKey,
    contentKeyName: publication.contentKeyFqn,
    recordSha256: publication.recordSha256,
    record: JSON.parse(publication.recordJson),
    encryptToAddress: publication.encryptToAddress ?? null,
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

  /** Ontsleutelt een versleutelde verwijzing (zie resolveContentValue); fouten = niet leesbaar. */
  #decrypt = async (descriptor, txid) => {
    try {
      return await this.verus.decryptDataDescriptor({ descriptor, txid });
    } catch {
      return null;
    }
  };

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
    if (error instanceof AttestationError) return new DailyServiceError(error.code, error.message, 409);
    if (error instanceof ActionBundleError) return new DailyServiceError(error.code, error.message, 409);
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

  /**
   * Staat er nog een onbevestigde update van deze identiteit uit (andere publicatie met
   * status 'receipt')? Leest die eerst zelf terug als dat mag (hooguit om de 15 s).
   * Een tweede update vóór bevestiging spendeert dezelfde identiteitsoutput en faalt.
   */
  async #previousUpdatePending(playerId, exceptRequestId = null) {
    for (const other of this.repository.listUnconfirmedPlayerPublications(playerId)) {
      if (other.requestIdHex === exceptRequestId) continue;
      if (other.lastCheckedAtMs === null || this.clock() - other.lastCheckedAtMs >= RECHECK_MS) await this.#reconcileOne(other);
      if (this.repository.getPlayerPublication(other.attemptId, other.kind)?.status === 'receipt') return true;
    }
    return false;
  }

  /** Maakt een publicatieverzoek, of geeft het bestaande terug (idempotent). */
  async createPublishRequest({ principal, attemptId, kind = 'result' }) {
    try {
      checkKind(kind);
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const round = this.repository.getRoundForAttempt(attempt);
      const resultSet = round ? this.repository.getRoundResultSet(round.id) : null;
      if (kind === 'bundle') {
        this.#requireBundleRound(round);
      } else if (!resultSet?.resultsTxid) {
        throw new DailyServiceError('RESULT_ROOT_UNPUBLISHED', 'The result root of this round is not confirmed on chain yet', 409);
      }
      let existing = this.repository.getPlayerPublication(attempt.id, kind);
      const { tip, serviceId, serviceFqn } = await this.#service();
      // Fase 5: een bundel die al op de chain staat (het antwoord van de wallet kwam nooit aan)
      // niet opnieuw vragen. Zeker nakijken vóór een verlopen verzoek vervangen wordt.
      if (existing && await this.#recoverBundle(existing, { force: existing.status === 'expired' || tip > existing.expiresHeight })) {
        existing = this.repository.getPlayerPublication(attempt.id, kind);
      }
      if (existing && ['published', 'receipt'].includes(existing.status)) {
        return { created: false, publication: publicPublication(existing) };
      }
      if (existing?.status === 'pending' && tip <= existing.expiresHeight) {
        const waitForPrevious = await this.#previousUpdatePending(attempt.player_i_address, existing.requestIdHex);
        return { created: false, publication: { ...publicPublication(existing, { tip }), waitForPrevious } };
      }
      if (existing?.status === 'pending') this.repository.markPlayerPublicationExpired(attempt.id, kind);
      if (await this.#previousUpdatePending(attempt.player_i_address)) {
        throw new DailyServiceError(
          'PREVIOUS_UPDATE_UNCONFIRMED',
          'Your previous identity update is not confirmed yet. Wait about a minute, then try again.',
          409,
        );
      }

      const { serialized, key, encryptToAddress = null } = kind === 'bundle'
        ? await this.#bundleRecord({ attempt, round, serviceId, serviceFqn })
        : kind === 'attestation'
          ? this.#attestationRecord({ attempt, round, serviceId, serviceFqn })
          : this.#resultRecord({ attempt, round, resultSet, serviceId, serviceFqn });
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
        ...(encryptToAddress ? { encryptToAddress } : {}),
      });
      const publication = this.repository.createPlayerPublication({
        attemptId: attempt.id, kind, contentKey: key.keyId, contentKeyFqn: key.fqn, recordJson: serialized.json, recordSha256: serialized.sha256,
        requestIdHex, requestHex: built.requestHex, walletUri: built.walletUri, responseMode: this.responseMode,
        createdHeight: built.height, expiresHeight: built.expiryHeight, now: this.clock(), encryptToAddress,
      });
      return { created: true, publication: publicPublication(publication, { tip }) };
    } catch (error) {
      throw this.#translate(error);
    }
  }

  #resultRecord({ attempt, round, resultSet, serviceId, serviceFqn }) {
    const proof = this.repository.getResultProof({ roundRecordId: round.id, playerIAddress: attempt.player_i_address });
    if (!proof) {
      throw new DailyServiceError('RESULT_COMPLETENESS_FAILURE', 'Final result set does not contain this attempt', 503);
    }
    // Resultaatschema 2 (sinds fase 1) → compact v2-record, schema 3 (fase 8) → compact v3 (past
    // in een Mobile-deeplink, ook bij grote rondes); oudere schema-1-rondes houden het volledige v1-record.
    const record = proof.record.schemaVersion >= 2
      ? buildCompactPlayerResultRecord({ round, proof })
      : buildPlayerResultRecord({ round, proof, resultRootTxid: resultSet.resultsTxid });
    return {
      serialized: serializePlayerResultRecord(record, { player: attempt.player_i_address }),
      key: playerResultContentKey({ roundId: round.round_id, serviceId, serviceFqn }),
    };
  }

  /**
   * Fase 5: mag deze ronde bundels krijgen? Alleen een ronde die haar versleuteladres
   * publiceerde (commitment-schema 2), en niet meer na de reveal: dan kan iedereen de
   * sleutel afleiden en bewijst de bundel geen tijdstip meer.
   */
  #requireBundleRound(round) {
    if (!round || Number(round.commitment_schema) !== 2) {
      throw new DailyServiceError('BUNDLE_NOT_AVAILABLE', 'This round did not publish an encryption address for action bundles', 409);
    }
    if (round.status === 'revealed') {
      throw new DailyServiceError('ROUND_ALREADY_REVEALED', 'This round is already revealed; sealing your moves no longer proves anything', 409);
    }
  }

  /** Fase 5: de bundel van deze poging, met ontvangstbewijs van Arcade@, en het adres van de ronde. */
  async #bundleRecord({ attempt, round, serviceId, serviceFqn }) {
    const definition = this.repository.getRoundPrivateDefinition(round.id);
    if (!definition?.salt) throw new DailyServiceError('BUNDLE_NOT_AVAILABLE', 'The round definition is not available', 409);
    const actions = bundleActionValues(recordActions(this.repository.listAttemptActions(attempt.id), definition));
    const built = await buildSignedActionBundle({
      roundId: round.round_id, playerId: attempt.player_i_address, actions, serviceId,
      signHash: (hash) => this.verus.signMmrRoot(hash),
    });
    return {
      serialized: { json: built.json, sha256: built.sha256 },
      key: actionBundleContentKey({ roundId: round.round_id, serviceId, serviceFqn }),
      encryptToAddress: roundEncryptionAddress(definition),
    };
  }

  /**
   * Fase 5: een bundel terugvinden in de ID van de speler. De verwijzing draagt geen
   * viewing key; de server opent ze met de sleutel uit de salt van de ronde. Alleen een
   * waarde die verzegeld is (geen sleutel in de ID) en exact ons record bevat, telt.
   * Zelfde uitkomstvorm als locatePublishedRecord.
   */
  async #locateBundle({ content, history, publication, attempt }) {
    const values = content?.identity?.contentmultimap?.[publication.contentKey] ?? [];
    if (!Array.isArray(values)) throw new Error('CHAIN_UNAVAILABLE: unexpected contentmultimap shape');
    const round = this.repository.getRoundForAttempt(attempt);
    const definition = round ? this.repository.getRoundPrivateDefinition(round.id) : null;
    if (!definition?.salt) throw new Error('CHAIN_UNAVAILABLE: round definition is not available');
    const { ivk } = roundKeyFromSalt(definition.salt);
    const kinds = [];
    for (const value of values.slice(0, 32)) {
      const seen = firstAppearance({ history, keyId: publication.contentKey, value });
      const updateTxid = seen?.txid ?? publication.receiptTxid;
      if (!value?.[DATA_DESCRIPTOR_KEY] || !updateTxid) { kinds.push('undecodable'); continue; }
      let record;
      try {
        record = await readMobileRecord({ value, updateTxid, getTransaction: (txid) => this.verus.transaction(txid), ivk });
      } catch (error) {
        if (error instanceof VerusRequestError) throw error; // chain niet leesbaar: later opnieuw
        kinds.push('unreadable');
        continue;
      }
      const same = crypto.createHash('sha256').update(record.bytes).digest('hex') === publication.recordSha256;
      kinds.push(record.ivkPublished ? 'public' : same ? 'sealed' : 'sealed-other');
      if (same && !record.ivkPublished) {
        return { found: true, valueCount: values.length, txid: seen?.txid ?? null, height: seen?.height ?? null, kinds };
      }
    }
    return { found: false, valueCount: values.length, txid: null, height: null, kinds };
  }

  /**
   * Fase 5: staat de bundel al in de ID van de speler terwijl het antwoord van de wallet
   * de server nooit bereikte (gsm zonder verbinding, browser gesloten)? Dan is de chain
   * het bewijs: een verzegelde waarde met exact ons record maakt de publicatie meteen
   * 'published', met de transactie van de chain als ontvangstbewijs. Hooguit om de 15 s
   * per publicatie, tenzij `force`. Gooit niet: bij een fout blijft alles zoals het was.
   * @returns {Promise<boolean>} of de publicatie nu 'published' is
   */
  async #recoverBundle(publication, { force = false } = {}) {
    if (publication.kind !== 'bundle' || !['pending', 'expired'].includes(publication.status)) return false;
    if (!force && publication.lastCheckedAtMs !== null && this.clock() - publication.lastCheckedAtMs < RECHECK_MS) return false;
    try {
      const attempt = this.repository.getAttemptById(publication.attemptId);
      if (!attempt) return false;
      const { tip, content, history } = await this.verus.readIdentityContent({ identityId: attempt.player_i_address, keyId: publication.contentKey });
      const located = await this.#locateBundle({ content, history, publication, attempt });
      if (located.found && located.txid) {
        this.repository.markPlayerPublicationFoundOnChain({
          attemptId: publication.attemptId, kind: 'bundle', txid: located.txid, height: located.height ?? tip, now: this.clock(),
        });
        return true;
      }
      this.repository.touchPlayerPublicationChecked({ attemptId: publication.attemptId, kind: 'bundle', now: this.clock() });
      return false;
    } catch {
      return false;
    }
  }

  /** Fase 2b: de verzegelde attestatie van deze poging (compact, zonder waarden en zouten). */
  #attestationRecord({ attempt, round, serviceId, serviceFqn }) {
    const attestation = this.repository.getAttestation({ playerIAddress: attempt.player_i_address, roundRecordId: round.id });
    if (!attestation || attestation.attemptId !== attempt.id) {
      throw new DailyServiceError('ATTESTATION_NOT_FOUND', 'Arcade@ has not attested this attempt yet (after the round closes)', 409);
    }
    const json = canonicalJson(sealedAttestationRecord(attestation, round));
    return {
      serialized: { json, sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex') },
      key: serviceContentKey({ name: attestationKeyName(round.round_id), serviceId, serviceFqn }),
    };
  }

  /**
   * Status voor de eigenaar (polling). Wacht de publicatie op bevestiging, dan
   * leest dit zelf de chain terug (hooguit om de 15 s per publicatie).
   */
  async getPublishRequest({ principal, attemptId, kind = 'result' }) {
    try {
      checkKind(kind);
      const attempt = this.#ownedCompletedAttempt(principal, attemptId);
      const existing = this.repository.getPlayerPublication(attempt.id, kind);
      if (!existing) return { publication: null };
      let tip;
      if (existing.status === 'pending') {
        tip = await this.verus.tip();
        const expired = tip > existing.expiresHeight;
        // Fase 5: de bundel kan al op de chain staan zonder dat het antwoord van de wallet aankwam.
        const recovered = await this.#recoverBundle(existing, { force: expired });
        if (expired && !recovered) this.repository.markPlayerPublicationExpired(attempt.id, kind);
      } else if (existing.status === 'receipt' && (existing.lastCheckedAtMs === null || this.clock() - existing.lastCheckedAtMs >= RECHECK_MS)) {
        await this.#reconcileOne(existing);
      }
      const current = this.repository.getPlayerPublication(attempt.id, kind);
      const view = publicPublication(current, { tip });
      // Wacht deze QR nog op bevestiging van een andere update van dezelfde ID? Dan zegt de UI dat.
      if (view.status === 'pending' && view.walletUri) {
        view.waitForPrevious = await this.#previousUpdatePending(attempt.player_i_address, current.requestIdHex);
      }
      return { publication: view };
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
      results.push(await this.#reconcileOne(publication));
    }
    // Fase 5: bundels zonder antwoord van de wallet kunnen toch al op de chain staan.
    for (const publication of this.repository.listPendingBundlePublications({ limit })) {
      const recovered = await this.#recoverBundle(publication, { force: true });
      results.push({
        attemptId: publication.attemptId, kind: 'bundle', requestId: publication.requestIdHex,
        before: 'pending', after: recovered ? 'published' : 'pending',
      });
    }
    return results;
  }

  /** Eén publicatie met ontvangstbewijs teruglezen (zie reconcile). Gooit niet; fouten staan in het resultaat. */
  async #reconcileOne(publication) {
    const kind = publication.kind ?? 'result';
    const summary = { attemptId: publication.attemptId, kind, requestId: publication.requestIdHex, before: publication.status };
    {
      try {
        const attempt = this.repository.getAttemptById(publication.attemptId);
        if (!attempt) throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
        const { tip, content, history } = await this.verus.readIdentityContent({ identityId: attempt.player_i_address, keyId: publication.contentKey });
        let located;
        try {
          located = kind === 'bundle'
            ? await this.#locateBundle({ content, history, publication, attempt })
            : await locatePublishedRecord({
              content, history, keyId: publication.contentKey, recordSha256: publication.recordSha256,
              fallbackTxid: publication.receiptTxid, decrypt: this.#decrypt,
            });
        } catch (error) {
          if (error instanceof VerusRequestError) throw error;
          throw new DailyServiceError('CHAIN_UNAVAILABLE', error.message, 503);
        }
        summary.valueCount = located.valueCount;
        summary.kinds = located.kinds;
        if (located.found) {
          const receipt = located.txid ? null : await this.verus.transactionStatus(publication.receiptTxid);
          const stored = this.repository.markPlayerPublicationPublished({
            attemptId: publication.attemptId, kind,
            publishedTxid: located.txid ?? publication.receiptTxid,
            publishedHeight: located.height ?? receipt?.height ?? tip,
            now: this.clock(),
          });
          Object.assign(summary, { after: stored.status, txid: stored.publishedTxid, height: stored.publishedHeight });
        } else {
          const receipt = await this.verus.transactionStatus(publication.receiptTxid);
          if (receipt && receipt.confirmations >= 1) {
            const stored = this.repository.markPlayerPublicationMismatch({ attemptId: publication.attemptId, kind, now: this.clock() });
            Object.assign(summary, { after: stored.status, receiptConfirmations: receipt.confirmations });
          } else {
            this.repository.touchPlayerPublicationChecked({ attemptId: publication.attemptId, kind, now: this.clock() });
            Object.assign(summary, { after: 'receipt', receiptConfirmations: receipt?.confirmations ?? 0 });
          }
        }
      } catch (error) {
        const translated = this.#translate(error);
        Object.assign(summary, { after: publication.status, error: translated.code ?? 'INTERNAL_ERROR' });
      }
    }
    return summary;
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
      // Officiële result-root van de ronde (bevestigd op de chain door de operator), om
      // gekopieerde of vervalste records uit te sluiten. In fase 4 leest de verifier die van de chain.
      const resolveRoot = (roundId) => {
        const round = this.repository.getRound(roundId);
        const set = round ? this.repository.getRoundResultSet(round.id) : null;
        return set?.resultsTxid ? set.rootSha256 : null;
      };
      // Fase 8: de onthulde puzzel (alleen na de reveal), om het record na te spelen.
      const resolvePuzzle = (roundId) => {
        const round = this.repository.getRound(roundId);
        const reveal = round ? this.repository.getRoundReveal(round.id) : null;
        if (!reveal?.hiddenDefinition) return null;
        try { return definitionPuzzle(reveal.hiddenDefinition); } catch { return null; }
      };
      const collected = await collectPlayerResults({ playerId, content, history, serviceId, serviceFqn, decrypt: this.#decrypt, resolveRoot, resolvePuzzle });
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
        ...(publication.encryptToAddress ? { encryptToAddress: publication.encryptToAddress } : {}),
      });
      // Fase 5: de bundel is al van de chain teruggelezen (zie #recoverBundle). Een geldig
      // antwoord dat daarna nog binnenkomt (ook van een tweede goedkeuring) verandert niets.
      if (publication.kind === 'bundle' && publication.status === 'published') {
        return { accepted: true, replayed: true, publication: publicPublication(publication) };
      }
      const stored = this.repository.markPlayerPublicationReceipt({
        attemptId: publication.attemptId, kind: publication.kind ?? 'result', receiptTxid: verified.txid, now: this.clock(),
      });
      return { accepted: true, replayed: !stored.created, publication: publicPublication(stored.publication) };
    } catch (error) {
      throw this.#translate(error);
    }
  }
}
