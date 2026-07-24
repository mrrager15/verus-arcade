# ADR-002 — Opaque Server-Side Web Sessions

Status: Accepted  
Date: 2026-07-25  
Owners: Verus Arcade maintainers

## Context

The prototype creates a bearer token, stores it in plaintext JSON, and places it in
browser `localStorage`. Tokens do not expire, rotate, or revoke server-side. Logout only
removes the browser copy.

The MVP needs passwordless VerusID login while protecting ranked attempts across
browser restart and multiple devices. Authentication must bind the identity to its
chain.

## Decision

Use opaque random server-side sessions for the web MVP.

### Principal

Every session binds:

```json
{
  "chainId": "<VRSCTEST-chain-id>",
  "chainName": "vrsctest",
  "iAddress": "<identity-address>",
  "friendlyName": "<display-name>"
}
```

Authorization uses `(chainId, iAddress)`. Friendly name is display-only.

### Session token

- Generate at least 256 bits using a cryptographically secure random source.
- Send the raw token only to the browser.
- Store only a keyed hash or cryptographic hash representation server-side.
- Compare token hashes in constant-time where the selected primitives require it.
- Never log raw tokens.
- Rotate the token after successful login and security-sensitive session changes.

### Browser transport

Use a cookie with:

- `HttpOnly`;
- `Secure` outside explicitly isolated local development;
- `SameSite=Lax` by default;
- a narrow `Path`;
- no JavaScript-readable copy.

If the final Verus callback topology requires cross-site cookie behavior, document and
test the smallest safe change. Do not fall back to `localStorage` without a superseding
ADR.

### Lifetime

Durations are typed configuration with conservative defaults:

- login challenge: 5 minutes;
- inactivity timeout: 12 hours;
- absolute session lifetime: 7 days.

Exact values may be adjusted before pilot, but expiry is mandatory. Activity extends
only inactivity expiry, never absolute lifetime.

### Revocation and logout

- Logout revokes the server-side session.
- Rotation revokes the previous token atomically.
- Expired sessions are rejected even if cleanup has not removed their rows.
- A user may hold multiple device sessions, all bound to the same principal.
- Administrative bulk revocation is available for incidents.
- Identity revocation/recovery behavior is reconciled at login and at defined
  authorization checkpoints.

### CSRF and origin

- State-changing routes validate Origin/Host according to deployment configuration.
- Cookie-authenticated mutations use same-site protections and a CSRF token where the
  final routing model requires one.
- Login challenges bind the expected origin, chain, nonce, and expiry.
- CORS does not use wildcard origins with credentials.

### Mobile

Native mobile token storage is outside the web MVP. The later mobile ADR may use secure
OS keychain storage and an Authorization header while preserving the same server-side
session semantics.

## Consequences

### Positive

- XSS cannot directly read the session token from JavaScript.
- Logout and incident revocation are real server-side operations.
- Sessions expire and rotate.
- Chain context cannot be separated from the authenticated identity.
- Multiple devices resume the same Daily attempt without sharing a local secret store.

### Negative

- Cookie and CSRF behavior must be tested with wallet callbacks and production domains.
- Server-side session storage is required.
- Native applications need a later transport-specific decision.

## Alternatives considered

### Bearer token in `localStorage`

Rejected because an XSS issue exposes a long-lived authentication secret and current
logout does not revoke server state.

### Self-contained JWT

Rejected for MVP. Immediate revocation, compact security review, and small scope are
more valuable than stateless verification. A JWT would not remove the need for
revocation/session state.

### Require VerusID signing for every action

Rejected because it creates poor game UX and unnecessary wallet prompts. VerusID proves
login; the expiring session authenticates ordinary game actions.

## Validation

- replayed and expired login challenges fail;
- a session token is absent from JavaScript APIs and application logs;
- logout immediately invalidates the session;
- rotated tokens cannot be reused;
- inactivity and absolute expiry are independently tested with an injected clock;
- two device sessions map to the same chain-bound principal and Daily attempt;
- wrong Origin/Host and CSRF attempts fail;
- VRSC principals are rejected in the VRSCTEST-only MVP;
- identity recovery/revocation test cases are executed on VRSCTEST;
- database backup output contains no raw token.

## Revisit triggers

- native mobile implementation;
- deployment across multiple first-party origins;
- external API clients;
- protocol changes in Verus Connect;
- evidence that cookie transport cannot support the required wallet flow safely.
