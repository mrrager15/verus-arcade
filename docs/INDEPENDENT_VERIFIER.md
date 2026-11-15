# Independent verifier (phases 4 and 5)

Anyone can check Verus Arcade without trusting Verus Arcade: the verifier runs in
the browser, reads the VRSCTEST chain through a Verus node (the public
`https://api.verustest.net` by default, or your own), and recomputes every hash
and signature locally. It never contacts the Arcade server.

## Where

| What | Where |
| --- | --- |
| Standalone verifier (one self-contained HTML file) | <https://mrrager15.github.io/verus-arcade/> (published from `master` by `.github/workflows/verifier-pages.yml`), or build it yourself: `npm run build:verifier` → `build-verifier/index.html` |
| Inside the app | `/verify/<round>/independent`, `/profile/<i-address>/independent`, `/verify/attestation#<share link>`, `/verify/<round>/replay` (app only, see below) |
| From a terminal | `node scripts/agent/round-check.mjs <round>`, `node scripts/agent/profile-check.mjs <i-address>`, `node scripts/agent/bundle-check.mjs <i-address> <round>`, `node scripts/agent/round-replay-check.mjs <round>` (all accept `--url <rpc>`) |

The standalone file works from any static host and from disk (`file://`): all
JavaScript and CSS are inlined. Routes are hash based: `#/round/<round-id>`,
`#/profile/<i-address>`, `#/attestation/<share link>`.

## What is checked

**A round** (`shared/independent-round.mjs`). From the history of the operator
identity (`Arcade@`) around the round date, the three records under the `.v1`
keys:

1. *Commitment* (before the game): SHA-256 of the hidden round definition.
2. *Results* (after the game): Merkle root and player count.
3. *Reveal*: the hidden definition itself.

Each must be in a confirmed transaction. The reveal must hash to the commitment
(`shared/round-proof.mjs`) and point to the actual commitment transaction. Timing
(commitment before the nominal opening, results after closing) is shown for
information only: block times drift and a round only opens for play once its
commitment is confirmed.

A commitment in schema 2 also carries `roundEncryptionAddress`, the address
players seal their moves to (see *Sealed action bundles*). After the reveal that
address must follow from the revealed salt (`shared/round-key.mjs`); if it does
not, the reveal is invalid (reason `encryption-address`). Schema 1 commitments
are unchanged.

**A share link of an attestation** (`shared/independent-attestation.mjs`). The
shared fields must hash into the sealed attestation root
(`shared/attestation.mjs`), and the root must be signed by `Arcade@`: the browser
fetches only `Arcade@`'s identity at the signing height and verifies the VerusID
signature itself (`shared/verus-signature.mjs`, same result as
`verusid-ts-client`). For information it also looks for exactly this sealed record
in the player's VerusID.

**A player profile** (`shared/independent-profile.mjs`). Every
`arcade-player-result` record in the player's VerusID under the key of its round
in the `Arcade@` namespace (`shared/vdxf-key.mjs`, same as `getDataKey`): its
Merkle root must equal the official result root `Arcade@` published, and after a
valid reveal the moves must replay to the recorded outcome with the game rules
(`shared/replay.mjs`). A record that does not match is shown as such, not hidden.
The profile also finds the player's sealed action bundles, with or without a
result record of the same round, and judges each one (next section).

## Sealed action bundles (phase 5)

A player can put their moves on chain *during* a round, in their own VerusID,
encrypted to the round's address. Nobody can read them until the reveal;
afterwards everybody can. That proves, without trusting the Arcade server, that
the moves existed before the answer was known. It is optional and does not count
for score, streak or attestations; the leaderboard shows "sealed by player".

The bundle (`shared/action-bundle.mjs`), stored under
`Arcade.VRSCTEST.::arcade.player.bundle.<round-id>`:

```json
{ "schema": "arcade-action-bundle", "version": 1,
  "round": "number-target:1.0.0:2026-11-20", "player": "i…",
  "actions": ["(25+3)*4", "100+7"],
  "ack": "<signature of Arcade@, base64>", "ackHeight": 1320000 }
```

`ack` is a *receipt*: `Arcade@` signs the SHA-256 of
`Verus Arcade receipt v1 / round / player / bundle:sha256:<hash of the bundle without ack>`.
A bundle that is missing from, or differs from, the official result is therefore
evidence against the operator, and nobody can invent a bundle the server never saw.

The round key is derived from the round's salt, so no extra secret exists:

```text
ivk         = BLAKE2b-256(salt, "ArcadeRoundIvkV1"), top 5 bits cleared
diversifier = BLAKE2b-88(salt ‖ counter, "ArcadeRoundDivV1"), first counter with a valid point
pk_d        = [ivk] · DiversifyHash(diversifier)
address     = bech32("zs", diversifier ‖ pk_d)        → roundEncryptionAddress in the commitment
```

Per bundle (`shared/independent-bundle.mjs`) the verifier checks:

| Check | How |
| --- | --- |
| Found | a value under the bundle key in the player's VerusID, with the transaction it first appeared in |
| Sealed | the reference carries no viewing key (otherwise it was publicly readable during the round) |
| Before the reveal | block of the bundle transaction < block of the reveal transaction (block order, not clock time) |
| Opens | with the `ivk` derived from the revealed salt |
| This player, this round | `player` and `round` inside the bundle |
| Receipt | signature of `Arcade@` at `ackHeight` (`shared/verus-signature.mjs`) |
| Replays | the moves, with the game rules, against the revealed puzzle |
| Same as the official result | same moves and outcome as the proven result record, when one is available |

