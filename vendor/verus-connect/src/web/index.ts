/**
 * <verus-connect-login> — drop-in custom element.
 *
 * Talks to a verus-connect sidecar over HTTP:
 *   GET  {base}/chains              → render chain picker
 *   POST {base}/login   {chain}     → render QR + deeplink for the picked chain
 *   GET  {base}/result/:challengeId → poll until { status: "verified" }
 *
 * On verification, fires a CustomEvent("verified", { detail: { iAddress,
 * friendlyName, systemId, chainName, evidence } }). Switching chains
 * regenerates the challenge automatically; old polls are cancelled.
 *
 * Usage:
 *   <script type="module" src="https://your.cdn/verus-connect-web.js"></script>
 *   <verus-connect-login base="/verus" default-chain="vrsc"></verus-connect-login>
 *   <script>
 *     document.querySelector('verus-connect-login').addEventListener('verified',
 *       (e) => console.log(e.detail));
 *   </script>
 *
 * Theme via CSS custom properties on the host (--vc-primary, --vc-fg,
 * --vc-fg-muted, --vc-pill-bg, --vc-qr-bg).
 */

// `qrcode` is bundled inline via tsup's `noExternal` for this entry; the
// import is resolved at build time so consumers don't need to install it.
import QRCode from 'qrcode';

interface ChainInfo {
  name: string;
  displayName: string;
  systemId: string;
  healthy: boolean;
  lastChecked: number;
}
interface ChainsResponse {
  default: string;
  chains: ChainInfo[];
}
interface LoginResponse {
  challengeId: string;
  /** Legacy single-deeplink field — kept for backward compatibility. Points at the POST envelope. */
  deepLink?: string;
  /** Legacy alias for deepLink. */
  uri?: string;
  /** POST-mode envelope. Use this in the QR (wallet POSTs the response server-side). */
  deepLinkPost?: string;
  /** REDIRECT-mode envelope. Use this for tap-to-open-wallet (wallet redirects user back). Null when REDIRECT_URL isn't configured. */
  deepLinkRedirect?: string | null;
  chain: string;
  chainName: string;
  systemId: string;
}

// VDXF key the wallet uses to append the base64url-encoded GenericResponse as
// a URL parameter when it honours TYPE_REDIRECT. Constant per the primitives
// definition; hardcoded here so the web bundle stays zero-dep.
const RESPONSE_PARAM_VDXFID = 'i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC';
interface VerifiedEvidence {
  decisionHash: string;
  decisionSignature: string;
  challengeHash: string;
  challengeSignature: string;
  challengeSigningId: string;
  systemId: string;
  verifiedAt: number;
}
interface VerifiedResult {
  status: 'verified';
  iAddress: string;
  friendlyName: string;
  systemId: string;
  chainName: string;
  evidence: VerifiedEvidence;
}

const DEFAULT_POLL_MS = 1500;

