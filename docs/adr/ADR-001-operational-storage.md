# ADR-001 — SQLite for MVP Operational Storage

Status: Accepted  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

The current prototype stores rounds, plays, and sessions in JSON files. Full-file
synchronous writes do not provide transactions, uniqueness constraints, safe
concurrency, migrations, or reliable crash recovery.

The MVP requires:

- atomic Daily attempt reservation;
- one attempt per chain-bound VerusID, game version, and round;
- idempotent action processing;
- durable round and transaction state;
- session expiry and revocation;
- restart recovery;
- deterministic result finalization;
- a clear migration path if deployment grows.

PostgreSQL provides strong concurrency and operational tooling, but would add a network
service, credentials, deployment complexity, backup configuration, and another failure
boundary before MVP load requires it.

## Decision

Use SQLite as the MVP operational database.

Requirements:

- use a maintained Node driver with explicit transaction support;
- enable foreign-key enforcement;
- use WAL mode where supported by the production filesystem;
- configure a bounded busy timeout;
- use schema migrations committed to the repository;
- do not construct schema changes dynamically at application startup;
- wrap attempt reservation, action application, round transition, and chain-intent
  creation in explicit transactions;
- enforce identity and attempt invariants with database constraints;
- use UTC timestamps in a documented representation;
- store canonical payload hashes beside mutable operational representations;
- back up through a SQLite-safe online backup or snapshot procedure;
- test restore and integrity checking;
- keep repository/domain interfaces independent of SQLite-specific query syntax.

The minimum uniqueness constraint for a Daily attempt is logically:

```text
UNIQUE (
  chain_id,
  player_i_address,
  game_id,
  game_version,
  round_id,
  mode
)
```

The minimum action idempotency constraints are logically:

```text
UNIQUE (attempt_id, action_id)
UNIQUE (attempt_id, sequence)
```

SQLite is authoritative for active operational state. It is not the permanent authority
for published proof records. Final chain records and proof bundles must remain
reconstructable and independently verifiable according to the MVP specification.

## Consequences

### Positive

- Real transactions and constraints replace unsafe JSON writes.
- Local development and test setup remain simple.
- Backup and restore can be exercised without external infrastructure.
- One Node service can operate the entire MVP.
- The database file is easy to isolate per environment.
- A storage repository boundary preserves a later PostgreSQL migration path.

### Negative

- Only one write-heavy application node is practical.
- Network filesystems and some container volume configurations require care.
- Horizontal write scaling is deferred.
- Operations must monitor lock contention, WAL growth, disk space, and integrity.

## Alternatives considered

### PostgreSQL immediately

Rejected for MVP because expected write volume does not yet justify the additional
operational service. It remains the preferred migration target if triggers are reached.

### JSON files

Rejected because they cannot safely enforce the attempt and idempotency invariants.

### Chain-only operational state

Rejected because active sessions, guesses, action idempotency, rate limits, and
low-latency state transitions do not belong entirely on-chain.

### Browser-only state

Rejected for ranked play because the client is not authoritative and multi-device
attempt uniqueness cannot be enforced.

## Validation

Tests must demonstrate:

- two concurrent reservation requests create one attempt;
- concurrent action submissions preserve sequence invariants;
- duplicate action IDs return the original result;
- process termination after commit does not lose the transaction;
- process termination before commit does not expose partial state;
- backup and restore preserve active attempts and transaction journal entries;
- an index/rebuild process does not mutate authoritative attempt rows;
- database corruption and full-disk conditions fail closed for Daily mode;
- Practice remains available where its local implementation permits it.

## PostgreSQL migration triggers

Revisit this decision when one or more apply:

- multiple application writers are required;
- measured lock contention affects gameplay;
- deployment requires multi-region or high-availability failover;
- online analytical queries interfere with gameplay writes;
- database size or backup duration exceeds operational targets;
- the closed pilot demonstrates a concurrency level SQLite cannot meet safely.

Migration must preserve stable IDs, uniqueness semantics, canonical hashes, and
transaction-journal history.
