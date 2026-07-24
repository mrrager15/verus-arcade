# Verus Arcade — Baseline Audit

Status: complete for the current repository baseline  
Audit date: 2026-07-25  
Audited revision: `d97d32a` (`master`, matching `origin/master` at audit time)  
Scope: current application code, configuration, persistence, Verus integration, build,
and test posture

## 1. Executive summary

The current repository is a useful testnet prototype. It proves that a SvelteKit client,
an Express backend, Verus Connect login, a server-authoritative word game, and a basic
VDXF commit/reveal flow can be connected in a small application.

The prototype is not safe to extend directly into the planned platform. Its strongest
assets are the working VerusID login integration, simple word-game UI, duplicate-letter
evaluation logic, and browser-side hash recomputation. Its most serious weaknesses are
in proof lifecycle, identity updates, chain separation, session security, persistence,
and test coverage.

Two findings block any claim of production-grade provable fairness:

1. A ranked round opens even when its on-chain commitment fails or remains unconfirmed.
2. `publishState()` constructs a replacement `contentmultimap` containing only three
   Arcade values. Because `updateidentity` replaces identity content, unrelated or
   previously required content can be removed.

The recommended approach is to retain the frontend and domain concepts as reference,
extract the pure game logic, and replace the round, persistence, proof, and chain-write
boundaries behind explicit interfaces.

## 2. Verification performed

The audit included:

- inspection of all application files outside the vendored Verus Connect package;
- inspection of the package scripts and repository layout;
- inspection of the current Git history and tracked files;
- Svelte type and diagnostic checks;
- a production build;
- a search for existing application tests;
- static analysis of login, sessions, round rotation, persistence, RPC, chain writes,
  leaderboard, and verification flows.

Commands and results:

| Check | Result |
|---|---|
| `npm.cmd run check` | Passed: 0 errors and 0 warnings |
| `npm.cmd run build` | Passed with the Node adapter |
| Application test discovery | No non-vendor `*.test.*` or `*.spec.*` files found |
| Live VRSCTEST transaction test | Not run during baseline audit |

A live test was intentionally deferred. The current backend imports RPC configuration
and may create or publish a round during startup. Real writes should only be performed
after test identities, configuration, expected payloads, and safety checks are explicit.

## 3. Current system

```text
SvelteKit client
├─ VerusID QR/deep-link login
├─ word-game board
├─ live leaderboard
└─ round verification page
          │
          ▼
Express application
├─ /verus → vendored Verus Connect
├─ /api/state
├─ /api/guess
├─ /api/leaderboard
└─ /api/verify/:round
          │
          ├─ JSON files: rounds, plays, sessions
          │
          ▼
Local verusd JSON-RPC
└─ updateidentity on Arcade@
```

Development runs Vite and Express separately. Production uses one Express process that
mounts the SvelteKit Node adapter after the API and authentication routes.

## 4. End-to-end behavior

### 4.1 Login

1. The client requests `/verus/login` for the selected chain.
2. Verus Connect creates a wallet request and returns a QR/deep link.
3. The client polls `/verus/result/:challengeId`.
4. `onLogin` creates a random bearer token.
5. The token and player identity are written to `server/data/sessions.json`.
6. The browser stores the bearer token in `localStorage`.

### 4.2 Round creation

1. Importing `server/game.mjs` calls `ensureRound()`.
2. A random word and salt are generated for the current UTC date.
3. `sha256(word + salt)` becomes the commitment.
4. `publishState()` submits an `updateidentity`.
5. The new round is persisted even if publication fails.
6. Play begins immediately; confirmation is not checked.

### 4.3 Gameplay

1. An authenticated player submits a five-letter guess.
2. The server computes the Wordle-style pattern.
3. The server stores the action in the local state file.
4. After success or six guesses, the answer is returned.
5. Solved players appear on a leaderboard generated from local state.

### 4.4 Rotation and reveal

At the first tick on a new UTC date, the backend attempts one identity update containing
the new commitment and the previous reveal/results. Failed publication is retried, but
the retry path publishes only the current commitment.

### 4.5 Verification

The verification page obtains commitment, answer, and salt from the Arcade API and
recomputes the SHA-256 hash in the browser. This demonstrates hash equality, but does
not independently retrieve or validate the on-chain transaction.

## 5. Findings

