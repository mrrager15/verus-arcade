# ADR-006 — Domain-Separated SHA-256 Merkle Result Root

Status: Accepted  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

The MVP needs to prove that each reserved Daily attempt appears exactly once in the
final published result set without requiring one chain transaction per player.

The construction must be deterministic, independently implementable, resistant to
leaf/node ambiguity, and able to provide compact inclusion proofs.

## Decision

Use a versioned binary Merkle tree with SHA-256 and explicit domain separation.

Algorithm identifier:

```text
arcade-merkle-sha256-jcs-v1
```

### Result records

- Validate every record against its versioned schema.
- Canonicalize using ADR-005.
- Every reserved attempt yields exactly one final record.
- The canonical identity key is `(chainId, playerIAddress)`.
- The finalization query enforces no duplicate attempt or identity key for a round.

### Leaf ordering

Sort records ascending by the UTF-8 byte sequence of:

```text
chainId + "\u0000" + playerIAddress
```

Both fields are normalized and schema-validated before sorting. The NUL separator is
not permitted within either field.

The published results descriptor contains the ordered leaf count. Verifiers reject
duplicate sort keys.

### Domain-separated hashes

Let `H` be SHA-256 and `||` be byte concatenation.

```text
leafHash  = H(0x00 || UTF8(JCS(resultRecord)))
nodeHash  = H(0x01 || leftHash || rightHash)
emptyRoot = H(0x02)
```

Each child hash is exactly 32 bytes.

### Tree construction

- Build level zero from sorted `leafHash` values.
- Pair adjacent hashes from left to right.
- If a level contains an odd final hash, duplicate that hash as both children:

```text
H(0x01 || lastHash || lastHash)
```

- Continue until one root remains.
- Zero leaves use `emptyRoot`.
- One leaf uses that leaf hash directly as the root.

### Published results descriptor

```json
{
  "schemaVersion": 1,
  "algorithm": "arcade-merkle-sha256-jcs-v1",
  "roundId": "<round-id>",
  "gameId": "word-grid",
  "gameVersion": "1.0.0",
  "leafCount": 123,
  "rootSha256": "<lowercase-hex>",
  "bundleSha256": "<optional-lowercase-hex>",
  "bundleReference": "<optional-reference>"
}
```

The descriptor itself is canonicalized and bound to the on-chain round-results record.

### Inclusion proof

An inclusion proof contains:

- algorithm identifier;
- canonical result record;
- leaf index;
- leaf count;
- ordered sibling hashes;
- left/right position for every sibling;
- expected root;
- on-chain results descriptor and receipt.

The verifier:

1. validates and canonicalizes the result;
2. calculates the leaf hash;
3. checks leaf index and proof length against leaf count;
4. recomputes each node with the correct orientation;
5. compares the root;
6. verifies the results descriptor against chain data.

Proof verification must not trust a server-supplied boolean.

### Completeness

Merkle inclusion proves membership, not by itself that the operator included every
reserved attempt. Completeness is enforced by:

- transactional attempt finalization;
- a database constraint and finalization query that accounts for every reservation;
- stored finalization counts by terminal status;
- an immutable result bundle or auditable export;
- VRSCTEST reconciliation tests;
- operational monitoring that compares reserved count, finalized count, leaf count,
  and bundle count.

The public product claim distinguishes inclusion integrity from operator completeness.

## Consequences

### Positive

- One small root commits to any number of results.
- Inclusion proofs grow logarithmically.
- Domain prefixes prevent leaf/node type ambiguity.
- JCS keeps leaves independently readable.
- The algorithm is straightforward in browser and Node.

### Negative

- Odd-leaf duplication and one-leaf behavior must be implemented exactly.
- Inclusion does not alone prove that no player was omitted.
- Full result-bundle availability needs an explicit storage decision.
- Deletion or correction requires a new versioned finalization record, not mutation of
  the confirmed root.

## Alternatives considered

### Hash of one JSON array

Rejected because a player would need the complete result set to verify membership.

### Merkle Mountain Range

Potentially valuable for append-only or native Verus integration, but not selected for
the fixed post-round result set before the Storage PoC establishes tooling advantages.

### One transaction per result

Rejected for MVP due to fee, latency, and wallet-operation scale.

### Unsorted tree

Rejected because insertion and database query order would affect the root.

## Validation

Fixtures cover:

- zero, one, two, three, and larger leaf counts;
- shuffled input producing the same root;
- duplicate identity-key rejection;
- changed action, score, identity, version, or status changing the root;
- valid inclusion for first, middle, and last leaves;
- wrong orientation, sibling, index, count, record, and root rejection;
- identical roots in Node and browser;
- complete finalization count reconciliation;
- bundle hash and root verification after restore/rebuild.

## Revisit triggers

- Verus native MMR tooling provides a clear interoperability advantage;
- incremental publication becomes necessary;
- a PBaaS chain offers a protocol-native proof format preferable to this construction;
- independent implementers identify ambiguity or incompatibility.
