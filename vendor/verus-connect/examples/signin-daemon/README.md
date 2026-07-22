# signin-daemon — daemon-mode example

A working "Sign in with Verus" demo using `verus-connect` in **daemon mode**: the middleware signs challenges and verifies wallet responses via local `verusd` RPC. Supports multiple chains in a single sidecar (VRSC + vARRR + vDEX + CHIPS, or any subset).

Your own VerusID appears in the wallet prompt ("yourapp.com wants to verify you").

## Setup

```bash
cd examples/signin-daemon
npm install                     # installs verus-connect from the parent repo via file:../..
cp .env.example .env
chmod 600 .env
$EDITOR .env                    # fill SIGNING_IADDRESS, CALLBACK_URL, CHAINS
node server.js
# → http://localhost:3030
```

## Prerequisites

- `verusd` running locally for every chain in `CHAINS`. RPC credentials are read from each daemon's `.conf` file — you don't paste them into `.env`.
- `SIGNING_IADDRESS` must exist on every chain listed in `CHAINS`. See the main README's "Exporting your signing identity to other chains" section.

## Required env

- `SIGNING_IADDRESS` — your VerusID. Must exist on every chain in `CHAINS`.
- `CALLBACK_URL` — public URL where the wallet POSTs signed responses (see below).
- `CHAINS` — comma-separated list of chains this sidecar accepts logins from (e.g. `vrsc,varrr,vdex,chips` or just `vrsc`).
- `DEFAULT_CHAIN` — chain used for challenge issuance when the client omits it.

## Wallet callback reachability

The mobile wallet POSTs signed responses to `CALLBACK_URL`. If `CALLBACK_URL=http://localhost:3030/...`, **your phone cannot reach localhost**. Use one of:

- Public domain pointing at this server (production).
- `ngrok http 3030` → use the https URL.
- `cloudflared tunnel --url http://localhost:3030` → same idea, free.
- LAN IP (`http://192.168.x.x:3030`) if the phone is on the same wifi.

## What this shows

- `verus-connect` mounted at `/verus` via `verusAuth({ mode: 'daemon', chains: [...], defaultChain: ... })`.
- Chain isolation: a login claiming `system_id` for vARRR is verified against the vARRR daemon, never silently falls back to VRSC.
- Standard browser UI: QR + tap-to-open-wallet + result polling.
- Response includes the `evidence` schema. Relying parties downstream can independently re-verify against any Verus node.

## Security

Private keys live entirely inside each `verusd` daemon — this process only talks to them via RPC. RPC credentials are read from `.conf` files at startup and never logged. Recommended for exchanges, custodians, and high-stakes flows.
