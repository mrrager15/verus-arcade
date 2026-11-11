/**
 * Login binden aan de browser die hem startte (opruimronde A3, 11 nov 2026).
 *
 * Zonder dit volstaat de challenge-ID (32 hex, staat in de login-QR en in de
 * terugkeer-URL) om na goedkeuring de sessie op te halen via
 * `GET /verus/result/:id`. Wie de QR fotografeert, kon dus meelezen.
 *
 * Nu krijgt de browser bij `POST /verus/login` een extra geheim (`loginSecret`)
 * dat nooit in de QR of een URL staat. De server bewaart alleen de sha256 ervan.
 * `GET /verus/result/:id` geeft pas antwoord met de header `x-login-secret`.
 * verus-connect zelf blijft ongewijzigd: deze router staat ervóór op `/verus`.
 */
import crypto from 'node:crypto';
import express from 'express';

export const LOGIN_SECRET_HEADER = 'x-login-secret';
const CHALLENGE_ID = /^[0-9a-f]{32}$/;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] hoe lang een binding geldt (ruimer dan de 5 min van verus-connect)
 * @param {() => number} [options.now]
 * @param {() => string} [options.createSecret]
 */
export function createLoginBinding({
  ttlMs = 10 * 60 * 1000,
  now = Date.now,
  createSecret = () => crypto.randomBytes(32).toString('base64url'),
} = {}) {
  const bindings = new Map(); // challengeId → { hash, at }

  function sweep() {
    const limit = now() - ttlMs;
    for (const [id, entry] of bindings) if (entry.at < limit) bindings.delete(id);
  }

  /** Geeft true als het geheim bij deze challenge hoort (tijdsconstant vergeleken). */
  function matches(challengeId, secret) {
    sweep();
    const entry = bindings.get(challengeId);
    if (!entry || typeof secret !== 'string' || secret.length === 0 || secret.length > 200) return false;
    return crypto.timingSafeEqual(entry.hash, sha256(secret));
  }

  const router = express.Router();

  // Het antwoord van verus-connect aanvullen met een geheim voor déze browser.
  router.post('/login', (request, response, next) => {
    const send = response.json.bind(response);
    response.json = (body) => {
      if (response.statusCode < 400 && body && typeof body.challengeId === 'string' && CHALLENGE_ID.test(body.challengeId)) {
        sweep();
        const loginSecret = createSecret();
        bindings.set(body.challengeId, { hash: sha256(loginSecret), at: now() });
        return send({ ...body, loginSecret });
      }
      return send(body);
    };
    next();
  });

  // Het resultaat alleen aan de browser met het geheim geven.
  router.get('/result/:challengeId', (request, response, next) => {
    const { challengeId } = request.params;
    if (!bindings.has(challengeId)) {
      sweep();
      return response.status(404).json({ status: 'error', error: 'Challenge not found or expired' });
    }
    if (!matches(challengeId, request.get(LOGIN_SECRET_HEADER))) {
      return response.status(403).json({
        status: 'error',
        code: 'LOGIN_OTHER_BROWSER',
        error: 'This login was started in another browser. Finish it on the screen that showed the QR code.',
      });
    }
    return next();
  });

  return { router, matches, size: () => bindings.size };
}
