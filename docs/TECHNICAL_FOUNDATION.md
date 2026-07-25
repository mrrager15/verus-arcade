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

### Round reveal and public verification

Migration `004_round_reveals.sql` separates the private operational definition from the
confirmed public reveal. Reveal preparation is allowed only after close, transactional
result finalization, and confirmation of the result publication. It refuses to sign
when the stored definition no longer hashes to the confirmed commitment. Requiring the
confirmed result transaction also serializes the two updates to the operator VerusID.

The reveal journal and public state have separate lifecycles:

- `prepare` creates a signed `returntx` containing the canonical hidden definition and
  commitment transaction reference;
- no public API reads from the transaction journal;
- `submit` is explicit and idempotent;
- `reconcile` copies the definition into the public reveal table and changes the round
  to `revealed` only after chain confirmation.

The complete guarded prepare, inspect, submit, and reconcile procedure is in
[`OPERATOR_RUNBOOK.md`](./OPERATOR_RUNBOOK.md).

`GET /api/v1/rounds/:roundId/proof` is public and exposes the commitment, optional
confirmed reveal, compact result descriptor, and their distinct transaction states.
Before reveal confirmation, the response cannot contain the answer, salt, or puzzle
seed.

The shared `verifyRoundReveal()` implementation validates the closed schema,
canonicalizes the definition, recomputes its SHA-256, and matches all public commitment
metadata. It returns no server assertion that clients need to trust.

The `/verify/:round` web route performs the same operation locally with the browser's
Web Crypto API. It fetches proof material from the public endpoint, displays separate
commitment, reveal, and result-publication receipts, and never treats a pending chain
write as confirmed.

Experimental VRSCTEST reveal key:

- URI: `Arcade::round.reveal.v1`;
- VDXF ID: `iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj`.

The real-daemon preparation test is deliberately non-broadcast:

```powershell
$env:VERUS_REVEAL_TEST_ACK='PREPARE_VRSCTEST_REVEAL_RETURNTX'
node scripts/integration/reveal-returntx.mjs
```

Observed VRSCTEST result:

- hidden-definition commitment:
  `a1ec197c3823a1262b1da3df9d9fb43055abbe30ade013e70b18eb1a6f246043`;
- signed transaction size: 2,010 bytes;
- derived, non-broadcast txid:
  `b3b843085bfff700d1cad93a2decf894507159de4f2d3143c0873ab3d61a88a3`;
- the independent verifier reproduced the commitment;
- no public reveal record existed before confirmation;
- `sendrawtransaction` was never called and the identity anchor remained unchanged.

Migration and repository tests use Node's in-memory SQLite implementation. Runtime
services now use the same `DatabaseSync` API on the pinned Node 22.13+ runtime, enable
WAL and foreign keys, apply migrations at startup, and default to the gitignored
`server/data/arcade.sqlite`. `ARCADE_DATABASE_PATH` can select an explicit staging
database. Dev and production both inject this durable Daily service into `/api/v1`;
the v1 API is no longer test-only.

## Next foundation slices

1. Add the SQLite repository and migrations.
2. Persist only hashed, expiring session records.
3. Integrate the repository with the game API.
4. Add the safe Verus gateway around the transaction journal.
5. Add structured health checks and sanitized logging.
6. Run integration tests against VRSCTEST.

No legacy JSON gameplay state is considered production-safe during this transition.

## First playable web slice

The homepage now exposes Word Grid Practice immediately without authentication.
Practice is deliberately isolated from ranked infrastructure:

- puzzle selection uses rejection-sampled `crypto.getRandomValues()` in the browser;
- every completed game can be followed by a fresh random puzzle;
- no session, operational database row, transaction journal entry, or Verus write is
  created;
- the UI explicitly labels the mode `Unranked` and `not stored on-chain`;
- physical keyboard and touch keyboard input share one state machine;
- layouts and controls are responsive down to narrow mobile screens.

The pure Word Grid v1.0.0 rules moved to `shared/word-grid.mjs`. Server-authoritative
Daily actions and local Practice now import the exact same normalization,
duplicate-letter evaluation, terminal-state, and guess-limit implementation. The
existing immutable engine vectors therefore protect both modes.

The legacy mainnet selector was removed from the homepage. VerusID login is presented
only as access to the upcoming ranked Daily screen and sends an explicit `vrsctest`
chain request. Anonymous Practice remains available if session restoration or wallet
login fails.

### Daily Seed web flow

The same homepage now switches between mutually exclusive Practice and Daily
components, preventing simultaneous keyboard handlers. Daily implements:

- public discovery through `GET /api/v1/games/word-grid/rounds/current`;
- commitment state and receipt display without exposing the hidden definition;
- read-only existing-attempt lookup that cannot consume eligibility;
- an explicit one-attempt warning and acknowledgement before reservation;
- atomic reservation through the v1 service;
- server-authoritative guesses using UUID action IDs and monotonic sequences;
- reuse of the exact pending action ID after an uncertain network failure;
- reconstruction of accepted guesses and terminal result after refresh;
- separate scheduled, commitment-pending, open, terminal, and unavailable states;
- a direct link to the public round verifier after completion.

The UI never selects or receives the answer during active play. Color feedback is
paired with tile content, text status, semantic controls, visible focus behavior, and
screen-reader live messages.

The durable VRSCTEST pre-start check is:

```powershell
$env:VERUS_DAILY_UI_ACK='CHECK_VRSCTEST_DAILY_UI_READINESS'
node scripts/integration/vrsctest-daily-readiness.mjs
```

Observed against the durable confirmed VRSCTEST round:

- round: `word-grid:1.0.0:2026-07-27`;
- UI availability: `scheduled`;
- commitment state: `confirmed`;
- commitment transaction:
  `b06d005b08ffb4f2d8bf91d83b0352db84117582623271c8bd8cf480b33a0113`;
- read-only lookup found no existing attempt and created zero attempts;
- public discovery and proof responses exposed no answer, salt, or puzzle seed;
- the mutable pre-round leaderboard returned `live` with zero entries and did not
  consume eligibility.

### Public leaderboard

Migration `005_attempt_presentation.sql` adds an optional friendly-name snapshot to the
attempt as presentation data. Identity uniqueness and canonical result records continue
to use only the chain-bound i-address; changing or omitting a friendly name cannot
change a score, leaf, root, or eligibility decision.

`GET /api/v1/rounds/:roundId/leaderboard` requires no login and returns:

- `live` rankings from accepted server-authoritative actions;
- `finalized` rankings rebuilt from the immutable canonical result bundle;
- `chain-verified` only after the result-root transaction is confirmed;
- standard competition ties (`1, 1, 3`) based only on solved state and guesses used;
- deterministic i-address ordering within a tie without implying a better rank;
- no rank for an attempt that is still in progress.

Solved attempts rank before completed unsolved attempts, which rank before abandoned
attempts. Completion time is deliberately excluded. The Daily UI displays the proof
state, shortened i-address reference, optional friendly name, score/status, and
published result root.
