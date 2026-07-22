<script lang="ts">
	import { onMount } from 'svelte';

	let { token, friendlyName }: { token: string; friendlyName: string } = $props();

	type Pattern = ('g' | 'y' | 'x')[];
	type GuessRow = { guess: string; pattern: Pattern };

	let round = $state<number | null>(null);
	let date = $state('');
	let commitSha256 = $state('');
	let commitTxid = $state<string | null>(null);
	let maxGuesses = $state(6);
	let guesses = $state<GuessRow[]>([]);
	let current = $state('');
	let solved = $state(false);
	let done = $state(false);
	let answer = $state('');
	let message = $state('');
	let leaderboard = $state<{ rank: number; name: string; guesses: number }[]>([]);
	let submitting = $state(false);

	const headers = () => ({ Authorization: `Bearer ${token}` });

	async function load() {
		const r = await fetch('/api/state', { headers: headers() });
		if (!r.ok) return;
		const s = await r.json();
		round = s.round;
		date = s.date;
		commitSha256 = s.commitSha256;
		commitTxid = s.commitTxid;
		maxGuesses = s.maxGuesses;
		if (s.you) {
			guesses = s.you.guesses.map((g: { guess: string; pattern: Pattern }) => ({
				guess: g.guess,
				pattern: g.pattern
			}));
			solved = s.you.solved;
			done = solved || guesses.length >= maxGuesses;
		}
	}

	async function loadLeaderboard() {
		const r = await fetch('/api/leaderboard');
		if (r.ok) leaderboard = (await r.json()).entries;
	}

	onMount(() => {
		load();
		loadLeaderboard();
	});

	async function submit() {
		if (submitting || done || current.length !== 5) return;
		submitting = true;
		message = '';
		try {
			const r = await fetch('/api/guess', {
				method: 'POST',
				headers: { ...headers(), 'Content-Type': 'application/json' },
				body: JSON.stringify({ guess: current })
			});
			const body = await r.json().catch(() => ({ error: `Server error (HTTP ${r.status})` }));
			if (!r.ok) {
				message = body.error ?? 'Something went wrong';
				return;
			}
			guesses = [...guesses, { guess: current, pattern: body.pattern }];
			current = '';
			solved = body.solved;
			done = body.solved || body.guessesLeft === 0;
			if (body.answer) answer = body.answer;
			if (done) loadLeaderboard();
		} finally {
			submitting = false;
		}
	}

	function handleKey(key: string) {
		if (done) return;
		message = '';
		if (key === 'enter') {
			if (current.length === 5) submit();
			else message = 'Not enough letters';
		} else if (key === 'back') {
			current = current.slice(0, -1);
		} else if (/^[a-z]$/.test(key) && current.length < 5) {
			current += key;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 'enter') handleKey('enter');
		else if (k === 'backspace') handleKey('back');
		else if (/^[a-z]$/.test(k)) handleKey(k);
	}

	// Best-known status per letter for the on-screen keyboard (g beats y beats x)
	const keyStatus = $derived.by(() => {
		const map: Record<string, 'g' | 'y' | 'x'> = {};
		const rankOf = { g: 3, y: 2, x: 1 } as const;
		for (const row of guesses) {
			for (let i = 0; i < row.guess.length; i++) {
				const c = row.guess[i];
				const p = row.pattern[i];
				if (!map[c] || rankOf[p] > rankOf[map[c]]) map[c] = p;
			}
		}
		return map;
	});

	const kbRows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
</script>

<svelte:window onkeydown={onKeydown} />

