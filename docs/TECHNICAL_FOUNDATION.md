# Verus Arcade — Technical Foundation

Status: in progress  
Started: 2026-07-25  
Default network: VRSCTEST

## Supported runtime

The application targets Node.js 22. The vendored `verus-connect@5.2.1` package declares
support for Node.js 20 through 22. `.nvmrc` and the root package engine range keep local,
CI, and deployment runtimes aligned.

GitHub Actions validates locked dependency installation, tests, Svelte/TypeScript
checks, and the production build on Node.js 22 for every pull request and master push.

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

### Database contract and first migration

The first migration defines:

- hashed, expiring, revocable sessions;
- rounds and commitment state;
- one Daily attempt per chain, identity, game, version, and round;
- idempotent action IDs and unique action sequences;
- a durable, idempotent transaction journal.

The repository contract already implements durable session operations and atomic Daily
attempt reservation. Duplicate reservation requests return the original attempt.

Action processing now enforces:

- the attempt must exist and be active;
- sequences start at one and increase without gaps;
- an exact `(actionId, sequence, actionHash)` retry returns the stored response;
- reuse of an action ID with different content is rejected;
- reuse of a sequence is rejected;
- rejected actions leave no partial database state.

The chain transaction journal now enforces:

- one immutable payload intent per operation key;
- explicit compare-and-set state transitions;
- distinct `uncertain` state for RPC timeouts after possible submission;
- reconciliation from `uncertain` to `submitted`, `confirmed`, or `failed`;
- terminal confirmed and failed states.

Migration and repository tests currently use Node's in-memory SQLite implementation as
a test adapter only. Production targets `better-sqlite3` on Node 22. The native package
could not be installed on this development machine because it runs unsupported Node 24
and has no compatible prebuilt binary or local C++ toolchain. We do not bypass that
runtime boundary in production.

## Next foundation slices

1. Add the SQLite repository and migrations.
2. Persist only hashed, expiring session records.
3. Integrate the repository with the game API.
4. Add the safe Verus gateway around the transaction journal.
5. Add structured health checks and sanitized logging.
6. Run integration tests against VRSCTEST.

No legacy JSON gameplay state is considered production-safe during this transition.
