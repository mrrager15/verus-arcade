# Verus Arcade game SDK (contract v1)

This is how an indie developer adds a game to Verus Arcade. You write the
rules, test vectors and a board. The platform does everything else: VerusID
login, one ranked attempt per player per day, commit → results → reveal on
chain, the player's signature over their moves, publication of the result in
the player's own VerusID, streak attestations, the public profile and the
verifier.

Number Target (`shared/games/number-target/1.0.0/`) is the reference
implementation; Word Grid is the second.

## 1. Files

| File | Used by | Content |
| --- | --- | --- |
| `shared/games/<slug>/<version>/rules.mjs` | server, browser, verifier | The rules. One file, **no imports**, deterministic (no `Math.random`, `Date`, I/O). Its sha256 goes into the manifest. |
| `shared/games/<slug>/<version>/generator.mjs` | server only | `createPuzzle({ random })` builds the puzzle of the day. May import. Nobody needs to re-run it: the puzzle itself is committed and later revealed. |
| `shared/games/<slug>/<version>/vectors.json` | tests | At least 20 cases: puzzle + moves → expected feedback, score, end state; at least one rejected move, one win, one loss. |
| `src/lib/games/<slug>/Board.svelte` | browser | The board. Props: `BoardProps` in `src/lib/games/types.ts`. |

Register the game in three places (one line each): `shared/games/index.mjs`
(rules), `server/games/generators.mjs` (generator) and `src/lib/games/boards.ts`
(board). `npm test` runs the contract test for every registered game and fails
if anything is missing.

A version is immutable. Changing the rules means a new folder (`1.1.0`) and a
new manifest; old rounds keep verifying with the old rules.

## 2. The rules module

```js
export const meta = Object.freeze({ contract: 1, slug, version, name, maxActions, inputHint });
export function validatePuzzle(puzzle)       // throws on an invalid puzzle; returns it
export function publicPuzzle(puzzle)         // what the player sees before playing
export function normalizeAction(value)       // canonical string, no commas or whitespace; throws if malformed
export function newState(puzzle)             // plain JSON state
export function applyAction(state, action)   // → { state, feedback }; throws if the move is not allowed
export function isTerminal(state)
export function score(state)                 // → { status: 'solved' | 'unsolved', actionsUsed }
export function revealOnEnd(puzzle)          // what the player sees after the game
```

Rules the platform relies on:

- Same puzzle + same moves → same result, everywhere (server, browser, any verifier).
- `applyAction` never mutates its input; state and feedback are plain JSON.
- A move that `applyAction` rejects does not count as an attempt; the player can try again.
- `feedback` should include `solved`. The platform computes the score itself by replaying the moves; it never trusts stored feedback.
- Ranking is the same for every game in contract v1: solved before unsolved, then fewer moves. Points or time are planned for contract v2.

Tip: let the puzzle prove itself. Number Target's puzzle contains an example
solution that `validatePuzzle` checks, so every revealed puzzle proves it was
solvable.

## 3. What the platform does with your game

1. **Round**: the operator (`Arcade@`) creates a Daily per game: definition schema 2
   `{ schemaVersion: 2, roundId: "<slug>:<version>:<date>", …, puzzle, salt }`. Only
   its sha256 goes on chain (commitment).
2. **Play**: moves go through `POST /api/v1/attempts/:id/actions` with
   `{ type: 'action', payload: { value } }`. The server normalizes, replays earlier
   moves and applies the new one with your rules.
3. **Sign**: the player signs `actions:sha256` of `[{ sequence, value }]` with their VerusID (Verus Mobile).
4. **Results**: after the round closes, every attempt becomes a result record
   (schema 3, `actions` + `score: { solved, actionsUsed }`) in a Merkle tree; the root goes on chain.
5. **Reveal**: the definition (with the puzzle) is published; anyone can check it against the commitment.
6. **Player's ID**: the player can store a compact record (v3) of their result and a signed
   streak attestation in their own VerusID.
7. **Verify**: anyone can replay a record with your rules (`server/replay.mjs`) and the revealed
   puzzle, after checking the rules hash against the manifest on chain.

## 4. The manifest

Key on the operator identity: `Arcade::game.<slug>.manifest.v1`.

```json
{
  "schema": "arcade-game-manifest", "version": 1,
  "slug": "number-target", "name": "Number Target", "gameVersion": "1.0.0",
  "contract": 1, "maxActions": 5,
  "rulesPath": "shared/games/number-target/1.0.0/rules.mjs",
  "rulesSha256": "<sha256 of rules.mjs with LF line endings>",
  "developer": "<developer i-address>",
  "developerSignature": { "signaturedata": { "...": "signdata form" }, "signatureheight": 0 }
}
```

The developer signs this fixed message with their VerusID (Verus Mobile):

```
Verus Arcade game manifest v1
game:<slug>@<version>
developer:<i-address>
manifest:sha256:<sha256 of the canonical JSON of the manifest without developerSignature>
```

Operator commands (`docs/OPERATOR_RUNBOOK.md` style, each with its own ACK):

```powershell
node scripts/operator/game-manifest.mjs show number-target
$env:VERUS_OPERATOR_ACK = 'REQUEST_VRSCTEST_MANIFEST_SIGNATURE'
node scripts/operator/game-manifest.mjs sign-request number-target --developer <i-address>   # wallet link for the developer
$env:VERUS_OPERATOR_ACK = 'PUBLISH_VRSCTEST_GAME_MANIFEST'
node scripts/operator/game-manifest.mjs publish-prepare number-target
node scripts/operator/game-manifest.mjs publish-submit number-target
node scripts/operator/game-manifest.mjs publish-reconcile number-target                       # repeat until confirmed
Remove-Item Env:VERUS_OPERATOR_ACK
node scripts/operator/game-manifest.mjs verify number-target                                  # from chain: signature + rules hash
```

When Arcade itself is the developer (Word Grid), `sign-service` signs with the
service key instead of a wallet request.

## 5. Checklist for a new game

- [ ] `rules.mjs` without imports; `npm test` passes the contract test.
- [ ] ≥ 20 vectors, including a rejected move, a win and a loss.
- [ ] `generator.mjs` always produces a valid puzzle (test it with a few hundred random puzzles).
- [ ] `Board.svelte` works at phone width and with `busy` (no input while a move is in flight).
- [ ] Registered in the three registries.
- [ ] A test round end to end in test mode (`ARCADE_TEST_ROUNDS=1 round-create --test-minutes 5 --game <slug>`, then `daily-cycle`).
- [ ] Manifest signed by the developer, published on the operator ID, `verify` passes.
