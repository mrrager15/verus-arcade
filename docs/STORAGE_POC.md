# Verus Arcade — Storage Proof of Concept

Status: in progress — core identity and small-payload round trips proven  
Started: 2026-07-25  
Network: VRSCTEST only  
Target identity: `arcade-storage-poc@`

## 1. Safety boundary

The PoC never writes to `Arcade@`. That identity already contains three
`contentmultimap` keys. A dedicated replaceable root test identity is used so identity
replacement, merge, retrieval, and failure tests cannot remove existing Arcade data.

The first attempt to create `storage-poc.Arcade@` was safely rejected before
transaction creation because `Arcade@` is an identity, not a parent currency configured
to issue SubIDs. No commitment or registration fee was spent. The PoC therefore uses
the independent root identity `arcade-storage-poc@`.

Write scripts require:

- a daemon that reports `testnet: true`;
- an exact hardcoded PoC identity allowlist;
- an operation-specific `STORAGE_POC_ACK`;
- explicit registration or payload parameters;
- read-before-write validation.

No private key, RPC credential, raw session token, or wallet seed is written to the
repository or printed by the tooling.

## 2. Environment baseline

Observed before writes:

| Property | Value |
|---|---|
| Daemon version | `2000753` |
| Protocol version | `170010` |
| Chain | VRSCTEST (`testnet: true`) |
| Initial synchronized height | `1,161,042` |
| VRSCTEST configuration | Present |
| Wallet funds | Sufficient testnet balance |
| `Arcade@` content keys | 3 — protected, not a PoC target |
| `arcade-storage-poc@` | Not registered at initial inspection |

Block height and confirmations are recorded again for every write.

## 3. Discovered RPC capabilities

The local daemon exposes:

- `listidentities`
- `getvdxfid`
- `getidentity`
- `getidentitycontent`
- `updateidentity`
- `signdata`
- `registernamecommitment`
- `registeridentity`

Local help confirms that `getidentitycontent` supports height ranges, transaction
proofs, VDXF-key filtering, and deleted-value retention. Local help for `signdata`
describes single-object signing, MMR creation, VDXF binding, and Sapling-address
encryption.

These are capabilities to test, not proof that every path already meets Arcade
requirements.

## 4. Initial VDXF test keys

| Purpose | URI | VDXF ID |
|---|---|---|
| Small JSON | `Arcade::storage.poc.small-json` | `iBd1Kqg2cqUeJbSkhgmqkYR2HMdg3U3BT7` |
| Preservation sentinel | `Arcade::storage.poc.preservation-sentinel` | `iFW67nkXn2L9jikSJezK2jRrP3obtBCvM7` |
| Small file | `Arcade::storage.poc.small-file` | `iRkDitRwjjoP8MMngfD7Lpier1BM14gPym` |

The returned qualified namespace for these URIs must be reviewed before final Arcade
schema keys are accepted. PoC keys are experimental and do not define production VDXF
names.

## 5. Planned sequence

### P0 — Read-only discovery

- Confirm daemon version, chain, and height.
- Read local RPC help.
- Inspect wallet identities without private material.
- Confirm target identity absence.
- Derive experimental VDXF keys.

Status: completed.

### P1 — Dedicated identity

- Create a new wallet control address.
- Submit `registernamecommitment` for `arcade-storage-poc`.
- Wait for confirmation.
- Register `arcade-storage-poc@`.
- Wait for confirmation.
- Confirm wallet authority and empty initial content.

Status: completed.

Observed evidence:

| Operation | Transaction | Serialized bytes | Wallet fee | Status |
|---|---|---:|---:|---|
| Name commitment | `5da1f995d77c6e47833e4ff2b25dd8d5816cd4989cda8cc28e6812cdd88b947e` | 309 | 0.0001 VRSCTEST | Confirmed |
| Identity registration | `5a44051e5f50b5a70ab3220a99ea872f8716ceb00016925ef4ea5307d6357c72` | 1,173 | 60 VRSCTEST | Confirmed |

The 60 VRSCTEST identity registration charge is a testnet protocol fee, not a storage
fee. Storage-write fees are measured separately.

### P2 — Preservation sentinel

- Write one sentinel value.
- Retrieve and hash it.
- Perform every later update by preserving the sentinel.
- Verify the sentinel after every transaction.

Status: completed and confirmed.

Observed write:

| Property | Value |
|---|---|
| Transaction | `537118a997c949e5716651f87d5b90f5132e92c61ef2a20e76dcf3d385043795` |
| VDXF ID | `iFW67nkXn2L9jikSJezK2jRrP3obtBCvM7` |
| Logical bytes | 177 |
| Hex characters | 354 |
| Source SHA-256 | `cd8e72be9245dad1d5cc02be02dba7eacb3d9f8e6698c50c16f2572e71e23862` |
| Serialized transaction bytes | 870 |
| Wallet fee | 0.0002 VRSCTEST |
| Pre-write content keys | 0 |
| Submitted content keys | 1 |

Confirmed retrieval through both `getidentity` and `getidentitycontent` reproduced the
177 source bytes and SHA-256 exactly.

### P3 — Small structured object

- Validate `fixtures/small-json.json`.
- Encode it as UTF-8/hex according to the tested VDXF value path.
- Store it under the experimental small-JSON key.
- Retrieve through `getidentity` and `getidentitycontent`.
- Compare byte length and SHA-256.
- Retrieve from a clean/read-only path if available.

