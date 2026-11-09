<script lang="ts">
	/**
	 * Fase 2: de speler zet zijn resultaat (met Merkle-bewijs) in zijn eigen VerusID.
	 *
	 * Verschijnt pas als de result-root van de ronde bevestigd is (anders geeft de
	 * server RESULT_ROOT_UNPUBLISHED). Toont QR/deeplink, pollt de status:
	 * pending → receipt (wallet gaf een txid) → published (teruggelezen van de chain).
	 */
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';

	let { token, attemptId, playerName }: { token: string; attemptId: string; playerName: string } = $props();

	type Publication = {
		attemptId: string;
		requestId: string;
		status: 'pending' | 'receipt' | 'published' | 'expired' | 'mismatch';
		contentKey: string;
		contentKeyName: string;
		recordSha256: string;
		record: { round: string; status: string; guesses: number; resultRoot: string; resultRootTxid: string };
		walletUri: string | null;
		expiresHeight: number;
		receiptTxid: string | null;
		publishedTxid: string | null;
		publishedHeight: number | null;
	};

	const headers = () => ({ authorization: `Bearer ${token}` });

	let publication = $state<Publication | null>(null);
	let qr = $state('');
	let busy = $state(false);
	let error = $state('');
	let notAvailable = $state(''); // reden waarom publiceren (nog) niet kan
	let unavailable = $state(false); // feature uit op deze server
	let timer: ReturnType<typeof setInterval> | null = null;

	async function fetchStatus() {
		const response = await fetch(`/api/v1/attempts/${encodeURIComponent(attemptId)}/publish-request`, { headers: headers() });
		if (response.status === 404) {
			unavailable = true;
			return;
		}
		if (!response.ok) throw new Error(`status ${response.status}`);
		const body = await response.json();
		await apply(body.publication);
	}

	async function apply(value: Publication | null) {
		publication = value;
		if (value?.status === 'pending' && value.walletUri) {
			// Het verzoek bevat het volledige record (~2000 tekens): lage foutcorrectie en groot genoeg om te scannen.
			qr = await QRCode.toDataURL(value.walletUri, { margin: 2, width: 720, errorCorrectionLevel: 'L' });
			startPolling();
		} else {
			qr = '';
			if (value?.status === 'receipt') startPolling(10_000);
			else stopPolling();
		}
	}

	async function requestPublication() {
		if (busy) return;
		busy = true;
		error = '';
		notAvailable = '';
		try {
			const response = await fetch(`/api/v1/attempts/${encodeURIComponent(attemptId)}/publish-request`, { method: 'POST', headers: headers() });
			const body = await response.json();
			if (!response.ok) {
				if (body.error?.code === 'RESULT_ROOT_UNPUBLISHED') {
					notAvailable = 'The operator has not published this round’s result root on chain yet. Come back after the round is finalized.';
				} else {
					error = body.error?.message ?? `Request failed (${response.status})`;
				}
				return;
			}
			await apply(body.publication);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Request failed';
		} finally {
			busy = false;
		}
	}

	function startPolling(interval = 3000) {
		stopPolling();
		timer = setInterval(() => {
			fetchStatus().catch(() => {
				/* tijdelijke fout: volgende poll */
			});
		}, interval);
	}

	function stopPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	onMount(() => {
		fetchStatus().catch((cause) => {
			error = cause instanceof Error ? cause.message : 'Could not load publication status';
		});
		return stopPolling;
	});
</script>