Severity definitions:

- **Critical:** invalidates a core proof or risks destructive chain writes.
- **High:** serious security, integrity, or network-separation weakness.
- **Medium:** reliability, maintainability, or product correctness limitation.
- **Low:** quality or usability issue that does not currently break the core flow.

### B-001 — Ranked play continues without a valid commitment

Severity: Critical  
Location: `server/game.mjs`

`ensureRound()` catches chain publication failure, stores `commitTxid: null`, activates
the round, and allows guesses. A returned transaction ID is also treated as sufficient;
the code does not establish mempool acceptance, confirmations, or finality.

Impact:

- an uncommitted round can be presented as provably fair;
- a transaction may be dropped or replaced after play begins;
- the product guarantee is stronger than the implemented guarantee.

Required disposition: Replace the lifecycle with explicit `DRAFT`, `SUBMITTED`,
`CONFIRMED`, `OPEN`, `CLOSED`, `REVEALED`, and `FAILED` states. Ranked play opens only
after the configured confirmation policy is satisfied. Practice remains available.

### B-002 — Identity updates can remove existing content

Severity: Critical  
Location: `server/chain.mjs`

`publishState()` creates a new `contentmultimap` containing only the supplied Arcade
commit, reveal, and result keys. The code comments correctly warn that an identity
update replaces current state, but the implementation does not read and merge the full
current identity.

Impact:

- unrelated `Arcade@` identity content may be removed;
- retrying only a commitment can remove reveal/results;
- concurrent identity writers can overwrite one another.

Required disposition: Do not perform another live write through this function. Build a
read-merge-validate-write-verify flow with optimistic concurrency, a transaction
journal, expected-before/after fixtures, and VRSCTEST destructive-content tests using a
dedicated test identity.

### B-003 — Authentication chain and write chain are not bound

Severity: High  
Locations: `server/app.mjs`, `server/rpc.mjs`, `src/routes/+page.svelte`

Login supports `vrsc` and `vrsctest`, while game writes use one separately configured
`ARCADE_CONF`, defaulting to VRSCTEST. A registered session stores no chain. Session
restoration labels the user as VRSCTEST regardless of the original login.

Impact:

- the same identity value can be interpreted without its chain context;
- a player can authenticate on one chain while gameplay writes target another;
- testnet and mainnet UI state can be misleading.

Required disposition: Make `chainId` part of every principal, session, game, round,
proof, database key, and API response. Use one allowlisted Verus gateway per chain.
Disable VRSC writes until mainnet approval.

### B-004 — VRSC is the default login network

Severity: High  
Locations: `server/app.mjs`, `src/routes/+page.svelte`

The default chain list begins with `vrsc`, and the UI initializes its selection to
`vrsc`. This conflicts with the agreed VRSCTEST-first and fail-closed policy.

Required disposition: Default to VRSCTEST everywhere. Mainnet support must require an
explicit production configuration and visible release gate.

### B-005 — Sessions do not expire or rotate

Severity: High  
Locations: `server/game.mjs`, `server/app.mjs`, `src/routes/+page.svelte`

Bearer tokens are persisted in plaintext, have no creation time, expiry, inactivity
timeout, rotation, or server-side logout/revocation. Browser tokens are stored in
`localStorage`.

Impact:

- a stolen token remains useful indefinitely;
- logout removes only the local copy;
- an XSS issue would expose the bearer token.

Required disposition: Replace with an expiring server-side session model, hashed token
storage, explicit revocation, and secure web/mobile storage. Prefer secure HttpOnly
cookies for the web application when compatible with the wallet flow.

### B-006 — Persistence is not transactional or concurrency-safe

Severity: High  
Location: `server/game.mjs`

Rounds, plays, and sessions are stored with synchronous full-file JSON writes. There is
no atomic rename, schema version, lock, transaction, backup, or corruption recovery.
Multiple processes would overwrite each other.

Impact:

- a crash can corrupt operational state;
- concurrent instances cannot be used safely;
- attempt uniqueness cannot be guaranteed;
- state and chain intent can diverge.

Required disposition: Replace file persistence with a transactional storage interface.
SQLite is a reasonable initial candidate; PostgreSQL remains an option after concurrency
and deployment requirements are measured.

### B-007 — Failed reveal/results are not retried correctly

Severity: High  
Location: `server/game.mjs`

