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

### Daily application service and HTTP contract

The new service and `/api/v1` router implement the first database-backed API slice:

- `GET /api/v1/me`;
- `POST /api/v1/rounds/:roundId/attempts`;
- `GET /api/v1/attempts/:attemptId`.
- `POST /api/v1/attempts/:attemptId/actions`.

Daily reservation requires a chain-bound session, matching round chain, an open time
window, and a recorded commitment transaction. A new reservation returns HTTP 201; an
idempotent resume returns HTTP 200. Attempt lookup is scoped to the authenticated
identity and deliberately returns not-found to other identities.

Word-grid action submission is server-authoritative:

- the request contains only identity-bound attempt context, action ID, sequence,
  game version, type, and guessed word;
- the server normalizes and validates the word against the versioned dictionary;
- duplicate-letter feedback is computed by the portable game engine;
- answer, feedback, terminal state, and result hash are never accepted from the client;
- feedback and attempt transition commit atomically;
- the answer is returned only after solve or the sixth accepted guess;
- exact action retries return the stored response even after terminal completion.

The router is dependency-injected into the shared application. It is not enabled by
the legacy JSON engine; server bootstrap will enable it only after a durable SQLite
adapter is available.

### Safe Verus gateway

The gateway wraps every identity write in the transaction journal:

1. assert that the daemon reports VRSCTEST;
2. retrieve the exact configured identity;
3. preserve its complete current `contentmultimap`;
4. merge only validated VDXF changes;
5. journal the identity anchor and complete payload hash;
6. create a signed transaction through `updateidentity(..., returntx=true)`;
7. submit the journaled raw transaction separately;
8. treat connection loss during submission as `uncertain`;
9. confirm only after `getrawtransaction` reports the configured confirmations.

The gateway keeps the friendly identity name and i-address as separate required
configuration. The daemon accepts the i-address for identity retrieval but requires
the friendly name in `updateidentity`; the returned i-address is still verified before
signing.

The gateway constructor refuses VRSC. Invalid keys, non-hex values, inactive or
mismatched identities, and daemon-network mismatches fail closed.

The shared RPC client has bounded timeouts and distinguishes a definite daemon
rejection from connection loss after a possible `sendrawtransaction`. Credentials are
kept in request headers and are not included in sanitized errors.

The real-daemon integration test prepares a no-op merged identity update through
`returntx=true`, never calls `sendrawtransaction`, and verifies that the VRSCTEST
identity anchor remains unchanged:

```powershell
$env:VERUS_GATEWAY_TEST_ACK='TEST_VRSCTEST_GATEWAY_RETURNTX'
node scripts/integration/verus-gateway-returntx.mjs
```

Observed VRSCTEST result:

- identity: `i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN`
  (`arcade-storage-poc@`);
- journal state: `signed`;
- signed transaction size: 1,129 bytes;
- derived, non-broadcast txid:
  `ac16d59f9cab867bb4749d9b7ddfecf5b0bb662ca304e05c1d1201f9edb464c0`;
- `sendrawtransaction` was never called;
- the identity transaction anchor remained unchanged.

### Round commitment coordinator

The coordinator validates the closed version-1 hidden round schema, canonicalizes it,
hashes it with SHA-256, stores the private definition operationally, and sends only the
public commitment object to the gateway. A round remains `commit_pending` through
preparation and submission and transitions to `open` only after the journaled
transaction is confirmed.

Experimental VRSCTEST commitment key:

- URI: `Arcade::round.commitment.v1`;
- VDXF ID: `i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7`.

The full real-daemon preparation test is non-broadcast:

```powershell
$env:VERUS_ROUND_TEST_ACK='PREPARE_VRSCTEST_ROUND_COMMITMENT_RETURNTX'
node scripts/integration/round-commitment-returntx.mjs
```

Broadcast testing uses a separate durable lifecycle runner. Its SQLite database lives
under gitignored `server/data`; hidden definition and journal survive process restarts.
Preparation, submission, and reconciliation require different explicit
acknowledgements and are never combined implicitly.

Observed durable VRSCTEST lifecycle result:

- round: `word-grid:1.0.0:2026-07-27`;
- public hidden-definition commitment:
  `8333d89d56147a4098ad09d182859c2d0b72327dbdc9f81c9ad408296c194f7f`;
- transaction:
  `b06d005b08ffb4f2d8bf91d83b0352db84117582623271c8bd8cf480b33a0113`;
- serialized transaction size: 1,462 bytes;
- confirmation block:
  `00000001853e186fb91c1b912353069da0e513d5c30ecc67edbbe32be968b1e6`;
- confirmation time: `2026-07-24T23:23:07Z`;
- after one confirmation, the journal transitioned to `confirmed` and the round to
  `open`;
- the hidden definition remained in the operational database and was not included in
  the public commitment;
- the identity contained four VDXF keys after the update, and all three earlier storage
  fixtures remained byte-identical.

`open` is the persisted commitment state. The Daily service independently enforces
`opensAt` and `closesAt`, so this future-dated test round cannot accept ranked attempts
before `2026-07-27T00:00:00Z`.

### Final result set and player proofs

Migration `003_round_results.sql` stores an immutable canonical result bundle, its
SHA-256, the Merkle root, status counts, ordered leaf records, and the confirmed
results transaction receipt. Finalization runs in one immediate transaction:

- active and reserved attempts become `abandoned` after close;
- every reservation becomes exactly one canonical result record;
- records are sorted by the binary `chainId + NUL + playerIAddress` key;
- leaves and internal nodes use the domain-separated construction in ADR-006;
- the complete bundle remains operational while only its hash, root, count, and
  protocol metadata enter the compact chain descriptor;
- exact retries return the already stored result set.

Authenticated players can retrieve a pending or finalized proof through
`GET /api/v1/attempts/:attemptId/proof`. The response contains the canonical record and
Merkle path, not a server-trusted verification boolean. The shared verifier recomputes
the root locally and rejects malformed paths, wrong orientation, extra levels, modified
records, and duplicate identity keys.

Experimental VRSCTEST results key:

- URI: `Arcade::round.results.v1`;
- VDXF ID: `iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA`.

The real-daemon results test prepares and signs the compact descriptor with `returntx`
but does not broadcast it:

```powershell
$env:VERUS_RESULT_TEST_ACK='PREPARE_VRSCTEST_RESULT_DESCRIPTOR_RETURNTX'
node scripts/integration/result-descriptor-returntx.mjs
```

Observed VRSCTEST result:

- zero-leaf root:
  `dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986`;
- canonical empty-bundle hash:
  `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`;
- signed transaction size: 1,832 bytes;
- derived, non-broadcast txid:
  `0a688ee053f1d9b1c4c892fefab8e3843f45f75e33899ba801dbd17217918ca6`;
- journal state: `signed`;
- the full result bundle was not included in the descriptor;
- `sendrawtransaction` was never called and the identity anchor remained unchanged.

The player proof API reports finalization and chain publication separately. A valid
local inclusion proof is not labelled chain-confirmed until reconciliation stores the
confirmed results transaction ID.

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
