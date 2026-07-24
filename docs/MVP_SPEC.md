# Verus Arcade — MVP Specification

Status: draft for implementation  
Version: 0.1  
Primary network: VRSCTEST  
Target platform for MVP: responsive web/PWA  
First game working title: Word Grid  
Related documents:

- [VERUS_ARCADE_STRATEGY.md](VERUS_ARCADE_STRATEGY.md)
- [EXECUTION_PLAN.md](EXECUTION_PLAN.md)
- [BASELINE_AUDIT.md](BASELINE_AUDIT.md)
- [Architecture Decision Records](adr/README.md)

## 1. Purpose

This document defines the first complete, testable version of Verus Arcade. It is a
product and engineering contract: implementation is complete only when the behavior,
security properties, failure handling, and VRSCTEST acceptance criteria in this
document are satisfied.

The MVP demonstrates a small set of Verus capabilities through one understandable game:

- passwordless VerusID authentication;
- chain-bound player identity;
- a VDXF-described game and round format;
- an on-chain commitment before ranked play;
- an on-chain reveal after ranked play;
- deterministic result verification;
- a permanent result commitment;
- links to real VRSCTEST transactions;
- verification without trusting the operational Arcade database.

The MVP prioritizes correctness and honest proof claims over game count, visual scope,
token economics, or mainnet availability.

## 2. Product scope

### 2.1 Included

- One five-letter word deduction game.
- Unlimited Practice mode.
- One-attempt-per-day Daily Seed mode.
- VerusID login through Verus Mobile.
- VRSCTEST only.
- Server-authoritative Daily gameplay.
- Deterministic evaluation of guesses.
- A maximum of six Daily guesses.
- Resume of the same Daily attempt before the round closes.
- Daily leaderboard with tied ranks.
- Round commitment, reveal, and result commitment.
- Public verification page.
- Responsive web interface and installable PWA readiness.
- Structured application health and transaction state.
- Automated unit, integration, failure, and VRSCTEST tests.

### 2.2 Explicitly excluded

- VRSC mainnet writes.
- Android and iOS store releases.
- Multiple games.
- Community game uploads.
- Challenge Seed mode.
- Historical ranked play.
- Real-time multiplayer.
- Payments, entry fees, rewards, tokens, NFTs, or wagering.
- Player-created Verus SubIDs.
- Permanent on-chain player profiles.
- Public anti-cheat risk signals.
- Claims that cooperation, multiple identities, or shared answers are impossible.

## 3. Terminology

| Term | Meaning |
|---|---|
| Game | A versioned ruleset and validator |
| Game version | Immutable semantic version of rules, dictionary, scoring, and schemas |
| Round | One Daily instance of a game with a defined open/close window |
| Daily Seed | Ranked mode using the canonical daily puzzle definition |
| Practice | Unlimited unranked play |
| Attempt | One VerusID's stateful participation in one Daily round |
| Action | A canonical player input, such as a guess |
| Commitment | Hash published before ranked play that binds the hidden round definition |
| Reveal | Data published after close that opens the commitment |
| Result record | Canonical final outcome for one attempt |
| Result root | Commitment to the complete ordered set of final result records |
| Inclusion proof | Proof that a result record belongs to a published result root |
| Chain receipt | Chain, transaction ID, block height, confirmations, and payload hash |
| Verifier | Client code that reads proof material and checks it independently |

## 4. Users and primary journeys

### 4.1 Anonymous visitor

An anonymous visitor can:

- read the Arcade explanation;
- inspect the active Daily round and its commitment status;
- play unlimited Practice rounds;
- inspect public leaderboards;
- verify completed rounds;
- start VerusID login.

An anonymous visitor cannot:

- reserve a Daily attempt;
- appear in a ranked leaderboard;
- create permanent achievements.

### 4.2 Authenticated player

An authenticated player can:

- perform all anonymous actions;
- reserve today's Daily attempt once;
- submit guesses to that attempt;
- resume the same attempt on another authenticated device;
- view their final result and inclusion proof;
- verify the round and their result.

