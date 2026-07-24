# Verus Arcade — Execution Plan

Status: active  
Version: 0.1  
Primary network: VRSCTEST  
Related document: [VERUS_ARCADE_STRATEGY.md](VERUS_ARCADE_STRATEGY.md)

## 1. Delivery approach

Verus Arcade will be delivered as a sequence of small vertical slices. We will not
design the entire platform in isolation and only then begin implementation. For each
phase, we will:

1. Specify the user-visible behavior and guarantees.
2. Make only the architecture decisions required for that phase.
3. Implement the smallest complete vertical slice.
4. Test it thoroughly, including real integration on VRSCTEST.
5. Record measurements, failures, and decisions.
6. Continue only when the phase exit criteria are satisfied.

The first release contains one complete game. A second game, community SDK, mobile
packaging, mainnet rollout, and PBaaS evaluation follow only after the core flow has
been demonstrated reliably.

## 2. Ordered phases

### Phase 1 — Baseline audit

Inspect the current MVP and determine what can be retained, revised, or replaced.

Scope:

- VerusID login and session restoration;
- current word-game engine and UI;
- commit/reveal implementation;
- VDXF keys and `contentmultimap` handling;
- local JSON persistence;
- frontend/backend boundaries;
- configuration and secret handling;
- test coverage and reproducibility;
- production and security risks.

Deliverable:

- `docs/BASELINE_AUDIT.md`;
- a disposition for each major component: retain, refactor, replace, or investigate;
- an ordered list of blocking risks.

Exit criteria:

- the current application can be explained end to end;
- important trust boundaries and failure modes are documented;
- no major architectural assumption remains implicit.

### Phase 2 — MVP specification

Specify the first complete product slice:

- one game;
- Practice mode;
- one-attempt Daily Seed mode;
- VerusID login;
- server-authoritative validation;
- deterministic replay or equivalent verification;
- commit/reveal;
- leaderboard;
- public verifier;
- VRSCTEST only;
- web first.

Deliverable:

- `docs/MVP_SPEC.md`;
- user journeys and screen states;
- Daily attempt state machine;
- API contracts;
- on-chain records;
- anti-cheat guarantees and limitations;
- acceptance tests.

Exit criteria:

- every MVP behavior is testable;
- ranked, practice, pending, abandoned, failed, and verified states are unambiguous;
- out-of-scope behavior is explicit.

### Phase 3 — Minimum architecture decisions

Decide only what the MVP requires:

- SvelteKit client structure;
- modular Node backend;
- portable deterministic game engine;
- Verus gateway for all RPC interaction;
- operational storage;
- index/read model;
- transaction journal and background jobs;
- configuration and secret handling;
- test organization.

Initial Architecture Decision Records:

- ADR-001: operational storage, SQLite or PostgreSQL;
- ADR-002: session model;
- ADR-003: Daily attempt lifecycle;
- ADR-004: on-chain data model;
- ADR-005: canonical serialization and hashing;
- ADR-006: individual results or bundled result roots.

Exit criteria:

- the MVP has an implementable component and data model;
- every security-sensitive boundary has an owner;
- decisions can be revised without rewriting game logic.

### Phase 4 — Verus Storage Proof of Concept

Execute the storage tests defined in the strategy on VRSCTEST.

Tests include:

- store and retrieve a VDXF game-definition object;
- store and retrieve a score object;
- store and retrieve a small file;
- test larger and potentially chunked data;
- test encryption and decryption;
- update an identity without removing existing content;
- retrieve from a clean or independent node;
- measure fees, bytes, confirmations, and latency;
- test retries, duplicate submissions, interruption, and recovery.

Deliverables:

- reproducible scripts and fixtures;
- `docs/STORAGE_POC.md`;
- VRSCTEST transaction IDs and block heights;
- ADR-001 or a dedicated storage ADR updated from measured results.

Exit criteria:

- stored data round-trips correctly;
- integrity checks are automated;
- failure and retry behavior is understood;
- each Arcade data class has a justified storage location.

### Phase 5 — Technical foundation

Stabilize the repository before expanding gameplay:

- typed configuration with VRSCTEST as the default;
- fail-closed mainnet configuration;
- test framework and CI;
- secure expiring sessions;
- operational storage interface;
- Verus gateway;
- transaction journal and idempotency;
- schema validation;
- structured logging and health checks;
- network and identity separation.

Exit criteria:

- clean installation and startup are reproducible;
- fast tests run on every change;
- VRSCTEST integration tests have a documented environment;
- failures do not silently weaken proof guarantees.

### Phase 6 — First vertical game slice

Build the complete first-game flow:

```text
VerusID login
    ↓
Practice or Daily Seed
    ↓
Daily attempt reserved atomically
    ↓
Required commitment confirmed
    ↓
Game played
    ↓
Actions validated authoritatively
    ↓
Result replayed or reproduced
    ↓
Proof published
    ↓
Leaderboard indexed
    ↓
Public verification
```

Exit criteria:

- Practice is unlimited and never enters ranked results;
- one VerusID cannot obtain a second ranked Daily attempt;
- an abandoned attempt cannot be selectively discarded;
- the exact game version and rules are recorded;
- a third party can verify the result without trusting the operational database.

### Phase 7 — Extensive VRSCTEST validation

Test at minimum:

- normal login and gameplay;
- concurrent attempts from two devices;
- a second Daily attempt;
- abandoned and timed-out attempts;
- browser and server restart;
- daemon and RPC failure;
- duplicate requests and jobs;
- modified actions and forged scores;
- wrong game or validator version;
- transaction uncertainty;
- chain reorganization;
- index loss and complete rebuild;
- independent proof verification;
- multi-day automatic round rotation;
- load, security, accessibility, and mobile-layout behavior.

Deliverable:

- a VRSCTEST evidence package with cases, versions, sanitized logs, transaction IDs,
  block heights, results, deviations, and sign-off.

Exit criteria:

- all release acceptance tests pass;
- no critical security issue remains open;
- recovery and rollback have been demonstrated;
- relevant chain transactions are confirmed and independently verified.

### Phase 8 — Closed web pilot

Operate one game with a small group on VRSCTEST for multiple weeks.

Measure:

- login completion and failure;
- completed and abandoned games;
- replay-validation failures;
- transaction cost and latency;
- pending and failed chain writes;
- Daily return rate;
- verifier use;
- attempted abuse and operational incidents.

Exit criteria:

- the core loop is reliable under real usage;
- costs and operational load are understood;
- pilot feedback does not require a fundamental redesign.

### Phase 9 — Mobile applications

After the web core is stable:

- improve the PWA;
- add Capacitor;
- implement Android internal testing;
- implement secure token storage;
- test Verus Mobile deep links and return flows;
- implement iOS and TestFlight;
- run a device, OS, wallet, and lifecycle test matrix.

Exit criteria:

- identity and game semantics match the web application;
- no secrets are present in application bundles;
- deep links, interruption, upgrades, and rollback are tested.

### Phase 10 — Community games

After the first game establishes the real platform contract:

- extract the minimal game SDK;
- publish a small game template;
- build a second simple game through that public interface;
- provide common conformance, replay, anti-cheat, accessibility, and resource tests;
- add a VRSCTEST staging catalog;
- document review and approval.

Exit criteria:

- a contributor can add a game without backend, wallet, secret, filesystem, or direct
  RPC access;
- the second game does not require copied platform logic;
- every game passes the same ranked-mode guarantees.

### Phase 11 — VRSC and PBaaS decision

Use real measurements to decide whether to:

- remain on VRSC;
- use hybrid storage;
- use an existing PBaaS chain;
- launch a dedicated Arcade PBaaS chain.

No mainnet or PBaaS launch occurs without its own security review, operational plan,
cost model, VRSCTEST shadow release, recovery exercise, and explicit go/no-go decision.

## 3. Immediate work queue

The active sequence is:

1. Complete the baseline audit.
2. Write the MVP specification.
3. Record the minimum architecture decisions.
4. Implement and execute the Storage PoC.
5. Build the technical foundation.
6. Deliver the first complete vertical game slice.

Only after this sequence succeeds do we begin mobile packaging or community-game work.

## 4. Working rules

- Repository documentation, code, comments, tests, and UI copy are written in English.
- Conversation and planning with the project owner may remain in Dutch.
- VRSCTEST is the default and mandatory proving environment.
- Mainnet writes are disabled by default.
- Tests are part of implementation, not a later cleanup phase.
- A feature is incomplete until its failure, retry, recovery, and verification paths
  are tested.
- Proof claims shown to users must match what the system actually guarantees.
- Existing user work and unrelated repository changes are preserved.
- Decisions based on uncertain Verus behavior are validated experimentally.
