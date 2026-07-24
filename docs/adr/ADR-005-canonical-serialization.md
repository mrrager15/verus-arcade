# ADR-005 — RFC 8785 JSON Canonicalization Scheme

Status: Accepted  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

Commitments, result leaves, payload hashes, and idempotency checks require identical
logical data to produce identical bytes across server, browser verifier, tests, and
future community implementations.

Ordinary `JSON.stringify()` is not an adequate public protocol definition. Object
construction order, unsupported numeric values, and implementation differences can
make equivalent-looking values hash differently.

## Decision

Use RFC 8785 JSON Canonicalization Scheme (JCS) for MVP protocol objects.

Reference:

- https://www.rfc-editor.org/rfc/rfc8785

The bytes hashed are UTF-8 encoding of the JCS output.

### Schema restrictions

Protocol schemas additionally require:

- unknown properties rejected unless a future schema explicitly permits them;
- no `undefined`, functions, symbols, comments, or non-JSON values;
- no `NaN`, positive infinity, or negative infinity;
- integers outside the interoperable JSON/IEEE-754 safe range encoded as validated
  decimal strings;
- monetary values encoded as protocol-defined integer minor units or validated decimal
  strings, never binary floating-point amounts;
- timestamps encoded as normalized RFC 3339 UTC strings with `Z`;
- hexadecimal strings lowercase with fixed expected length;
- chain IDs, i-addresses, game IDs, and versions validated before canonicalization;
- Unicode strings interpreted exactly as schema-defined input;
- user-visible normalization performed before object construction, not by the
  canonicalizer.

### Hash representation

- Hash algorithm for MVP protocol commitments: SHA-256.
- Hash bytes are represented externally as lowercase 64-character hexadecimal strings.
- Hash inputs use domain separation where ADR-006 or another schema defines it.
- A schema/version field is included in every independently hashed object.

### Test vectors

The repository will contain immutable fixtures with:

- logical JSON input;
- canonical JSON text;
- UTF-8 bytes or byte hash;
- expected SHA-256;
- expected rejection cases.

The same vectors run in Node and the browser verifier.

### Persistence

Operational database JSON is not automatically canonical. Whenever a canonical payload
is created:

- validate against its schema;
- generate canonical bytes once;
- store or journal its SHA-256;
- avoid reconstructing historical payloads from mutable presentation fields.

## Consequences

### Positive

- A published standard defines cross-language behavior.
- Object property insertion order no longer affects hashes.
- Server and browser can share fixtures.
- Future community verifiers can implement the format independently.
- Human-readable JSON remains available for debugging and explorer tooling.

### Negative

- Schemas must avoid ambiguous or unsafe numeric representations.
- A compliant implementation/library must be selected and tested.
- Canonicalization does not replace semantic schema validation.
- Existing prototype hashes are not automatically compatible.

## Alternatives considered

### Plain `JSON.stringify()`

Rejected because it is not a sufficient cross-implementation protocol contract.

### Custom sorted-key JSON

Rejected because a home-grown subset would require its own complete specification and
edge-case security review.

### CBOR canonical encoding

Viable but not selected for MVP. It provides efficient binary encoding but adds
debugging and browser/tooling complexity before measured payload size requires it.

### Protocol Buffers

Rejected for MVP because schema evolution and deterministic serialization would add
tooling without a clear benefit for these small proof objects.

## Validation

- Node and browser produce identical bytes and hashes for every fixture;
- shuffled object construction order produces the same output;
- unsupported numeric values are rejected;
- Unicode and escape cases match RFC vectors;
- dictionary, validator, round, result, and root fixtures are versioned;
- changing one logical field changes the expected hash;
- schema-invalid but canonicalizable JSON is rejected before hashing.

## Revisit triggers

- Storage PoC shows binary overhead is materially important;
- Verus native VDXF types require a different canonical binary representation;
- cross-language community tooling demonstrates interoperability problems;
- a future schema needs data types that JSON cannot represent safely.
