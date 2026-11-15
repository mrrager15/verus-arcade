<script lang="ts">
	/**
	 * Fase 2: de speler zet zijn resultaat (met Merkle-bewijs) in zijn eigen VerusID.
	 *
	 * Verschijnt pas als de result-root van de ronde bevestigd is (anders geeft de
	 * server RESULT_ROOT_UNPUBLISHED). Toont QR/deeplink, pollt de status:
	 * pending → receipt (wallet gaf een txid) → published (teruggelezen van de chain).
	 *
	 * Fase 2b: met `kind="attestation"` dezelfde flow voor de verzegelde attestatie
	 * van Arcade@ (zonder waarden of zouten; jij kiest later wat je toont).
	 *
	 * Fase 5: met `kind="bundle"` verzegelt de speler zijn zetten: versleuteld naar het
	 * adres van de ronde, al tijdens de ronde. Alleen tonen bij een ronde die zo'n adres
	 * publiceerde. Optioneel: het telt nergens voor mee, het klassement toont een label.
	 */
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';

	let {
		token,
		attemptId,
		playerName,
		kind = 'result',
		onpublished
	}: {
		token: string;
		attemptId: string;
		playerName: string;
		kind?: 'result' | 'attestation' | 'bundle';
		onpublished?: () => void;
	} = $props();
	const attestation = $derived(kind === 'attestation');
	const bundle = $derived(kind === 'bundle');
	const endpoint = $derived(
		`/api/v1/attempts/${encodeURIComponent(attemptId)}/publish-request${kind === 'result' ? '' : `?kind=${kind}`}`
	);

	type Publication = {
		attemptId: string;
		requestId: string;
		status: 'pending' | 'receipt' | 'published' | 'expired' | 'mismatch';
		contentKey: string;
		contentKeyName: string;
		recordSha256: string;
		record: { round: string; status?: string; guesses?: number; resultRoot?: string; resultRootTxid?: string };
		encryptToAddress?: string | null;
		walletUri: string | null;
		expiresHeight: number;
		receiptTxid: string | null;
		publishedTxid: string | null;
		publishedHeight: number | null;
		waitForPrevious?: boolean;
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
		const response = await fetch(endpoint, { headers: headers() });
		if (response.status === 404) {
			unavailable = true;
			return;
		}
		if (!response.ok) throw new Error(`status ${response.status}`);
		const body = await response.json();
		await apply(body.publication);
	}

	async function apply(value: Publication | null) {
		const justPublished = value?.status === 'published' && publication !== null && publication.status !== 'published';
		publication = value;
		if (justPublished) onpublished?.();
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
			const response = await fetch(endpoint, { method: 'POST', headers: headers() });
			const body = await response.json();
			if (!response.ok) {
				if (body.error?.code === 'PREVIOUS_UPDATE_UNCONFIRMED') {
					notAvailable = 'Your previous update of this identity is not confirmed yet. Wait about a minute and try again.';
				} else if (body.error?.code === 'ATTESTATION_NOT_FOUND') {
					notAvailable = 'Arcade@ has not attested this round yet. That happens shortly after the round closes.';
				} else if (body.error?.code === 'ROUND_ALREADY_REVEALED') {
					notAvailable = 'This round is already revealed. Sealing your moves now would no longer prove when you made them.';
				} else if (body.error?.code === 'BUNDLE_NOT_AVAILABLE') {
					notAvailable = 'This round did not publish an encryption address, so moves cannot be sealed.';
				} else if (body.error?.code === 'RESULT_ROOT_UNPUBLISHED') {
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
			<p class="eyebrow">{bundle ? 'Seal your moves' : attestation ? 'Own your attestation' : 'Own your result'}</p>
			<h3>
				{#if bundle}
					{#if publication?.status === 'published'}Sealed in your VerusID{:else}Seal your moves on-chain{/if}
				{:else if publication?.status === 'published'}Stored in your VerusID{:else}Put this {attestation ? 'attestation' : 'result'} in your VerusID{/if}
			</h3>
		</header>

		{#if publication?.status === 'published' && bundle}
			<p class="explain">
				Your moves for round <code>{publication.record.round}</code> are sealed in your identity, in transaction
				<code>{publication.publishedTxid}</code> (block <strong>{publication.publishedHeight}</strong>). They are
				encrypted to this round's address, so nobody can read them yet. Once the round is revealed, anyone can
				open them, replay your game and see that they were on chain before the answer was known.
			</p>
		{:else if publication?.status === 'published' && attestation}
			<p class="explain">
				The sealed attestation for round <code>{publication.record.round}</code> is stored in your identity, in
				transaction <code>{publication.publishedTxid}</code> (block <strong>{publication.publishedHeight}</strong>). It
				holds no values: only salted hashes and Arcade@'s signature. Share links can now also be checked against
				your own identity.
			</p>
		{:else if publication?.status === 'published'}
			<p class="explain">
				Your result for round <code>{publication.record.round}</code> is stored in your identity under the
				Arcade key, in transaction <code>{publication.publishedTxid}</code> (block
				<strong>{publication.publishedHeight}</strong>). It carries the Merkle proof against the round's result
				root{#if publication.record.resultRoot}&nbsp;<code>{publication.record.resultRoot}</code>{/if}, so anyone can verify it
				without this server.
			</p>
		{:else if publication?.status === 'receipt'}
			<p class="explain">
				Your wallet created transaction <code>{publication.receiptTxid}</code>. Waiting for the chain to
				confirm it and for the record to be read back… this usually takes a minute or two.
			</p>
		{:else if publication?.status === 'pending' && publication.walletUri}
			<p class="explain">
				Scan with Verus Mobile. You approve an update of <strong>your own</strong> identity that only adds one
				{bundle ? 'encrypted ' : ''}record under the Arcade key; nothing else in your identity changes. Your wallet pays the small
				update fee (free test coins on VRSCTEST).
			</p>
			{#if bundle}
				<p class="signer">
					Verus Mobile shows this as an <strong>encrypted upload</strong>. Approve it once: every extra approval adds
					another copy and costs another fee.
				</p>
			{/if}
			{#if publication.waitForPrevious}
				<p class="wait">
					Wait a moment before scanning: your previous update of this identity is not confirmed yet. Scanning now
					makes the chain reject this one ("inputs spent"). This message disappears once it is confirmed.
				</p>
			{/if}
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
						{#if bundle && publication.encryptToAddress}
							<p class="hint">
								Encrypted to this round's address <code>{publication.encryptToAddress}</code>. The key to open it
								follows from the round's secret, which Arcade@ only publishes at the reveal. The Verus node your
								wallet uses builds the encrypted record, so that node does see your moves.
							</p>
						{/if}
						<pre>{JSON.stringify(publication.record, null, 1)}</pre>
					</details>
				</div>
			</div>
		{:else}
			<p class="explain">
				{#if bundle}
					Optional. Put your moves on chain now, encrypted, in your own VerusID. After the reveal anyone can open
					them and check, without trusting this server, that they existed before the answer was known. It costs one
					identity update (about 0.005 VRSCTEST) and does not change your score or streak.
				{:else if attestation}
					Store Arcade@'s signed attestation in your own VerusID. Only the sealed form goes on chain (salted hashes
					and the signature), so nobody can read your stats from it; you still decide what to share.
				{:else}
					Once the operator has published this round’s result root, you can store your result and its
					Merkle proof in your own VerusID. It travels with your identity to any app that reads it.
				{/if}
			</p>
			{#if publication?.status === 'expired'}<p class="hint">The previous request expired. Create a new one.</p>{/if}
			{#if publication?.status === 'mismatch'}
				<p class="error">
					{bundle
						? 'What was found in your identity is not the sealed record that was requested. You can seal again.'
						: 'The record found in your identity does not match what was requested. You can publish again.'}
				</p>
			{/if}
			{#if notAvailable}<p class="hint">{notAvailable}</p>{/if}
			<button disabled={busy} onclick={requestPublication}>
				{busy ? 'Preparing…' : bundle ? 'Seal my moves' : 'Put in my VerusID'}
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
	.wait { margin: 0; padding: 0.5rem 0.7rem; border-radius: 0.5rem; background: #fde8e4; border: 1px solid #e3a99c; font-size: 0.8rem; line-height: 1.4; }
	.signer { margin: 0; padding: 0.5rem 0.7rem; border-radius: 0.5rem; background: #fff6d6; border: 1px solid #e6d58a; font-size: 0.8rem; line-height: 1.4; }
	.error { margin: 0; color: #8b2b2b; font-size: 0.8rem; }
	details { font-size: 0.75rem; }
	pre { margin: 0.4rem 0 0; padding: 0.5rem; background: #e2e9e1; border-radius: 0.4rem; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.65rem; max-height: 14rem; overflow: auto; }
</style>