function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class VerusConnectLogin extends HTMLElement {
  private base = '/verus';
  private currentChain: string | null = null;
  private currentChallengeId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  static get observedAttributes(): string[] {
    return ['base', 'default-chain'];
  }

  connectedCallback(): void {
    this.base = (this.getAttribute('base') ?? '/verus').replace(/\/+$/, '');
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.render();
    void this.handleRedirectReturn();
    void this.bootstrap();
  }

  /**
   * If the current page URL has `?challengeId=…` AND the wallet's response
   * payload as the second VDXF-keyed param, the user just came back from a
   * mobile wallet redirect (TYPE_REDIRECT). Submit the carried response to
   * the sidecar so verification + result population happen, then poll
   * /result/:id to fire the `verified` event. Strips the params from the URL
   * on success so a page refresh doesn't double-resolve.
   */
  /**
   * Single chokepoint for dispatching the `verified` event. Both the polling
   * path (QR-scan) and the redirect-return path (deeplink-click) call this so
   * the event payload shape can never drift between the two code paths.
   * Includes `challengeId` so integrators can finalise sessions without
   * having to keep their own state, plus the `evidence` block from /result
   * for independent re-verification.
   */
  private dispatchVerified(data: VerifiedResult, challengeId: string): void {
    this.setStatus(`Signed in as ${data.friendlyName ?? data.iAddress}`);
    this.dispatchEvent(new CustomEvent('verified', {
      detail: { ...data, challengeId },
      bubbles: true,
      composed: true,
    }));
  }

  private async handleRedirectReturn(): Promise<void> {
    try {
      const url = new URL(window.location.href);
      const challengeId = url.searchParams.get('challengeId');
      const payload = url.searchParams.get(RESPONSE_PARAM_VDXFID);
      if (!challengeId) return;

      // If the wallet attached a response payload, ship it server-side so the
      // sidecar can verify the signature. Same endpoint the POST-flow wallet
      // hits — `/verusidlogin/:id` accepts the raw response bytes.
      if (payload) {
        try {
          const bytes = base64UrlToBytes(payload);
          await fetch(`${this.base}/verusidlogin/${challengeId}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes,
          });
        } catch {
          // Verification will fail downstream; let the poll surface the real
          // status. Stripping the URL params still proceeds.
        }
      }

      // Always try /result — the server may have already resolved this
      // challenge via the POST path, in which case there's no payload to
      // submit but the result is ready.
      const res = await fetch(`${this.base}/result/${challengeId}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = (await res.json()) as { status: string } & VerifiedResult;
        if (data.status === 'verified') {
          this.dispatchVerified(data, challengeId);
        }
      }

      // Strip both params so a reload doesn't double-resolve and the URL
      // stays clean for any onverified handler the host page installs.
      url.searchParams.delete('challengeId');
      url.searchParams.delete(RESPONSE_PARAM_VDXFID);
      history.replaceState(null, '', url.toString());
    } catch {
      // Best-effort; fall through to normal bootstrap.
    }
  }

  disconnectedCallback(): void {
    this.stopPolling();
  }

  /** Force a new challenge for the currently selected chain. */
  async regenerate(): Promise<void> {
    if (this.currentChain) await this.startChallenge(this.currentChain);
  }

  private async bootstrap(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/chains`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`/chains -> HTTP ${res.status}`);
      const data = (await res.json()) as ChainsResponse;
      const initial = this.getAttribute('default-chain') ?? data.default;
      this.renderPicker(data.chains, initial);
      await this.startChallenge(initial);
    } catch (err) {
      this.emitError(err instanceof Error ? err.message : String(err));
    }
  }

  private async startChallenge(chain: string): Promise<void> {
    this.currentChain = chain;
    this.stopPolling();
    this.setStatus(`Issuing challenge for ${chain.toUpperCase()}…`);
    try {
      const res = await fetch(`${this.base}/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain }),
      });
      if (!res.ok) throw new Error(`/login -> HTTP ${res.status}`);
      const data = (await res.json()) as LoginResponse;
      this.currentChallengeId = data.challengeId;

      // QR uses the POST envelope (works for scan-from-another-device).
      // The "Sign in with Verus" button uses the REDIRECT envelope when the
      // sidecar offers one (same-device deeplink flow). When REDIRECT_URL
      // isn't configured server-side, deepLinkRedirect is null — we fall the
      // button back to the POST link so it still opens the wallet, just
      // without browser-redirect-back behaviour.
      const qrLink = data.deepLinkPost ?? data.deepLink ?? data.uri ?? '';
      const buttonLink = data.deepLinkRedirect ?? qrLink;
      await this.renderQr(qrLink);
      this.renderDeepLinkButton(buttonLink);
      this.setStatus('Waiting for signature…');
      this.startPolling(data.challengeId);
    } catch (err) {
      this.emitError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderDeepLinkButton(href: string): void {
    if (!this.shadowRoot) return;
    const anchor = this.shadowRoot.querySelector('.deeplink') as HTMLAnchorElement | null;
    if (!anchor) return;
    anchor.href = href;
    anchor.hidden = false;
  }

  private startPolling(challengeId: string): void {
    const interval = Number(this.getAttribute('poll-interval-ms') ?? DEFAULT_POLL_MS);
    this.pollTimer = setInterval(async () => {
      if (challengeId !== this.currentChallengeId) {
        // Chain switched mid-poll; this timer is for the previous challenge.
        this.stopPolling();
        return;
      }
      try {
        const res = await fetch(`${this.base}/result/${challengeId}`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = (await res.json()) as { status: string } & VerifiedResult;
        if (data.status === 'verified') {
          this.stopPolling();
          this.dispatchVerified(data, challengeId);
        } else if (data.status === 'expired') {
          this.stopPolling();
          this.setStatus('Challenge expired — pick a chain to start again.');
          this.dispatchEvent(new CustomEvent('expired', { bubbles: true, composed: true }));
        }
      } catch {
        // Transient network error — let the next tick retry.
      }
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private render(): void {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, sans-serif;
          color: var(--vc-fg, #111);
          text-align: center;
        }
        .picker { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-bottom: 12px; }
        .pill {
          padding: 6px 14px;
          border: none;
          border-radius: 999px;
          background: var(--vc-pill-bg, #eef);
          color: inherit;
          cursor: pointer;
          font-size: 13px;
          font-family: inherit;
        }
        .pill[aria-pressed="true"] {
          background: var(--vc-primary, #4f46e5);
          color: var(--vc-primary-fg, #fff);
        }
        .pill:disabled { opacity: 0.4; cursor: not-allowed; }
        .qr {
          width: 220px; height: 220px;
          display: flex; align-items: center; justify-content: center;
          background: var(--vc-qr-bg, #f7f7fa);
          border-radius: 8px;
          margin: 0 auto 8px;
        }
        .qr img { width: 200px; height: 200px; display: block; }
        .deeplink {
          display: inline-block;
          padding: 8px 18px;
          background: var(--vc-primary, #4f46e5);
          color: var(--vc-primary-fg, #fff);
          text-decoration: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          margin-bottom: 8px;
        }
        .deeplink-hint {
          font-size: 11px;
          color: var(--vc-fg-muted, #888);
          margin-left: 8px;
        }
        .status {
          font-size: 12px;
          color: var(--vc-fg-muted, #666);
          min-height: 1.2em;
        }
      </style>
      <div class="picker" role="tablist" aria-label="Chain"></div>
      <div class="qr" aria-live="polite"></div>
      <div><a class="deeplink" rel="noopener" hidden>Sign in with Verus</a></div>
      <div class="status">Loading…</div>
    `;
  }

  private renderPicker(chains: ChainInfo[], selected: string): void {
    const picker = this.shadowRoot?.querySelector('.picker');
    if (!picker) return;
    picker.innerHTML = '';
    for (const chain of chains) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pill';
      pill.textContent = chain.displayName;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-pressed', String(chain.name === selected));
      if (!chain.healthy) pill.disabled = true;
      pill.addEventListener('click', () => {
        if (pill.disabled || this.currentChain === chain.name) return;
        picker.querySelectorAll('.pill').forEach((p) => p.setAttribute('aria-pressed', 'false'));
        pill.setAttribute('aria-pressed', 'true');
        void this.startChallenge(chain.name);
      });
      picker.appendChild(pill);
    }
  }

  private async renderQr(link: string): Promise<void> {
    if (!this.shadowRoot) return;
    const wrapper = this.shadowRoot.querySelector('.qr');
    if (!wrapper) return;
    try {
      const dataUrl = await QRCode.toDataURL(link, { margin: 1, width: 200 });
      wrapper.innerHTML = `<img src="${dataUrl}" alt="Scan with Verus mobile wallet" />`;
    } catch (err) {
      wrapper.textContent = '(QR encode failed)';
      this.emitError(err instanceof Error ? err.message : String(err));
    }
  }

  private setStatus(text: string): void {
    const el = this.shadowRoot?.querySelector('.status');
    if (el) el.textContent = text;
  }

  private emitError(message: string): void {
    this.setStatus(`Error: ${message}`);
    this.dispatchEvent(new CustomEvent('error', { detail: { message }, bubbles: true, composed: true }));
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('verus-connect-login')) {
  customElements.define('verus-connect-login', VerusConnectLogin);
}