When daily rotation fails, `retryPendingCommit()` retries only the current commitment.
The previous round's reveal and results are omitted.

Impact:

- a completed round may never receive its promised reveal or results;
- a successful later retry can misleadingly mark only the commitment as repaired.

Required disposition: Journal every intended chain operation independently. Retry the
complete immutable payload by idempotency key until it reaches a terminal state.

### B-008 — Verification is not independent of the Arcade API

Severity: High  
Locations: `src/routes/verify/[round]/+page.svelte`, `server/game.mjs`

The browser recomputes a hash, which is useful, but all inputs come from local server
state. The page does not fetch the referenced transaction, verify identity history,
decode the VDXF payload, or prove publication time relative to round opening.

Required disposition: Create a verifier that can use a read-only node or explorer API,
decode the actual chain record, verify schema and transaction reference, and then
recompute the commitment locally.

### B-009 — Results are not reproducible from published data

Severity: High  
Locations: `server/game.mjs`, `server/chain.mjs`

Published results include aggregate counts, a top list, and a hash of the local plays
object. Individual canonical action logs or inclusion proofs are not published. The
hash uses ordinary `JSON.stringify()` over insertion-ordered state rather than a
specified canonical format.

Impact:

- a third party cannot reconstruct the leaderboard;
- `playsSha256` cannot be checked without the server's private JSON file;
- implementations may produce different hashes for equivalent data.

Required disposition: Define canonical serialization, result records, replay rules, and
either individual proofs or a result bundle/Merkle-root design.

### B-010 — No application tests

Severity: High

The repository has no tests for the word evaluator, authentication integration, session
behavior, round rotation, chain payloads, retries, persistence, APIs, or verification.
The current `check` command performs Svelte diagnostics only.

Required disposition: Add unit, contract, integration, and failure-path tests before
refactoring core behavior. First freeze the evaluator and proof/hash behavior in tests.

### B-011 — Round lifecycle starts as an import side effect

Severity: Medium  
Locations: `server/game.mjs`, `server/rpc.mjs`

Importing the game router loads RPC configuration, calls `ensureRound()`, and starts a
timer. This makes tests difficult and couples application startup to wallet/daemon
availability.

Required disposition: Move lifecycle into an explicit service with `start()` and
`stop()`. Inject clock, random source, storage, and chain gateway.

### B-012 — RPC client lacks production resilience

Severity: Medium  
Location: `server/rpc.mjs`

The RPC client has no request timeout, abort handling, response-status validation,
retry policy, typed errors, method allowlist, metrics, or redaction boundary.

Required disposition: Replace with a configured gateway that distinguishes transport,
RPC, rejection, uncertainty, and confirmation errors.

### B-013 — Configuration is fragmented and unsafe by default

Severity: Medium  
Locations: `server/app.mjs`, `server/rpc.mjs`, `server/chain.mjs`

Authentication and game RPC use different environment variables and defaults. The
operator identity and VDXF keys are hardcoded. The development callback has a specific
LAN IP. Configuration is not validated at startup.

Required disposition: Introduce one typed, validated configuration module. Print only
non-secret effective settings and fail on incompatible network/identity combinations.

### B-014 — The current product has no Practice mode

Severity: Medium

The current game is effectively one server-held daily round. It does not implement the
agreed unlimited Practice mode or explicit one-attempt Daily reservation lifecycle.

Required disposition: Add modes only after the MVP protocol defines their exact state
and proof behavior.

### B-015 — Daily attempt semantics are implicit

Severity: Medium  
Location: `server/game.mjs`

The local play record limits guesses for one identity and round, but there is no
separate atomic attempt reservation, abandoned state, invalidation path, or multi-device
concurrency guarantee.

Required disposition: Specify and implement the Daily attempt state machine in
transactional storage with a uniqueness constraint.

### B-016 — Word validation is minimal

Severity: Medium  
Location: `server/game.mjs`

Any five ASCII letters are accepted. There is no allowed-guess dictionary, language
version, dictionary hash, or normalization policy.

Impact:

- scoring rules are underspecified;
- future verification can change when the word list changes;
- players can submit meaningless strings.

Required disposition: Version and hash the answer/guess dictionaries as part of the
game definition.

### B-017 — Basic API hardening is absent

Severity: Medium