### 4.3 Operator

The operator can:

- prepare a future round;
- monitor chain publication and confirmations;
- pause opening before any attempt starts;
- invalidate a round before opening;
- mark a documented platform incident;
- rebuild the public index from authoritative records.

The operator cannot through an ordinary admin action:

- reset a player's failed or abandoned attempt silently;
- edit a confirmed commitment;
- change a result without producing a different result root;
- label an uncommitted round as ranked and verified;
- hide proof status from the user.

## 5. First game: Word Grid

“Word Grid” is a provisional original product name. Final naming and visual design must
avoid implying affiliation with another word-game trademark.

### 5.1 Rules

- The answer contains exactly five lowercase English letters `a-z`.
- The player has at most six guesses.
- A guess must contain exactly five letters and exist in the versioned allowed-guess
  dictionary.
- Feedback for each position is:
  - `correct`: letter and position match;
  - `present`: letter exists elsewhere, subject to duplicate-letter accounting;
  - `absent`: no unmatched occurrence remains.
- A round is solved when all five positions are `correct`.
- No guess can be removed or edited after acceptance.
- The game ends on solve, sixth accepted guess, explicit forfeit, or round close.

### 5.2 Versioned game definition

The immutable game definition contains:

```json
{
  "schemaVersion": 1,
  "gameId": "word-grid",
  "gameVersion": "1.0.0",
  "rulesVersion": 1,
  "answerLength": 5,
  "maxGuesses": 6,
  "language": "en",
  "answerDictionarySha256": "<hex>",
  "guessDictionarySha256": "<hex>",
  "validatorSha256": "<hex>",
  "scoringVersion": 1,
  "proofModel": "commit-reveal-result-root"
}
```

Changing rules, normalization, dictionaries, scoring, or canonical serialization
requires a new game version or schema version.

### 5.3 Score and ranking

The MVP deliberately avoids speed scoring.

The canonical score is:

```json
{
  "solved": true,
  "guessesUsed": 4
}
```

Ranking rules:

1. Solved attempts rank before unsolved attempts.
2. Fewer accepted guesses rank higher.
3. Equal outcomes receive the same rank.
4. Completion time does not break a skill tie.
5. Abandoned and forfeited attempts are recorded but are not placed above completed
   unsolved attempts.

The UI may order equal-ranked entries consistently for display, but must not imply that
display order is a better rank.

## 6. Shared modes

### 6.1 Practice

Practice is unlimited and available without login.

Properties:

- Every Practice session receives a fresh cryptographically random seed.
- Practice may run locally when no hidden server value is required.
- Practice results are not written to the ranked operational tables.
- Practice results are not published on-chain.
- Practice does not affect Daily attempt eligibility, rank, or streak.
- Restart is always available.
- The answer may be shown after completion or forfeit.
- Practice has no independent proof guarantee in the MVP.

The UI labels Practice as “unranked” and “not stored on-chain.”

### 6.2 Daily Seed

Daily Seed is ranked and requires VerusID.

Properties:

- One canonical round exists per UTC date and game version.
- Every chain-bound VerusID can reserve at most one attempt.
- Clicking “Start Daily” reserves the attempt and consumes daily eligibility.
- A player can resume that same attempt until it becomes terminal or the round closes.
- Closing the browser does not create a new attempt.
- Starting from another device resumes the existing state.
- A rejected or duplicate request does not consume an extra guess.
- An abandoned attempt remains part of the daily result set.
- Daily actions and scores are server-authoritative.

The uniqueness key is:

```text
(chainId, playerIAddress, gameId, gameVersion, roundId, mode)
```

For the MVP, `mode` is `daily`.

## 7. Time model

- All protocol times use UTC.
- Human-readable local time is presentation only.
- Server time is authoritative for open, close, expiry, and action acceptance.
- Database timestamps are stored as UTC instants.
- Chain block time is evidence, not the only application clock.

Recommended Daily schedule:

