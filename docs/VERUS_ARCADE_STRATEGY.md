# Verus Arcade — Strategy, Architecture, and Delivery Plan

Status: living document  
Version: 0.1  
Primary environment: VRSCTEST  
Target platforms: web, Android, and iOS

## 1. Executive summary

Verus Arcade will be a gaming platform for simple, accessible, and, wherever possible,
provably fair games. VerusID will provide player identity. VDXF will define the data
exchanged by games, players, and third-party applications. Verus, or potentially a
Verus PBaaS chain, will hold permanent and proof-worthy state.

Temporary or frequently changing data may be processed outside the blockchain when
doing so does not weaken verification of final results. An operational database may
serve as an index and cache, but it must not silently become the only source of truth
for records that the product claims are permanent or independently verifiable.

The project will progress through three network stages:

1. Development and extensive integration testing on VRSCTEST.
2. A limited and explicitly approved introduction on VRSC.
3. If measurements justify it, the launch or adoption of a dedicated PBaaS chain.

No blockchain feature will go directly to mainnet. Every feature must first complete a
documented and reproducible VRSCTEST test path. This includes VerusID login, identity
updates, VDXF, storage, payments, rewards, game commitments, replays, cross-chain
references, and any future PBaaS functionality.

The repository already contains a testnet MVP:

- a SvelteKit frontend;
- a Node/Express backend;
- VerusID login using a QR code and deep link;
- a daily word game;
- a VDXF and `contentmultimap` commit/reveal mechanism;
- a verification page for completed rounds.

This MVP is a research foundation, not a production architecture. The first objective
is to make it secure, testable, modular, observable, and recoverable.

## 2. Product vision

Verus Arcade should feel like a simple game arcade rather than a blockchain interface.
A player signs in with a VerusID, chooses a game, and starts playing. The blockchain
layer provides identity, ownership, proof, and portability while remaining in the
background during ordinary gameplay.

The primary product purpose is to showcase real Verus capabilities through a coherent
and enjoyable application. Each feature must demonstrate something concrete, such as
VerusID authentication, VDXF schemas, on-chain data, signatures, commitments,
verification, privacy, payments, recovery, or cross-chain interoperability.

The project launches with one game and makes it complete, secure, understandable, and
well tested before adding another. The shared platform contract is extracted from the
needs of that real game and is proven by adding a second game later.

### 2.1 Player value

- One self-sovereign VerusID across all games.
- No conventional password or centrally owned player account.
- Verifiable rounds, scores, and achievements.
- Portable profiles and achievements using documented VDXF schemas.
- A consistent experience across web, Android, and iOS.
- Clear disclosure of which data is public, encrypted, temporary, or permanent.

### 2.2 Game developer value

- A shared SDK for login, scores, achievements, and verification.
- Reusable and versioned VDXF schemas.
- A standard game lifecycle.
- A clean separation between fast gameplay and final proof.
- A low-friction path for community-built games that follow the same rules.
- Shared anti-cheat, validation, replay, and test infrastructure.

### 2.3 Verus ecosystem value

- A visible consumer application built around VerusID, VDXF, and native storage.
- Reproducible examples of Verus integration.
- Open and documented data schemas.
- A practical evaluation of Verus storage and, if justified, PBaaS.

## 3. Core principles

### 3.1 Verus-first, not on-chain for its own sake

Verus is the preferred layer for identity, proof-worthy data, and permanent public
state. Not every UI action or temporary state belongs on a blockchain. Every data type
must have an explicit reason for being on-chain.

### 3.2 VRSCTEST before every mainnet feature

Every Verus integration is built on VRSCTEST first. It is tested automatically where
possible and manually where wallet interaction is required. The test evidence includes
transaction IDs, inputs, sanitized outputs, expected behavior, and failure behavior.

### 3.3 No silent degradation of proof

If a game promises that a round was committed on-chain before play, the round must not
continue as normal when that commit fails. The application must:

- wait and retry;
- enter an explicit pending or maintenance state; or
- offer an unranked practice round that makes no proof claim.

An unprovable round must never be presented as provable.

### 3.4 Chain as authority, index as acceleration

The chain is authoritative for permanent records. SQLite, PostgreSQL, or another index
may accelerate searches and leaderboards, but proof-worthy state must be rebuildable
from chain data.

### 3.5 Privacy through data minimization

Public blockchain data is effectively permanent. Personal data, session secrets, IP
addresses, email addresses, and moderation records must never be published on-chain
without a compelling and reviewed reason. Encryption does not make permanent data
deletable.

### 3.6 Portable core

Game rules and domain logic are platform-independent. Web, Android, and iOS share the
same components, types, validation, and tests wherever practical.

### 3.7 Measure before choosing

The choice between VRSC, an existing PBaaS chain, and a dedicated PBaaS chain will be
based on measured transaction size, fees, confirmation time, retrieval performance,
indexing, operational burden, and expected usage.

### 3.8 Simple games, strong integrity

The initial catalog deliberately favors small games with limited state, deterministic
rules, short sessions, and outcomes that the server or an independent verifier can
reproduce. Complexity is added only after the shared anti-cheat and verification model
has proved reliable.

Anti-cheat is a platform concern rather than a collection of unrelated fixes inside
individual games. Every ranked game uses the same identity, session, action-validation,
rate-limit, replay, result-signing, versioning, and audit mechanisms.

