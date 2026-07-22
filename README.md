# 🕹️ Verus Arcade

**Provably fair skill games on the [Verus](https://verus.io) blockchain — your name, streak and rating on-chain forever.**

Verus Arcade is a daily word game (more games coming) where fairness isn't a promise, it's a proof:

1. **Before** a round starts, `sha256(answer + salt)` is committed on-chain in the
   [`Arcade@`](https://verus.io/build/verusid) identity's contentmultimap.
2. Players log in with their **VerusID** (QR scan via Verus Mobile — no password, no
   account database, no keys in the browser) and guess during the day.
3. **After** the round ends, the answer + salt are revealed on-chain, together with the
   results. Anyone can recompute the hash — including your own browser, on the built-in
   verification page.

No one — not even the operator — can change the answer after play begins, or quietly
rewrite the leaderboard afterwards.

## Why Verus?

- **VerusID**: self-sovereign, human-readable identities as player accounts, with
  protocol-level revocation/recovery. Login is a signed challenge, free and off-chain.
- **On-chain data**: rounds are committed/revealed via `updateidentity` into the
  identity's contentmultimap under deterministic [VDXF](https://docs.verus.io/vdxf/) keys —
  no smart contracts needed, nothing to exploit.
- **Cheap forever**: a full year of daily commits costs pennies.

## Architecture

```
Verus Mobile ──QR──▶ SvelteKit frontend (5173)
                          │ /verus, /api (Vite proxy)
                          ▼
                     Express backend (8100)
                     ├─ verus-connect (daemon mode) — VerusID login
                     └─ round engine — daily rotation, guesses, leaderboard
                          │ JSON-RPC
                          ▼
                     verusd -chain=vrsctest  (holds Arcade@'s keys)
```

- `server/` — backend: auth (`auth.mjs`), round engine (`game.mjs`), on-chain
  publication (`chain.mjs`), RPC client (`rpc.mjs`)
- `src/` — SvelteKit frontend: login + game board + `/verify/[round]` page
- `vendor/verus-connect` — vendored [verus-connect](https://github.com/Fried333/verus-connect)
  with two testnet patches (a `vrsctest` chain entry and `FLAG_IS_TESTNET` on login
  envelopes) pending upstreaming

## Running it yourself

Requirements: Node 20+, a synced `verusd -chain=vrsctest` with a funded identity whose
keys are in the wallet.

```sh
npm install

# adjust in server/auth.mjs or via env:
#   ARCADE_LAN_IP    — LAN/public IP the wallet can reach for the login callback
#   ARCADE_AUTH_PORT — backend port (default 8100)
# and set your own identity + VDXF keys in server/auth.mjs / server/chain.mjs

node server/auth.mjs   # backend
npm run dev            # frontend on http://localhost:5173
```

Log in with any VerusID on the configured chain via Verus Mobile (testnet mode for
vrsctest) and play.

## Status

Testnet MVP. Roadmap: sub-ID onboarding (`you.Arcade@`), on-chain streaks & rating
attestations, more game cabinets, skill-ranked prizes, mainnet launch.

## License

MIT