- Future round preparation: before `23:30 UTC`.
- Commitment submission: early enough to reach the configured confirmation threshold.
- Round opens: `00:00 UTC`, only if the commitment is confirmed.
- Round closes: next `00:00 UTC`.
- Reveal and result-root publication: after close and result finalization.

If confirmation is not sufficient at the scheduled open:

- the round remains `PENDING_COMMIT`;
- Daily cannot be reserved;
- Practice remains available;
- the UI explains the delay;
- the round may open late only under a predefined policy, or be cancelled;
- it is never silently treated as a normal full-day round.

The exact confirmation threshold is configuration, recorded in every test dossier and
shown by the verifier.

## 8. Round state machine

```text
DRAFT
  │ validate and freeze definition
  ▼
READY
  │ submit commitment
  ▼
COMMIT_SUBMITTED
  ├─ rejected/expired ─────────────▶ COMMIT_FAILED
  │ confirmations reached
  ▼
COMMIT_CONFIRMED
  │ scheduled open
  ▼
OPEN
  │ scheduled close
  ▼
CLOSED
  │ finalize canonical result set
  ▼
RESULTS_FINALIZED
  │ submit reveal + result commitment
  ▼
REVEAL_SUBMITTED
  ├─ retryable failure ────────────▶ REVEAL_PENDING_RETRY
  │ confirmations reached
  ▼
VERIFIED
```

Terminal exceptional states:

- `CANCELLED_BEFORE_OPEN`
- `COMMIT_FAILED`
- `INVALIDATED_BY_INCIDENT`

Rules:

- Only `OPEN` accepts Daily reservations and actions.
- A round cannot move backward.
- State transitions are transactional and journaled.
- Every chain submission has an idempotency key and payload hash.
- Transaction uncertainty is not treated as rejection; the system reconciles by
  idempotency key, payload hash, wallet history, or transaction ID.
- A round with accepted attempts is not deleted.
- Incident invalidation remains publicly visible with a reason code.

## 9. Attempt state machine

```text
ELIGIBLE
  │ atomic reservation
  ▼
RESERVED
  │ first accepted action
  ▼
IN_PROGRESS
  ├─ correct answer ───────────────▶ SOLVED
  ├─ maximum guesses ─────────────▶ UNSOLVED
  ├─ explicit forfeit ────────────▶ FORFEITED
  └─ round closes ────────────────▶ ABANDONED
```

`SOLVED`, `UNSOLVED`, `FORFEITED`, and `ABANDONED` are terminal.

Rules:

- Reservation and uniqueness enforcement occur in one database transaction.
- Repeating the same reservation request is idempotent and returns the existing attempt.
- `RESERVED` consumes eligibility even before the first guess.
- A player may resume `RESERVED` or `IN_PROGRESS`.
- Accepted actions use monotonically increasing sequence numbers.
- Repeating the exact action request returns the original response.
- Reusing a sequence number with different content is rejected and audited.
- Actions after a terminal state or round close are rejected.
- Platform-caused invalidation is an exceptional audited operation, never an ordinary
  player-facing retry button.

## 10. Action validation

Every Daily action includes:

```json
{
  "attemptId": "<opaque-id>",
  "sequence": 1,
  "actionId": "<client-generated-uuid>",
  "type": "guess",
  "payload": {
    "word": "crane"
  },
  "gameVersion": "1.0.0"
}
```

The server validates:

- authenticated session and chain-bound identity;
- ownership of the attempt;
- round is open;
- attempt is non-terminal;
- expected game version;
- action schema and payload size;
- next sequence number or exact idempotent replay;
- five-letter normalization;
- membership in the versioned guess dictionary;
- maximum guess count;
- rate limit.

The server computes feedback and persists the action, resulting state, and response in
one transaction before returning success.

The client never submits:

- authoritative feedback;
- authoritative score;
- completion time used for rank;
- answer;
- result status.

## 11. Round commitment and reveal

### 11.1 Hidden round definition

The frozen hidden definition contains:

```json
{
  "schemaVersion": 1,
  "roundId": "word-grid:1.0.0:2026-07-25",
  "chainId": "<VRSCTEST-chain-id>",
  "gameId": "word-grid",
  "gameVersion": "1.0.0",
  "date": "2026-07-25",
  "opensAt": "2026-07-25T00:00:00Z",
  "closesAt": "2026-07-26T00:00:00Z",
  "puzzleSeed": "<hex>",
  "answer": "<five-letters>",
  "salt": "<32-byte-random-hex>"
}
```

### 11.2 Canonicalization

Before hashing:

- strings use UTF-8;
- keys follow the schema-defined order or a selected canonical JSON standard;
- timestamps use normalized RFC 3339 UTC form;
- hexadecimal values use lowercase;
- no insignificant whitespace contributes to the logical object;
- unknown properties are rejected for schema version 1.

The exact canonicalization algorithm is selected in an ADR and implemented identically
in server and verifier test vectors.

### 11.3 Commitment object

```json
{
  "schemaVersion": 1,
  "roundId": "word-grid:1.0.0:2026-07-25",
  "chainId": "<VRSCTEST-chain-id>",
  "gameId": "word-grid",
  "gameVersion": "1.0.0",
  "date": "2026-07-25",
  "opensAt": "2026-07-25T00:00:00Z",
  "closesAt": "2026-07-26T00:00:00Z",
  "hiddenDefinitionSha256": "<hex>"
}
```

`hiddenDefinitionSha256` is the SHA-256 of the canonical hidden definition.

### 11.4 Reveal object

After close, the reveal contains the complete hidden definition and references the
commitment transaction. Anyone can canonicalize it and reproduce the commitment hash.

The answer is never returned by a Daily API before the attempt is terminal. Publishing
the global reveal occurs only after the round closes.

## 12. Result records and result commitment

### 12.1 Canonical result record

Each attempt produces:

```json
{
  "schemaVersion": 1,
  "roundId": "word-grid:1.0.0:2026-07-25",
  "chainId": "<VRSCTEST-chain-id>",
  "gameId": "word-grid",
  "gameVersion": "1.0.0",
  "playerIAddress": "<i-address>",
  "status": "solved",
  "guesses": [
    { "sequence": 1, "word": "crane" }
  ],
  "score": {
    "solved": true,
    "guessesUsed": 1
  }
}
```

Friendly names are presentation data and are not part of identity uniqueness. The
canonical record uses the chain-bound i-address.

### 12.2 Final result set

- Every reserved attempt appears exactly once.
- Records are sorted by a specified binary or lexical key independent of insertion
  order.
- Every record is canonicalized and hashed.
- The result commitment binds the ordered set through a selected Merkle or equivalent
  construction.
- Empty-result rounds still publish a valid result commitment.
- The construction and domain-separation prefixes are versioned.

### 12.3 Inclusion proof

For a completed publication, the API can return:

- the canonical player result;
- its leaf hash;
- sibling hashes/path;
- result root;
- reveal/result transaction reference;
- algorithm version.

The browser verifier checks inclusion locally.

The exact Merkle representation is an architecture decision informed by the Storage
PoC. The logical requirement—independent proof that a result is included—remains fixed.

## 13. VDXF model

Candidate logical keys:

```text
arcade::schema.game
arcade::schema.round.commit
arcade::schema.round.reveal
arcade::schema.round.results
arcade::game.definition
arcade::round.commit
arcade::round.reveal
arcade::round.results
```

Requirements:

- keys are derived and verified on VRSCTEST;
- raw key IDs and human-readable names are documented;
- schema version is present in every value;
- all chain data identifies chain, game, version, and round;
- existing identity content is preserved;
- writes are read-merge-validate-write-verify operations;
- concurrent modification is detected;
- a dedicated VRSCTEST operator identity is used for PoC and staging;
- the current unsafe `publishState()` function is not used.

Physical grouping into one or multiple identity updates is decided after the Storage
PoC measures size, fees, replacement behavior, and retrieval.

## 14. Authentication and sessions

### 14.1 Principal

The authenticated principal is:

```json
{
  "chainId": "<VRSCTEST-chain-id>",
  "chainName": "vrsctest",
  "iAddress": "<identity-address>",
  "friendlyName": "<display-name>"
}
```