<section class="game">
	<p class="round-info">
		Round #{round} — {date} · playing as <strong>{friendlyName}</strong>
	</p>

	<div class="board">
		{#each Array(maxGuesses) as _, r}
			<div class="row">
				{#each Array(5) as _, c}
					{@const g = guesses[r]}
					{@const isCurrent = r === guesses.length}
					{@const letter = g ? g.guess[c] : isCurrent ? (current[c] ?? '') : ''}
					<div
						class="cell {g ? g.pattern[c] : ''}"
						class:filled={letter !== ''}
					>
						{letter.toUpperCase()}
					</div>
				{/each}
			</div>
		{/each}
	</div>

	{#if message}<p class="message">{message}</p>{/if}

	{#if done}
		<div class="result">
			{#if solved}
				<h3>🎉 Solved in {guesses.length}/{maxGuesses}!</h3>
			{:else}
				<h3>Out of guesses — the word was <strong>{answer.toUpperCase()}</strong></h3>
			{/if}
			<p class="hint">Come back tomorrow for round #{(round ?? 0) + 1}.</p>
		</div>
	{:else}
		<div class="keyboard">
			{#each kbRows as kr, i}
				<div class="kb-row">
					{#if i === 2}<button class="kb-key wide" onclick={() => handleKey('enter')}>ENTER</button>{/if}
					{#each kr.split('') as k}
						<button class="kb-key {keyStatus[k] ?? ''}" onclick={() => handleKey(k)}>
							{k.toUpperCase()}
						</button>
					{/each}
					{#if i === 2}<button class="kb-key wide" onclick={() => handleKey('back')}>⌫</button>{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if leaderboard.length > 0}
		<div class="leaderboard">
			<h3>Today's leaderboard</h3>
			<ol>
				{#each leaderboard as e}
					<li>{e.name} — {e.guesses}/{maxGuesses}</li>
				{/each}
			</ol>
		</div>
	{/if}

	<details class="fairness">
		<summary>🔍 Provably fair</summary>
		<p>
			The answer was committed on-chain <em>before</em> this round started:
		</p>
		<p class="mono">sha256(word + salt) = {commitSha256}</p>
		{#if commitTxid}
			<p class="mono">commit tx: {commitTxid}</p>
		{/if}
		<p>
			After the round ends, word + salt are revealed on-chain so anyone can verify the hash.
			{#if round}<a href={`/api/verify/${round}`} target="_blank">Verification data →</a>{/if}
		</p>
	</details>
</section>

<style>
	.game {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}
	.round-info {
		color: #666;
		font-size: 0.9rem;
	}
	.board {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.row {
		display: flex;
		gap: 0.3rem;
	}
	.cell {
		width: 3.2rem;
		height: 3.2rem;
		border: 2px solid #d3d6da;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.6rem;
		font-weight: 700;
		text-transform: uppercase;
	}
	.cell.filled {
		border-color: #878a8c;
	}
	.cell.g {
		background: #6aaa64;
		border-color: #6aaa64;
		color: white;
	}
	.cell.y {
		background: #c9b458;
		border-color: #c9b458;
		color: white;
	}
	.cell.x {
		background: #787c7e;
		border-color: #787c7e;
		color: white;
	}
	.message {
		color: #c0392b;
		font-size: 0.9rem;
		min-height: 1.2rem;
	}
	.keyboard {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		user-select: none;
	}
	.kb-row {
		display: flex;
		gap: 0.3rem;
		justify-content: center;
	}
	.kb-key {
		min-width: 2.1rem;
		height: 3rem;
		border: none;
		border-radius: 0.25rem;
		background: #d3d6da;
		font-weight: 700;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.kb-key.wide {
		min-width: 3.6rem;
		font-size: 0.7rem;
	}
	.kb-key.g {
		background: #6aaa64;
		color: white;
	}
	.kb-key.y {
		background: #c9b458;
		color: white;
	}
	.kb-key.x {
		background: #787c7e;
		color: white;
	}
	.result h3 {
		margin: 0.5rem 0 0.2rem;
	}
	.hint {
		color: #888;
		font-size: 0.9rem;
	}
	.leaderboard {
		border-top: 1px solid #eee;
		padding-top: 0.5rem;
		width: 100%;
		max-width: 20rem;
		text-align: left;
	}
	.leaderboard h3 {
		font-size: 1rem;
		text-align: center;
	}
	.fairness {
		max-width: 24rem;
		font-size: 0.85rem;
		color: #555;
		text-align: left;
		border: 1px solid #eee;
		border-radius: 0.5rem;
		padding: 0.6rem 0.9rem;
	}
	.fairness summary {
		cursor: pointer;
		font-weight: 600;
	}
	.mono {
		font-family: monospace;
		font-size: 0.75rem;
		word-break: break-all;
		color: #444;
	}
</style>
