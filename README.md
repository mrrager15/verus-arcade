# 🎮 Verus Arcade

**Blockchain-native arcade games with proof-of-gameplay on the Verus network.**

Your VerusID is your account, your save file, and your proof. No passwords, no emails — just a gamertag and the blockchain.

🌐 **Play now:** [verusarcade.com](https://www.verusarcade.com)

---

## What is this?

Verus Arcade is a collection of browser-based games where every score is **verifiable on-chain**. Each game uses deterministic logic seeded by the player's identity — same player, same world, every time. Actions are hash-chained into a proof-of-gameplay that anyone can replay and verify.

Game data (scores, stats, and cryptographic proofs) is stored directly on the player's **VerusID** via `contentmultimap` — no external databases, no centralized servers owning your data.

### How it works

1. **VerusID = You** — Your identity on the Verus blockchain is your account. No signup forms.
2. **Deterministic worlds** — Every game is seeded by your identity. Same ID → same world.
3. **Proof-of-Play** — Every action is hash-chained. Scores are mathematically verifiable.
4. **On-chain saves** — Your stats and proofs are written to your VerusID's `contentmultimap`.

---

## Games

### 🍋 Lemonade Stand
Run a lemonade stand for 14 days. Buy supplies, set recipes, choose prices, and react to the weather. Classic economic sim with a blockchain twist.

- **Genre:** Economy / Simulation
- **Length:** 14 days
- **Difficulty:** Easy

### 🪐 Colony One
Land on a procedurally generated planet. Build structures, manage resources, and survive 30 sols on an alien world.

- **Genre:** Survival / Strategy
- **Length:** 30 sols
- **Difficulty:** Medium

---

## Getting Started

### For players

Visit [verusarcade.com](https://www.verusarcade.com) and create a free account. You'll get a VerusID on the testnet — no wallet or crypto needed.

**Two ways to play:**
- **Quick start** — Choose a gamertag, we create a SubID for you automatically (e.g. `yourname.Verus Arcade@`)
- **VerusID login** — Already have a VerusID on testnet? Sign in with a cryptographic signature

### For developers

#### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Verus daemon](https://verus.io) running on `vrsctest` (testnet)

#### Setup

```bash
# Clone the repo
git clone https://github.com/mrrager15/verus-arcade.git
cd verus-arcade

# Install dependencies
npm install

# Set RPC credentials (your verusd testnet credentials)
# Windows:
setx RPC_USER "your_rpc_username"
setx RPC_PASS "your_rpc_password"
# Linux/Mac:
export RPC_USER="your_rpc_username"
export RPC_PASS="your_rpc_password"

# Start the backend (connects to local verusd)
node server.cjs

# Start the frontend (in a new terminal)
npm run dev
```

The frontend runs on `http://localhost:5173` and the backend API on `http://localhost:3001`.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (React + Vite)                     │
│  ┌────────────┐  ┌────────────────────────┐ │
│  │ Game Logic │  │ Proof-of-Gameplay      │ │
│  │ (determin.)│  │ (hash chain of actions)│ │
│  └────────────┘  └────────────────────────┘ │
└──────────────────┬──────────────────────────┘
                   │ API calls
┌──────────────────▼──────────────────────────┐
│  Backend (Express.js)                       │
│  - SubID registration (custodial)           │
│  - Save/load via contentmultimap            │
│  - Login verification (signature-based)     │
│  - Player profiles                          │
└──────────────────┬──────────────────────────┘
                   │ RPC
┌──────────────────▼──────────────────────────┐
│  Verus Daemon (vrsctest)                    │
│  - VerusID management                       │
│  - On-chain data storage                    │
│  - Identity verification                    │
└─────────────────────────────────────────────┘
```

### On-chain data structure

Player data is stored in the identity's `contentmultimap`, keyed by the identity's own address:

```json
{
  "game": "lemonade",
  "stats": {
    "gamesPlayed": 5,
    "highscore": 925,
    "totalPoints": 2840,
    "bestGrade": "S",
    "lastPlayed": 1771196213
  },
  "proof": {
    "seed": "playername",
    "actions": ["buy:10,5,10,5", "recipe:classic", "price:2.50", "..."],
    "chainHead": "ae76fb76"
  }
}
```

### Proof-of-gameplay verification

Each action during gameplay is hash-chained:

```
action₀ → hash(seed + action₀) = h₁
action₁ → hash(h₁ + action₁) = h₂
...
actionₙ → hash(hₙ₋₁ + actionₙ) = chainHead
```

To verify a score: replay all actions with the same seed. If the resulting `chainHead` matches, the score is authentic.

---

## Tech Stack

- **Frontend:** React, Vite, React Router
- **Backend:** Express.js (Node.js)
- **Blockchain:** Verus (vrsctest), VerusID, contentmultimap
- **Hosting:** Vercel (frontend), Cloudflare Tunnel (backend API)
- **Token:** Verus Arcade (custom currency with ProofProtocol 2 for SubID provisioning)

---

## The Verus Arcade Token

A custom currency launched on vrsctest that enables player SubID creation:

| Property | Value |
|---|---|
| **Name** | Verus Arcade |
| **Currency ID** | `iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P` |
| **Type** | Simple token (options: 32) |
| **ProofProtocol** | 2 (controller can mint + create SubIDs) |
| **SubID cost** | 1 Verus Arcade token + 0.02 VRSCTEST |
| **Supply** | 1,000,000 (preallocated) |

---

## Status

🚧 **Testnet Beta** — Running on vrsctest. Play for free, scores are real but on testnet.

- [x] VerusID login (signature-based)
- [x] Custodial onboarding (instant gamertag → SubID)
- [x] Proof-of-gameplay hash chain
- [x] On-chain save/load via contentmultimap
- [x] Player profiles with XP/level system
- [x] Lemonade Stand (complete)
- [x] Colony One (complete)
- [ ] Leaderboard
- [ ] More games
- [ ] Mainnet deployment

---

## License

MIT

---

*Built on [Verus](https://verus.io) — truth and privacy for all.*