Authorization uses `(chainId, iAddress)`. Friendly name is never an authorization key.

### 14.2 Session requirements

- VRSCTEST is the only allowed MVP login network.
- Login challenges are random, single-use, origin-bound, and short-lived.
- Session tokens are random and stored hashed server-side.
- Sessions have creation, inactivity, and absolute expiry.
- Logout revokes the server-side session.
- Session rotation invalidates the replaced token.
- Web transport uses a secure HttpOnly cookie unless integration testing demonstrates a
  blocking incompatibility.
- Mobile token storage is deferred to the mobile phase.
- Revoked/recovered identity behavior is included in VRSCTEST tests.

## 15. API contract

All MVP application endpoints use `/api/v1`. Error responses share:

```json
{
  "error": {
    "code": "ROUND_NOT_OPEN",
    "message": "The Daily round is not open.",
    "requestId": "<opaque-id>",
    "retryable": false
  }
}
```

### 15.1 Public endpoints

#### `GET /api/v1/health`

Returns process liveness without exposing secrets.

#### `GET /api/v1/ready`

Returns readiness of operational storage, read-only chain access, write capability,
index lag, and current round service. A degraded dependency is explicit.

#### `GET /api/v1/games`

Returns the one versioned MVP game and supported modes.

#### `GET /api/v1/games/word-grid/rounds/current`

Returns:

- round metadata;
- state;
- commitment hash and chain receipt when submitted;
- confirmation status;
- open/close time;
- no hidden definition.

#### `POST /api/v1/games/word-grid/practice`

Creates an unranked Practice session.

#### `GET /api/v1/rounds/:roundId/leaderboard`

Returns canonical tied ranks derived from finalized or live validated attempts. The
response states whether it is live, finalized, or chain-verified.

#### `GET /api/v1/rounds/:roundId/proof`

Returns commitment, reveal when available, result root, chain receipts, schemas, and
verification material.

### 15.2 Authenticated endpoints

#### `GET /api/v1/me`

Returns the current chain-bound principal and session expiry.

#### `POST /api/v1/rounds/:roundId/attempts`

Atomically reserves or returns the existing Daily attempt. Supports an idempotency key.

Outcomes:

- `201` new reservation;
- `200` existing resumable or terminal attempt;
- `401` not authenticated;
- `409` round not open or incompatible game version;
- `503` ranked mode unavailable.

#### `GET /api/v1/attempts/:attemptId`

Returns the player's current attempt, accepted actions, feedback, and terminal result.
The answer is included only when permitted by terminal/reveal policy.

#### `POST /api/v1/attempts/:attemptId/actions`

Validates and atomically applies one action.

#### `POST /api/v1/attempts/:attemptId/forfeit`

Explicitly ends the attempt as forfeited. It is idempotent.

#### `GET /api/v1/attempts/:attemptId/proof`

Returns proof status and, after result publication, the result inclusion proof.

### 15.3 Administrative endpoints

Admin behavior is authenticated separately and is not exposed through player sessions.
MVP administration may be CLI-only. Required operations:

- prepare next round;
- submit/reconcile commitment;
- inspect confirmation state;
- pause/cancel before open;
- close/finalize;
- submit/reconcile reveal and result root;
- record an incident reason;
- rebuild the index.

## 16. Error and degraded-mode behavior

| Condition | Daily behavior | Practice behavior |
|---|---|---|
| Commitment not confirmed | Disabled/pending | Available |
| Chain read temporarily unavailable | Existing gameplay may continue only per policy; proof marked unavailable | Available |
| Chain write unavailable before open | Daily does not open | Available |
| Chain write unavailable after close | Results retained; publication retries; status pending | Available |
| Operational database unavailable | Daily disabled; no in-memory fallback | Local Practice may remain available |
| Session expired | Re-authenticate, then resume same attempt | Unaffected |
| Duplicate action request | Return original result | Mode-specific local behavior |
| Conflicting sequence reuse | Reject and audit | Not ranked |
| Server restart | Resume from committed storage | New Practice may start |
| Round closes during action | Transactional close/action ordering decides once; never accept ambiguously | Unaffected |
| Verifier cannot reach chain | Show unverified/degraded, never green success | Not applicable |