There is no visible request-rate limiting, security-header policy, structured audit
logging, payload schema library, abuse throttling, or health/readiness endpoint in the
Arcade application.

Required disposition: Add these as shared platform middleware, with privacy-conscious
logging.

### B-018 — Vendored Verus Connect requires an ownership plan

Severity: Medium  
Location: `vendor/verus-connect`

The repository vendors source and generated distributions with local testnet patches.
This can be appropriate for compatibility, but creates update, provenance, and security
review obligations.

Required disposition: Record the upstream revision, local patch set, build
reproducibility, compatibility matrix, and upgrade process. Prefer upstreamed changes
when feasible.

### B-019 — Operational visibility is insufficient

Severity: Medium

Console logs are the primary diagnostics. There is no transaction journal, confirmation
dashboard, index lag, metrics, readiness, or incident state.

Required disposition: Add structured logs, health/readiness endpoints, operation IDs,
and proof/transaction state metrics before a pilot.

### B-020 — UI and documentation contain inconsistent network/proof language

Severity: Low

The verifier refers specifically to Verus testnet while the login UI offers mainnet.
Some restored sessions are labeled VRSCTEST regardless of login chain. Explorer links
are not provided. A Vite comment is in Dutch despite the English-repository convention.

Required disposition: Derive all network labels and links from typed chain
configuration, and keep repository text in English.

## 6. Component disposition

| Component | Disposition | Reason |
|---|---|---|
| SvelteKit and Node adapter | Retain | Builds cleanly and supports shared web/mobile direction |
| Express composition | Retain, modularize | Suitable for MVP but services need explicit boundaries |
| Verus Connect integration | Retain, harden | Working foundation; chain/session binding needs correction |
| Login page and QR polling | Refactor | Preserve UX concept; add expiry, cancellation, network truth |
| Browser bearer-token storage | Replace | No expiry/revocation and exposed to XSS |
| Word-game UI | Retain as reference | Useful vertical slice; separate from platform state |
| `evaluate()` word logic | Extract and test | Small pure function suitable for shared game engine |
| Current round engine | Replace | Import side effects, unsafe proof lifecycle, file persistence |
| JSON operational storage | Replace | Not transactional or concurrency-safe |
| RPC client | Replace behind gateway | Needs timeouts, typed errors, chain binding, metrics |
| Hardcoded VDXF keys | Investigate and migrate | Must be namespaced, versioned, and network-tested |
| `publishState()` | Stop using for live writes | Destructive merge behavior |
| Browser hash recomputation | Retain and expand | Good UX foundation for an independent verifier |
| Current leaderboard | Replace read model | Local-only and not independently reproducible |
| Vendored Verus Connect | Retain temporarily | Requires provenance, patch, and upgrade documentation |
| Production single process | Retain for MVP | Simple deployment; background jobs need explicit ownership |

## 7. Trust boundaries

The current code implicitly trusts:

- the Arcade server to choose and retain the original answer;
- the local JSON files to preserve all plays;
- the configured daemon and wallet;
- a transaction ID as proof of publication;
- the Arcade API to provide genuine verification inputs;
- the client to retain its bearer token safely;
- one Node process to be the only writer;
- local time and UTC day rotation;
- ordinary JSON property order for result hashes.

The target architecture must either remove each trust assumption, make it explicit in
the product, or protect it with testable controls.

## 8. Recommended first implementation boundary

Before changing game features:

1. Freeze pure word evaluation with unit tests.
2. Add typed VRSCTEST-only configuration.
3. Define the Daily attempt and round state machines.
4. Define chain principal and reference types including `chainId`.
5. Introduce interfaces for clock, random source, operational storage, and Verus
   gateway.
6. Build the Storage PoC against a dedicated VRSCTEST identity.
7. Do not use the current `publishState()` for further live testing.

This sequence preserves the working prototype while preventing unsafe code from
becoming the platform foundation.

## 9. Audit conclusion

The MVP has successfully demonstrated feasibility, but the next milestone is not “add
more features.” It is to establish honest proof states, safe identity updates,
testnet-only configuration, transactional attempts, secure sessions, and reproducible
tests.

The next planned artifact is `docs/MVP_SPEC.md`. It should turn Practice, Daily Seed,
login, scoring, proof, leaderboard, and verification into precise testable behavior
before implementation begins.