## 4. Scope

### 4.1 First product release

- VerusID login through Verus Mobile.
- A catalog shell containing one complete game.
- One production-ready daily word game.
- A documented minimal game contract and sample game.
- Shared server-authoritative validation and anti-cheat controls.
- Shared Practice and Daily Seed modes.
- Guest or practice mode without ranked on-chain achievements.
- Public round verification.
- An opt-in player profile.
- Leaderboards, streaks, and a small set of achievements.
- A web application and installable PWA.
- Android and iOS wrappers around the shared application.
- VRSCTEST explorer links and diagnostics.
- A rebuildable chain index.

### 4.2 Later scope

- Multiple small, deterministic games.
- Seasons and tournaments.
- Multiplayer.
- A community game SDK, templates, validator, and review workflow.
- Rewards, currencies, or paid features.
- Cross-chain data and assets.
- A dedicated PBaaS chain if evaluation is positive.

### 4.3 Outside the initial scope

- Gambling or wagering.
- Custodial wallets or custody of player private keys.
- Untested mainnet transactions.
- A PBaaS launch before storage and volume measurements.
- A token economy without separate legal, economic, and security analysis.

## 5. Logical architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Clients                                                      │
│ SvelteKit web/PWA │ Capacitor Android │ Capacitor iOS        │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼───────────────────────────────┐
│ Arcade API                                                   │
│ Auth │ Game sessions │ Validation │ Results │ Administration│
└──────────────┬───────────────────────┬───────────────────────┘
               │                       │
┌──────────────▼──────────────┐  ┌─────▼──────────────────────┐
│ Verus gateway              │  │ Operational data           │
│ RPC adapter                │  │ Sessions/cache/index/jobs  │
│ transaction writer/reader  │  │ SQLite → optional PG       │
│ chain configuration        │  └────────────────────────────┘
└──────────────┬──────────────┘
               │ JSON-RPC
┌──────────────▼───────────────────────────────────────────────┐
│ verusd: VRSCTEST first, later explicitly VRSC or PBaaS       │
│ VerusID │ VDXF │ contentmultimap │ files │ proofs           │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 Client architecture

SvelteKit remains the shared frontend. Capacitor is the proposed packaging layer for
Android and iOS. Platform adapters handle:

- wallet deep links;
- returning from Verus Mobile to Arcade;
- secure local token storage;
- application lifecycle and network recovery;
- push notifications;
- store metadata and app signing.

Game code must not call Verus RPC directly. Clients use typed Arcade APIs or, for public
verification, a read-only verification gateway.

### 5.2 Arcade API

The API is logically divided into:

- **Auth service:** challenges, wallet callbacks, verification, sessions, and logout.
- **Game service:** catalog, rounds, actions, validation, and final results.
- **Proof service:** commitments, reveals, result bundles, hashes, and verification.
- **Profile service:** opt-in profiles, achievements, and preferences.
- **Indexer:** reads relevant identity and transaction data into query models.
- **Job runner:** retries, confirmation tracking, round rotation, and index rebuilds.
- **Admin service:** health, game publication, incidents, and controlled rollouts.

These can initially run as one modular process. Separate microservices are only
introduced when scale, fault isolation, or team structure demonstrably requires them.

### 5.3 Verus gateway

All chain-specific code is placed behind one interface:

```ts
interface ArcadeChain {
  createLoginChallenge(input: LoginRequest): Promise<LoginChallenge>;
  verifyLogin(result: WalletResult): Promise<VerifiedIdentity>;
  publishRoundCommit(commit: RoundCommit): Promise<ChainReceipt>;
  publishRoundResult(result: FinalRoundBundle): Promise<ChainReceipt>;
  storeObject(object: StorageObject): Promise<ChainReceipt>;
  retrieveObject(reference: ChainDataRef): Promise<StoredObject>;
  getTransactionStatus(txid: string): Promise<TransactionStatus>;
}
```

Network configuration—chain, operator identity, VDXF keys, RPC endpoint, confirmation
policy, and explorer—is not hardcoded in game logic. Every response and stored
reference includes a chain ID so testnet and mainnet data cannot be confused.

## 6. Data architecture

### 6.1 Data classification

| Class | Examples | Primary storage |
|---|---|---|
| Identity | i-address, VerusID name, public profile reference | Verus |
| Schemas | game, score, achievement, and replay types | VDXF/Verus |
| Proof | commit, reveal, result root, game version | Verus |
| Final records | season results, important achievements | Verus |
| Large proof objects | replay, score bundle, asset manifest | evaluate on Verus |
| Active state | moves, timer, pending result | operational storage |
| Session secrets | challenges, bearer/refresh tokens | encrypted temporary storage |
| Query models | leaderboard, catalog, rendered profile | rebuildable index |
| Abuse controls | rate limits and risk signals | private temporary storage |
| Media | images, audio, application builds | object storage or tested chain storage |

### 6.2 PostgreSQL, SQLite, and Verus

PostgreSQL is not a replacement for Verus. It is a fast relational database for
frequently changing state and complex queries. SQLite can be sufficient during early
development for operational state and a local index. PostgreSQL is introduced when
concurrency, hosting, replication, or query volume requires it.

