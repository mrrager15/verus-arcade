# Verus Arcade

**Small games. Verifiable results.**

Verus Arcade is an open-source gaming platform being built to demonstrate
[Verus](https://verus.io) capabilities through simple, carefully tested games.
The first vertical slice is Word Grid with two modes:

- **Practice** — unlimited local play without login, ranking, or chain writes.
- **Daily Seed** — one server-authoritative ranked attempt per VerusID and round.

The project currently targets **VRSCTEST only**. VRSC mainnet remains disabled
for normal development, and a PBaaS deployment is a later architectural option.

## What is already working

- Passwordless VerusID login through Verus Mobile.
- Chain-bound sessions and one-attempt Daily reservation.
- Server-authoritative guesses, scoring, ordering, and idempotent retries.
- Durable SQLite operational state with migrations and hashed session storage.
- A confirmed on-chain commitment before a Daily round opens.
- Deterministic result bundles and Merkle inclusion proofs.
- Sequential result and reveal publication through VDXF keys on a VerusID.
- A public browser verifier for commitment, reveal, and publication receipts.
- A live leaderboard that becomes `chain-verified` after result confirmation.
- A guarded operator CLI with separate prepare, submit, and reconcile steps.

The first complete accelerated Daily Seed lifecycle was successfully executed on
VRSCTEST on 2026-07-25:

| Evidence | VRSCTEST transaction |
| --- | --- |
| Round commitment | `3c679b27ef7c4a12c7ff075b512e854b0f87d86356635ac76931bb9284db195c` |
| Result root | `838d8b9dbc3f1493dc0a35240c1f1571af8e30495e62c543d8ffbde14b27e69c` |
| Round reveal | `4c018403aec5184e833e2431a8ec5d55d4ad86306da3484774b2cfc270ed6f19` |

The confirmed reveal reproduced the original commitment, the player's inclusion
proof validated against the confirmed result root, and the leaderboard reached
`chain-verified`.

## How the proof flow works

```text
Prepare hidden round definition
              |
              v
Publish SHA-256 commitment on VRSCTEST
              |
              v
Players authenticate with VerusID and play
              |
              v
Freeze results and calculate a Merkle root
              |
              v
Publish and confirm the compact result descriptor
              |
              v
Publish and confirm the hidden definition reveal
              |
              v
Verify reveal hash, result proof, and leaderboard
```

The answer, puzzle seed, and salt stay in private operational storage while a
round is active. Public APIs expose them only after the reveal transaction is
confirmed. Result and reveal updates are serialized because both update the same
operator VerusID.

## Architecture

```text
Verus Mobile
    | QR/deep-link login and signed response
    v
SvelteKit web client
    | /verus and /api
    v
Express application
    |-- verus-connect authentication
    |-- Daily Seed service and authoritative validator
    |-- public proof and leaderboard APIs
    |
    +--> SQLite
    |    sessions, rounds, attempts, actions, result sets, journals
    |
    +--> verusd JSON-RPC
         VerusID content updates under deterministic VDXF keys
```

SQLite is authoritative for live operational state. Confirmed Verus
transactions provide permanent integrity anchors. Clients do not submit scores;
they submit ordered game actions that the server validates and persists.

Important directories:

- `src/` — SvelteKit UI, Daily/Practice components, and browser verifier.
- `server/` — authentication, API, game service, SQLite repository, proofs, and
  Verus gateway.
- `shared/` — deterministic game rules shared by browser and server.
- `scripts/operator/` — guarded VRSCTEST round publication workflow.
- `scripts/integration/` — real-daemon VRSCTEST integration tests.
- `scripts/storage-poc/` — Verus native-storage experiments.
- `docs/` — strategy, architecture decisions, specifications, runbooks, and
  test evidence.

## Local development

### Requirements

- Node.js `>=22.13.0 <23`.
- npm.
- A synchronized `verusd -chain=vrsctest`.
- Verus Mobile configured for VRSCTEST.
- For chain writes: a funded VRSCTEST operator identity controlled by the local
  daemon wallet.

Install dependencies and run the fast checks:

```powershell
npm install
npm test
npm run check
npm run build
```

The test suite uses in-memory SQLite and does not broadcast transactions.
Integration and operator scripts require explicit acknowledgement variables
before they can sign or broadcast.

### Start the development app

Set a callback origin that Verus Mobile can reach. Do not use `127.0.0.1` or
`localhost` when scanning the QR code from another device.

```powershell
$env:ARCADE_NETWORK = 'vrsctest'
$env:ARCADE_ORIGIN = 'http://192.168.0.235:8100' # replace with this computer's LAN IP
$env:ARCADE_DATABASE_PATH = (Resolve-Path 'server/data').Path + '\arcade.sqlite'

node server/auth.mjs
```

In a second terminal:

```powershell
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173` on the development computer. The frontend proxies
`/verus` and `/api` to the backend on port `8100`; Verus Mobile sends its signed
login response directly to `ARCADE_ORIGIN`.

Common configuration:

| Variable | Purpose | Default |
| --- | --- | --- |
| `ARCADE_NETWORK` | Exactly `vrsctest` or guarded `vrsc` | `vrsctest` |
| `ARCADE_ORIGIN` | Wallet-reachable callback origin | `http://127.0.0.1:8100` |
| `ARCADE_AUTH_PORT` | Development backend port | `8100` |
| `ARCADE_DATABASE_PATH` | SQLite database path | `server/data/arcade.sqlite` |
| `ARCADE_ID` | Authentication service VerusID | `Arcade@` |
| `ARCADE_CONF` | Explicit daemon configuration path | network default |
| `ARCADE_VRSCTEST_CONF` | VRSCTEST daemon configuration path | platform default |
| `ARCADE_SESSION_TTL_SECONDS` | Login session lifetime | `43200` |
| `ARCADE_DEBUG` | Enable Verus authentication diagnostics with `1` | disabled |

Runtime databases, environment files, credentials, and signed transaction
journals are excluded from Git.

## VRSCTEST operations

Use the accelerated E2E procedure to test a complete round in one session:

- [Fast VRSCTEST Daily Seed E2E](docs/VRSCTEST_E2E.md)
- [Round operator runbook](docs/OPERATOR_RUNBOOK.md)

Every mutating operator action requires an exact acknowledgement. Preparation,
submission, and reconciliation are separate by design. Never automate
consecutive identity updates without waiting for the preceding transaction to
confirm.

## Documentation

- [Strategy](docs/VERUS_ARCADE_STRATEGY.md)
- [Execution plan](docs/EXECUTION_PLAN.md)
- [MVP specification](docs/MVP_SPEC.md)
- [Technical foundation](docs/TECHNICAL_FOUNDATION.md)
- [Storage proof of concept](docs/STORAGE_POC.md)
- [Baseline audit](docs/BASELINE_AUDIT.md)
- [Architecture decisions](docs/adr/)

## Current roadmap

The next milestones are:

1. automate safe multi-day round rotation and recovery;
2. expand VRSCTEST resilience, concurrency, security, and accessibility testing;
3. run a closed web pilot;
4. package the stable web application with Capacitor for Android and iOS;
5. define and implement the community game contract and SDK;
6. evaluate VRSC mainnet and a dedicated PBaaS chain using measured pilot data.

Community games will remain deterministic, versioned, and server-authoritative
for ranked play. Shared platform rules will cover authentication, attempts,
proofs, anti-cheat controls, storage, and verification.

## Project status

Verus Arcade is an experimental VRSCTEST MVP. It is not ready for mainnet,
prizes, or production custody. Licensing terms have not yet been finalized.
