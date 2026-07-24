# ADR-004 — Round-Level On-Chain Proof Records

Status: Provisional, pending Verus Storage PoC  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

The MVP must demonstrate Verus storage and make a Daily round independently verifiable.
Publishing every guess or every player's complete result through an identity update
would increase fees, wallet operations, chain growth, and concurrency risk.

The current prototype publishes a commitment, reveal, and aggregate results on the
operator identity, but it can overwrite existing `contentmultimap` data and does not
provide independently verifiable player inclusion.

The Storage PoC has not yet established practical payload sizes, fees, indexing,
encryption behavior, confirmation latency, or safe update mechanics for the selected
daemon version.

## Decision

For the MVP, publish proof at round level rather than one chain transaction per player.

Logical on-chain records:

1. **Game definition reference**
   - game and schema version;
   - dictionary/validator hashes;
   - proof algorithm versions.

2. **Round commitment**
   - chain, game, version, round, date, open/close times;
   - hash of the canonical hidden round definition.

3. **Round reveal**
   - the canonical hidden definition including puzzle seed, answer, and salt;
   - commitment transaction reference.

4. **Round results**
   - result-root algorithm and version;
   - result root and leaf count;
   - round and reveal references;
   - optional retrievable result-bundle reference.

Player guesses and active attempts remain in operational storage during play. Final
canonical result records are committed through ADR-006. A player receives their record
and inclusion proof.

### Identity ownership

- Use a dedicated VRSCTEST operator identity for the Storage PoC and staging.
- Do not test new writes against an identity that holds unrelated valuable data.
- The production namespace/identity decision occurs after PoC evidence.

### Safe identity updates

Every identity write must:

1. read the current identity and relevant history/version context;
2. decode and validate existing content;
3. merge only the intended key/value change;
4. detect concurrent modification;
5. construct the complete required update;
6. record intent and payload hash in the transaction journal;
7. submit idempotently;
8. reconcile uncertainty;
9. retrieve and verify the confirmed result.

The current `publishState()` implementation is prohibited for further live writes.

### Publication grouping

The logical model does not require each record to be a separate transaction. The Storage
PoC will decide whether reveal and result records should share one safe identity update.
Commitment publication remains separate and confirmed before opening.

### Off-chain bundle

If complete result records are too large or operationally unsuitable for native storage,
the system may store a content-addressed bundle outside the chain while publishing:

- bundle hash;
- result root;
- retrieval reference;
- MIME/schema information.

The root remains the permanent integrity authority. Availability claims must accurately
state whether the full bundle is native Verus storage or external storage.

## Consequences

### Positive

- A constant number of chain writes per game/day is possible.
- Player count does not linearly increase operator identity updates.
- Every included result remains cryptographically verifiable.
- The design showcases VDXF, storage, commitment/reveal, and result proofs.
- Active gameplay avoids wallet latency.

### Negative

- Players depend on Arcade or another provider for their inclusion proof and possibly
  full result-bundle availability.
- A result is not individually discoverable as its own transaction.
- Finalization must include every reserved attempt.
- Result publication occurs after the round rather than immediately at completion.

## Alternatives considered

### One identity update per player result

Deferred because cost, concurrency, wallet authority, and content replacement behavior
need evidence. It may later be offered as an opt-in personal achievement path.

### One SubID per player

Deferred. It showcases Verus namespaces but creates registration, recovery, authority,
fee, indexing, and wallet-UX scope outside the MVP.

### Operational database only

Rejected because it would not meet the independent proof or Verus showcase goal.

### Store every action directly on-chain

Rejected because it is unnecessary for verification and unsuitable for the interactive
game loop.

## Storage PoC validation

The provisional decision becomes Accepted or is superseded after measuring:

- VDXF key derivation and retrieval;
- identity replacement/merge behavior;
- safe preservation of unrelated content;
- payload size and serialized overhead;
- fees for commitment, reveal, and representative result data;
- confirmation and retrieval latency;
- independent node retrieval;
- transaction uncertainty and idempotent reconciliation;
- concurrent identity update behavior;
- practical native bundle/file storage;
- index and history query behavior.

## Revisit triggers

- PoC shows the model is unsafe or uneconomic;
- native file storage makes full bundles preferable;
- player-owned records become a core product requirement;
- a PBaaS chain changes fee or throughput assumptions;
- result availability cannot meet the verifier guarantee.