The design rule is:

> SQLite or PostgreSQL may disappear without losing identity, final proofs, or
> important permanent results.

Not all operational state can or should be recovered from the chain. Temporary
sessions, rate limits, and unfinished games may expire or follow explicit recovery
rules.

### 6.3 Proposed VDXF namespace

Final names and keys will be derived and documented on VRSCTEST. A candidate schema is:

```text
arcade::schema.game
arcade::schema.round
arcade::schema.score
arcade::schema.achievement
arcade::schema.replay
arcade::game.definition
arcade::round.commit
arcade::round.reveal
arcade::round.results
arcade::season.root
arcade::player.profile
arcade::player.achievement
```

Every object contains at least:

- `schemaVersion`;
- `chain`;
- `gameId`;
- `gameVersion`;
- a stable identifier;
- creation or validity time;
- a payload or content reference;
- relevant hashes;
- producer or operator identity;
- a privacy classification.

JSON canonicalization must be specified before hashes are calculated. Without canonical
serialization, semantically identical objects can produce different hashes.

### 6.4 Game and result model

A game definition describes the rules, client version, proof strategy, and score
function. Every round refers to the exact game version.

```text
GameDefinition
  └─ RoundCommit
       ├─ commitHash
       ├─ gameVersion
       ├─ opensAt / closesAt
       └─ randomness commitment

RoundResult
  ├─ reveal
  ├─ canonical result bundle
  ├─ resultsHash or Merkle root
  └─ commit transaction reference
```

Individual player actions do not all need to be on-chain. A result bundle may contain
individual records or publish a Merkle root, allowing each player to verify their own
record using an inclusion proof.

### 6.5 Indexer and reconstruction

The indexer:

1. stores a chain cursor or block height;
2. reads only relevant identities, VDXF keys, and transactions;
3. validates schema and hashes;
4. handles confirmations and reorganizations;
5. builds query tables;
6. supports a complete rebuild;
7. marks invalid or incomplete data without rewriting the source.

A complete rebuild is a regular test, not merely an emergency procedure.

## 7. Verus Storage Proof of Concept

The storage PoC is a formal project milestone and runs entirely on VRSCTEST. Its goal
is to determine which native storage capabilities are reproducible, suitable, and
operationally manageable for Arcade.

### 7.1 Test objects

At minimum, store and retrieve:

1. A small VDXF game-definition object.
2. A JSON score object with schema and hash.
3. A small text or image file.
4. An object larger than the practical inline limit.
5. An encrypted object for a controlled recipient.
6. Multiple versions under one identity and VDXF namespace.
7. A cross-chain data reference when an appropriate test chain is available.

### 7.2 RPC paths to investigate

- `getvdxfid`
- `updateidentity`
- `getidentity`
- `signdata`
- `getidentitycontent`
- relevant transaction and proof RPCs

Exact parameters will be tied to the daemon version under test. Community claims about
chunking, Merkle Mountain Ranges, encryption, and large files remain hypotheses until
the selected version reproduces them on VRSCTEST.

### 7.3 Measurements

Record for every test:

- daemon and protocol version;
- chain and block height;
- source file and SHA-256;
- logical and serialized size;
- RPC input, sanitized output, and errors;
- transaction size and fee;
- transaction ID, confirmations, and time until retrieval;
- number of transactions, outputs, or chunks;
- warm and cold retrieval time;
- reconstructed hash;
- behavior after restart and index rebuild;
- interruption, retry, and duplicate-submit behavior;
- encryption/decryption and wrong-key behavior;
- explorer and local RPC visibility.

### 7.4 Failure tests

- Invalid VDXF key.
- Invalid schema or MIME type.
- Data immediately below, at, and above practical limits.
- RPC unavailable before submission.
- RPC lost after a transaction may have been submitted.
- Insufficient funds.
- Unconfirmed and conflicting transactions.
- Update attempted by an unauthorized identity.
- Corrupt chunk or incorrect ordering.
- Retrieval from a clean second node.
- Identity update that would overwrite existing `contentmultimap` values.
- Duplicate idempotency key.

### 7.5 Acceptance criteria

The PoC succeeds only when:

- every test object is returned byte-identically or canonically equivalent;
- hashes are checked automatically;
- failed actions can resume safely and idempotently;
- existing identity content is not accidentally removed;
- fees and latency have been measured;
- retrieval from an independent or clean node is demonstrated;
- privacy claims are tested with negative cases;
- scripts and documentation make all tests reproducible;
- each data class has a clear on-chain, indexed, or external placement.

The outcome is an Architecture Decision Record selecting one of:

- native Verus storage as primary object storage;
- native storage only for small or proof-worthy objects;
- hybrid storage with on-chain hashes and references;
- further testing on a PBaaS test chain.

## 8. Authentication and sessions

### 8.1 Login flow

1. The client requests a single-use challenge.
2. The server binds it to origin, chain, nonce, and short expiry.
3. Verus Mobile displays the request and identity.
4. The wallet approves and signs or confirms the request.
5. The server verifies the chain, challenge, signature, and identity status.
6. The server issues a short session and a rotatable refresh mechanism.
7. Logout and revocation invalidate local sessions.

### 8.2 Security requirements

