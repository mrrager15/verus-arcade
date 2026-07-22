# signin-lite — lite-mode example

A working "Sign in with Verus" demo using `verus-connect` in **lite mode**: the middleware signs challenges offline with a WIF private key and verifies wallet responses against a public Verus node. No local daemon required.

Your own VerusID appears in the wallet prompt ("yourapp.com wants to verify you").

## Prerequisites

- **You own a VerusID** on the chain you'll authenticate against (default: VRSC). Lite mode signs challenges with this identity's primary R-address WIF key — no identity, no signing.
- **A public RPC node** for that chain. `https://api.verus.services` works for VRSC. **PBaaS chains (vARRR, vDEX, CHIPS) do not currently have well-known public RPC nodes**, so lite mode is in practice VRSC-only today. If you operate your own public RPC for a PBaaS chain, point `VERIFY_NODE_URL` at it.
- **A callback URL reachable from the user's phone** (your public domain in production; ngrok/cloudflared/LAN IP for local testing).

For multi-chain support (including PBaaS), use [daemon mode](../signin-daemon/) instead.

## Setup

```bash
cd examples/signin-lite
npm install                     # installs verus-connect from the parent repo via file:../..
cp .env.example .env
chmod 600 .env
$EDITOR .env                    # fill SIGNING_IADDRESS, CALLBACK_URL, PRIVATE_KEY
node server.js
# → http://localhost:3030
```

## Required env

- `SIGNING_IADDRESS` — your VerusID (`yourid@`), must exist on VRSC.
- `PRIVATE_KEY` — WIF private key for that identity. Get it with `verus dumpprivkey "yourid@"`.
- `CALLBACK_URL` — public URL where the wallet POSTs signed responses. Must be reachable from the user's phone. For local testing, use ngrok / cloudflared / your LAN IP.
- `VERIFY_NODE_URL` — public Verus node for verification (default `https://api.verus.services`).

## Wallet callback reachability

The mobile wallet POSTs signed responses to `CALLBACK_URL`. If `CALLBACK_URL=http://localhost:3030/...`, **your phone cannot reach localhost**. Use one of:

- Public domain pointing at this server (production).
- `ngrok http 3030` → use the https URL.
- `cloudflared tunnel --url http://localhost:3030` → same idea, free.
- LAN IP (`http://192.168.x.x:3030`) if the phone is on the same wifi.

## What this shows

- `verus-connect` mounted at `/verus` on an Express app via `verusAuth({ mode: 'lite', ... })`.
- The same browser UI as the other examples: QR + tap-to-open-wallet + result polling.
- The response includes the `evidence` schema (decisionHash, decisionSignature, challengeHash, challengeSignature, challengeSigningId, systemId, verifiedAt) — relying parties downstream can independently re-verify against any Verus node they trust via `verifysignature`.

## Security

`PRIVATE_KEY` is held in memory by this process for the duration it's running. Never log it, never commit `.env`, restrict file permissions (`chmod 600 .env`). Lite mode is appropriate for small/medium apps; for high-stakes flows graduate to daemon mode and isolate keys inside verusd.
