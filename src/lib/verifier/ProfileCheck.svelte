<script lang="ts">
	/**
	 * Fase 4: het Arcade-profiel van een speler nagaan met alleen de chain. Geen
	 * gegevens van de Arcade-server: de browser leest de spelers-ID en Arcade@ via
	 * een (publieke) VRSCTEST-RPC, ontsleutelt de records zelf (de publieke RPC
	 * kent geen decryptdata), vergelijkt de wortel met die van Arcade@ en speelt de
	 * zetten na (shared/independent-profile.mjs).
	 *
	 * Fase 5: ook de verzegelde actie-bundels van de speler, bij het resultaat van hun
	 * ronde of apart als er van die ronde geen resultaat in de ID staat.
	 */
	import { onMount } from 'svelte';
	import { createChainReader } from '../../../shared/chain-reader.mjs';
	import { verifyProfileIndependently } from '../../../shared/independent-profile.mjs';
	import { sha256Text } from '../proof-verifier';
	import { DEFAULT_RPC_URL, rememberedRpcUrl, rememberRpcUrl, rpcHost } from '../verifier-rpc';
	import BundleSummary from './BundleSummary.svelte';
	import type { VerifierLinks } from './links';

	let { playerId, links }: { playerId: string; links: VerifierLinks } = $props();

	type Check = Awaited<ReturnType<typeof verifyProfileIndependently>>;

	const VERDICTS: Record<string, { tone: string; title: string; text: string }> = {
		verified: { tone: 'ok', title: 'Everything checks out', text: 'Each result below is in the player’s own VerusID, belongs to the official result root that Arcade@ published, and replays to the same outcome with the game rules. Sealed moves, where present, open with the round key and carry Arcade@’s receipt.' },
		partial: { tone: 'wait', title: 'Checked as far as possible', text: 'Some items cannot be fully checked yet (for example: not revealed yet), or only test rounds were found. Nothing found is wrong.' },
		invalid: { tone: 'bad', title: 'Something does not match', text: 'At least one result or sealed bundle does not match what Arcade@ published, or does not replay to its outcome. Details below.' },
		empty: { tone: 'neutral', title: 'No Arcade results', text: 'This identity holds no Arcade result records and no sealed moves.' },
		unavailable: { tone: 'neutral', title: 'Could not read the chain', text: 'The RPC did not answer in time or within its limits. This is not evidence of anything: try again, or use another RPC.' },
		'wrong-chain': { tone: 'bad', title: 'Wrong chain', text: 'This RPC does not serve VRSCTEST. Use a VRSCTEST node.' }
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
			// Een profiel is veel controles samen: ruimer tijdsbudget dan voor één ronde.
			const reader = createChainReader({ url: rpcUrl.trim(), limits: { timeMs: 30_000 } });
			check = await verifyProfileIndependently({ playerId, reader, sha256Hex: sha256Text });
			rememberRpcUrl(rpcUrl.trim(), check.verdict);
		} catch (caught) {
			const code = (caught as { code?: string })?.code;
			error =
				code === 'INVALID_INPUT'
					? (caught as Error).message.startsWith('Player')
						? `“${playerId}” is not an i-address.`
						: 'That RPC address is not a valid http(s) URL.'
					: caught instanceof Error
						? caught.message
						: String(caught);
		} finally {
			running = false;
		}
	}

	onMount(() => {
		rpcUrl = rememberedRpcUrl();
		void run();
	});

	const rootText = (root: string, testRound: boolean) => {
		const operator = testRound ? 'the test operator' : 'Arcade@';
		return root === 'ok' ? `✓ matches the result root ${operator} published` : root === 'mismatch' ? `✗ does not match the root ${operator} published` : 'no official root found';
	};
	const replayText = (replay: string, reason: string | null) =>
		replay === 'ok' ? '✓ the moves give this result (game rules, revealed puzzle)' : replay === 'failed' ? `✗ the moves do not give this result${reason ? ` (${reason})` : ''}` : 'after the reveal';
</script>

<svelte:head><title>Profile on chain | Verus Arcade</title></svelte:head>

