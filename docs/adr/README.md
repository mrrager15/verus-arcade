# Verus Arcade Architecture Decision Records

Architecture Decision Records (ADRs) capture decisions that materially affect security,
data compatibility, proof semantics, operations, or future development.

## Status values

- **Proposed:** under review and not yet binding.
- **Accepted:** binding for implementation.
- **Provisional:** selected for the current phase but must be validated by a named test
  or experiment.
- **Superseded:** replaced by a newer ADR.
- **Rejected:** considered and intentionally not selected.

## Rules

- An accepted ADR is changed by superseding it, not by silently rewriting its history.
- Small factual corrections may be applied in place.
- Every superseding ADR links to the decision it replaces.
- Product guarantees remain in `MVP_SPEC.md`; ADRs describe how those guarantees are
  implemented.
- VRSCTEST evidence can overturn a provisional Verus-specific decision.
- Code, schemas, fixtures, and tests reference the applicable ADR where useful.

## Current decisions

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-operational-storage.md) | SQLite for MVP operational storage | Accepted |
| [ADR-002](ADR-002-session-model.md) | Opaque server-side web sessions | Accepted |
| [ADR-003](ADR-003-daily-attempt-lifecycle.md) | Transactional one-attempt Daily lifecycle | Accepted |
| [ADR-004](ADR-004-on-chain-data-model.md) | Round-level on-chain proof records | Provisional |
| [ADR-005](ADR-005-canonical-serialization.md) | RFC 8785 JSON Canonicalization Scheme | Accepted |
| [ADR-006](ADR-006-result-root.md) | Domain-separated SHA-256 Merkle result root | Accepted |

## ADR template

```markdown
# ADR-NNN — Title

Status: Proposed
Date: YYYY-MM-DD
Owners: Verus Arcade maintainers

## Context

## Decision

## Consequences

### Positive

### Negative

## Alternatives considered

## Validation

## Revisit triggers
```
