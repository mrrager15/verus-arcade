# 🎮 Verus Arcade

**Blockchain-native arcade games with proof-of-gameplay on the Verus network.**

Your VerusID is your account, your save file, and your proof. No passwords, no emails — just your identity and the blockchain.

🌐 **Play now:** [verusarcade.com](https://www.verusarcade.com)

---

> ⚠️ **TESTNET BETA** — Running on vrsctest. Things may break, scores may reset, and features are still being built. Play for free, have fun, and please report any bugs!

---

## What is this?

Verus Arcade is a collection of browser-based games where every score is **verifiable on-chain**. Each game uses deterministic logic seeded by the player's identity — same player, same world, every time. Actions are hash-chained into a proof-of-gameplay that anyone can replay and verify.

Game data is stored directly on the player's **VerusID** via `contentmultimap` — no external databases, no centralized servers owning your data.

### Core concepts

1. **VerusID = You** — Your identity on the Verus blockchain is your account. Self-sovereign.
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
- **Status:** Playable (beta)

*More games coming soon.*

---

## Three ways to play

### 🆔 I have a VerusID
Already have a VerusID? Sign in by scanning a QR code with **Verus Mobile**. Works with any VerusID — root IDs, SubIDs, anything on testnet. No registration needed; your account is created automatically on first login.

### 📱 Get a VerusID
Don't have one yet? We'll provision a SubID for you (e.g. `yourname.Verus Arcade@`) through Verus Mobile's QR provisioning flow. You own the keys from day one.

### ⚡ Just try it — no app needed
Pick a gamertag and a pin code. We create a custodial SubID for you on-chain. You get **10 free saves** to try things out. Upgrade to a self-sovereign VerusID anytime.

---

## How login works

Verus Arcade uses the **VerusID Login Consent Protocol** for passwordless authentication:

1. The server generates a signed login consent request
2. A QR code containing a deeplink is displayed
3. The player scans with Verus Mobile and approves
4. Verus Mobile posts a signed response to the server's webhook
5. The server verifies the cryptographic signature and logs the player in

No passwords are transmitted or stored. Identity is proven through public-key cryptography on the Verus blockchain.

For custodial accounts (Quick Play), a simple gamertag + pin flow is used instead.

---

## Known beta limitations

- 🔄 Refreshing the page during a game will restart it (saved stats are safe on-chain)
- 📱 Mobile browser experience may have rough edges
- ⏳ Account creation takes ~1-2 minutes (waiting for blockchain confirmation)
- 🧪 Running on testnet — all data may be reset

---

## Feedback & Bug Reports

**This is a beta — your feedback is invaluable!**

- 🐛 **Bugs:** [Open an issue](https://github.com/mrrager15/verus-arcade/issues) on GitHub
- 💡 **Suggestions:** Open an issue tagged `suggestion`
- 💬 **General feedback:** Drop a message in the issues or reach out directly

---

## For Developers

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Verus daemon](https://verus.io) running on `vrsctest` (testnet)
- [Verus Mobile](https://verus.io/wallet/verus-mobile) for QR login/provisioning testing

### Setup

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

### Key dependencies

- **verusid-ts-client** — VerusID Login Consent Protocol (QR provisioning & login)
- **qrcode** — QR code generation for deeplinks

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
│  - QR provisioning (verusid-ts-client)      │
│  - QR login (Login Consent Protocol)        │
│  - Custodial SubID registration             │
│  - Save/load via contentmultimap            │
│  - Player profiles & XP tracking            │
└──────────────────┬──────────────────────────┘
                   │ RPC
┌──────────────────▼──────────────────────────┐
│  Verus Daemon (vrsctest)                    │
│  - VerusID management                       │
│  - On-chain data storage (contentmultimap)  │
│  - Identity & signature verification        │
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
- **Auth:** verusid-ts-client (Login Consent Protocol, QR provisioning)
- **Hosting:** Vercel (frontend), Cloudflare Tunnel (backend API)
- **Token:** Verus Arcade (custom currency with ProofProtocol 2 for SubID provisioning)

---

## Roadmap

- [x] VerusID login (signature-based)
- [x] QR login via Verus Mobile (Login Consent Protocol)
- [x] QR provisioning — create SubIDs through Verus Mobile
- [x] Any VerusID login — root IDs, SubIDs, auto-register on first scan
- [x] Custodial onboarding (gamertag + pin → SubID)
- [x] Three-tier system (Quick Play / Own Your ID / Bring Your ID)
- [x] Proof-of-gameplay hash chain
- [x] On-chain save/load via contentmultimap
- [x] Player profiles with XP/level system
- [x] Lemonade Stand (playable)
- [x] Verus Arcade token launch
- [x] Live on verusarcade.com
- [ ] Leaderboard
- [ ] More games
- [ ] Mac Mini dedicated server
- [ ] Mainnet deployment

---

## License

MIT

---

*Built on [Verus](https://verus.io) — truth and privacy for all.*
