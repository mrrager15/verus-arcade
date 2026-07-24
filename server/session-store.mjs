import crypto from 'node:crypto';

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new Error('Session token has an invalid format');
  }
}

export class SessionStore {
  #clock;
  #sessions = new Map();
  #ttlMilliseconds;

  constructor({ ttlSeconds, clock = () => Date.now() }) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error('Session TTL must be a positive integer');
    }
    this.#ttlMilliseconds = ttlSeconds * 1000;
    this.#clock = clock;
  }

  register(token, user) {
    assertToken(token);
    if (!user?.iAddress || !user?.chain) {
      throw new Error('Session user requires iAddress and chain');
    }
    const now = this.#clock();
    this.#sessions.set(hashToken(token), {
      user: Object.freeze({ ...user }),
      createdAt: now,
      expiresAt: now + this.#ttlMilliseconds,
    });
  }

  resolve(token) {
    try {
      assertToken(token);
    } catch {
      return null;
    }
    const key = hashToken(token);
    const session = this.#sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.#clock()) {
      this.#sessions.delete(key);
      return null;
    }
    return {
      user: session.user,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  revoke(token) {
    try {
      assertToken(token);
    } catch {
      return false;
    }
    return this.#sessions.delete(hashToken(token));
  }

  removeExpired() {
    const now = this.#clock();
    let removed = 0;
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.#sessions.size;
  }
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
