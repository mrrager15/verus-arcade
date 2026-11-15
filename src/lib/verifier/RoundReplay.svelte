<script lang="ts">
	/**
	 * Fase 5: een hele ronde naspelen. De lijst van resultaten staat niet op de chain
	 * (alleen haar Merkle-wortel) en komt van de Arcade-server; de browser rekent de
	 * wortel na en vergelijkt hem met die op de chain. Al het andere leest hij zelf van
	 * de chain: de onthulde puzzel, en per speler de verzegelde zetten in zijn eigen
	 * VerusID (shared/independent-replay.mjs). Alleen in de app, niet in de losse verifier.
	 */
	import { onMount } from 'svelte';
	import { createChainReader } from '../../../shared/chain-reader.mjs';
	import { verifyRoundReplayIndependently } from '../../../shared/independent-replay.mjs';
	import { isTestRound } from '../../../shared/independent-round.mjs';
	import { sha256Text } from '../proof-verifier';
	import { DEFAULT_RPC_URL, rememberedRpcUrl, rememberRpcUrl, rpcHost } from '../verifier-rpc';
	import BundleSummary from './BundleSummary.svelte';
	import type { VerifierLinks } from './links';

	let { roundId, links }: { roundId: string; links: VerifierLinks } = $props();

	type Check = Awaited<ReturnType<typeof verifyRoundReplayIndependently>>;

	const VERDICTS: Record<string, { tone: string; title: string; text: string }> = {
		verified: { tone: 'ok', title: 'Every result replays', text: 'The list below is exactly the list whose root is on chain, and every player’s moves give their published result with the game rules and the revealed puzzle.' },
		partial: { tone: 'wait', title: 'Checked as far as possible', text: 'The results replay, but not every player’s sealed moves could be read from the chain. Nothing found is wrong.' },
		invalid: { tone: 'bad', title: 'Something does not match', text: 'The result list is not the one committed on chain, or a result or sealed bundle does not check out. Details below.' },
		incomplete: { tone: 'wait', title: 'Not revealed yet', text: 'The puzzle and the results of this round are not all on chain yet, so there is nothing to replay. That is normal while a round runs and during the night after it closes.' },
		'not-found': { tone: 'wait', title: 'Round not found', text: 'No commitment for this round was found on chain around its date. Check the round ID.' },
		unavailable: { tone: 'neutral', title: 'Could not finish the check', text: 'The chain or the result list could not be read. This is not evidence of anything: try again.' },
		'wrong-chain': { tone: 'bad', title: 'Wrong chain', text: 'This RPC does not serve VRSCTEST. Use a VRSCTEST node.' }
	};

	let rpcUrl = $state(DEFAULT_RPC_URL);
	let check = $state<Check | null>(null);
	let running = $state(false);
	let error = $state('');
	let listNote = $state('');

	const verdict = $derived(check ? VERDICTS[check.verdict] : null);
	const sealedCount = $derived(check ? check.players.filter((p) => p.bundle && p.bundle.verdict !== 'not-found').length : 0);

	/** De resultatenlijst van de Arcade-server, of null (nog niet onthuld, of niet bereikbaar). */
	async function loadRecords(): Promise<unknown[] | null> {
		listNote = '';
		try {
			const response = await fetch(`/api/v1/rounds/${encodeURIComponent(roundId)}/results`);
			const body = await response.json();
			if (response.ok && Array.isArray(body.records)) return body.records;
			listNote = body.error?.code === 'ROUND_NOT_REVEALED' ? 'The server only gives the result list after the reveal is confirmed.' : (body.error?.message ?? `The server answered ${response.status}.`);
		} catch {
			listNote = 'The Arcade server could not be reached for the result list.';
		}
		return null;
	}

	async function run() {
		running = true;
		error = '';
		check = null;
		try {
			const records = await loadRecords();
			const reader = createChainReader({ url: rpcUrl.trim(), limits: { timeMs: 45_000 } });
			check = await verifyRoundReplayIndependently({ roundId, records, reader, sha256Hex: sha256Text });
			rememberRpcUrl(rpcUrl.trim(), check.verdict);
		} catch (caught) {
			const code = (caught as { code?: string })?.code;
			error =
				code === 'INVALID_INPUT'
					? (caught as Error).message === 'Invalid round ID'
						? `“${roundId}” is not a valid round ID.`
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

	const puzzleText = (puzzle: unknown) => (puzzle && typeof puzzle === 'object' && 'answer' in puzzle && Object.keys(puzzle).length === 1 ? String((puzzle as { answer: unknown }).answer) : JSON.stringify(puzzle));
</script>

<svelte:head><title>Replay round | Verus Arcade</title></svelte:head>

<main class="replay">
	<p class="eyebrow">Round replay · checked in this browser</p>
	<h1>{roundId}</h1>
	<p class="lead">
		Every player’s moves, replayed with the game rules against the puzzle that was revealed on chain.
		{#if isTestRound(roundId)}This is a <strong>test round</strong>: its proof is on the separate test operator identity, not on Arcade@.{/if}
	</p>

	{#if error}
		<p class="banner bad">{error}</p>
	{:else if running && !check}
		<p class="banner neutral">Loading the result list and reading the chain…</p>
	{:else if check && verdict}
		<section class="banner {verdict.tone}">
			<strong>{verdict.title}</strong>
			<span>{verdict.text}</span>
			{#if check.problems.length > 0}<span class="problems">{check.problems.join('; ')}</span>{/if}
		</section>
		<p class="source">
			Chain read from <strong>{rpcHost(check.source.url)}</strong>
			{#if check.source.tip !== null}at height {check.source.tip.toLocaleString('en')}{/if}
			· {check.source.calls} {check.source.calls === 1 ? 'request' : 'requests'} · {(check.source.elapsedMs / 1000).toFixed(1)} s.
			The result list is the only thing that comes from the Arcade server.
			{#if listNote}{listNote}{/if}
		</p>

		{#if check.set.officialRoot}
			<section class="card">
				<h2>Result list</h2>
				<dl>
					<dt>Root on chain</dt>
					<dd><code>{check.set.officialRoot}</code> ({check.set.officialCount} {check.set.officialCount === 1 ? 'player' : 'players'})</dd>
					{#if check.set.computedRoot}
						<dt>Root of this list</dt>
						<dd>
							<code>{check.set.computedRoot}</code> ({check.set.count} {check.set.count === 1 ? 'player' : 'players'})
							<br />{check.set.status === 'ok' ? '✓ identical: this is the list Arcade@ committed to' : '✗ different: this is not the list Arcade@ committed to'}
						</dd>
					{:else if check.set.status === 'mismatch'}
						<dt>This list</dt><dd>✗ not a valid result list</dd>
					{/if}
					{#if check.puzzle}
						<dt>Revealed puzzle</dt><dd><code>{puzzleText(check.puzzle)}</code></dd>
					{/if}
					{#if check.sealing && check.set.status === 'ok'}
						<dt>Sealed moves</dt>
						<dd>
							{sealedCount} of {check.players.length} {check.players.length === 1 ? 'player' : 'players'} put their encrypted moves on chain themselves.
							A player who is missing from this list does not show up here: check their own profile.
						</dd>
					{/if}
				</dl>
			</section>
		{/if}

		{#if check.players.length > 0}
			<ul class="players">
				{#each check.players as player (player.playerId)}
					<li class:bad={player.replay === 'failed' || player.bundle?.verdict === 'invalid'}>
						<div class="head">
							<a class="who" href={links.profile(player.playerId)}>{player.playerId}</a>
							<span class="status" class:solved={player.status === 'solved'}>{player.status}</span>
						</div>
						<dl>
							<dt>Moves</dt>
							<dd>
								{#each player.actions as action, i}<code>{action}</code>{i < player.actions.length - 1 ? ' → ' : ''}{/each}
								{#if player.actions.length === 0}none{/if}
							</dd>
							<dt>Replay</dt>
							<dd>{player.replay === 'ok' ? '✓ these moves give this result' : `✗ these moves do not give this result${player.replayReason ? ` (${player.replayReason})` : ''}`}</dd>
							<dt>Signed by player</dt>
							<dd>{player.signed ? 'yes: the record carries the player’s VerusID signature' : 'no'}</dd>
							{#if player.bundle}
								<BundleSummary check={player.bundle} />
							{:else if player.bundleSkipped}
								<dt>Sealed moves</dt><dd>not checked here (large round): open this player’s profile</dd>
							{/if}
						</dl>
					</li>
				{/each}
			</ul>
		{:else if check.set.status === 'ok'}
			<p class="hint">Nobody played this round.</p>
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
	<a class="more" href={links.round(roundId)}>The round’s own proof on chain (commitment, results, reveal) →</a>
</main>

<style>
	.replay { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; font-family: system-ui, sans-serif; color: #18221b; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; overflow-wrap: anywhere; }
	h2 { margin: 0 0 0.4rem; font-family: Georgia, serif; font-weight: 500; font-size: 1.2rem; }
	.lead { margin: 0; line-height: 1.5; }
	.source, .hint { margin: 0; font-size: 0.8rem; color: #5c6d61; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.banner { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.9rem 1rem; border-radius: 0.7rem; margin: 0; }
	.problems { font-size: 0.8rem; }
	.ok { background: #dff4e3; color: #155c2b; }
	.wait { background: #fff4d6; color: #6b4a00; }
	.neutral { background: #eef1ef; color: #34423a; }
	.bad { background: #ffe1df; color: #8d2019; }
	.card { padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #fbfdfb; }
	.players { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.8rem; }
	.players li { padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; gap: 0.5rem; }
	.players li.bad { border-color: #d9a3a0; background: #fff4f3; color: inherit; }
	.head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
	.who { font-weight: 700; overflow-wrap: anywhere; color: #1d5a32; font-family: ui-monospace, monospace; font-size: 0.85rem; }
	.status { padding: 0.2rem 0.55rem; border-radius: 999px; background: #e0e9df; color: #3f6549; font-size: 0.65rem; font-weight: 800; text-transform: uppercase; }
	.status.solved { background: #193d26; color: white; }
	dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.8rem; font-size: 0.78rem; }
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
