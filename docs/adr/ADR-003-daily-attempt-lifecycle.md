# ADR-003 — Transactional One-Attempt Daily Lifecycle

Status: Accepted  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

Daily Seed permits one ranked attempt per VerusID, game version, and UTC round. The
prototype infers an attempt from a local plays object. It has no reservation,
idempotency, abandonment, incident invalidation, or concurrency model.

Client storage cannot enforce a one-attempt rule. Multiple devices and concurrent
requests must resolve to one authoritative attempt.

## Decision

Model Daily participation as a persisted state machine with transactional uniqueness.

### Eligibility key

```text
(chainId, playerIAddress, gameId, gameVersion, roundId, mode=daily)
```

The operational database enforces one row for this key.

### States

```text
ELIGIBLE (derived; no row)
  │ reserve
  ▼
RESERVED
  │ first accepted action
  ▼
IN_PROGRESS
  ├─ correct answer ───────────────▶ SOLVED
  ├─ maximum actions ─────────────▶ UNSOLVED
  ├─ explicit forfeit ────────────▶ FORFEITED
  └─ round closes ────────────────▶ ABANDONED
```

Terminal states:

- `SOLVED`
- `UNSOLVED`
- `FORFEITED`
- `ABANDONED`

An audited `INVALIDATED_BY_PLATFORM` disposition may exist outside normal player
transitions. It never silently returns eligibility.

### Reservation

- “Start Daily” creates the attempt inside a database transaction.
- Reservation consumes eligibility.
- Concurrent reservations return the same attempt.
- Reservation requires an authenticated VRSCTEST principal and an `OPEN` round.
- An idempotency key makes request retries safe.
- The player sees the one-attempt warning before reservation.

### Resume

- `RESERVED` and `IN_PROGRESS` attempts can be resumed until round close.
- Any valid session for the same chain-bound identity can resume.
- Resume returns authoritative actions and feedback from storage.
- Resume does not create or reset an attempt.

### Actions

Every action has `actionId` and monotonically increasing `sequence`.

In one transaction, the server:

1. authenticates ownership;
2. locks or otherwise serializes the attempt update;
3. validates round and attempt state;
4. checks action idempotency and sequence;
5. validates the action through the versioned game engine;
6. stores action and authoritative response;
7. updates attempt state and score;
8. commits before returning success.

An exact duplicate returns the original response. A reused sequence or action ID with
different content is rejected and audited.

### Close

At round close:

- `RESERVED` and `IN_PROGRESS` become `ABANDONED`;
- terminal attempts remain unchanged;
- final result generation includes every reserved attempt exactly once;
- close processing is idempotent;
- close and an in-flight action serialize to one unambiguous outcome.

### Platform failure

A support or admin action cannot reset an attempt. A proven platform incident may:

- mark the attempt `INVALIDATED_BY_PLATFORM`;
- record a public-safe reason code and private incident reference;
- exclude it from ordinary rank while retaining it in audit history.

Granting a replacement ranked attempt requires a future explicit policy and a
superseding ADR. It is not part of MVP operations.

## Consequences

### Positive

- One-attempt behavior survives restart and multiple devices.
- Abandoning a poor result cannot preserve a fictitious unplayed status.
- Action retries are safe.
- Final result completeness is testable.
- Operational incidents remain visible.

### Negative

- Starting Daily consumes the attempt even without a guess.
- Players need a clear confirmation screen.
- Server storage remains a live availability dependency.
- Multiple VerusIDs and answer sharing remain outside the guarantee.

## Alternatives considered

### Consume on first guess

Rejected because a player could request hidden/session information repeatedly before
submitting a first action.

### Store eligibility in browser

Rejected because it is trivial to reset and cannot coordinate devices.

### On-chain transaction for every attempt reservation

Rejected for MVP because latency, wallet interaction, fees, and failure handling would
damage the game loop. The finalized result set prevents selective omission.

### Legacy pre-signed forfeit transaction

Deferred. It is an interesting non-custodial anti-dodge mechanism but adds wallet,
`nLockTime`, transaction replacement, and recovery complexity. It may be tested later
on VRSCTEST.

## Validation

- 100 concurrent reservation requests yield one attempt ID;
- two sessions/devices resume one state;
- closing the browser cannot restore eligibility;
- exact action retries do not add guesses;
- conflicting action retries fail;
- two simultaneous valid next actions result in exactly one accepted sequence;
- close/action races produce a single documented outcome;
- server termination around transaction boundaries preserves invariants;
- all reserved attempts appear once in finalization;
- terminal state cannot transition to another player outcome;
- UTC and round ID boundaries are tested with an injected clock.

## Revisit triggers

- non-custodial attempt reservation becomes a product requirement;
- tournament rules require purchased entries or multiple attempts;
- Personal Daily is introduced;
- a PBaaS chain makes per-attempt on-chain reservation practical and desirable.
