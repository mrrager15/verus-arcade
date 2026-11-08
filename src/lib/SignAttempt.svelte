<script lang="ts">
	/**
	 * Fase 1: de speler tekent zijn afgeronde poging met zijn VerusID.
	 *
	 * Toont een QR (voor scannen met de telefoon) en een knop (als de wallet op
	 * hetzelfde toestel staat), pollt de status tot 'signed' en verwerkt de
	 * terugkeer uit de wallet via ?walletReturn=<requestId>&signed=1.
	 */
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';

	let { token, attemptId }: { token: string; attemptId: string } = $props();

	type Signature = {
		attemptId: string;
		requestId: string;
		status: 'pending' | 'signed' | 'expired';
		message: string;
		walletUri: string | null;
		expiresHeight: number;
		signer: string | null;
		signingHeight: number | null;
	};

	const headers = () => ({ authorization: `Bearer ${token}` });

	let signature = $state<Signature | null>(null);
	let qr = $state('');
	let busy = $state(false);
	let error = $state('');
	let returnNotice = $state('');
	let unavailable = $state(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function fetchStatus() {
		const response = await fetch(`/api/v1/attempts/${encodeURIComponent(attemptId)}/sign-request`, {
			headers: headers()
		});
		if (response.status === 404) {
			// Router zonder handtekeningservice: feature staat uit op deze server.
			unavailable = true;
			return;
		}
		if (!response.ok) throw new Error(`status ${response.status}`);
		const body = await response.json();
		await apply(body.signature);
	}

	async function apply(value: Signature | null) {
		signature = value;
		if (value?.status === 'pending' && value.walletUri) {
			qr = await QRCode.toDataURL(value.walletUri, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
			startPolling();
		} else {
			qr = '';
			stopPolling();
		}
	}

	async function requestSignature() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/v1/attempts/${encodeURIComponent(attemptId)}/sign-request`, {
				method: 'POST',
				headers: headers()
			});
			const body = await response.json();
			if (!response.ok) {
				error = body.error?.message ?? `Request failed (${response.status})`;
				return;
			}
			await apply(body.signature);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Request failed';
		} finally {
			busy = false;
		}
	}

	function startPolling() {
		if (timer) return;
		timer = setInterval(() => {
			fetchStatus().catch(() => {
				/* tijdelijke fout: volgende poll */
			});
		}, 3000);
	}

	function stopPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	function readWalletReturn() {
		const params = new URLSearchParams(window.location.search);
		const walletReturn = params.get('walletReturn');
		if (!walletReturn) return;
		const returnError = params.get('returnError');
		returnNotice = returnError
			? `The wallet returned, but the signature was not accepted (${returnError}).`
			: params.get('signed') === '1'
				? 'Signature received from Verus Mobile.'
				: 'Returned from the wallet.';
		// Query opruimen zodat een herlaad de melding niet herhaalt.
		const clean = new URL(window.location.href);
		for (const key of ['walletReturn', 'signed', 'returnError']) clean.searchParams.delete(key);
		history.replaceState(null, '', clean.toString());
	}

	onMount(() => {
		readWalletReturn();
		fetchStatus().catch((cause) => {
			error = cause instanceof Error ? cause.message : 'Could not load signature status';
		});
		return stopPolling;
	});
</script>

{#if !unavailable}
	<section class="sign">
		<header>
			<p class="eyebrow">Sign your attempt</p>
			<h3>
				{#if signature?.status === 'signed'}Signed with your VerusID{:else}Prove this was you{/if}
			</h3>
		</header>

		{#if returnNotice}<p class="notice">{returnNotice}</p>{/if}

		{#if signature?.status === 'signed'}
			<p class="explain">
				Your identity <code>{signature.signer}</code> signed this attempt at block
				<strong>{signature.signingHeight}</strong>. The signature becomes part of your entry in the
				permanent result proof: nobody, not even the operator, can alter or fabricate your attempt.
			</p>
		{:else if signature?.status === 'pending' && signature.walletUri}
			<p class="explain">
				Scan with Verus Mobile (testnet profile, experimental deeplinks on), or open the wallet on this
				device. You sign a short text with the round, your i-address and a hash of your guesses. No
				transaction, no fee.
			</p>
			<div class="qr-row">
				{#if qr}<img class="qr" src={qr} alt="QR code for Verus Mobile" width="240" height="240" />{/if}
				<div class="actions">
					<a class="button" href={signature.walletUri}>Open in Verus Mobile</a>
					<p class="hint">Waiting for your wallet… valid until block {signature.expiresHeight}.</p>
					<details>
						<summary>What exactly am I signing?</summary>
						<pre>{signature.message}</pre>
					</details>
				</div>
			</div>
		{:else}
			<p class="explain">
				Optional, but recommended: sign a short statement with your VerusID so the result proof carries
				your own signature over your guesses. One scan, no transaction.
			</p>
			{#if signature?.status === 'expired'}<p class="hint">The previous request expired. Create a new one.</p>{/if}
			<button disabled={busy} onclick={requestSignature}>
				{busy ? 'Preparing…' : 'Sign with VerusID'}
			</button>
		{/if}

		{#if error}<p class="error">{error}</p>{/if}
	</section>
{/if}

<style>
	.sign { margin-top: 1rem; padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; gap: 0.6rem; }
	.sign header { display: grid; gap: 0.15rem; }
	.eyebrow { margin: 0; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h3 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.3rem; }
	.explain { margin: 0; font-size: 0.85rem; line-height: 1.45; color: #2a3a2e; }
	.explain code { overflow-wrap: anywhere; }
	.qr-row { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
	.qr { border-radius: 0.6rem; background: white; padding: 0.4rem; border: 1px solid #c7d1c7; }
	.actions { display: grid; gap: 0.5rem; min-width: 14rem; flex: 1; }
	.button, button { display: inline-block; padding: 0.6rem 1rem; border-radius: 0.6rem; border: 0; background: #193d26; color: white; font-weight: 700; text-decoration: none; text-align: center; cursor: pointer; }
	button:disabled { opacity: 0.55; cursor: default; }
	.hint { margin: 0; font-size: 0.75rem; color: #5c6d61; }
	.notice { margin: 0; padding: 0.5rem 0.7rem; border-radius: 0.5rem; background: #e0e9df; font-size: 0.8rem; }
	.error { margin: 0; color: #8b2b2b; font-size: 0.8rem; }
	details { font-size: 0.75rem; }
	pre { margin: 0.4rem 0 0; padding: 0.5rem; background: #e9eee7; border-radius: 0.4rem; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.7rem; }
</style>
