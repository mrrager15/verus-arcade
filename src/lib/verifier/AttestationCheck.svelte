<script lang="ts">
	/**
	 * Een gedeelde attestatie controleren. De link staat na het #-teken (komt dus
	 * niet in serverlogs terecht).
	 *
	 * Fase 4: het oordeel komt volledig uit deze browser en een (publieke)
	 * VRSCTEST-RPC (shared/independent-attestation.mjs): de getoonde velden tegen
	 * de verzegelde wortel, en de handtekening van Arcade@ tegen zijn sleutels op
	 * tekenhoogte, in de browser zelf nagerekend. Ook "staat dit ook in de VerusID
	 * van de speler?" gebeurt hier: het versleutelde record wordt in de browser
	 * ontsleuteld (de publieke RPC kent geen decryptdata). Geen Arcade-server nodig.
	 */
	import { onMount } from 'svelte';
	import { createChainReader } from '../../../shared/chain-reader.mjs';
	import { verifyAttestationLinkIndependently } from '../../../shared/independent-attestation.mjs';
	import { DEFAULT_RPC_URL, rememberedRpcUrl, rememberRpcUrl, rpcHost } from '../verifier-rpc';
	import type { VerifierLinks } from './links';

	/** `link`: alles na het #-teken van een deellink. */
	let { link, links }: { link: string; links: VerifierLinks } = $props();

	type Check = Awaited<ReturnType<typeof verifyAttestationLinkIndependently>>;

	const LABELS: Record<string, string> = {
		streak: 'Streak (signed Dailies in a row, solved)',
		rounds: 'Signed rounds played',
		solved: 'Signed rounds solved',
		prev: 'Previous attestation (root)'
	};
	const VERDICTS: Record<string, { tone: string; title: string }> = {
		verified: { tone: 'ok', title: 'Signed by Arcade@' },
		invalid: { tone: 'bad', title: 'This does not check out' },
		unavailable: { tone: 'neutral', title: 'Could not read the chain' },
		'wrong-chain': { tone: 'bad', title: 'Wrong chain' }
	};

	let rpcUrl = $state(DEFAULT_RPC_URL);
	let check = $state<Check | null>(null);
	let running = $state(false);
	let error = $state('');

	const verdict = $derived(check ? VERDICTS[check.verdict] : null);

	async function run() {
		running = true;
		error = '';
		check = null;
		try {
			const reader = createChainReader({ url: rpcUrl.trim() });
			check = await verifyAttestationLinkIndependently({ link, reader });
			rememberRpcUrl(rpcUrl.trim(), check.verdict);
		} catch (caught) {
			error =
				(caught as { code?: string })?.code === 'INVALID_INPUT'
					? 'That RPC address is not a valid http(s) URL.'
					: caught instanceof Error
						? caught.message
						: String(caught);
		} finally {
			running = false;
		}
	}

	onMount(async () => {
		if (!link) {
			error = 'This page needs a share link (everything after # in the address).';
			return;
		}
		rpcUrl = rememberedRpcUrl();
		await run();
	});
</script>

<svelte:head>
	<title>Verus Arcade · Verify attestation</title>
</svelte:head>

