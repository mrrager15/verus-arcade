# Independent verifier (phase 4)

Anyone can check Verus Arcade without trusting Verus Arcade: the verifier runs in
the browser, reads the VRSCTEST chain through a Verus node (the public
`https://api.verustest.net` by default, or your own), and recomputes every hash
and signature locally. It never contacts the Arcade server.

## Where

| What | Where |
| --- | --- |
| Standalone verifier (one self-contained HTML file) | <https://mrrager15.github.io/verus-arcade/> (published from `master` by `.github/workflows/verifier-pages.yml`), or build it yourself: `npm run build:verifier` → `build-verifier/index.html` |
| Inside the app | `/verify/<round>/independent`, `/profile/<i-address>/independent`, `/verify/attestation#<share link>` |
| From a terminal | `node scripts/agent/round-check.mjs <round>`, `node scripts/agent/profile-check.mjs <i-address>` (both accept `--url <rpc>`) |

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

## Trust model and limits

- The RPC only supplies chain data. Hashes, Merkle proofs, decryption, replay and
  signatures are computed in the browser; a lying RPC can withhold or forge data,
  but cannot make a forged record verify.
- Only VRSCTEST: `getinfo` must report the VRSCTEST chain, otherwise "wrong chain".
- Budgets (as in Vatermark): 12 s per check (30 s for a profile), at most 32
  different values per key per window, at most 1024 history entries. Over a limit
  or on an RPC error the outcome is **unavailable** — never "invalid". An RPC
  failure is not evidence of anything.
- Reads use a height window around the round date (found by binary search on
  block times), widened up to 30 days if results or reveal came late.
- Not yet: the hash of the bundled `rules.mjs` is not compared with the game
  manifest on `Arcade@`; test rounds (separate test operator) are shown but not
  judged.

## Public RPC (measured 14 Nov 2026)

`api.verustest.net` allows CORS (`*`) and `getinfo`, `getidentity` (also at a
height), `getidentitycontent`, `getidentityhistory`, `getrawtransaction`,
`getblock`, `verifyhash`; it blocks `decryptdata` and `getsignatureinfo`. The
verifier uses `Content-Type: text/plain` so browsers do not send a preflight per
call.

## Building

```bash
npm run build:verifier     # build-verifier/index.html, one file (~230 KB)
npm run preview:verifier   # serve it on http://localhost:4174
```

The same components are used by the app (`src/lib/verifier/`); the standalone
entry is `src/lib/verifier/StandaloneApp.svelte` with `verifier/index.html`, built
by `vite.verifier.config.ts` and inlined by `scripts/build-verifier-inline.mjs`.
