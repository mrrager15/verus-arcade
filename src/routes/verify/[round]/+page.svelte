<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		verifyRoundReveal,
		type Commitment,
		type Reveal
	} from '$lib/proof-verifier';

	type Transaction = { status: 'pending' | 'confirmed'; txid: string | null };
	type ProofResponse = {
		roundStatus: string;
		commitment: Commitment & { transaction: Transaction };
		reveal: (Reveal & { transaction: Transaction }) | null;
		results: {
			algorithm: string;
			leafCount: number;
			rootSha256: string;
			bundleSha256: string;
			transaction: Transaction;
		} | null;
	};

	let data = $state<ProofResponse | null>(null);
	let error = $state('');
	let recomputed = $state('');
	let valid = $state<boolean | null>(null);

	onMount(async () => {
		try {
			const roundId = page.params.round;
			if (!roundId) {
				error = 'Round ID is missing.';
				return;
			}
			const response = await fetch(`/api/v1/rounds/${encodeURIComponent(roundId)}/proof`);
			const body = await response.json();
			if (!response.ok) {
				error = body.error?.message ?? 'Round proof is unavailable.';
				return;
			}
			data = body;
			if (body.reveal) {
				const verification = await verifyRoundReveal(body.commitment, body.reveal);
				recomputed = verification.recomputedSha256;
				valid = verification.valid;
			}
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
	});
</script>

<svelte:head><title>Verify round | Verus Arcade</title></svelte:head>

<main>
	<p class="eyebrow">Independent browser verification</p>
	<h1>Round proof</h1>

	{#if error}
		<p class="error">{error}</p>
	{:else if !data}
		<p>Loading proof material…</p>
	{:else}
		<section>
			<h2>Commitment</h2>
			<p>Your browser received the public commitment for <code>{data.commitment.roundId}</code>.</p>
			<dl>
				<dt>Hidden-definition SHA-256</dt>
				<dd>{data.commitment.hiddenDefinitionSha256}</dd>
				<dt>Transaction</dt>
				<dd>{data.commitment.transaction.txid ?? 'Pending'}</dd>
			</dl>
		</section>

		<section>
			<h2>Reveal</h2>
			{#if data.reveal}
				<p>
					The complete definition is public. This browser canonicalized it and recomputed the
					hash locally with Web Crypto.
				</p>
				<dl>
					<dt>Answer</dt>
					<dd>{data.reveal.hiddenDefinition.answer}</dd>
					<dt>Recomputed SHA-256</dt>
					<dd>{recomputed}</dd>
					<dt>Reveal transaction</dt>
					<dd>{data.reveal.transaction.txid}</dd>
				</dl>
				<p class:ok={valid === true} class:bad={valid === false} class="verdict">
					{valid === true
						? 'Verified: the reveal matches the pre-game commitment.'
						: 'Verification failed: the reveal does not match the commitment.'}
				</p>
			{:else}
				<p>The reveal is not confirmed yet. No answer, salt, or puzzle seed is exposed.</p>
			{/if}
		</section>

		<section>
			<h2>Result set</h2>
			{#if data.results}
				<dl>
					<dt>Algorithm</dt><dd>{data.results.algorithm}</dd>
					<dt>Players</dt><dd>{data.results.leafCount}</dd>
					<dt>Merkle root</dt><dd>{data.results.rootSha256}</dd>
					<dt>Bundle SHA-256</dt><dd>{data.results.bundleSha256}</dd>
					<dt>Chain publication</dt><dd>{data.results.transaction.status}</dd>
				</dl>
			{:else}
				<p>Results have not been finalized.</p>
			{/if}
		</section>
	{/if}
</main>

<style>
	main { max-width: 52rem; margin: 4rem auto; padding: 0 1.25rem 4rem; font-family: system-ui, sans-serif; color: #18221b; }
	.eyebrow { color: #497755; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
	h1 { font-size: clamp(2.2rem, 7vw, 4.5rem); margin: .2rem 0 2rem; }
	section { border: 1px solid #cad8cd; border-radius: 1rem; padding: 1.25rem; margin: 1rem 0; background: #fbfdfb; }
	dl { display: grid; grid-template-columns: minmax(9rem, .45fr) 1fr; gap: .6rem 1rem; }
	dt { font-weight: 700; }
	dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: .86rem; }
	.verdict { padding: .8rem; border-radius: .6rem; font-weight: 700; }
	.ok { background: #dff4e3; color: #155c2b; }
	.bad, .error { background: #ffe1df; color: #8d2019; padding: .8rem; border-radius: .6rem; }
	code { overflow-wrap: anywhere; }
	@media (max-width: 600px) { dl { grid-template-columns: 1fr; } }
</style>
