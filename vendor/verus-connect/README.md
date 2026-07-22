# verus-connect

VerusID authentication, payments, and identity requests for any website. Add a "Sign in with VerusID" button to your site, and the wallet's consent prompt will show **your app's identity** (your own VerusID) — the user is approving the relationship with *your* app, not with a third party.

## Table of contents

- [What you get](#what-you-get)
- [What you provide](#what-you-provide)
- [Try it locally in 5 minutes](#try-it-locally-in-5-minutes)
- [Three integration axes (pick one per axis)](#three-integration-axes-pick-one-per-axis)
- [Why each app needs its own signer](#why-each-app-needs-its-own-signer)
- [Quick Start — three paths](#quick-start--three-paths)
- [Frontend integration](#frontend-integration)
- [Configuration reference](#configuration-reference)
- [API endpoints](#api-endpoints)
- [Login flow](#login-flow)
- [Evidence schema & trust model](#evidence-schema--trust-model)
- [Multi-chain support](#multi-chain-support)
- [Web component reference](#web-component-reference)
- [CORS](#cors)
- [Operating in production](#operating-in-production)
- [Other features](#other-features-payments-and-identity-update)
- [Production integrations](#production-integrations)
- [Dependencies](#dependencies)
- [Security model summary](#security-model-summary)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## What you get

A 4-step user flow:

```
1. User clicks "Sign in with VerusID" on your site
2. Your page shows a QR code (desktop) or a deeplink button (mobile)
3. The wallet shows  "<your-app-id>@ wants to verify you"
   User taps approve
4. Your page receives a `verified` event with the user's iAddress + a
   cryptographic `evidence` receipt. Mint a session and you're done.
```

The receipt (`evidence`) lets your backend (or any third party) re-prove the login against any Verus RPC node — you don't have to trust this sidecar.

## What you provide

- **Your own VerusID** on the chain(s) you'll authenticate against. This is *the app's* identity, not the user's. The wallet shows it in the consent prompt.
- A **public URL** the user's wallet can reach (your production domain; ngrok/cloudflared for local testing).
- Either a **local verusd** OR a **WIF private key** for your identity (one or the other — see Axis A below).

That's it. No accounts to register, no API keys, no monthly fee. Verus is decentralised — verus-connect just speaks the protocol.

## Try it locally in 5 minutes

```bash
git clone https://github.com/Fried333/verus-connect.git
cd verus-connect
npm install && npm run build
cd examples/signin-lite
npm install
cp .env.example .env
chmod 600 .env
$EDITOR .env                    # fill SIGNING_IADDRESS, PRIVATE_KEY, CALLBACK_URL
node server.js
# → http://localhost:3030
```

You'll need a VerusID on VRSC (with `verus dumpprivkey "yourid@"` for the WIF) and a callback URL the wallet can reach (ngrok / cloudflared / your LAN IP — `localhost` won't work from a phone). See [`examples/signin-lite/README.md`](./examples/signin-lite/README.md) for the full walkthrough.

---

## Three integration axes (pick one per axis)

verus-connect lets you make **three independent choices**. Decide one per axis and combine.

### Axis A — Where the signing keys live

| | **Lite mode** | **Daemon mode** |
|---|---|---|
| **Caller runs** | this npm package only | this npm package + a local `verusd` |
| **Caller signs as** | their own VerusID + WIF private key | their own VerusID (verusd holds the key) |
| **Verifies with** | a public Verus RPC node (e.g. `https://rpc.verus.cx/`) | the local verusd |
| **Best for** | Indie apps that don't want to operate verusd | Exchanges, custodians, high-stakes, anyone already running verusd |
| **Multi-chain** | yes — one public RPC URL per chain | yes — local verusd per chain |
| **Need WIF private key?** | yes — `verus dumpprivkey "yourid@"` | no — verusd holds it |

### Axis B — How verus-connect runs

| | **Sidecar** | **SDK (Express middleware)** |
|---|---|---|
| **Shape** | verus-connect is a **separate Node process** behind nginx, listens on `127.0.0.1:PORT`. Your frontend (any tech stack) calls it via HTTP. | verus-connect is `import`-ed into **your own Node app**. Your Express server mounts the auth routes alongside your business logic. |
| **Processes** | 2 (your app + sidecar) | 1 |
| **Your app's language** | anything (Python, Go, Rust, plain HTML) — only HTTP | must be Node |
| **Restart verus-connect without touching your app** | yes | no — kills your whole app |
| **Crash isolation** | sidecar bug ≠ your app crash | bug in verus-connect can kill your app |
| **Ops complexity** | higher (systemd unit + nginx route) | lower (one process) |
| **Templates** | [`deploy/`](./deploy/) (systemd + nginx + env) | [`examples/signin-lite/server.js`](./examples/signin-lite/server.js) |

### Axis C — How the UI is rendered

| | **`<verus-connect-login>` web component** | **Bespoke frontend** |
|---|---|---|
| **What you write** | One HTML tag + one event listener | Your own QR + polling JS (~50 lines) |
| **Styling** | CSS custom properties on the host element | full control |
| **Use when** | drop-in works; you want the standard UX | you have a strict design system or non-HTML UI (native mobile, etc.) |
| **Reference** | [Web component reference](#web-component-reference) below | [Login flow](#login-flow) + raw `/login` / `/result/:id` calls |

### Common combinations

| Your situation | Axis A | Axis B | Axis C |
|---|---|---|---|
| Indie dev, static HTML site, single chain | Lite | Sidecar | Web component |
| Indie dev evaluating before committing | Lite | SDK | Web component (in `examples/signin-lite`) |
| Existing Node/Express app, wants minimum new infra | Lite or Daemon | SDK | either |
| Production: SvelteKit/Next/etc. frontend, custom design system | Daemon | Sidecar | Bespoke |
| Exchange or custodian, multi-chain, high-stakes | Daemon | Sidecar | Bespoke |
| Multiple sites on one box, one VerusID per site | Daemon | Sidecar | either |

> **Terminology note.** Throughout this README, "sidecar" means **verus-connect running as a separate Node process** behind nginx. "SDK" or "middleware" means **verus-connect `import`-ed into your own Node app**. Same code, different shape.

---

## Why each app needs its own signer

The wallet's consent prompt shows the signing identity — that's the app's identity from the user's perspective. Sharing one signer across many apps collapses the app-identity boundary the wallet relies on (it's the namespace key for per-app encrypted credentials, VDXF writes, and future DREAM-style features). Every integration should own its signer.

---

## Quick Start — three paths

Pick the path that matches your Axis B choice (sidecar vs SDK) and your evaluation stage.

### Prerequisites (all paths)

- [Node.js](https://nodejs.org/) 20+
- Git
- Your own VerusID on the chain(s) you'll authenticate against
- A callback URL the wallet can reach (production domain, or ngrok/cloudflared for dev)

### Path 1 — Try it locally (SDK pattern, no nginx needed)

The fastest way to see verus-connect work end-to-end. Spins up a tiny Express server bundling verus-connect as middleware. ~5 minutes.

```bash
git clone https://github.com/Fried333/verus-connect.git
cd verus-connect
npm install && npm run build
cd examples/signin-lite       # or examples/signin-daemon
npm install
cp .env.example .env
chmod 600 .env
$EDITOR .env
node server.js
# → http://localhost:3030
```

See [`examples/signin-lite/README.md`](./examples/signin-lite/README.md) (lite mode) or [`examples/signin-daemon/README.md`](./examples/signin-daemon/README.md) (daemon mode) for full details.

### Path 2 — Sidecar in production (behind nginx)

What every real deployment looks like. The sidecar runs as a systemd service on `127.0.0.1:PORT`; nginx terminates TLS and reverse-proxies the `/verus/*` path.

```bash
# On your production host:
git clone https://github.com/Fried333/verus-connect.git /opt/verus-connect
cd /opt/verus-connect
npm install && npm run build

# Config (daemon mode shown; swap to env.lite-multi.example for lite)
mkdir -p /etc/verus-connect
cp deploy/env.daemon.example /etc/verus-connect/yourapp.env
chmod 600 /etc/verus-connect/yourapp.env
$EDITOR /etc/verus-connect/yourapp.env

# Systemd unit
cp deploy/verus-connect-daemon.service /etc/systemd/system/yourapp-sidecar.service
$EDITOR /etc/systemd/system/yourapp-sidecar.service    # set EnvironmentFile= path
systemctl daemon-reload
systemctl enable --now yourapp-sidecar.service

# nginx (reverse-proxy /verus/ to 127.0.0.1:PORT)
cp deploy/nginx-site.conf /etc/nginx/sites-available/yourapp.conf
$EDITOR /etc/nginx/sites-available/yourapp.conf       # set server_name + cert paths
ln -s /etc/nginx/sites-available/yourapp.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

The `deploy/` templates include `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict` and the matching nginx server block. See [`deploy/README.md`](./deploy/README.md) for the full playbook.

### Path 3 — Embed as Express middleware (SDK pattern, your own Node app)

```bash
npm install Fried333/verus-connect              # adds verus-connect to your package.json
```

```js
import { verusAuth } from 'verus-connect/server';
import express from 'express';

const app = express();

// Daemon mode — multi-chain (verusd holds the key)
app.use('/verus', verusAuth({
  iAddress: 'youridentity@',
  callbackUrl: 'https://yoursite.com/verus/verusidlogin',
  chains: ['vrsc', 'varrr'],
  defaultChain: 'vrsc',
}));

// — or — Lite mode (WIF in your app's memory)
app.use('/verus', verusAuth({
  iAddress: 'youridentity@',
  callbackUrl: 'https://yoursite.com/verus/verusidlogin',
  privateKey: process.env.PRIVATE_KEY,
  verifyNodeUrl: 'https://rpc.verus.cx/',
}));

app.listen(8100);
```

Mode auto-detection: if you pass `privateKey`, mode is lite; otherwise daemon. Both modes accept `chains[]` for multi-chain operation.

**Lite mode install caveat.** The `verusid-ts-client` peer dep used by lite mode has a post-install build step that npm sometimes drops. If `import { VerusIdInterface } from 'verusid-ts-client'` fails at runtime, reinstall it with yarn:
```bash
yarn add verusid-ts-client@github:VerusCoin/verusid-ts-client#9b5a6f0db30ccf2a57c7a952d0191e5da7f3f195
```

---

## Frontend integration

The browser side. Independent of Axis A (lite/daemon) and Axis B (sidecar/SDK) — both backends expose the same HTTP API, so the same frontend code works for both.

### Option A — `<verus-connect-login>` web component (recommended)

One HTML tag, one event listener. Works in plain HTML, React, Svelte, Vue, anything that speaks DOM.

```html
<script type="module" src="https://your.cdn/dist/web.global.js"></script>

<verus-connect-login base="/verus"></verus-connect-login>

<script>
  document.querySelector('verus-connect-login').addEventListener('verified', (e) => {
    // e.detail = { iAddress, friendlyName, systemId, chainName, evidence }
    fetch('/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e.detail),
    });
  });
</script>
```

The element handles every API call (`GET /chains`, `POST /login`, polling `GET /result/:challengeId`) and regenerates the deeplink + QR whenever the user picks a different chain.

See [Web component reference](#web-component-reference) below for attributes, events, methods, and theming.

### Option B — Roll your own (manual fetch pattern)

If you have a strict design system or need a non-HTML UI (React Native, Tauri, …), call the API directly:

```js
// 1. List the chains the sidecar supports
const { default: defaultChain, chains } = await (await fetch('/verus/chains')).json();
renderPicker(chains, defaultChain);

// 2. When the user picks a chain (or on first render), issue a challenge
async function pickChain(chain) {
  const r = await (await fetch('/verus/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain }),
  })).json();
  const { challengeId, deepLinkPost, deepLinkRedirect } = r;

  renderQr(deepLinkPost);                  // QR code (TYPE_POST envelope)
  renderButton('Open in Verus wallet',
               { href: deepLinkRedirect }); // mobile button (TYPE_REDIRECT envelope)
  startPolling(challengeId);
}

function startPolling(challengeId) {
  const t = setInterval(async () => {
    const r = await (await fetch(`/verus/result/${challengeId}`)).json();
    if (r.status === 'verified') { clearInterval(t); onLoggedIn(r); }
    else if (r.status === 'expired') { clearInterval(t); /* restart */ }
  }, 1500);
}

// 3. Handle the mobile redirect-return path
// (when the wallet returns the user to your page after signing on the same device)
const url = new URL(location.href);
const cid = url.searchParams.get('challengeId');
const payload = url.searchParams.get('i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC');
if (cid && payload) {
  const bytes = base64UrlToBytes(payload);   // helper: atob with -/_ → +/
  await fetch(`/verus/verusidlogin/${cid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  startPolling(cid);
  // Strip URL params so refresh doesn't re-post.
  url.searchParams.delete('challengeId');
  url.searchParams.delete('i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC');
  history.replaceState(null, '', url.toString());
}
```

**Why two deeplinks (`deepLinkPost` + `deepLinkRedirect`)?** Mobile wallets distinguish QR-scan (POST result back to your server) from same-device deeplink-click (redirect user back to your page with the response in URL params). Two envelopes prevent the wallet from ambiguously picking. The legacy `deepLink` field also still returns for older clients — equals `deepLinkPost`.

Each call to `/login` returns a **new** `challengeId`. Switching chains MUST regenerate — the deep link is per-chain (different `systemId` baked in).

---

## Configuration reference

Env vars (sidecar mode reads them from the env file; SDK mode reads them via `process.env` or you pass them inline to `verusAuth()`).

| Variable | Required | Mode | Description |
|---|---|---|---|
| `SIGNING_IADDRESS` | Yes | Both | VerusID to sign challenges with. Must exist on every chain in `CHAINS`. |
| `CALLBACK_URL` | Yes | Both | URL the wallet POSTs signed responses to (QR-scan path). Sidecar appends `/<challengeId>` per challenge. Must end with `/verus/verusidlogin` (or whatever path nginx routes to the sidecar). |
| `REDIRECT_URL` | No | Both | URL the wallet redirects users to after sign (deeplink-click path). Defaults to the origin of `CALLBACK_URL`. Sidecar appends `?challengeId=<id>`; wallet appends `&i9JzVt59...=<base64url-response>`. Set explicitly if you want a different landing page than `/`. |
| `CHAINS` | Yes | Both | Comma-separated chain names (e.g. `vrsc,varrr,vdex,chips`). Daemon mode: each chain needs a local verusd. Lite mode: each chain needs a `VERIFY_NODE_URL_<CHAIN>=`. |
| `DEFAULT_CHAIN` | Yes | Both | Chain used for challenge issuance when client omits it. Must be in `CHAINS`. |
| `CONF_PATH_<NAME>` | No | Daemon | Override a chain's conf file path (uppercase chain name). Default lookup table below. |
| `PRIVATE_KEY` | Yes | Lite | WIF private key for offline signing. Must derive `SIGNING_IADDRESS`'s **current** primary R-address — if rotated, update this. |
| `VERIFY_NODE_URL` | single-chain lite | Lite | Public node URL for verification when only one chain is used. Either this or `VERIFY_NODE_URL_<CHAIN>` is required. |
| `VERIFY_NODE_URL_<CHAIN>` | multi-chain lite | Lite | Per-chain public node URL. One entry required for every name in `CHAINS`. e.g. `VERIFY_NODE_URL_VARRR=https://varrr.rpc.verus.cx/`. |
| `CHAIN` | No | Lite | Legacy single-chain selector. Ignored when `CHAINS` is set. Default: `vrsc`. |
| `API_URL` | No | Both | Public API for identity resolution (default: `https://api.verus.services`). |
| `PORT` | No | Both | Server port (default: 8100). |
| `HOST` | No | Both | Server host (default: 127.0.0.1). |
| `CORS_ORIGINS` | No | Both | Allowed origins, comma-separated. Default: locked to `CALLBACK_URL`'s origin. See [CORS](#cors) before opening up. |
| `DEBUG` | No | Both | `1` or `true` to enable verbose logging. |

### Conf-file default paths (daemon mode)

| Chain | Conf path |
|---|---|
| VRSC | `~/.komodo/VRSC/VRSC.conf` |
| PBaaS (vARRR, vDEX, CHIPS, …) | `~/.verus/pbaas/<hex>/<hex>.conf` where `<hex>` is the chain system_id's hash160 in reversed byte order |

Override per-chain if your conf lives somewhere non-standard:
```env
CONF_PATH_VRSC=/custom/path/VRSC.conf
```

### Built-in chain table

| Name | Display | system_id |
|---|---|---|
| `vrsc`  | VRSC  | `i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV` |
| `varrr` | vARRR | `iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2` |
| `vdex`  | vDEX  | `iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N` |
| `chips` | CHIPS | `iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP` |

To add a new chain, edit `KNOWN_CHAINS` in `src/chain-registry.ts`.

---

## API endpoints

### Authentication

| Method | Path | Description |
|---|---|---|
| `GET` | `/chains` | List supported chains + live health → `{ default, chains: [{ name, displayName, systemId, healthy, lastChecked }] }` |
| `POST` | `/login` | Create a login challenge. Body: `{ chain?: string }` (defaults to `DEFAULT_CHAIN`) → `{ challengeId, deepLink, deepLinkPost, deepLinkRedirect, chain, chainName, systemId }` |
| `POST` | `/verusidlogin/:id` | Receive signed response from wallet. Body: raw `GenericResponse` bytes (`Content-Type: application/octet-stream`) → `{ status: "ok" }` |
| `GET` | `/result/:challengeId` | Poll for result → `{ status: "pending" }` or `{ status: "verified", iAddress, friendlyName, systemId, chainName, evidence }` or `{ status: "expired" }`. See [Evidence schema](#evidence-schema--trust-model). |

### Payments & Requests

| Method | Path | Description |
|---|---|---|
| `POST` | `/pay-deeplink` | Generate a VerusPay invoice deep link → `{ deep_link, resolved_address }` |
| `POST` | `/generic-request` | Create a GenericRequest deep link → `{ deep_link, qr_string }` |
| `POST` | `/identity-update-request` | Create an identity update request → `{ deep_link, qr_string }` |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check → `{ status: "ok", mode, primitivesLoaded }` |

---

## Login flow

```
1. Browser          GET /chains
                    ← { default: "vrsc", chains: [{name:"vrsc",healthy:true}, {name:"varrr",healthy:true}] }
                    Render picker, grey out unhealthy chains

2. Browser          POST /login  { chain: "varrr" }
                    ← { challengeId, deepLinkPost, deepLinkRedirect, chain:"varrr", chainName:"vARRR", systemId:"iExB..." }

3. Show QR / button QR encodes deepLinkPost; mobile button uses deepLinkRedirect
                    Browser starts polling GET /result/:challengeId every 1.5s

4. User signs       (a) QR-scan path: wallet POSTs to CALLBACK_URL/<challengeId>
                        directly → sidecar verifies, /result transitions to verified
                    (b) Deeplink-click path: wallet redirects user back to
                        REDIRECT_URL?challengeId=<id>&i9JzVt59...=<base64url-response>
                        → browser POSTs the response bytes to /verusidlogin/<id>
                        → sidecar verifies, /result transitions to verified

5. Browser polls    GET /result/:challengeId
                    ← { status: "verified", iAddress, friendlyName, systemId, chainName, evidence }

6. Done             Browser fires `verified` event → your code mints a session.
                    Persist systemId so you know which chain authenticated.
```

The sidecar rejects logins for chains not in `CHAINS` with an explicit error — there's no silent fallback. Verification is routed to the daemon (or RPC node) whose `system_id` matches the response's `signature.systemID`.

---

## Evidence schema & trust model

Every verified `/result` includes an `evidence` object — the cryptographic receipt the relying party can re-verify against any Verus node without trusting this server:

```ts
interface LoginEvidence {
  decisionHash:        string  // hex SHA256 of the wallet's signed decision
  decisionSignature:   string  // base64 signature by the user's identity
  challengeHash:       string  // hex SHA256 of the server-issued challenge
  challengeSignature:  string  // base64 signature by the server's signing identity
  challengeSigningId:  string  // i-address of the server's signing identity
  systemId:            string  // canonical chain i-address
  verifiedAt:          number  // Unix seconds when verification completed
}
```

Independent re-verification — your backend (or any third party) calls a Verus node's `verifysignature` RPC:

```bash
curl -X POST https://api.your-trusted-node.example -H "Content-Type: text/plain" -d '{
  "jsonrpc": "1.0", "method": "verifysignature",
  "params": [{
    "address":   "<result.iAddress>",
    "signature": "<result.evidence.decisionSignature>",
    "datahash":  "<result.evidence.decisionHash>"
  }]
}'
# → { "result": { "signaturestatus": "verified", "identity": "alice@",
#                 "system": "VRSC", "signatureheight": 4067136, ... } }
```

The daemon response reveals `signatureheight` (block when the signature was minted) — your code can reject signatures more than N blocks old for stronger replay protection.

### Trust boundaries

| Actor | What they can do | What they can't do |
|---|---|---|
| **Malicious wallet** | Refuse to sign | Forge a signature (verified against the user's on-chain identity) |
| **Malicious user (no wallet access)** | Submit garbage to `/verusidlogin/:id` | Bypass signature verification — the daemon's `verifysignature` checks against the on-chain primary R-address |
| **Malicious third-party site** | Try to use your sidecar as a shared IdP | Be blocked by CORS lock to `CALLBACK_URL` origin (default) |
| **Malicious frontend** (someone with write access to your HTML) | Show a fake "Sign in" UI | Skip signature verification — `evidence` is checked server-side against the on-chain identity |
| **Malicious sidecar operator** | Refuse to issue challenges; lie about results to first-party calls | Forge a verified `evidence` block — it would fail re-verification at any Verus node |
| **Network attacker** | MITM if you don't use HTTPS | Forge a signed envelope (signatures don't depend on transport) |

The sidecar is **not** the trust anchor — the Verus chain is. Even if you completely don't trust the sidecar, re-verifying the `evidence` block against any RPC node gives you the same security guarantees.

---

## Multi-chain support

verus-connect supports authenticating users on **any combination of VRSC + PBaaS chains** on a single sidecar. The user picks which chain in the QR/button UI; the sidecar routes verification to the right daemon (or RPC) automatically.

### Exporting your signing identity to other chains

`SIGNING_IADDRESS` must exist on every chain in `CHAINS`. Run this once per chain after creating the identity on VRSC:

```bash
# fund the identity once (skip if its i-addr already has a UTXO)
verus sendtoaddress "yourid@" 0.01

# export to vARRR
verus sendcurrency "yourid@" '[{"address":"yourid@","exportto":"vARRR","exportid":"true","amount":0}]'
```

The `amount:0` form is required — anything else triggers consensus checks for converters that aren't needed. Source must be the identity itself (R-address holding the primary key fails the controller check). ~0.002 VRSC fee per export.

Repeat for each PBaaS chain (`vDEX`, `CHIPS`, etc.).

> ⚠️ Cross-chain identity export is permanent. All controllers (revoke/recovery authorities) must consent. The exported identity is created on the destination chain with **no control token**, and this state is permanent — once exported, the identity on that chain can never be linked back to a control token. Plan accordingly.

---

## Web component reference

### Attributes

| Attribute | Default | What it does |
|---|---|---|
| `base` | `/verus` | URL prefix where the sidecar is mounted. Matches the nginx location block. |
| `default-chain` | server's `DEFAULT_CHAIN` | Chain selected on first render. The picker still shows every chain in `CHAINS`. |
| `poll-interval-ms` | `1500` | How often to poll `/result/:id`. |

### Events

| Event | `detail` |
|---|---|
| `verified` | `{ iAddress, friendlyName, systemId, chainName, evidence }` |
| `error` | `{ message }` — network or sidecar error |
| `expired` | — challenge ran past its 5-minute window without a wallet response |

### Methods

```js
const el = document.querySelector('verus-connect-login');
el.regenerate();          // force a new challenge for the current chain
```

### Theming

Override these CSS custom properties on the host element:

```css
verus-connect-login {
  --vc-primary:    #4f46e5;   /* selected pill + deeplink button */
  --vc-primary-fg: #fff;
  --vc-fg:         #111;      /* default text */
  --vc-fg-muted:   #666;      /* status line */
  --vc-pill-bg:    #eef;
  --vc-qr-bg:      #f7f7fa;
}
```

The element uses an open shadow root — styles inside don't leak out, the host element is the only restyling surface.

### Distribution

The published package exposes the bundle at `verus-connect/web` for npm consumers, plus a standalone `dist/web.global.js` for plain `<script>` drops. Both have `qrcode` bundled inline — no peer install required.

```js
// bundler path
import 'verus-connect/web';  // side-effect import; registers the element

// vanilla path
// <script type="module" src=".../verus-connect/dist/web.global.js"></script>
```

Cache-bust the bundle URL with a `?v=X.Y.Z` query string when you depend on a newly-released SDK behaviour — the bundle URL itself is stable, so browsers will happily serve a stale copy from cache for hours.

---

## CORS

`verus-connect` ships **private by default**: endpoints are mounted but CORS is locked to `CALLBACK_URL`'s origin, so only requests from your own site can reach them. That's the right default — your sidecar authenticates users of *your* app, not third-party callers under your signer.

**Don't open this up to act as a shared identity provider for other people's apps.** Doing so means strangers' sites trigger wallet prompts that say `<yourapp.com> wants to verify you`, conflating their identity with yours — and collapses the per-app signer boundary the wallet relies on.

If you genuinely need cross-origin access (e.g. browser on one host, sidecar on another during dev, or you operate multiple first-party properties under the same signer), set an explicit allow-list:

```env
CORS_ORIGINS=https://yourapp.com,https://app.yourapp.com
```

Setting `CORS_ORIGINS=*` is supported but logs a startup warning — prefer an explicit list.

---

## Operating in production

### Logs

Sidecar mode (systemd):
```bash
journalctl -u yourapp-sidecar.service -f                # follow live
journalctl -u yourapp-sidecar.service --since "1h ago"  # last hour
```

SDK mode: logs go wherever your Node app's stdout/stderr go.

Set `DEBUG=1` in the env file for verbose logging (includes per-request input shapes — leave OFF in steady-state production).

### Common errors — what they mean

| Log message | Means | Fix |
|---|---|---|
| `Challenge creation failed: This wallet does not contain valid signing keys for <id>` | (daemon mode) verusd doesn't have the primary R-address WIF for `SIGNING_IADDRESS` | `verus importprivkey "<wif>" "" false` then restart sidecar |
| `Webhook error: Cannot read slice out of bounds` | Wallet POSTed an envelope shape the sidecar can't parse | Usually a wallet/SDK version skew — upgrade the sidecar (`git pull && npm install && npm run build && systemctl restart`) |
| `Verification error` (500 on `/verusidlogin/:id`) | Response signature didn't verify — wrong identity, rotated key, or wrong chain | Check identity primary-address history; confirm the wallet signed as the expected identity |
| `Challenge not found or expired` (404 on `/verusidlogin/:id`) | Wallet POSTed for a `challengeId` older than 5 min, or never issued | User should retry — fresh challenge needed |
| `Signing identity is not active` | The user's identity has been revoked on-chain | Per Verus protocol — revoked identities can't sign. Nothing to fix on the sidecar |
| `<chain> is temporarily unavailable` | Health check found the daemon/RPC unreachable | Check `verus -chain=<X> getinfo`; if RPC node down, `/login` will reject until it recovers |
| `chain <X> not supported` | Client requested a chain not in `CHAINS=` | Add it to `CHAINS=`, restart |

### Key rotation

**Lite mode**: if you rotate `SIGNING_IADDRESS`'s primary R-address on-chain (`updateidentity`), update `PRIVATE_KEY` to the new WIF and restart. The old WIF won't sign as the rotated identity any more.

**Daemon mode**: if the primary R-address rotates, import the new WIF into verusd's wallet:
```bash
verus importprivkey "<new-wif>" "" false   # "" = no label, false = no rescan
systemctl restart yourapp-sidecar.service  # so the sidecar re-reads identity state
```

### Upgrading

```bash
cd /opt/verus-connect
git pull
npm install              # picks up any new pinned deps
npm run build
systemctl restart yourapp-sidecar.service
```

No DB schema, no migrations — sidecar state is in-memory only (5-min challenge TTL). Brief auth-flake window during restart (existing challenges are dropped); new logins work as soon as the process is up (~1 sec).

### Backup considerations

The sidecar is **stateless** — challenges live in memory and auto-expire after 5 min. Nothing to back up beyond:

- The env file (`/etc/verus-connect/yourapp.env`) — contains `PRIVATE_KEY` in lite mode, just config in daemon mode
- (Daemon mode) the verusd wallet.dat, which holds the actual signing key
- The systemd unit + nginx config (in `deploy/` if you used the templates)

Treat the lite-mode `.env` like any other secret: file mode 600, root-owned, never commit to git.

---

## Other features (Payments and Identity Update)

verus-connect also exposes the Verus protocol's payment-request and identity-update flows. Same envelope shape as auth.

### Payment Flow

```
1. Your app        POST /pay-deeplink
                   { address: "alice@", amount: 1.5 }
                   ← { deep_link: "vrsc://...", resolved_address: "i..." }

2. Show QR code    Encode deep_link as QR

3. User scans      Verus Mobile shows payment confirmation

4. User pays       Transaction broadcast on-chain
```

### Identity Update Flow

```
1. Your app        POST /identity-update-request
                   { identity: "alice@", updates: { contentmultimap: { ... } } }
                   ← { deep_link: "vrsc://...", qr_string: "..." }

2. Show QR code    User scans, wallet shows proposed changes

3. User approves   Wallet signs and broadcasts updateidentity transaction
```

---

## Production integrations

Live deployments using `<verus-connect-login>` as their VerusID auth surface. Useful as reference implementations — both are intentionally minimal-changes integrations to show the SDK is drop-in.

| Site | Stack | Integration shape |
|---|---|---|
| [crypto-world.verus.cx](https://crypto-world.verus.cx) | React + Vite SPA (frontend), FastAPI (backend) | Component mounted on the auth screen alongside Telegram / passphrase / MetaMask. `verified` event POSTs to a small `/api/auth/verus/finalize` backend endpoint that re-polls the sidecar's `/result/:id` for the verified payload and mints the site's session JWT. |
| [rugpull.verus.cx](https://rugpull.verus.cx) | Static HTML + FastAPI | Component embedded in the existing inline-JS login card. `verified` event calls the existing `GET /api/auth/verus/status/:id` endpoint to mint the session JWT — no new backend code needed. |
| [scan.verus.cx](https://scan.verus.cx/login) | SvelteKit | Bespoke Svelte page (not the web component) calling the sidecar's API directly; uses the manual fetch pattern documented in [Frontend integration § Option B](#option-b--roll-your-own-manual-fetch-pattern). |

The reference dev guide + interactive demo at [verus.cx/dev/verus-connect/](https://verus.cx/dev/verus-connect/) and [verus.cx/dev/demos/login/](https://verus.cx/dev/demos/login/) embed the component too — those are the simplest possible integrations (`<script src="…"></script><verus-connect-login base="/verus"></verus-connect-login>` + an event listener that logs to a `<pre>`).

### Lessons from real integrations

- **Single chokepoint for `verified` event dispatch**: the SDK constructs the event in exactly one private helper. Any field added/changed there flows to every dispatch path automatically. Don't roll your own dispatch from new code paths — call the shared helper.
- **Cache-bust the bundle URL** with a `?v=X.Y.Z` suffix when you depend on a newly-released SDK behaviour.
- **Each site keeps its own visual style** via CSS custom properties on the host element — no SDK fork needed.
- **Re-verify server-side**: the `verified` event detail carries the full `evidence` block; your backend should independently verify it (via `verifysignature` against a Verus RPC node) rather than trusting the client.

---

## Dependencies

The HTTP layer is plain Express; everything Verus-specific comes from two upstream libraries:

- **`express`** — HTTP server and middleware. Used by both modes.
- [`verus-typescript-primitives`](https://github.com/VerusCoin/verus-typescript-primitives) — required for both modes. Builds and serialises every envelope (`GenericRequest`, `GenericResponse`, invoices, deep links). **Pinned to a specific commit hash** for supply-chain safety.
- [`verusid-ts-client`](https://github.com/VerusCoin/verusid-ts-client) — required for **lite mode only**. Off-chain signing/verification against a public Verus RPC. Loaded dynamically; daemon mode never touches it. Install with `yarn run install:lite` (pinned to a commit SHA).

```
verus-connect
├── express                         HTTP server
├── verus-typescript-primitives     Envelope serialisation (both modes)
│   ├── bs58check                   Address encoding
│   ├── bn.js                       Big number arithmetic
│   ├── base64url                   Deep link encoding
│   ├── create-hash                 Hashing
│   └── blake2b                     Hashing
└── verusid-ts-client (lite only)   Offline signing + RPC-based verification
```

**2 production deps for daemon mode (express + primitives). Lite adds 1 (`verusid-ts-client`).**

---

## Security model summary

(Full per-actor trust table in [Evidence schema & trust model](#trust-boundaries).)

- **Daemon mode**: private keys never leave each daemon. Only RPC calls. RPC creds read from each chain's `.conf` file and never logged.
- **Lite mode**: WIF key held in memory only. Never logged, never returned in any response. Protect your `.env` (mode 600).
- **Chain isolation**: every verification routed to the daemon whose `system_id` matches the response. Chains not in `CHAINS` are rejected — no silent fallback.
- **Periodic health checks**: each daemon pinged every 30s; unhealthy chains are flagged in `/chains` and `/login` rejects challenges for them.
- **Rate limiting**: 30 requests/minute per IP on all POST routes.
- **Input validation**: addresses (alphanumeric only), amounts (positive, max 1 trillion), flags (0-15), minimumsignatures (1-13), VDXF keys (i-address format).
- **Error sanitisation**: internal error details never reflected to clients.
- **Challenge expiry**: 5 minutes. Auto-cleaned every 60s.
- **Body size limits**: 4 KB (login), 10 KB (pay-deeplink), 100 KB (generic-request, identity-update), 1 MB (wallet callback).
- **CORS**: locked to `CALLBACK_URL`'s origin by default. See [CORS](#cors).
- **No remote code**: everything bundled at build time. Dependencies pinned to exact versions / commit SHAs.

---

## License

MIT — see [LICENSE](./LICENSE) if present, or the standard MIT terms.

## Disclaimer

This software is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

Run your own security review before putting this in front of real users or real money. The trust model, key handling, and verification chain are documented in [Evidence schema & trust model](#evidence-schema--trust-model) and [Security model summary](#security-model-summary) — verify they match your own threat model.
