<script lang="ts">
	/**
	 * Fase 2: publiek profiel van een speler. Alles hier komt van de chain: de
	 * server leest de contentmultimap van de identiteit en houdt alleen geldige
	 * Arcade-records over (juiste namespace-key, juiste speler, kloppend bewijs).
	 * In fase 4 verhuist dit lezen naar de publieke RPC, zonder onze server.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	type Result = {
		round: string;
		game: string;
		gameVersion: string;
		status: 'solved' | 'unsolved' | 'abandoned';
		guesses: number;
		resultRoot: string;
		resultRootTxid: string | null;
		rootChecked?: boolean;
		contentKey: string;
		recordSha256: string;
		txid: string | null;
		height: number | null;
	};
	type Profile = {
		playerId: string;
		name: string | null;
		readAtHeight: number;
		namespace: { serviceId: string; serviceFqn: string };
		results: Result[];
		ignoredValues: number;
	};

	let profile = $state<Profile | null>(null);
	let error = $state('');

	onMount(async () => {
		try {
			const id = page.params.id;
			if (!id) {
				error = 'Identity is missing.';
				return;
			}
			const response = await fetch(`/api/v1/profile/${encodeURIComponent(id)}`);
			const body = await response.json();
			if (!response.ok) {
				error = body.error?.message ?? 'Profile is unavailable.';
				return;
			}
			profile = body;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Profile is unavailable.';
		}
	});
</script>

<svelte:head>
	<title>Verus Arcade · Profile</title>
</svelte:head>

<main class="profile">
	<p class="eyebrow">Player profile · read from VRSCTEST</p>
	{#if error}
		<p class="error">{error}</p>
	{:else if !profile}
		<p>Reading the identity from the chain…</p>
	{:else}
		<h1>{profile.name ?? profile.playerId}</h1>
		<p class="meta">
			<code>{profile.playerId}</code> · read at block {profile.readAtHeight} · records under the namespace of
			<strong>{profile.namespace.serviceFqn}</strong>
		</p>

		{#if profile.results.length === 0}
			<p class="empty">No Arcade results stored in this identity yet.</p>
		{:else}
			<ul class="results">
				{#each profile.results as result (result.contentKey + result.recordSha256)}
					<li>
						<div class="head">
							<span class="round">{result.round}</span>
							<span class="status" class:solved={result.status === 'solved'}>{result.status}</span>
						</div>
						<p>
							{result.game} {result.gameVersion} · {result.guesses} {result.guesses === 1 ? 'guess' : 'guesses'}
						</p>
						<dl>
							<dt>Result root</dt><dd><code>{result.resultRoot}</code>{#if result.rootChecked} ✓ matches the root Arcade@ published{/if}</dd>
							{#if result.resultRootTxid}<dt>Root published in</dt><dd><code>{result.resultRootTxid}</code></dd>{/if}
							<dt>Stored in identity</dt>
							<dd>{#if result.txid}<code>{result.txid}</code> (block {result.height}){:else}transaction not found in history{/if}</dd>
							<dt>Record sha256</dt><dd><code>{result.recordSha256}</code></dd>
						</dl>
						<a href={`/verify/${encodeURIComponent(result.round)}`}>Open round verifier →</a>
					</li>
				{/each}
			</ul>
		{/if}
		{#if profile.ignoredValues > 0}
			<p class="hint">{profile.ignoredValues} value(s) in this identity were ignored: not valid Arcade records for this player.</p>
		{/if}
	{/if}
</main>

<style>
	.profile { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; overflow-wrap: anywhere; }
	.meta { margin: 0; font-size: 0.8rem; color: #5c6d61; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.results { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.8rem; }
	.results li { padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; gap: 0.4rem; }
	.head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
	.round { font-weight: 700; }
	.status { padding: 0.2rem 0.55rem; border-radius: 999px; background: #e0e9df; color: #3f6549; font-size: 0.65rem; font-weight: 800; text-transform: uppercase; }
	.status.solved { background: #193d26; color: white; }
	.results p { margin: 0; font-size: 0.85rem; }
	dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 0.8rem; font-size: 0.75rem; }
	dt { color: #5c6d61; }
	dd { margin: 0; }
	.empty, .hint { margin: 0; font-size: 0.8rem; color: #5c6d61; }
	.error { color: #8b2b2b; }
</style>