Verdicts: `verified`; `late` (correct, but on chain in or after the reveal block:
proves no timing); `invalid` (receipt, replay or result does not match, or stored
with its viewing key); `unreadable` (the round key does not open it); `pending`
(round not revealed yet: only the transaction and block are known); `not-found`;
`not-applicable` (the round has no encryption address); `unavailable`. A wallet
request can be approved more than once, so several copies may exist: the oldest
readable one counts and the rest are reported as duplicates.

**Finding bundles in a profile** (`shared/bundle-discovery.mjs`). A bundle key is
a hash of its name and the content is unreadable before the reveal, so the round
does not follow from the value itself. Round IDs are predictable, though: for
every sealed value the verifier takes the block time of the update and tries the
Daily rounds of the registered games around that date (and, for test rounds, each
time slot), comparing keys. No index and no server are needed, and a bundle is
found even when the player stored no result for that round.

**Replaying a whole round** (`shared/independent-replay.mjs`, app only:
`/verify/<round>/replay`). The list of result records is not on chain, only its
Merkle root. The Arcade server gives the list (`GET /api/v1/rounds/<id>/results`,
only after the reveal is confirmed); the browser rebuilds the root
(`resultSetRoot` in `shared/result-set.mjs`) and uses the list only if root and
player count equal what the operator published. Then, per player: the moves are
replayed against the revealed puzzle and, in a round with an encryption address,
the player's sealed bundle is checked and compared with their official record
(at most 12 players per run; use the profile for the others). A player who holds
a valid receipt but was left out of the list cannot appear on this page; their own
profile shows that bundle. The standalone verifier has no server to ask for the
list, so it offers bundles through the profile only.

## Encrypted records

Verus Mobile stores records in a VerusID encrypted, with the incoming viewing key
next to them, and the public RPC does not allow `decryptdata`. The verifier
decrypts them itself (`shared/verus-decrypt.mjs`), exactly like the daemon
(`CVDXFEncryptor::Decrypt`, `KDF_Sapling`):

- shared secret = [ivk]([8]·epk) on Jubjub; key = BLAKE2b-256(secret ‖ epk,
  personalization `Zcash_SaplingKDF`); ChaCha20-Poly1305 (IETF) with a zero nonce;
- layer 1: the reference in the contentmultimap (flags 13) → `CrossChainDataRef`;
- layer 2: the `notaryevidence` in that transaction (`EvidenceData`) →
  data descriptor (flags 5, own epk) → record and salt.

Checked byte-for-byte against `decryptdata` on real records. Multipart evidence
is not supported yet.

A sealed bundle uses the same two layers, but its reference has flags 5 and no
viewing key: Verus Mobile passes the request with `encrypttoaddress` to its node,
which encrypts to that address and publishes no key. The verifier supplies the
`ivk` derived from the revealed salt instead. Checked against a real daemon
(`shared/fixtures/round-key-bundle.json`) and against bundles published by Verus
Mobile on VRSCTEST.

## Trust model and limits

- The RPC only supplies chain data. Hashes, Merkle proofs, decryption, replay and
  signatures are computed in the browser; a lying RPC can withhold or forge data,
  but cannot make a forged record verify.
- Only VRSCTEST: `getinfo` must report the VRSCTEST chain, otherwise "wrong chain".
- Budgets (as in Vatermark): 12 s per check (30 s for a profile, 45 s for a round replay), at most 32
  different values per key per window, at most 1024 history entries. Over a limit
  or on an RPC error the outcome is **unavailable** — never "invalid". An RPC
  failure is not evidence of anything.
- Reads use a height window around the round date (found by binary search on
  block times), widened up to 30 days if results or reveal came late.
- Sealing hides the moves from everyone except the Verus node the player's wallet
  uses: that node builds the encrypted record and therefore sees the plaintext.
- The leaderboard label "sealed by player" is the server's observation (it read the
  sealed bundle back before it saw the reveal confirmed). Whether a bundle was on
  time is decided here, from block heights.
- Test rounds (round ID with a time slot, e.g. `…:2026-11-15T1020`) live on a
  separate test operator identity (`arcade-storage-poc@`). The verifier reads them
  there and says so; in a profile they are checked but do not count for the verdict.
- Not yet: the hash of the bundled `rules.mjs` is not compared with the game
  manifest on `Arcade@`.

## Public RPC (measured 14 Nov 2026)

`api.verustest.net` allows CORS (`*`) and `getinfo`, `getidentity` (also at a
height), `getidentitycontent`, `getidentityhistory`, `getrawtransaction`,
`getblock`, `verifyhash`; it blocks `decryptdata` and `getsignatureinfo`. The
verifier uses `Content-Type: text/plain` so browsers do not send a preflight per
call.

## Building

```bash
npm run build:verifier     # build-verifier/index.html, one file (~255 KB)
npm run preview:verifier   # serve it on http://localhost:4174
```

The same components are used by the app (`src/lib/verifier/`); the standalone
entry is `src/lib/verifier/StandaloneApp.svelte` with `verifier/index.html`, built
by `vite.verifier.config.ts` and inlined by `scripts/build-verifier-inline.mjs`.