Status: completed and confirmed.

Observed write:

| Property | Value |
|---|---|
| Transaction | `a80a019b18ca0121d89cf87751e471cf9e11763014b7902a2384d2cb12fe0eda` |
| VDXF ID | `iBd1Kqg2cqUeJbSkhgmqkYR2HMdg3U3BT7` |
| Logical bytes | 160 |
| Hex characters | 320 |
| Source SHA-256 | `d5032837d57733fa988697fe9a48d2f292510a369cdef795c50f7c0aa0587aec` |
| Serialized transaction bytes | 1,051 |
| Wallet fee | 0.0003 VRSCTEST |
| Submitted content keys | 2 |

The structured fixture and preservation sentinel both reproduced byte-identically after
confirmation. Filtered `getidentitycontent` behavior still needs a dedicated history
test: in one query the daemon returned the complete current identity content rather
than only the requested key.

### P4 — Small file and larger payloads

- Store a small text/binary fixture.
- Test boundary sizes incrementally.
- Record serialized transaction size, fees, outputs, and retrieval latency.
- Stop before an unsafe or unexpectedly expensive transaction.

Status: small-file transaction submitted; boundary tests pending.

Small-file submission:

| Property | Value |
|---|---|
| Transaction | `aa86937e5a1d9c08c360581af83e08e0e1d033e0d2ba900145c87530e48be677` |
| VDXF ID | `iRkDitRwjjoP8MMngfD7Lpier1BM14gPym` |
| Logical bytes | 237 |
| Hex characters | 474 |
| Source SHA-256 | `70b2dc036d998ae9558141f29fb0eb786340f5631fcc740f65f703b4686e7153` |
| Serialized transaction bytes | 1,311 |
| Wallet fee | 0.0005 VRSCTEST |
| Submitted content keys | 3 |
| Current state | Accepted in mempool; awaiting first confirmation |

### P5 — Signing, MMR, and encryption

- Test `signdata` with a message.
- Verify the signature.
- Test multi-object MMR creation and verification.
- Resolve a dedicated Sapling test recipient.
- Test encrypted data and negative decryption.

Status: signing and MMR reproduced; encryption partially reproduced.

Signing observations:

- a message was signed by `arcade-storage-poc@`;
- a two-leaf MMR produced root
  `2863bb9c1541401dfdce3a1b2b938fe1c6be0f1a60ae5b01826e230f8f76db04`;
- `verifysignature` accepted the message signature, but its returned `hash` differed
  from the `signdata` hash. No Arcade verifier may assume those fields are identical
  until the identity-signature envelope semantics are documented and tested.

Encryption observations:

- a dedicated Sapling recipient was created in the VRSCTEST wallet;
- `signdata` returned encrypted MMR and signature-data descriptors;
- `decryptdata` accepted both descriptor forms without an RPC error;
- the returned representation did not expose the original plaintext as plain UTF-8 or
  direct hex, so a semantic round-trip assertion is not yet proven;
- actual output fields differ from the singular `datadescriptor` wording in local help:
  `mmrdescriptor_encrypted` and `signaturedata_encrypted` were returned.

Encryption remains experimental and must not be used for application secrets yet.

### P6 — Failure and recovery

- Invalid VDXF key/value.
- Unauthorized identity.
- Insufficient or unavailable RPC path using a controlled harness.
- Connection uncertainty after possible submission.
- Duplicate idempotency request.
- Concurrent identity modification detection.
- Restart and independent retrieval.

Status: pending.

## 6. Measurements per write

- operation ID;
- daemon and protocol version;
- pre-write block height;
- identity address;
- existing key and value counts;
- VDXF URI and ID;
- logical, encoded, and transaction byte sizes;
- source SHA-256;
- transaction ID;
- fee when discoverable;
- mempool acceptance time;
- confirmation height and count;
- confirmed timestamp;
- retrieval time;
- retrieved SHA-256;
- post-write key and value counts;
- preservation-sentinel status;
- sanitized errors and retry behavior.

## 7. Tooling

Read-only inspection:

```powershell
node scripts/storage-poc/inspect.mjs
```

Identity commitment requires an explicit acknowledgement:

```powershell
$env:STORAGE_POC_ACK='CREATE_VRSCTEST_STORAGE_POC_IDENTITY'
node scripts/storage-poc/create-identity-commitment.mjs
```

Registration is a separate step after commitment confirmation. This separation prevents
the script from guessing that an unconfirmed commitment is final.

## 8. Acceptance criteria

The Storage PoC is complete only when:

- the dedicated identity is confirmed;
- unrelated/sentinel content survives every update;
- structured and file fixtures round-trip byte-identically;
- hashes are checked automatically;
- actual size, fee, and latency are recorded;
- independent retrieval is demonstrated;
- duplicate and uncertain submissions reconcile safely;
- signing/MMR claims used by Arcade are reproduced;
- encryption behavior and negative cases are reproduced;
- ADR-004 is accepted or superseded using measured evidence.

## 9. Sources

- Verus data overview: https://verus.io/build/data
- Verus PBaaS documentation: https://docs.verus.io/
- VerusID CLI registration guide:
  https://wiki.verus.io/how-to/how-to_create_verus_id_with_cli.pdf
- Community SubID registration example:
  https://gist.github.com/imylomylo/4013cc0bf64c3493bda76e77c4166509
- Community file-storage research:
  https://wiki.autobb.app/concepts/on-chain-file-storage/