No fallback may silently convert unverified data into a verified or ranked result.

## 17. Anti-cheat guarantees and limitations

### 17.1 MVP prevents or structurally limits

- submitting an arbitrary client-calculated score;
- changing accepted guesses;
- submitting more than six accepted guesses;
- playing a second ranked attempt with the same chain-bound VerusID;
- replaying an action to gain an additional state transition;
- using a different game version without detection;
- selectively omitting a reserved attempt from final results;
- opening ranked play without the required commitment state;
- editing published results without changing the result commitment.

### 17.2 MVP detects or records

- sequence conflicts;
- malformed or impossible actions;
- excessive request rates;
- abandoned attempts;
- transaction uncertainty;
- validator/version mismatch;
- result-root mismatch;
- failed chain verification.

### 17.3 MVP does not claim to prevent

- one person using multiple VerusIDs;
- players sharing the answer;
- another person playing on behalf of an identity owner;
- reverse engineering an open-source game;
- automation that submits otherwise valid guesses;
- collusion or external communication.

The UI and public documentation use “server-validated” and “independently verifiable,”
not “cheat-proof.”

## 18. Privacy

- The leaderboard displays the player's public VerusID friendly name and i-address
  reference according to an explicit UI policy.
- IP addresses, session tokens, device identifiers, risk signals, and request logs are
  never included in on-chain records.
- Operational security logs have a retention policy.
- Practice does not require identity.
- The MVP collects no email address.
- Analytics are opt-in or privacy-preserving and are not required for gameplay.
- On-chain permanence is explained before ranked participation.

## 19. User interface requirements

Minimum screens:

1. Landing and Verus capability explanation.
2. VerusID login.
3. Game page with Practice and Daily Seed cards.
4. Practice game.
5. Daily pre-start screen showing attempt and proof rules.
6. Daily game with commitment status.
7. Result screen.
8. Daily leaderboard.
9. Public round verifier.
10. Service/degraded-status presentation.

The Daily pre-start screen states:

- this is the only ranked attempt for the identity today;
- starting consumes the attempt;
- the attempt can be resumed before close;
- abandoning is recorded;
- what will be stored permanently;
- what the proof guarantees and does not guarantee.

Accessibility:

- complete keyboard operation;
- visible focus states;
- semantic labels;
- screen-reader feedback for cell results;
- color is not the only feedback channel;
- responsive layout at small mobile widths;
- reduced-motion support where animation exists.

## 20. Observability

Required structured events and metrics:

- login challenge created, verified, expired, rejected;
- session created, rotated, expired, revoked;
- attempt reserved, resumed, action accepted/rejected, terminal;
- round state transition;
- chain intent created, submitted, uncertain, confirmed, failed;
- proof verification success/failure;
- index lag and rebuild status;
- API latency and error counts;
- no secret, raw session token, answer-before-reveal, or private key in logs.

Every request receives a request ID. Every chain operation receives an operation ID and
idempotency key.

## 21. Test requirements

### 21.1 Unit tests

- duplicate-letter evaluation;
- answer and guess normalization;
- dictionary membership;
- scoring and tied ranking;
- canonical serialization test vectors;
- commitment hash vectors;
- result-leaf and root vectors;
- round state transitions;
- attempt state transitions;
- session expiration;
- UTC boundary behavior.

### 21.2 Property-based tests

- evaluation never marks more occurrences than the answer contains;
- deterministic replay produces identical state;
- canonicalization is stable;
- result ordering is independent of insertion order;
- duplicate action processing is idempotent;
- no attempt accepts more than six guesses.

### 21.3 API integration tests

- anonymous Practice;
- Daily requires login;
- atomic first reservation;
- two concurrent reservations return one attempt;
- two devices resume the same attempt;
- duplicate action ID returns the original result;
- conflicting sequence is rejected;
- terminal attempts reject actions;
- round close races with an action safely;
- session logout/revocation;
- invalid dictionary word;
- payload and rate limits.