<main class="page">
	<p class="eyebrow">Attestation check · VRSCTEST · checked in this browser</p>
	{#if error}
		<h1 class="bad">Not checked</h1>
		<p class="error">{error}</p>
	{:else if !check}
		<p>{running ? 'Checking against the chain…' : ''}</p>
	{:else if verdict}
		<h1 class={verdict.tone}>{verdict.title}</h1>
		{#if check.player && check.round}
			<p class="meta">
				Player <a href={links.profile(check.player)}><code>{check.player}</code></a> · round
				<strong>{check.round}</strong>
			</p>
		{/if}
		{#if Object.keys(check.fields).length > 0}
			<dl class="fields">
				{#each Object.entries(check.fields) as [name, value] (name)}
					<dt>{LABELS[name] ?? name}</dt>
					<dd>{#if name === 'prev'}<code>{value}</code>{:else}<strong>{value}</strong>{/if}</dd>
				{/each}
			</dl>
			<p class="hint">Only these fields were shared. The other fields of this attestation stay hidden; only their salted hashes are part of the proof.</p>
		{/if}
		<ul class="checks">
			{#if check.root}
				<li class="ok">Shared fields belong to the sealed attestation (root <code>{check.root.slice(0, 16)}…</code>).</li>
			{:else}
				<li class="fail">The link itself does not check out: {check.problem}</li>
			{/if}
			{#if check.signature.status === 'valid'}
				<li class="ok">
					Signature by <code>{check.signer}</code> (Arcade@) checked <strong>in this browser</strong> against its keys at block
					{check.signatureHeight?.toLocaleString('en')} ({check.signature.primaryAddresses.join(', ')}).
				</li>
			{:else if check.signature.status === 'invalid'}
				<li class="fail">Signature check failed: {check.signature.reason}</li>
			{:else if check.signature.status === 'unavailable'}
				<li class="neutral">
					Could not read Arcade@’s keys from the chain ({check.problem}). This is not evidence of anything: try again or use another RPC.
				</li>
			{/if}
		</ul>
		<p class="source">
			Read from <strong>{rpcHost(check.source.url)}</strong>
			{#if check.source.tip !== null}at height {check.source.tip.toLocaleString('en')}{/if}
			· {check.source.calls} {check.source.calls === 1 ? 'request' : 'requests'} · no data from the Arcade server
		</p>

		{#if check.verdict === 'verified'}
			<section class="identity">
				<h2>Also stored in the player’s own VerusID?</h2>
				<p class="hint">
					Verus Mobile stores records in a VerusID encrypted (with the viewing key next to them). This browser
					decrypted them itself. For information only: the result above does not depend on it.
				</p>
				{#if check.inPlayerIdentity.status === 'found'}
					<p class="ok">Yes: this exact attestation is in the player’s VerusID (block {check.inPlayerIdentity.height?.toLocaleString('en')}).</p>
				{:else if check.inPlayerIdentity.status === 'absent'}
					<p>Not (yet) stored in the player’s own VerusID. The signature above is still valid.</p>
				{:else}
					<p class="neutral">Could not read the player’s identity right now.</p>
				{/if}
			</section>
		{/if}
	{/if}

	{#if link && !error}
		<form
			class="rpc"
			onsubmit={(event) => {
				event.preventDefault();
				void run();
			}}
		>
			<label for="rpc">VRSCTEST RPC</label>
			<div class="row">
				<input id="rpc" type="url" bind:value={rpcUrl} spellcheck="false" autocomplete="off" />
				<button type="submit" disabled={running}>{running ? 'Checking…' : 'Check again'}</button>
			</div>
			{#if rpcUrl !== DEFAULT_RPC_URL}
				<button type="button" class="link" onclick={() => { rpcUrl = DEFAULT_RPC_URL; void run(); }}>Use the public node again</button>
			{/if}
		</form>
	{/if}
	<a class="back" href={links.home}>Verus Arcade</a>
</main>

<style>
	.page { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; color: #193d26; }
	h1.bad { color: #8b2b2b; }
	h1.neutral { color: #34423a; }
	h2 { margin: 0; font-size: 1rem; }
	.meta, .hint, .source { margin: 0; font-size: 0.85rem; color: #5c6d61; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.fields { margin: 0; padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; }
	.fields dt { color: #5c6d61; font-size: 0.85rem; }
	.fields dd { margin: 0; font-size: 1.1rem; }
	.checks { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.35rem; font-size: 0.85rem; }
	.checks .ok::marker { content: '✓  '; color: #193d26; }
	.checks .fail, .error { color: #8b2b2b; }
	.checks .neutral, p.neutral { color: #34423a; }
	p.ok { color: #193d26; }
	.identity { border: 1px solid #c7d1c7; border-radius: 0.9rem; padding: 0.9rem; display: grid; gap: 0.4rem; }
	.identity p { margin: 0; font-size: 0.9rem; }
	.rpc { display: grid; gap: 0.35rem; margin-top: 0.5rem; font-size: 0.85rem; }
	.rpc label { font-weight: 700; }
	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.row input { flex: 1 1 14rem; min-width: 0; padding: 0.45rem 0.6rem; border: 1px solid #9fb5a5; border-radius: 0.5rem; font-family: ui-monospace, monospace; font-size: 0.8rem; }
	button { padding: 0.45rem 0.9rem; border-radius: 0.5rem; border: 1px solid #1d3b26; background: #1d3b26; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
	button:disabled { opacity: 0.6; cursor: default; }
	button.link { justify-self: start; background: none; border: 0; padding: 0; color: #1d5a32; text-decoration: underline; font-weight: 400; }
	.back { font-size: 0.85rem; }
</style>