- Nonces are cryptographically random and single-use.
- Challenges expire quickly.
- Tokens are stored hashed or encrypted.
- Mobile applications use platform secure storage.
- Web cookies are `HttpOnly`, `Secure`, and `SameSite` where practical.
- Sessions have absolute and inactivity expiration.
- Chain and identity i-address are part of the authenticated principal.
- Friendly names are display data, not authorization identifiers.
- Identity revocation, recovery, and key rotation are tested.
- Private keys never enter the browser, app server, or analytics.

## 9. Game platform

The first games remain intentionally simple. A small ruleset is easier to understand,
test, replay, secure, and verify than a feature-heavy game. A proposed game is suitable
for ranked play only when its authoritative state transitions and final score can be
validated without trusting values calculated exclusively by the client.

### 9.1 Game contract

Every game implements a common contract:

```ts
interface ArcadeGame {
  metadata: GameMetadata;
  createRound(seedOrCommitment: unknown): Round;
  validateAction(state: unknown, action: unknown): ValidationResult;
  applyAction(state: unknown, action: unknown): unknown;
  finalize(state: unknown): CanonicalResult;
  verify(input: VerificationBundle): VerificationResult;
}
```

A client cannot be the sole authority for a score. The server validates or reproduces
the outcome. A deterministic game must produce the same final hash from the same start
state and action replay.

The production contract will also define:

- a stable `gameId` and semantic `gameVersion`;
- a manifest with name, description, icon, permissions, and supported platforms;
- JSON schemas for configuration, actions, state, replay, and final result;
- maximum action count, payload size, and session duration;
- a declared randomness and fairness model;
- deterministic serialization and hashing;
- server-side validation hooks;
- replay and verification fixtures;
- compatibility and migration behavior;
- accessibility and localization metadata.

### 9.2 Shared game modes

Modes are platform concepts with identical names and guarantees across games. A game
declares which supported modes it implements; it cannot redefine their meaning.

#### Practice

Practice is unlimited and may be played anonymously.

- A fresh seed is generated for every session.
- It does not affect the ranked leaderboard or Daily streak.
- It requires no permanent chain write.
- Players can restart immediately.
- Hints, solutions, and replay tools may be more freely available.
- Practice milestones are local unless a specific permanent achievement policy exists.

Practice is the onboarding mode and remains available when ranked or chain services are
temporarily unavailable.

#### Daily Seed

Daily Seed is the initial competitive mode.

- Every game has one canonical seed or puzzle definition per UTC date.
- Every eligible VerusID receives at most one ranked attempt per game and date.
- VerusID login is required before an attempt is reserved.
- The server atomically reserves the attempt before returning playable hidden data.
- Starting and abandoning an attempt still consumes it.
- Game version, date, commitment, attempt status, actions, score, and proof references
  form the verifiable result.
- A retry is permitted only for a proven platform failure and creates an audited event.

The daily definition is committed before play and revealed according to the selected
fairness model. A deterministic replay must reproduce the result from the seed and
canonical action log.

A shared seed has a known limitation: players can share solutions or inspect an
open-source deterministic engine. Server-authoritative validation prevents forged
actions and scores, but cannot prevent cooperation or prior knowledge. The first Daily
mode therefore showcases reproducibility and transparent proof without claiming perfect
spoiler resistance.

#### Challenge Seed

Challenge Seed is the preferred third mode, but is not required for the first release.

- A player shares a deterministic seed through a link.
- Friends receive the same puzzle and compare verified replays or scores.
- It is separate from the global Daily leaderboard and streak.
- Challenge metadata is signed or server-issued so identities and scores cannot be
  substituted in a shared URL.
- It requires no chain write initially; a challenge can later be anchored by hash.

This adds social play without real-time multiplayer and is directly inspired by the
legacy project's shareable practice seeds.

#### Archive and Replay

Archive is a verification feature rather than a competitive mode. After a Daily closes,
players can inspect its reveal, replay a submitted action log, verify the commitment and
result, and optionally play the historical puzzle unranked. Historical play never
changes the original leaderboard.

#### Deferred modes

- **Personal Daily:** a deterministic seed derived from date and VerusID. It reduces
  simple solution sharing but requires difficulty normalization for fair comparison.
- **Event/Tournament:** time-limited seed sets with separate entry and settlement rules.
- **Multiplayer:** deferred because coordination, disconnects, hidden information, and
  disputes materially expand the trust model.

The initial application implements only Practice and Daily Seed. Challenge Seed is the
first optional extension. Adding more modes before the first game is stable is out of
scope.

### 9.3 Anti-cheat model

No browser or mobile client can be made fully trustworthy. Obfuscated code, hidden
values, client clocks, and local storage are not security boundaries. Ranked play is
therefore server-authoritative.

Shared controls include:

- the server creates the authoritative round and session;
- every action is authenticated, ordered, bounded, and schema-validated;
- actions include a round/session reference and monotonic sequence number;
- duplicate, late, impossible, or out-of-order actions are rejected;
- time-sensitive values use server time, with measured network tolerance;
- random inputs or hidden answers never depend on client-generated randomness alone;
- commits are confirmed according to policy before ranked play opens;
- score calculation runs in trusted server code and, where possible, in the verifier;
- canonical action logs enable deterministic replay;
- rate limits apply per session, identity, IP risk bucket, and game;
- impossible-state and statistical anomaly signals are recorded privately;
- suspicious results can be quarantined before permanent publication;
- every result records the exact game and validator version;
- an independent verification path checks the final proof.