### 21.4 Chain integration tests on VRSCTEST

- derive and document VDXF keys;
- publish a commitment using a dedicated test identity;
- wait for and record confirmations;
- prove Daily remains closed before confirmation;
- retrieve and decode commitment independently;
- publish reveal and result commitment;
- retrieve them from a clean/read-only path;
- verify canonical hashes and inclusion proof;
- preserve unrelated `contentmultimap` entries;
- simulate concurrent identity modification;
- RPC unavailable before submission;
- connection lost after possible submission;
- idempotent reconciliation;
- insufficient funds;
- rejected transaction;
- restart with pending transaction;
- confirmation and reorganization behavior.

### 21.5 End-to-end tests

- VerusID login through a real wallet on VRSCTEST;
- Practice without login;
- full solved Daily;
- full unsolved Daily;
- forfeit;
- abandon and resume;
- abandon through round close;
- second-attempt denial;
- server restart and resume;
- verifier success;
- verifier detects modified answer, salt, action, result, root, or transaction reference;
- accessible keyboard and screen-reader flow;
- responsive mobile-browser flow.

## 22. MVP acceptance criteria

The MVP is ready for a closed VRSCTEST pilot only when:

- VRSCTEST is the only enabled write network;
- all application and integration test suites pass;
- no critical or high baseline finding remains unresolved for the implemented path;
- Practice remains available without ranked dependencies;
- every Daily opens only after its commitment policy is satisfied;
- one VerusID cannot obtain a second attempt through concurrency, restart, or another
  device;
- abandoned attempts are retained in the final set;
- scores are produced by authoritative validation;
- all accepted actions replay deterministically;
- every finalized result is included in the published result commitment;
- the verifier reads actual chain material and does not rely only on Arcade API claims;
- unrelated identity content survives every tested update;
- chain uncertainty and retries are idempotent;
- session expiry, rotation, logout, and revocation work;
- database loss recovery and index rebuild are demonstrated;
- a multi-day automated VRSCTEST run completes without silent proof degradation;
- the user interface states proof limits honestly;
- VRSCTEST evidence includes versions, configuration, transaction IDs, block heights,
  sanitized logs, and sign-off.

## 23. Decisions still required

Resolved architecture decisions:

- SQLite for MVP operational storage: ADR-001.
- Opaque server-side sessions and web cookie strategy: ADR-002.
- Transactional one-attempt lifecycle: ADR-003.
- Round-level on-chain proof model, provisional pending PoC: ADR-004.
- RFC 8785/JCS canonical serialization: ADR-005.
- Domain-separated SHA-256 Merkle result root: ADR-006.

The following still require evidence or operational configuration before their boundary:

1. VDXF namespace owner and dedicated VRSCTEST identities.
2. Confirmation thresholds for commitment, reveal, and result publication.
3. Late-open versus cancel policy when a commitment misses its deadline.
4. Final session durations before pilot, within ADR-002 guarantees.
5. Read-only chain source for the public verifier.
6. Whether reveal and result root share one identity update.
7. Operational retention period for detailed action and security logs.
8. Node driver and migration library used for SQLite.

These receive new or superseding ADRs after review and, where applicable, the Storage
PoC.

## 24. Implementation order

1. Freeze the current word evaluator in tests.
2. Add typed VRSCTEST-only configuration and chain-bound principal types.
3. Add explicit round and attempt domain models.
4. Introduce clock, random, storage, and chain-gateway interfaces.
5. Execute the Storage PoC and record safe identity update behavior.
6. Select operational storage and canonicalization through ADRs.
7. Implement secure sessions.
8. Implement Practice.
9. Implement Daily reservation and action transactions.
10. Implement commitment confirmation gating.
11. Implement final result records and result root.
12. Implement reveal and independent verifier.
13. Implement index rebuild, observability, and admin operations.
14. Run the complete VRSCTEST acceptance suite.
15. Begin the closed web pilot only after sign-off.
