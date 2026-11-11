<script lang="ts">
	/**
	 * Fase 2b: een gedeelde attestatie controleren. De link staat na het #-teken
	 * (komt dus niet in serverlogs terecht) en gaat in de body naar de server, die
	 * (1) de velden tegen de verzegelde wortel controleert, (2) de handtekening van
	 * Arcade@ met de sleutels op tekenhoogte, en (3) kijkt of precies deze
	 * attestatie in de VerusID van de speler staat. In fase 4 gebeurt dit in de
	 * browser met de publieke RPC.
	 */
	import { onMount } from 'svelte';

	type Result = {
		valid: boolean;
		player: string;
		round: string;
		fields: Record<string, string>;
		root: string;
		signer: string;
		signatureHeight: number;
		signature: { ok: boolean; error?: string; message?: string };
		inPlayerIdentity: { checked: boolean; found?: boolean; txid?: string | null; height?: number | null; error?: string };
	};

	let result = $state<Result | null>(null);
	let error = $state('');

	const LABELS: Record<string, string> = {
		streak: 'Streak (signed Dailies in a row, solved)',
		rounds: 'Signed rounds played',
		solved: 'Signed rounds solved',
		prev: 'Previous attestation (root)'
	};

	onMount(async () => {
		const link = location.hash.slice(1);
		if (!link) {
			error = 'This page needs a share link (everything after # in the address).';
			return;
		}
		try {
			const response = await fetch('/api/v1/attestations/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ link })
			});
			const body = await response.json();
			if (!response.ok) {
				error = body.error?.message ?? 'This link could not be checked.';
				return;
			}
			result = body;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'This link could not be checked.';
		}
	});
</script>

<svelte:head>
	<title>Verus Arcade · Verify attestation</title>
</svelte:head>

<main class="page">
	<p class="eyebrow">Attestation check · VRSCTEST</p>
	{#if error}
		<h1>Not valid</h1>
		<p class="error">{error}</p>
	{:else if !result}
		<p>Checking against the chain…</p>
	{:else}
		<h1 class:bad={!result.valid}>{result.valid ? 'Signed by Arcade@' : 'Signature does not check out'}</h1>
		<p class="meta">
			Player <a href={`/profile/${encodeURIComponent(result.player)}`}><code>{result.player}</code></a> · round
			<strong>{result.round}</strong>
		</p>
		<dl class="fields">
			{#each Object.entries(result.fields) as [name, value] (name)}
				<dt>{LABELS[name] ?? name}</dt>
				<dd>{#if name === 'prev'}<code>{value}</code>{:else}<strong>{value}</strong>{/if}</dd>
			{/each}
		</dl>
		<p class="hint">Only these fields were shared. The other fields of this attestation stay hidden; only their salted hashes are part of the proof.</p>
		<ul class="checks">
			<li class:ok={true}>Shared fields belong to the sealed attestation (root <code>{result.root.slice(0, 16)}…</code>).</li>
			<li class:ok={result.signature.ok} class:fail={!result.signature.ok}>
				{#if result.signature.ok}
					Signature by <code>{result.signer}</code> (Arcade@) checked against its keys at block {result.signatureHeight}.
				{:else}
					Signature check failed: {result.signature.message ?? result.signature.error}
				{/if}
			</li>
			<li class:ok={result.inPlayerIdentity.found === true}>
				{#if !result.inPlayerIdentity.checked}
					Could not read the player's identity right now.
				{:else if result.inPlayerIdentity.found}
					This exact attestation is stored in the player's own VerusID (block {result.inPlayerIdentity.height}).
				{:else}
					Not (yet) stored in the player's own VerusID. The signature above is still valid.
				{/if}
			</li>
		</ul>
	{/if}
	<a class="back" href="/">Verus Arcade</a>
</main>

<style>
	.page { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; color: #193d26; }
	h1.bad { color: #8b2b2b; }
	.meta, .hint { margin: 0; font-size: 0.85rem; color: #5c6d61; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.fields { margin: 0; padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; }
	.fields dt { color: #5c6d61; font-size: 0.85rem; }
	.fields dd { margin: 0; font-size: 1.1rem; }
	.checks { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.35rem; font-size: 0.85rem; }
	.checks .ok::marker { content: '✓  '; color: #193d26; }
	.checks .fail { color: #8b2b2b; }
	.back { font-size: 0.85rem; }
	.error { color: #8b2b2b; }
</style>