Anti-cheat does not mean collecting excessive personal data. Signals must be
proportionate, retained for a defined period, and kept out of public on-chain records.
The platform should prefer structural prevention and deterministic verification over
opaque player profiling.

Practice mode may run with lighter controls, but its results never enter ranked
leaderboards or permanent achievements.

One-attempt enforcement uses a server-side unique constraint equivalent to
`(chainId, playerIAddress, gameId, gameVersion, utcDate, mode)`. Attempt reservation and
session issuance occur atomically. Client storage is never authoritative for whether a
Daily Seed has already been played.

### 9.4 Early game categories

- Daily word and logic games.
- Trivia.
- Memory.
- Sudoku and number puzzles.
- Mines-style puzzles without wagering.

Games involving payment, chance-based prizes, or tradable rewards require a separate
legal, economic, and security phase.

Reaction, real-time physics, and latency-sensitive competitive games are postponed
because their anti-cheat and fairness models are substantially harder.

### 9.5 Fairness models

- **Commit/reveal:** commit to a hidden answer or seed before play.
- **Deterministic replay:** reproduce actions from a known initial state.
- **Result bundle and Merkle root:** anchor many scores efficiently.
- **Signed attestation:** the operator or game engine attests to a measurement that
  cannot be reproduced fully.

The interface must explain which model applies and what a verifier does and does not
prove.

### 9.6 Community game model

Community members should be able to add games without receiving access to the Arcade
backend, wallet, secrets, or unrestricted server execution. The contribution path is
repository-based and uses a constrained SDK.

A community game package contains:

```text
community-game/
├─ arcade-game.json
├─ src/
│  ├─ game.ts
│  ├─ validator.ts
│  └─ verifier.ts
├─ tests/
│  ├─ rules.test.ts
│  ├─ anti-cheat.test.ts
│  └─ fixtures/
├─ assets/
├─ README.md
└─ LICENSE
```

All games follow the same contribution rules:

- keep the initial ruleset and dependency set small;
- use the Arcade SDK instead of direct wallet, database, filesystem, or RPC access;
- declare every permission and external resource;
- provide deterministic validation where the game model permits it;
- never trust a client-provided score, duration, seed, or completion flag;
- include valid, invalid, boundary, replay, and tampering tests;
- pass common security, accessibility, performance, and VRSCTEST test suites;
- use licensed assets and declare their provenance;
- contain no advertising, tracking, hidden network calls, or secrets;
- avoid gambling, wagering, deceptive mechanics, and unreviewed financial rewards;
- document scoring, fairness guarantees, known limitations, and data use;
- follow schema, versioning, localization, and UI conventions;
- accept code review and automated validation before publication.

The preferred early distribution model is source-reviewed and built by Arcade CI.
Uploading arbitrary executable bundles is out of scope. Third-party code must run in a
restricted browser sandbox or a deliberately constrained runtime. It cannot make direct
chain writes; it requests approved capabilities through the Arcade host.

### 9.7 Community game lifecycle

1. A contributor starts from the official minimal template.
2. A local validator checks the manifest, schemas, permissions, and required tests.
3. CI runs the shared game conformance and anti-cheat suites.
4. Maintainers review code, assets, licenses, UX, and proof claims.
5. The game is deployed to an isolated VRSCTEST staging catalog.
6. Testers attempt normal play, replay, tampering, interruption, and abuse scenarios.
7. An approved version is signed and added to the catalog.
8. Updates repeat the process and receive a new immutable version.
9. A kill switch can hide a vulnerable version from new sessions without rewriting
   historical proofs.

Community publication is permissioned initially. A more decentralized registry may be
considered later, but it must not remove the security boundary between untrusted game
code and platform or wallet capabilities.

### 9.8 Game acceptance checklist

A game can enter the ranked catalog only when:

- rules and scoring are unambiguous;
- authoritative validation does not trust the client;
- replay fixtures reproduce the expected final state;
- tampered actions and forged scores are rejected;
- resource limits prevent abusive CPU, memory, storage, and network use;
- proof and on-chain data requirements are documented;
- all shared test suites pass on VRSCTEST;
- accessibility and mobile layouts pass review;
- dependencies, licenses, and assets pass review;
- version rollback and historical verification are supported.

### 9.9 Lessons retained from the legacy project

The `mrrager15/verus-arcade-legacy` repository is a valuable design reference, not a
codebase to copy without review. Ideas worth retaining include:

- deterministic engines driven by a seed and compact action log;
- `replay(seed, actions)` as a client/server/verifier invariant;
- shared Practice and Daily scaffolding;
- a game registry instead of hardcoded navigation;
- one package per game;
- shareable challenge seeds;
- common and game-specific achievements;
- server-side replay validation;
- explorer links that make proofs tangible;
- contribution documentation and conformance tests.

Several legacy choices require renewed security analysis:

- browser-held signing keys;
- decrypted signing material passing through a server endpoint;
- client-side advisory validation;
- pre-signed `nLockTime` forfeit transactions;
- per-player SubID creation and authority design;
- direct identity updates for every result.