{#if !unavailable}
	<section class="publish">
		<header>
			<p class="eyebrow">Own your result</p>
			<h3>
				{#if publication?.status === 'published'}Stored in your VerusID{:else}Put this result in your VerusID{/if}
			</h3>
		</header>

		{#if publication?.status === 'published'}
			<p class="explain">
				Your result for round <code>{publication.record.round}</code> is stored in your identity under the
				Arcade key, in transaction <code>{publication.publishedTxid}</code> (block
				<strong>{publication.publishedHeight}</strong>). It carries the Merkle proof against result root
				<code>{publication.record.resultRoot}</code>, so anyone can verify it without this server.
			</p>
		{:else if publication?.status === 'receipt'}
			<p class="explain">
				Your wallet created transaction <code>{publication.receiptTxid}</code>. Waiting for the chain to
				confirm it and for the record to be read back… this usually takes a minute or two.
			</p>
		{:else if publication?.status === 'pending' && publication.walletUri}
			<p class="explain">
				Scan with Verus Mobile. You approve an update of <strong>your own</strong> identity that only adds one
				record under the Arcade key; nothing else in your identity changes. Your wallet pays the small
				update fee (free test coins on VRSCTEST).
			</p>
			<p class="signer">
				In Verus Mobile, choose <strong>{playerName}</strong> as the identity to update.
			</p>
			<div class="qr-row">
				{#if qr}<img class="qr" src={qr} alt="QR code for Verus Mobile" width="360" height="360" />{/if}
				<div class="actions">
					<a class="button" href={publication.walletUri}>Open in Verus Mobile</a>
					<p class="hint">Waiting for your wallet… valid until block {publication.expiresHeight}.</p>
					<details>
						<summary>What exactly goes into my identity?</summary>
						<p class="hint">Key <code>{publication.contentKeyName}</code></p>
						<pre>{JSON.stringify(publication.record, null, 1)}</pre>
					</details>
				</div>
			</div>
		{:else}
			<p class="explain">
				Once the operator has published this round’s result root, you can store your result and its
				Merkle proof in your own VerusID. It travels with your identity to any app that reads it.
			</p>
			{#if publication?.status === 'expired'}<p class="hint">The previous request expired. Create a new one.</p>{/if}
			{#if publication?.status === 'mismatch'}
				<p class="error">The record found in your identity does not match what was requested. You can publish again.</p>
			{/if}
			{#if notAvailable}<p class="hint">{notAvailable}</p>{/if}
			<button disabled={busy} onclick={requestPublication}>
				{busy ? 'Preparing…' : 'Put in my VerusID'}
			</button>
		{/if}

		{#if error}<p class="error">{error}</p>{/if}
	</section>
{/if}

<style>
	.publish { margin-top: 1rem; padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #eef3ee; display: grid; gap: 0.6rem; }
	.publish header { display: grid; gap: 0.15rem; }
	.eyebrow { margin: 0; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h3 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.3rem; }
	.explain { margin: 0; font-size: 0.85rem; line-height: 1.45; color: #2a3a2e; }
	.explain code, .hint code { overflow-wrap: anywhere; }
	.qr-row { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
	.qr { border-radius: 0.6rem; background: white; padding: 0.4rem; border: 1px solid #c7d1c7; width: min(360px, 100%); height: auto; image-rendering: pixelated; }
	.actions { display: grid; gap: 0.5rem; min-width: 14rem; flex: 1; }
	.button, button { display: inline-block; padding: 0.6rem 1rem; border-radius: 0.6rem; border: 0; background: #193d26; color: white; font-weight: 700; text-decoration: none; text-align: center; cursor: pointer; }
	button:disabled { opacity: 0.55; cursor: default; }
	.hint { margin: 0; font-size: 0.75rem; color: #5c6d61; }
	.signer { margin: 0; padding: 0.5rem 0.7rem; border-radius: 0.5rem; background: #fff6d6; border: 1px solid #e6d58a; font-size: 0.8rem; line-height: 1.4; }
	.error { margin: 0; color: #8b2b2b; font-size: 0.8rem; }
	details { font-size: 0.75rem; }
	pre { margin: 0.4rem 0 0; padding: 0.5rem; background: #e2e9e1; border-radius: 0.4rem; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.65rem; max-height: 14rem; overflow: auto; }
</style>
