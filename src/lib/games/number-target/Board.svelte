<script lang="ts">
	import type { BoardProps } from '../types';

	let { puzzle, actions, terminal, solved, reveal, maxActions, busy, onsubmit }: BoardProps = $props();

	let expression = $state('');

	// Welke getallen staan al in de berekening? (zelfde regel als de server: elk getal zo vaak als het voorkomt)
	const usedCounts = $derived.by(() => {
		const counts: Record<number, number> = {};
		for (const match of expression.match(/\d+/g) ?? []) counts[Number(match)] = (counts[Number(match)] ?? 0) + 1;
		return counts;
	});
	const chips = $derived.by(() => {
		const seen: Record<number, number> = {};
		return (puzzle?.numbers ?? []).map((n: number) => {
			seen[n] = (seen[n] ?? 0) + 1;
			return { n, used: (usedCounts[n] ?? 0) >= seen[n] };
		});
	});
	const best = $derived(actions.length ? Math.min(...actions.map((a) => a.feedback?.distance ?? Infinity)) : null);

	function add(token: string) {
		if (busy || terminal) return;
		expression += token;
	}
	function backspace() {
		expression = expression.replace(/(\d+|.)$/, '');
	}
	function send() {
		if (busy || terminal || !expression.trim()) return;
		onsubmit(expression);
	}
	// Na een geaccepteerde zet de invoer leegmaken.
	let lastCount = 0;
	$effect(() => {
		if (actions.length !== lastCount) {
			lastCount = actions.length;
			expression = '';
		}
	});
</script>

<div class="nt">
	<div class="target" aria-label="Target">
		<span>Target</span>
		<strong>{puzzle?.target ?? '—'}</strong>
	</div>

	<div class="numbers" aria-label="Numbers">
		{#each chips as chip}
			<button class="chip" class:used={chip.used} disabled={busy || terminal} onclick={() => add(String(chip.n))}>{chip.n}</button>
		{/each}
	</div>

	{#if actions.length}
		<ol class="history">
			{#each actions as action}
				<li class:hit={action.feedback?.solved}>
					<code>{action.value}</code>
					<span>= {action.feedback?.value}</span>
					<em>{action.feedback?.solved ? 'target!' : `${action.feedback?.distance} off`}</em>
				</li>
			{/each}
		</ol>
	{/if}

	{#if !terminal}
		<label class="input">
			<span class="sr">Calculation</span>
			<input
				bind:value={expression}
				placeholder="e.g. (25+3)*4"
				inputmode="text"
				autocomplete="off"
				spellcheck="false"
				disabled={busy}
				onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); send(); } }}
			/>
		</label>
		<div class="ops">
			{#each ['+', '-', '×', '÷', '(', ')'] as op}
				<button class="op" disabled={busy} onclick={() => add(op)}>{op}</button>
			{/each}
			<button class="op" disabled={busy} onclick={backspace} aria-label="Delete">⌫</button>
		</div>
		<button class="submit" disabled={busy || !expression.trim()} onclick={send}>
			{busy ? 'Checking…' : `Try (${actions.length + 1}/${maxActions})`}
		</button>
		<p class="rules">Use each number at most once. Every step must give a positive whole number.</p>
	{:else}
		<div class="end">
			<h3>{solved ? `Target reached in ${actions.length}` : `Closest: ${best} off`}</h3>
			{#if reveal?.solution}<p>One way to reach {puzzle?.target}: <code>{reveal.solution}</code></p>{/if}
		</div>
	{/if}
</div>

<style>
	.nt { display:grid; gap:.9rem; margin-top:1rem; }
	.target { display:flex; justify-content:space-between; align-items:baseline; padding:.8rem 1rem; border-radius:.8rem; background:#173e25; color:white; }
	.target span { font-size:.75rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; opacity:.8; }
	.target strong { font-family:Georgia,serif; font-size:2.4rem; }
	.numbers { display:grid; grid-template-columns:repeat(6,1fr); gap:.4rem; }
	.chip { padding:.75rem 0; border:2px solid #839489; border-radius:.5rem; background:#fbfdf9; font-size:1.1rem; font-weight:850; cursor:pointer; }
	.chip.used { opacity:.35; }
	.history { list-style:none; margin:0; padding:0; display:grid; gap:.3rem; }
	.history li { display:grid; grid-template-columns:1fr auto auto; gap:.6rem; align-items:center; padding:.5rem .7rem; border-radius:.5rem; background:#eef3ec; font-size:.85rem; }
	.history li.hit { background:#33794a; color:white; }
	.history code { overflow-wrap:anywhere; }
	.history em { font-style:normal; font-weight:800; font-size:.75rem; }
	.input input { width:100%; box-sizing:border-box; padding:.75rem; border:2px solid #cbd8ce; border-radius:.5rem; font-size:1.15rem; font-family:ui-monospace,monospace; }
	.ops { display:grid; grid-template-columns:repeat(7,1fr); gap:.3rem; }
	.op { padding:.65rem 0; border:0; border-radius:.4rem; background:#dbe2dc; font-size:1rem; font-weight:800; cursor:pointer; }
	.submit { width:100%; border:0; border-radius:.6rem; padding:.8rem; background:#173e25; color:white; font-weight:800; cursor:pointer; }
	button:disabled { opacity:.45; cursor:not-allowed; }
	.rules { margin:0; color:#647268; font-size:.75rem; text-align:center; }
	.end { padding:1rem; border:1px solid #cbd8ce; border-radius:.8rem; background:#fbfdf9; }
	.end h3 { margin:0 0 .4rem; }
	.end code { font-weight:800; }
	.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
</style>