The legacy anti-dodge forfeit attempted to stop players from saving only good Daily
results. The new architecture first addresses this with an atomic server-side attempt
reservation and an explicit abandoned result. A non-custodial on-chain forfeit may be
evaluated separately on VRSCTEST if stronger enforcement is later required.

## 10. Test strategy

### 10.1 Mandatory policy

Everything we build is tested thoroughly. All blockchain functionality is also tested
on VRSCTEST before any mainnet use. Mainnet configuration is disabled by default and
requires a deliberate release decision.

### 10.2 Test layers

1. **Unit tests**
   - canonicalization, hashing, and score calculation;
   - duplicate-letter behavior in the word game;
   - schema validation;
   - state transitions;
   - fee and confirmation logic;
   - session expiration.

2. **Property-based tests**
   - determinism;
   - replay equivalence;
   - serialization round trips;
   - invariants such as maximum actions;
   - idempotent processing.

3. **Contract tests**
   - client/API types;
   - Verus gateway behavior;
   - RPC fixtures per daemon version;
   - VDXF version compatibility.

4. **Integration tests**
   - API and operational storage;
   - job runner and retries;
   - verusd on VRSCTEST;
   - identity update and retrieval;
   - complete index rebuild.

5. **End-to-end tests**
   - browser login with a manual wallet step;
   - session restoration;
   - a complete game;
   - commit, reveal, and public verification;
   - Android/iOS deep-link and app-return behavior.

6. **Security tests**
   - replayed login challenges;
   - forged callbacks;
   - authorization bypass;
   - rate limits;
   - input fuzzing;
   - token leakage;
   - dependency and secret scans.

7. **Resilience tests**
   - daemon offline;
   - network partition;
   - server restart during a round;
   - duplicate jobs;
   - database loss and rebuild;
   - chain reorganization;
   - full disk and corrupt cache.

8. **Performance tests**
   - concurrent players;
   - leaderboard queries;
   - RPC backpressure;
   - index catch-up;
   - storage size and retrieval performance.

9. **Accessibility and UX**
   - keyboard navigation;
   - screen readers;
   - contrast;
   - small screens;
   - slow networks;
   - clear pending, confirmed, and failed states.

### 10.3 VRSCTEST evidence package

Every blockchain feature receives a test package containing:

- requirement and risk;
- test cases;
- version and configuration;
- test identity and VDXF keys;
- transaction IDs and block heights;
- sanitized logs;
- outcomes and deviations;
- reproducible scripts;
- explicit sign-off.

Test identities and funds remain separate from future production identities. Private
keys and RPC credentials never enter Git.

### 10.4 CI and network-bound tests

Fast tests run on every change. Tests that require a daemon, wallet, or VRSCTEST
transaction run in a controlled integration environment and must not be silently
skipped. CI reports separately on:

- fast test suite;
- integration suite;
- VRSCTEST suite;
- mobile builds;
- security checks.

### 10.5 Release gates

A phase is not complete merely because it works on one developer machine. At minimum:

- all acceptance criteria pass;
- no critical security issue remains open;
- rollback is documented;
- recovery has been tested;
- relevant VRSCTEST transactions are confirmed and verified;
- monitoring exists;
- known limitations are communicated.

## 11. Environments and configuration

| Environment | Chain | Purpose |
|---|---|---|
| Local | mocks or isolated fixtures | fast development |
| Integration | VRSCTEST node/wallet | real RPC integration |
| Staging | VRSCTEST | production-like complete application |
| Production pilot | initially VRSCTEST | controlled user pilot |
| Mainnet | VRSC | only after formal approval |
| PBaaS | test chain, then production | only after separate evaluation |

Configuration fails closed:

- VRSCTEST is the default chain;
- builds accept only allowlisted chain IDs;
- the UI displays the active network prominently;
- mainnet writes require separate secrets, configuration, and release approval;
- test and production identities do not share wallet or RPC configuration.

## 12. Delivery phases

### Phase 0 — Baseline and safety net

Objectives:

- reproduce the current MVP;
- inventory dependencies, configuration, and data flows;
- document existing bugs and risks;
- establish unit and integration testing;
- enforce VRSCTEST as the safe default.

Work:

- extract hardcoded configuration;
- add type and schema validation;
- replace JSON persistence with a storage interface;
- add session expiration and secure storage;
- block ranked play or enter practice mode when commitments fail;
- add health checks, structured logs, CI, tests, and builds.

Exit criteria:

- clean installation and documented startup;
- testable login and game flows;
- no ranked round without the required proof state;
- restart recovery is tested.

### Phase 1 — Verus Storage PoC and VDXF model

Objectives:

- measure native storage capabilities;
- define VDXF namespace and schema version 1;
- build an indexer prototype.

Work:

- execute all tests in section 7;
- define canonicalization and hashing;
- implement safe merge/update behavior for `contentmultimap`;
- prove independent retrieval and verification;
- write the storage ADR.

Exit criteria:

- reproducible storage report;
- scripts and transaction IDs;
- schema version 1;
- an explicit placement decision for every data class.

### Phase 2 — Arcade Core

Objectives:

- deliver a game-independent platform core;
- provide robust authentication, rounds, proofs, and indexing.

Work:

- implement game contracts and registry;
- implement the chain gateway;
- add job queue and idempotency;
- add profile, achievement, and leaderboard read models;
- implement index rebuild;
- add administration and incident state.

Exit criteria:

- a second dummy game can be added without copying platform logic;
- the chain index rebuilds from zero;
- authentication and proof security tests pass.

### Phase 3 — First production-ready game

Objectives:

- complete the word game;
- complete Practice and one-attempt Daily Seed modes;
- make public verification independent;
- operate a closed VRSCTEST pilot.

Work:

- define dictionary and language policy;
- complete the round lifecycle;
- implement atomic Daily attempt reservation and abandoned-attempt handling;
- implement canonical Daily seed commitment and reveal;
- add streaks and achievements;
- add replay or result bundles;
- complete accessibility and mobile layouts;
- run load, resilience, and fraud tests.

Exit criteria:

- multi-day automatic VRSCTEST rounds run without data loss;
- a VerusID cannot obtain a second ranked attempt for the same Daily Seed;
- restart, multi-device, concurrent-request, and abandoned-attempt tests pass;
- every ranked round is provable;
- an independent verifier works;
- pilot feedback has been addressed.

### Phase 4 — Web/PWA and mobile applications

Objectives:

- production-ready web/PWA;
- Android and iOS test builds.

Work:

- add Capacitor;
- configure universal/app links;
- use secure token storage;
- implement wallet return flow;
- design offline and pending-state UX;
- ship Android internal testing;
- ship iOS TestFlight;
- satisfy platform privacy and store requirements.

Exit criteria:

- the same account and game result work on every platform;
- deep links pass on a device matrix;
- application bundles contain no secrets;
- crash, update, and rollback behavior are tested.

### Phase 5 — Multiple games and platform SDK

Objectives:

- expand the catalog with small, deterministic games;
- stabilize a constrained community game interface;
- make common anti-cheat rules enforceable by tooling.

Work:

- add at least two games;
- publish a minimal community game template;
- define game manifests, schemas, capabilities, and permissions;
- build a local conformance validator and shared anti-cheat suite;
- isolate or sandbox untrusted game code;
- add source, dependency, asset, and license review;
- add a VRSCTEST staging catalog and approval workflow;
- define version and compatibility policy;
- publish developer documentation.

Exit criteria:

- a community contributor can build a game from the template without backend access;
- the game passes automated conformance, tampering, replay, and resource-limit tests;
- a reviewed game can progress through VRSCTEST staging into the catalog;
- incompatible game versions remain independently verifiable.

### Phase 6 — VRSC mainnet readiness

Requirements:

- complete security review;
- fee and capacity budget;
- privacy and legal review;
- operator identity with recovery and potentially multisig;
- wallet and key-management runbook;
- monitoring and incident response;
- VRSCTEST shadow release;
- explicit go/no-go decision.

Rollout order:

1. Read-only mainnet data.
2. Limited operator writes.
3. Opt-in player records.
4. Gradual expansion.

### Phase 7 — PBaaS evaluation

A dedicated chain is a business and infrastructure decision, not an ordinary deploy.

Evaluate:

- expected daily data volume and TPS;
- block time and confirmation goals;
- storage fees;
- mining, staking, and security budget;
- notarization and cross-chain behavior;
- node, explorer, seed, and monitoring infrastructure;
- chain upgrades;
- currency and reward design;
- liquidity and player migration;
- governance and incident authority;
- total operational cost.

Go criteria:

- VRSCTEST or VRSC presents a measured scale, cost, or product limitation;
- a PBaaS test chain passes the same storage, auth, proof, and recovery tests;
- multiple independent nodes or operators are arranged;
- a sustainable security and operating model exists;
- cross-chain references and migration are tested.

## 13. Security model

### 13.1 Assets

- Operator VerusID and wallet.
- Player identities and sessions.
- Unrevealed game secrets.
- Integrity of game code and versions.
- Jobs that create chain transactions.
- RPC credentials.
- Mobile signing keys.
- Index integrity and proof presentation.

### 13.2 Primary threats

- Stolen operator wallet.
- Forged or replayed login challenge.
- Score or game-client manipulation.
- Premature reveal.
- Duplicate or inconsistent chain writes.
- Content loss during identity updates.
- Testnet/mainnet confusion.
- Supply-chain compromise.
- Spam and denial of service.
- A verifier that misleadingly trusts only the Arcade server.
- Permanent publication of sensitive data.

### 13.3 Controls

- Separate signing from the application service.
- Grant minimum wallet permissions.
- Use multisig and recovery for production identities.
- Use idempotency keys and a transaction journal.
- Use secrets management.
- Pin and scan dependencies.
- Use canonical hashes and an independent read path.
- Apply rate limits and quotas.
- Keep secrets out of audit logs.
- Sign releases and mobile applications.
- Exercise restore and key recovery regularly.

## 14. Operations and observability

Measure at minimum:

- login success, failure, and expiry;
- active and completed games;
- chain RPC latency and errors;
- pending, confirmed, and failed transactions;
- confirmation time;
- job retries and dead letters;
- index lag in blocks;
- reconstruction and hash failures;
- storage fees and bytes;
- API latency and error rate;
- mobile crashes and deep-link failures.

