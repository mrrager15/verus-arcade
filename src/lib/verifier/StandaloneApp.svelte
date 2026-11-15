<script lang="ts">
	/**
	 * Fase 4: de losse verifier (één HTML-bestand, zonder Arcade-server). Zelfde
	 * componenten als in de app, met hash-routes:
	 *   #/round/<ronde-id>   #/profile/<i-adres>   #/attestation/<deellink>
	 * Praat alleen met een VRSCTEST-RPC (standaard de publieke node).
	 */
	import { onMount } from 'svelte';
	import AttestationCheck from './AttestationCheck.svelte';
	import ProfileCheck from './ProfileCheck.svelte';
	import RoundCheck from './RoundCheck.svelte';
	import { standaloneLinks } from './links';

	const commit: string = import.meta.env.VITE_VERIFIER_COMMIT ?? 'dev';
	const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
	const ROUND_ID = /^[a-z0-9][a-z0-9-]*:\d+\.\d+\.\d+:\d{4}-\d{2}-\d{2}(T\d{4})?$/;
	const LINK = /^[A-Za-z0-9_-]{20,3000}$/;

	let hash = $state(typeof location === 'undefined' ? '' : location.hash);
	let input = $state('');
	let inputError = $state('');

	type Route = { kind: 'home' } | { kind: 'round' | 'profile' | 'attestation'; value: string };
	const route = $derived(parse(hash));

	function parse(h: string): Route {
		const match = /^#\/(round|profile|attestation)\/(.+)$/.exec(h);
		if (!match) return { kind: 'home' };
		const kind = match[1] as 'round' | 'profile' | 'attestation';
		try {
			return { kind, value: kind === 'attestation' ? match[2] : decodeURIComponent(match[2]) };
		} catch {
			return { kind: 'home' };
		}
	}

	/** Ronde-ID, i-adres of deellink (ook een volledige URL met #) naar de juiste route. */
	function go(event: SubmitEvent) {
		event.preventDefault();
		inputError = '';
		const text = input.trim();
		const afterHash = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text;
		if (ROUND_ID.test(text)) location.hash = standaloneLinks.round(text);
		else if (I_ADDRESS.test(text)) location.hash = standaloneLinks.profile(text);
		else if (LINK.test(afterHash)) location.hash = `#/attestation/${afterHash}`;
		else inputError = 'Paste a round ID (word-grid:1.0.0:2026-11-13), a player i-address, or a share link.';
	}

	onMount(() => {
		const update = () => (hash = location.hash);
		addEventListener('hashchange', update);
		return () => removeEventListener('hashchange', update);
	});
</script>

<header class="bar">
	<a href="#/">Verus Arcade · standalone verifier</a>
	<span>no Arcade server · build {commit}</span>
</header>

{#if route.kind === 'home'}
	<main class="home">
		<p class="eyebrow">Check Verus Arcade without trusting Verus Arcade</p>
		<h1>Standalone verifier</h1>
		<p>
			This single file contains everything it needs. It never contacts the Arcade server: it reads the
			VRSCTEST chain through a Verus node (the public <code>api.verustest.net</code> by default, or your
			own) and checks every hash and signature in your browser. You can save this page and open it from disk.
		</p>
		<form onsubmit={go}>
			<label for="what">Round ID, player i-address, or share link</label>
			<div class="row">
				<input id="what" bind:value={input} spellcheck="false" autocomplete="off" placeholder="word-grid:1.0.0:2026-11-13" />
				<button type="submit">Check</button>
			</div>
			{#if inputError}<p class="error">{inputError}</p>{/if}
		</form>
		<ul class="what">
			<li><strong>A round</strong>: the puzzle was fixed on chain before the game, the results were published, and the reveal matches.</li>
			<li><strong>A player</strong>: every result in their own VerusID belongs to the official results and replays to its outcome. Moves they sealed on chain during a round open with the round key and were there before the reveal.</li>
			<li><strong>A share link</strong>: the shared fields belong to an attestation signed by Arcade@.</li>
		</ul>
	</main>
{:else}
	{#key hash}
		{#if route.kind === 'round'}
			<RoundCheck roundId={route.value} links={standaloneLinks} />
		{:else if route.kind === 'profile'}
			<ProfileCheck playerId={route.value} links={standaloneLinks} />
		{:else}
			<AttestationCheck link={route.value} links={standaloneLinks} />
		{/if}
	{/key}
{/if}

<style>
	.bar { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; padding: 0.6rem 1rem; background: #193d26; color: #dfeee3; font: 0.8rem system-ui, sans-serif; }
	.bar a { color: #fff; font-weight: 700; text-decoration: none; }
	.home { max-width: 44rem; margin: 2.5rem auto; padding: 0 1rem 3rem; font-family: system-ui, sans-serif; color: #18221b; display: grid; gap: 0.9rem; line-height: 1.5; }
	.eyebrow { margin: 0; color: #497755; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; }
	h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.2rem); }
	p { margin: 0; }
	form { display: grid; gap: 0.35rem; }
	label { font-weight: 700; font-size: 0.9rem; }
	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	input { flex: 1 1 16rem; min-width: 0; padding: 0.55rem 0.7rem; border: 1px solid #9fb5a5; border-radius: 0.5rem; font-family: ui-monospace, monospace; font-size: 0.9rem; }
	button { padding: 0.55rem 1rem; border-radius: 0.5rem; border: 1px solid #1d3b26; background: #1d3b26; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
	.error { color: #8d2019; font-size: 0.9rem; }
	.what { margin: 0; padding-left: 1.2rem; display: grid; gap: 0.3rem; color: #34423a; }
	code { font-size: 0.85em; }
</style>
