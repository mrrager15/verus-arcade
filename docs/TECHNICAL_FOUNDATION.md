# Verus Arcade — Technical Foundation

Status: in progress  
Started: 2026-07-25  
Default network: VRSCTEST

## Implemented baseline

### Fail-closed network configuration

- exactly one configured network;
- VRSCTEST is the default;
- legacy multi-chain environment variables are rejected when ambiguous;
- VRSC requires production mode, an exact risk acknowledgement, and HTTPS;
- daemon configuration is selected from the explicit network;
- ports and session TTL values are validated;
- the configuration object is immutable.

### Legacy publication quarantine

The old publisher constructed a replacement `contentmultimap` without reading and
merging all existing identity content. It is now hard-disabled. It cannot be enabled
with an environment variable.

Daily Seed rejects guesses with `COMMITMENT_NOT_CONFIRMED` while a round lacks a
confirmed commitment. A chain or publication failure therefore fails closed instead
of silently weakening the proof guarantee.

### Automated checks

The root `npm test` command runs server foundation tests and Storage PoC tests.
Configuration tests cover:

- safe defaults;
- invalid networks;
- deprecated ambiguous multi-chain input;
- mainnet without production mode;
- mainnet without exact acknowledgement;
- mainnet without HTTPS;
- invalid ports, TTL, and origins.

### Ephemeral secure sessions

- login tokens use 256 bits of randomness and URL-safe encoding;
- only SHA-256 token hashes are retained by the server;
- sessions have a configured absolute expiry;
- expiry and revocation remove the server-side record immediately;
- every session is bound to an identity i-address and chain;
- malformed bearer tokens fail closed;
- `ARCADE_DEV_TOKEN` is forbidden in production.

Sessions are intentionally memory-only in this slice. A restart logs users out rather
than persisting raw bearer secrets. The SQLite slice will add durable hashed sessions.

## Next foundation slices

1. Add the SQLite repository and migrations.
2. Persist only hashed, expiring session records.
3. Implement atomic Daily attempt reservation and action idempotency.
4. Add a Verus gateway and durable transaction journal.
5. Add structured health checks and sanitized logging.
6. Run integration tests against VRSCTEST.

No legacy JSON gameplay state is considered production-safe during this transition.