Every chain write receives a transaction-journal entry with intent, idempotency key,
payload hash, chain, submission status, transaction ID, and confirmations. Monitoring
must not contain private keys, session tokens, or unrevealed answers.

Required runbooks:

- daemon or RPC unavailable;
- stuck or unknown transaction;
- missed commitment;
- incorrect reveal;
- chain reorganization;
- corrupt index;
- lost operational database;
- operator identity recovery;
- security incident;
- mobile rollback.

## 15. Governance and change management

Important technical decisions are recorded as Architecture Decision Records:

- ADR-001: on-chain versus operational storage;
- ADR-002: canonical JSON or binary serialization;
- ADR-003: result bundles versus individual records;
- ADR-004: SQLite or PostgreSQL;
- ADR-005: session model;
- ADR-006: mobile wrapper;
- ADR-007: VRSC mainnet launch;
- ADR-008: PBaaS go/no-go.

VDXF schemas are versioned public contracts. Breaking changes receive a new key or
major `schemaVersion`. Historical verification code remains available while historical
records exist.

## 16. Risks and responses

| Risk | Response |
|---|---|
| On-chain storage is less practical than expected | Storage PoC and hybrid fallback |
| RPC behavior differs by version | Version pinning, contract tests, and fixtures |
| Mainnet fees or volume grow | Batching, Merkle roots, and PBaaS evaluation |
| Operator can influence results | Commit/reveal, deterministic replay, public verifier |
| Client cheating | Server validation, replay, and anomaly detection |
| Permanent privacy error | Data classification and review before every write |
| Identity update removes existing content | Read-merge-verify, concurrency control, tests |
| Daemon failure during a round | Transaction journal, retry, pending/practice mode |
| Mobile wallet return fails | Platform matrix, app links, recoverable polling |
| Dedicated PBaaS is operationally too heavy | No launch without measured need and operator plan |

## 17. Immediate backlog

1. Reproduce and document the current build, login, and complete game flow.
2. Select a test framework and add unit tests for scoring, hashing, and state.
3. Add centralized typed configuration with VRSCTEST as default.
4. Make the round lifecycle enforce its on-chain proof claim honestly.
5. Design session expiry, rotation, and revocation.
6. Introduce an operational storage interface.
7. Draft VDXF schema version 1.
8. Build storage PoC scripts and fixtures.
9. Build independent retrieval and hash verification.
10. Write the storage ADR from measured results.
11. Design the chain indexer and rebuild test.
12. Specify the minimal game manifest, contract, and validator.
13. Create the shared anti-cheat threat model and conformance test suite.
14. Specify Practice and Daily Seed as shared platform modes.
15. Implement atomic one-attempt Daily reservations and concurrency tests.
16. Build one complete game using only the public game SDK.
17. Add Challenge Seed only after the first game and Daily flow are stable.
18. Add Capacitor and mobile shells only after the core is stable.

## 18. Definition of success

Verus Arcade is technically successful when:

- a player can use VerusID without a centrally managed password;
- every ranked round fulfills its stated proof guarantee;
- Practice is unlimited while Daily Seed permits exactly one ranked attempt per
  VerusID, game, version, and UTC date;
- a third party can verify historical results without trusting the Arcade database;
- important data can be retrieved from Verus and the index can be rebuilt;
- web, Android, and iOS share the same identity and game semantics;
- ranked games never accept a client-provided result without authoritative validation;
- a community developer can add a simple game through documented, constrained APIs;
- every community game passes the same conformance, anti-cheat, and VRSCTEST gates;
- RPC failure, restart, or duplicate jobs cannot silently corrupt state;
- sensitive data is not accidentally published permanently;
- every mainnet feature has first been demonstrated on VRSCTEST;
- measured evidence supports the choice between VRSC and PBaaS.

## 19. Sources and verification status

Official and primary sources:

- Verus, “Store & Retrieve Data On-Chain”:  
  https://verus.io/build/data
- Verus PBaaS Documentation:  
  https://docs.verus.io/
- Verus protocol and PBaaS overview:  
  https://docs.verus.io/overview/
- Verus network economy and protocol fees:  
  https://docs.verus.io/economy/
- VerusCoin releases; tests must record the exact daemon version:  
  https://github.com/VerusCoin/VerusCoin/releases

Community and research sources:

- Verus Community developer hub and live demos:  
  https://verus.cx/
- Verus Community demo catalog:  
  https://verus.cx/dev/demos/
- Legacy Verus Arcade implementation and design reference:  
  https://github.com/mrrager15/verus-arcade-legacy
- AutoBB, “On-Chain File Storage”:  
  https://wiki.autobb.app/concepts/on-chain-file-storage/
- AutoBB, “The Hidden Power of Verus”:  
  https://wiki.autobb.app/introduction/the-hidden-power-of-verus/
- `vdappdev2/verus-pbaas-docs`:  
  https://github.com/vdappdev2/verus-pbaas-docs

Claims from community sources concerning maximum size, automatic chunking, Merkle
Mountain Ranges, encryption, and cross-chain retrieval are not treated as product
guarantees without testing. The Storage PoC will verify them against the exact
VRSCTEST daemon version in use. Official documentation describes VDXF indexing,
structured and unstructured data, encryption, PBaaS-dependent fees, and entries up to
999,999 bytes; the project will still measure these capabilities in its own integration.