<main class="profile">
	<p class="eyebrow">Player profile · checked in this browser · chain only</p>
	<h1>{check?.name ?? playerId}</h1>
	<p class="meta"><code>{playerId}</code></p>

	{#if error}
		<p class="banner bad">{error}</p>
	{:else if running && !check}
		<p class="banner neutral">Reading the identity and Arcade@ from the chain, decrypting the records…</p>
	{:else if check && verdict}
		<section class="banner {verdict.tone}">
			<strong>{verdict.title}</strong>
			<span>{verdict.text}</span>
		</section>
		<p class="source">
			Read from <strong>{rpcHost(check.source.url)}</strong>
			{#if check.source.tip !== null}at height {check.source.tip.toLocaleString('en')}{/if}
			· {check.source.calls} {check.source.calls === 1 ? 'request' : 'requests'} · {(check.source.elapsedMs / 1000).toFixed(1)} s · no data from the Arcade server
		</p>

		{#if check.results.length > 0}
			<ul class="results">
				{#each check.results as result (result.keyId + result.round)}
					<li class:bad={result.root === 'mismatch' || result.replay === 'failed' || result.bundle?.verdict === 'invalid'}>
						<div class="head">
							<span class="round">{result.round}</span>
							<span class="status" class:solved={result.status === 'solved'}>{result.status}</span>
						</div>
						<p>
							{result.game} {result.gameVersion} · {result.actionsUsed} {result.actionsUsed === 1 ? 'move' : 'moves'} · record v{result.recordVersion}
							{#if result.testRound}· <em>test round (checked against the separate test operator, does not count for the verdict)</em>{/if}
						</p>
						<dl>
							<dt>Result root</dt><dd>{rootText(result.root, result.testRound)}<br /><code>{result.resultRoot}</code></dd>
							<dt>Replay</dt><dd>{replayText(result.replay, result.replayReason)}</dd>
							<dt>Stored in identity</dt>
							<dd>{#if result.txid}<code>{result.txid}</code> (block {result.height?.toLocaleString('en')}){:else}transaction not found in history{/if}</dd>
							{#if result.bundle}<BundleSummary check={result.bundle} />{/if}
						</dl>
						<a href={links.round(result.round)}>Check this round on chain →</a>
					</li>
				{/each}
			</ul>
		{/if}
		{#if check.sealedOnly.length > 0}
			<h2>Sealed moves</h2>
			<p class="hint">
				Rounds where this player put their encrypted moves on chain during the round, without a result record in this
				identity. The round follows from the key the moves are stored under.
			</p>
			<ul class="results">
				{#each check.sealedOnly as sealed (sealed.keyId)}
					<li class:bad={sealed.check.verdict === 'invalid'}>
						<div class="head">
							<span class="round">{sealed.round}</span>
							{#if sealed.check.replay}<span class="status" class:solved={sealed.check.replay.status === 'solved'}>{sealed.check.replay.status}</span>{/if}
						</div>
						{#if sealed.testRound}<p><em>test round (checked against the separate test operator, does not count for the verdict)</em></p>{/if}
						<dl>
							<BundleSummary check={sealed.check} />
						</dl>
						<a href={links.round(sealed.round)}>Check this round on chain →</a>
					</li>
				{/each}
			</ul>
		{/if}
		{#if check.ignored > 0}
			<p class="hint">{check.ignored} value(s) in this identity were ignored: not Arcade results or sealed moves of this player (for example attestations).</p>
		{/if}
		{#if check.problems.length > 0}
			<p class="hint">Could not read: {check.problems.join('; ')}</p>
		{/if}
	{/if}

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
	{#if links.arcadeProfile}
		<a class="more" href={links.arcadeProfile(playerId)}>Arcade’s own profile page</a>
	{/if}
</main>

<style>
	.profile { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; overflow-wrap: anywhere; }
	h2 { margin: 0.6rem 0 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.3rem; }
	.meta, .source, .hint { margin: 0; font-size: 0.8rem; color: #5c6d61; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.banner { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.9rem 1rem; border-radius: 0.7rem; margin: 0; }
	.ok { background: #dff4e3; color: #155c2b; }
	.wait { background: #fff4d6; color: #6b4a00; }
	.neutral { background: #eef1ef; color: #34423a; }
	.bad { background: #ffe1df; color: #8d2019; }
	.results { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.8rem; }
	.results li { padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; gap: 0.4rem; }
	.results li.bad { border-color: #d9a3a0; background: #fff4f3; color: inherit; }
	.head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
	.round { font-weight: 700; overflow-wrap: anywhere; }
	.status { padding: 0.2rem 0.55rem; border-radius: 999px; background: #e0e9df; color: #3f6549; font-size: 0.65rem; font-weight: 800; text-transform: uppercase; }
	.status.solved { background: #193d26; color: white; }
	.results p { margin: 0; font-size: 0.85rem; }
	dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 0.8rem; font-size: 0.75rem; }
	dt { color: #5c6d61; }
	dd { margin: 0; }
	.rpc { display: grid; gap: 0.35rem; margin-top: 0.5rem; font-size: 0.85rem; }
	.rpc label { font-weight: 700; }
	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.row input { flex: 1 1 14rem; min-width: 0; padding: 0.45rem 0.6rem; border: 1px solid #9fb5a5; border-radius: 0.5rem; font-family: ui-monospace, monospace; font-size: 0.8rem; }
	button { padding: 0.45rem 0.9rem; border-radius: 0.5rem; border: 1px solid #1d3b26; background: #1d3b26; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
	button:disabled { opacity: 0.6; cursor: default; }
	button.link { justify-self: start; background: none; border: 0; padding: 0; color: #1d5a32; text-decoration: underline; font-weight: 400; }
	.more { font-size: 0.85rem; }
	@media (max-width: 600px) { dl { grid-template-columns: 1fr; } }
</style>
