<script lang="ts">
	/**
	 * Fase 4: een ronde nagaan met alleen de chain. Deze pagina gebruikt geen
	 * gegevens van de Arcade-server: de browser leest Arcade@ rechtstreeks via een
	 * (publieke) Verus-RPC en rekent alles zelf na (shared/independent-round.mjs).
	 * De RPC-URL is instelbaar (eigen daemon) en wordt per browser onthouden.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { createChainReader, DEFAULT_RPC_URL } from '../../../../../shared/chain-reader.mjs';
	import { verifyRoundIndependently } from '../../../../../shared/independent-round.mjs';
	import { sha256Text } from '$lib/proof-verifier';

	type Check = Awaited<ReturnType<typeof verifyRoundIndependently>>;
	type Part = Check['parts']['commitment'];

	const STORAGE_KEY = 'arcade.verifier.rpcUrl';
	const VERDICTS: Record<string, { tone: string; title: string; text: string }> = {
		verified: {
			tone: 'ok',
			title: 'Verified on chain',
			text: 'The puzzle was fixed on chain before the results, the results are published, and the reveal matches the commitment exactly.'
		},
		incomplete: {
			tone: 'wait',
			title: 'Not finished yet',
			text: 'The commitment is on chain, but the results or the reveal are not published yet. That is normal while a round runs and during the night after it closes.'
		},
		'not-found': {
			tone: 'wait',
			title: 'Round not found',
			text: 'No commitment for this round was found on chain around its date. Check the round ID.'
		},
		unavailable: {
			tone: 'neutral',
			title: 'Could not read the chain',
			text: 'The RPC did not answer in time or within its limits. This is not evidence of anything: try again, or use another RPC.'
		},
		invalid: {
			tone: 'bad',
			title: 'Something does not match',
			text: 'A published record is malformed or contradicts another one. Details below.'
		},
		'wrong-chain': {
			tone: 'bad',
			title: 'Wrong chain',
			text: 'This RPC does not serve VRSCTEST. Use a VRSCTEST node.'
		}
	};
	const STATUS_LABELS: Record<string, string> = {
		confirmed: 'confirmed',
		pending: 'waiting for a block',
		missing: 'not published yet',
		unavailable: 'could not read',
		invalid: 'does not match'
	};

	let rpcUrl = $state(DEFAULT_RPC_URL);
	let check = $state<Check | null>(null);
	let running = $state(false);
	let error = $state('');

	const roundId = $derived(page.params.round ?? '');
	const verdict = $derived(check ? VERDICTS[check.verdict] : null);
	const host = $derived.by(() => {
		try {
			return new URL(check?.source.url ?? rpcUrl).host;
		} catch {
			return rpcUrl;
		}
	});

	function remembered(): string | null {
		try {
			return localStorage.getItem(STORAGE_KEY);
		} catch {
			return null;
		}
	}

	function remember(url: string) {
		try {
			if (url === DEFAULT_RPC_URL) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, url);
		} catch {
			/* geen opslag: dan niet onthouden */
		}
	}

	async function run() {
		running = true;
		error = '';
		check = null;
		try {
			const reader = createChainReader({ url: rpcUrl.trim() });
			check = await verifyRoundIndependently({ roundId, reader, sha256Hex: sha256Text });
			// Alleen een RPC die echt VRSCTEST antwoordde onthouden, geen tikfout of dode node.
			if (check.verdict !== 'unavailable' && check.verdict !== 'wrong-chain') remember(rpcUrl.trim());
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

	function reset() {
		rpcUrl = DEFAULT_RPC_URL;
		void run();
	}

	onMount(() => {
		rpcUrl = remembered() ?? DEFAULT_RPC_URL;
		void run();
	});

	const short = (value: string | null) => (value ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—');
	const puzzleText = (definition: { schemaVersion: number; answer?: string; puzzle?: unknown }) =>
		definition.schemaVersion === 1 ? String(definition.answer) : JSON.stringify(definition.puzzle);
	const yesNo = (value: boolean | null | undefined, yes: string, no: string) =>
		value === null || value === undefined ? 'unknown' : value ? yes : no;
</script>

<svelte:head><title>Verify on chain | Verus Arcade</title></svelte:head>

<main>
	<p class="eyebrow">Independent verification · chain only</p>
	<h1>Round proof</h1>
	<p class="lead">
		This page does not use any data from the Arcade server. Your browser reads <code>Arcade@</code>
		directly from a Verus node and checks every step itself. Round <code>{roundId}</code>.
	</p>

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
		<p class="hint">
			Don’t want to trust this node? Point this at your own VRSCTEST daemon (it needs to allow
			browser requests).
			{#if rpcUrl !== DEFAULT_RPC_URL}
				<button type="button" class="link" onclick={reset}>Use the public node again</button>
			{/if}
		</p>
	</form>

	{#if error}
		<p class="banner bad">{error}</p>
	{:else if running && !check}
		<p class="banner neutral">Reading the chain…</p>
	{:else if check && verdict}
		<section class="banner {verdict.tone}">
			<strong>{verdict.title}</strong>
			<span>{verdict.text}</span>
		</section>
		<p class="source">
			Read from <strong>{host}</strong>
			{#if check.source.tip !== null}at height {check.source.tip.toLocaleString('en')}{/if}
			{#if check.source.version}(daemon {check.source.version}){/if}
			· {check.source.calls} {check.source.calls === 1 ? 'request' : 'requests'} · {(check.source.elapsedMs / 1000).toFixed(1)} s
			{#if check.window}· searched blocks {check.window.fromHeight.toLocaleString('en')}–{check.window.toHeight.toLocaleString('en')}{/if}
		</p>

		{#snippet partStatus(part: Part)}
			<span class="status {part.status}">{STATUS_LABELS[part.status] ?? part.status}</span>
		{/snippet}

		{#snippet txRows(part: Part)}
			{#if part.txid}
				<dt>Transaction</dt>
				<dd>{part.txid}</dd>
				<dt>Block</dt>
				<dd>
					{part.height?.toLocaleString('en') ?? '—'}
					{#if part.confirmations}({part.confirmations.toLocaleString('en')} confirmations){/if}
				</dd>
			{/if}
			{#if part.problem}
				<dt>Problem</dt>
				<dd class="problem">{part.problem}</dd>
			{/if}
		{/snippet}

		<section>
			<h2>1. Commitment {@render partStatus(check.parts.commitment)}</h2>
			<p>Before the game: a hash of the secret puzzle, so it cannot change afterwards.</p>
			<dl>
				{#if check.parts.commitment.value}
					<dt>Puzzle hash (SHA-256)</dt>
					<dd>{check.parts.commitment.value.hiddenDefinitionSha256}</dd>
					<dt>Opens – closes</dt>
					<dd>{check.parts.commitment.value.opensAt} – {check.parts.commitment.value.closesAt}</dd>
				{/if}
				{@render txRows(check.parts.commitment)}
			</dl>
		</section>

		<section>
			<h2>2. Results {@render partStatus(check.parts.results)}</h2>
			<p>After the game: one Merkle root over every player’s result.</p>
			<dl>
				{#if check.parts.results.value}
					<dt>Players</dt>
					<dd>{check.parts.results.value.leafCount}</dd>
					<dt>Merkle root</dt>
					<dd>{check.parts.results.value.rootSha256}</dd>
				{/if}
				{@render txRows(check.parts.results)}
			</dl>
		</section>

		<section>
			<h2>3. Reveal {@render partStatus(check.parts.reveal)}</h2>
			<p>Then: the secret puzzle itself. This browser hashed it and compared it with the commitment.</p>
			<dl>
				{#if check.parts.reveal.value?.hiddenDefinition}
					<dt>{check.parts.reveal.value.hiddenDefinition.schemaVersion === 1 ? 'Answer' : 'Puzzle'}</dt>
					<dd>{puzzleText(check.parts.reveal.value.hiddenDefinition)}</dd>
					<dt>Recomputed hash</dt>
					<dd>{check.parts.reveal.recomputedSha256 ?? '—'}</dd>
					<dt>Points to commitment</dt>
					<dd>{short(check.parts.reveal.value.commitmentTxid)}</dd>
				{/if}
				{@render txRows(check.parts.reveal)}
			</dl>
		</section>

		{#if check.timing}
			<section class="timing">
				<h2>Timing <span class="status info">for information</span></h2>
				<ul>
					{#if check.timing.commitmentBeforeOpen !== null}
						<li>
							Commitment {yesNo(check.timing.commitmentBeforeOpen, 'before', 'after')} the nominal opening time
							{#if check.timing.commitmentBeforeOpen === false}
								— a round only opens for play once its commitment is confirmed, so this is not a problem by itself.
							{/if}
						</li>
					{/if}
					{#if check.timing.resultsAfterClose !== null}
						<li>Results {yesNo(check.timing.resultsAfterClose, 'after', 'before')} the closing time</li>
					{/if}
					{#if check.timing.revealAfterResults !== null}
						<li>Reveal {yesNo(check.timing.revealAfterResults, 'after', 'before')} the results</li>
					{/if}
				</ul>
				<p class="hint">Block times can differ a few minutes from real time, so timing is shown, not judged.</p>
			</section>
		{/if}
	{/if}

	<p class="more">
		<a href={`/verify/${encodeURIComponent(roundId)}`}>Arcade’s own proof page for this round</a>
	</p>
</main>

<style>
	main { max-width: 52rem; margin: 4rem auto; padding: 0 1.25rem 4rem; font-family: system-ui, sans-serif; color: #18221b; }
	.eyebrow { color: #497755; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
	h1 { font-size: clamp(2.2rem, 7vw, 4.5rem); margin: .2rem 0 1rem; }
	h2 { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; font-size: 1.25rem; margin: 0 0 .4rem; }
	.lead { font-size: 1.05rem; line-height: 1.5; }
	section { border: 1px solid #cad8cd; border-radius: 1rem; padding: 1.25rem; margin: 1rem 0; background: #fbfdfb; }
	dl { display: grid; grid-template-columns: minmax(9rem, .45fr) 1fr; gap: .6rem 1rem; margin: .8rem 0 0; }
	dt { font-weight: 700; }
	dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: .86rem; }
	code { overflow-wrap: anywhere; }
	.rpc { margin: 1.5rem 0; }
	.rpc label { font-weight: 700; display: block; margin-bottom: .35rem; }
	.row { display: flex; gap: .5rem; flex-wrap: wrap; }
	.row input { flex: 1 1 16rem; min-width: 0; padding: .55rem .7rem; border: 1px solid #9fb5a5; border-radius: .5rem; font: inherit; font-family: ui-monospace, monospace; font-size: .9rem; }
	button { padding: .55rem 1rem; border-radius: .5rem; border: 1px solid #1d3b26; background: #1d3b26; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
	button:disabled { opacity: .6; cursor: default; }
	button.link { background: none; border: 0; padding: 0; color: #1d5a32; text-decoration: underline; font-weight: 400; }
	.hint { color: #4d5f52; font-size: .9rem; }
	.banner { display: flex; flex-direction: column; gap: .3rem; padding: .9rem 1rem; border-radius: .7rem; border: 0; }
	.ok { background: #dff4e3; color: #155c2b; }
	.wait { background: #fff4d6; color: #6b4a00; }
	.neutral { background: #eef1ef; color: #34423a; }
	.bad { background: #ffe1df; color: #8d2019; }
	.source { color: #4d5f52; font-size: .9rem; margin: .5rem 0 1rem; }
	.status { font-size: .75rem; font-weight: 700; padding: .15rem .55rem; border-radius: 999px; background: #eef1ef; color: #34423a; text-transform: uppercase; letter-spacing: .04em; }
	.status.confirmed { background: #dff4e3; color: #155c2b; }
	.status.pending, .status.missing { background: #fff4d6; color: #6b4a00; }
	.status.invalid { background: #ffe1df; color: #8d2019; }
	.problem { color: #8d2019; font-family: system-ui, sans-serif; }
	.timing ul { margin: .4rem 0; padding-left: 1.2rem; line-height: 1.6; }
	.more { margin-top: 2rem; }
	@media (max-width: 600px) { dl { grid-template-columns: 1fr; } main { margin-top: 2rem; } }
</style>
