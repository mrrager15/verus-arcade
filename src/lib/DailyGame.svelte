<script lang="ts">
	import { onMount } from 'svelte';
	import { MAX_GUESSES, WORD_LENGTH } from '../../shared/word-grid.mjs';

	let {
		token,
		friendlyName
	}: {
		token: string;
		friendlyName: string;
	} = $props();

	type Mark = 'g' | 'y' | 'x';
	type Guess = { sequence: number; word: string; pattern: Mark[] };
	type Round = {
		id: string;
		roundId: string;
		gameVersion: string;
		availability: 'open' | 'scheduled' | 'commitment-pending' | 'closed';
		opensAt: number;
		closesAt: number;
		commitment: {
			sha256: string;
			transaction: { status: string; txid: string | null };
		};
	};
	type Attempt = {
		id: string;
		status: string;
		actions?: Guess[];
		terminalResult?: {
			solved: boolean;
			answer?: string;
			guessesUsed: number;
		} | null;
	};
	type PendingAction = {
		actionId: string;
		sequence: number;
		word: string;
	};
	type Leaderboard = {
		state: 'live' | 'finalized' | 'chain-verified';
		resultRoot: string | null;
		entries: Array<{
			rank: number | null;
			playerIAddress: string;
			friendlyName: string | null;
			status: 'solved' | 'unsolved' | 'abandoned' | 'in_progress';
			guessesUsed: number;
		}>;
	};

	const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
	const headers = () => ({ authorization: `Bearer ${token}` });

	let loading = $state(true);
	let round = $state<Round | null>(null);
	let attempt = $state<Attempt | null>(null);
	let guesses = $state<Guess[]>([]);
	let current = $state('');
	let message = $state('');
	let acceptedWarning = $state(false);
	let reserving = $state(false);
	let submitting = $state(false);
	let pendingAction = $state<PendingAction | null>(null);
	let terminal = $state(false);
	let solved = $state(false);
	let answer = $state('');
	let leaderboard = $state<Leaderboard | null>(null);

	onMount(load);

	async function load() {
		loading = true;
		message = '';
		try {
			const response = await fetch('/api/v1/games/word-grid/rounds/current');
			if (response.status === 404) {
				round = null;
				return;
			}
			const body = await response.json();
			if (!response.ok) throw new Error(body.error?.message ?? 'Daily round unavailable.');
			const discovered: Round = body.round;
			round = discovered;
			await loadLeaderboard(discovered.id);
			const existing = await fetch(`/api/v1/rounds/${encodeURIComponent(discovered.id)}/attempt`, {
				headers: headers()
			});
			if (existing.ok) {
				const existingBody = await existing.json();
				if (existingBody.attempt) restoreAttempt(existingBody.attempt);
			}
		} catch (caught) {
			message = caught instanceof Error ? caught.message : String(caught);
		} finally {
			loading = false;
		}
	}

	async function loadLeaderboard(roundId = round?.id) {
		if (!roundId) return;
		const response = await fetch(
			`/api/v1/rounds/${encodeURIComponent(roundId)}/leaderboard`
		);
		if (response.ok) leaderboard = await response.json();
	}

	function restoreAttempt(value: Attempt) {
		attempt = value;
		guesses = value.actions ?? [];
		terminal = value.status === 'completed' || ['abandoned', 'expired', 'failed'].includes(value.status);
		solved = value.terminalResult?.solved === true;
		answer = value.terminalResult?.answer ?? '';
	}

	async function startDaily() {
		if (!round || !acceptedWarning || reserving) return;
		reserving = true;
		message = '';
		try {
			const response = await fetch(`/api/v1/rounds/${encodeURIComponent(round.id)}/attempts`, {
				method: 'POST',
				headers: headers()
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error?.message ?? 'Could not reserve Daily attempt.');
			const full = await fetch(`/api/v1/attempts/${encodeURIComponent(body.attempt.id)}`, {
				headers: headers()
			});
			const fullBody = await full.json();
			if (!full.ok) throw new Error(fullBody.error?.message ?? 'Could not load attempt.');
			restoreAttempt(fullBody.attempt);
		} catch (caught) {
			message = caught instanceof Error ? caught.message : String(caught);
		} finally {
			reserving = false;
		}
	}

	async function submit() {
		if (!attempt || !round || terminal || submitting) return;
		if (current.length !== WORD_LENGTH && !pendingAction) {
			message = 'Enter five letters.';
			return;
		}
		const action =
			pendingAction ??
			({
				actionId: crypto.randomUUID(),
				sequence: guesses.length + 1,
				word: current
			} satisfies PendingAction);
		pendingAction = action;
		submitting = true;
		message = '';
		try {
			const response = await fetch(
				`/api/v1/attempts/${encodeURIComponent(attempt.id)}/actions`,
				{
					method: 'POST',
					headers: { ...headers(), 'content-type': 'application/json' },
					body: JSON.stringify({
						actionId: action.actionId,
						sequence: action.sequence,
						type: 'guess',
						payload: { word: action.word },
						gameVersion: round.gameVersion
					})
				}
			);
			const body = await response.json();
			if (!response.ok) {
				if (response.status < 500) pendingAction = null;
				throw new Error(body.error?.message ?? 'Guess was rejected.');
			}
			guesses = [
				...guesses,
				{ sequence: action.sequence, word: action.word, pattern: body.result.pattern }
			];
			current = '';
			pendingAction = null;
			terminal = body.result.terminal;
			solved = body.result.solved;
			answer = body.result.answer ?? '';
			message = terminal
				? solved
					? `Solved in ${body.result.guessesUsed} guesses.`
					: `The answer was ${answer.toUpperCase()}.`
				: '';
			await loadLeaderboard();
		} catch (caught) {
			message =
				(caught instanceof Error ? caught.message : String(caught)) +
				(pendingAction ? ' Retry will reuse the same action ID.' : '');
		} finally {
			submitting = false;
		}
	}

	function input(key: string) {
		if (!attempt || terminal || submitting || pendingAction) return;
		message = '';
		if (key === 'enter') void submit();
		else if (key === 'backspace') current = current.slice(0, -1);
		else if (/^[a-z]$/.test(key) && current.length < WORD_LENGTH) current += key;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const key = event.key.toLowerCase();
		if (key === 'enter' || key === 'backspace' || /^[a-z]$/.test(key)) {
			event.preventDefault();
			input(key);
		}
	}

	const keyStatus = $derived.by(() => {
		const status: Record<string, Mark> = {};
		const rank = { x: 1, y: 2, g: 3 };
		for (const guess of guesses) {
			guess.word.split('').forEach((letter, index) => {
				const next = guess.pattern[index];
				if (!status[letter] || rank[next] > rank[status[letter]]) status[letter] = next;
			});
		}
		return status;
	});
</script>

<svelte:window onkeydown={onKeydown} />

<section class="daily">
	<header>
		<div>
			<p class="mode">Daily Seed · Word Grid v1.0.0</p>
			<h2>Today's ranked puzzle</h2>
		</div>
		<span class="badge">VRSCTEST</span>
	</header>

	{#if loading}
		<div class="state"><p>Loading the confirmed Daily round…</p></div>
	{:else if !round}
		<div class="state">
			<h3>No Daily round scheduled</h3>
			<p>Practice remains available while the operator prepares the next commitment.</p>
		</div>
	{:else if !attempt}
		<div class="proof">
			<span>Commitment {round.commitment.transaction.status}</span>
			<code>{round.commitment.sha256}</code>
		</div>
		{#if round.availability !== 'open'}
			<div class="state">
				<h3>Daily is {round.availability}</h3>
				<p>
					Opens {new Date(round.opensAt).toLocaleString()} · closes
					{new Date(round.closesAt).toLocaleString()}.
				</p>
			</div>
		{:else}
			<div class="warning">
				<h3>Starting consumes today's only ranked attempt</h3>
				<ul>
					<li>You can resume this exact attempt before the round closes.</li>
					<li>Closing the browser does not restore eligibility.</li>
					<li>Abandoned attempts remain in the final result set.</li>
					<li>Your i-address and canonical result enter the permanent result proof.</li>
				</ul>
				<label>
					<input type="checkbox" bind:checked={acceptedWarning} />
					I understand this is my only ranked attempt today.
				</label>
				<button disabled={!acceptedWarning || reserving} onclick={startDaily}>
					{reserving ? 'Reserving…' : 'Start Daily'}
				</button>
			</div>
		{/if}
	{:else}
		<p class="player">Playing as <strong>{friendlyName}</strong> · attempt {attempt.id.slice(0, 8)}…</p>
		<div class="board" aria-label="Daily guess board">
			{#each Array(MAX_GUESSES) as _, row}
				<div class="guess-row">
					{#each Array(WORD_LENGTH) as _, column}
						{@const accepted = guesses[row]}
						{@const active = row === guesses.length && !terminal}
						{@const letter = accepted?.word[column] ?? (active ? current[column] : '') ?? ''}
						<div
							class="tile"
							class:filled={Boolean(letter)}
							class:correct={accepted?.pattern[column] === 'g'}
							class:present={accepted?.pattern[column] === 'y'}
							class:absent={accepted?.pattern[column] === 'x'}
							aria-label={letter
								? `${letter}, ${accepted?.pattern[column] ?? 'entered'}`
								: 'empty'}
						>{letter}</div>
					{/each}
				</div>
			{/each}
		</div>
		<p class="message" class:success={solved} aria-live="polite">{message || ' '}</p>
		{#if pendingAction}
			<button class="retry" disabled={submitting} onclick={submit}>
				{submitting ? 'Retrying…' : 'Retry same action'}
			</button>
		{:else if !terminal}
			<div class="keyboard">
				{#each KEY_ROWS as row, index}
					<div class="key-row">
						{#if index === 2}<button class="key action" onclick={() => input('enter')}>Enter</button>{/if}
						{#each row as letter}
							<button
								class="key"
								class:correct={keyStatus[letter] === 'g'}
								class:present={keyStatus[letter] === 'y'}
								class:absent={keyStatus[letter] === 'x'}
								onclick={() => input(letter)}
							>{letter}</button>
						{/each}
						{#if index === 2}<button class="key action" onclick={() => input('backspace')}>⌫</button>{/if}
					</div>
				{/each}
			</div>
		{:else}
			<div class="state">
				<h3>{solved ? 'Daily complete' : 'Attempt complete'}</h3>
				<p>{answer ? `Answer: ${answer.toUpperCase()}. ` : ''}Your result awaits round finalization.</p>
				<a href={`/verify/${encodeURIComponent(round.id)}`}>Open round verifier →</a>
			</div>
		{/if}
	{/if}

	{#if message && !attempt}<p class="message">{message}</p>{/if}

	{#if leaderboard}
		<section class="leaderboard">
			<header>
				<div>
					<p class="mode">Public leaderboard</p>
					<h3>Daily standings</h3>
				</div>
				<span class="proof-state">{leaderboard.state}</span>
			</header>
			{#if leaderboard.entries.length === 0}
				<p class="empty">No ranked results yet.</p>
			{:else}
				<ol>
					{#each leaderboard.entries as entry}
						<li>
							<span class="rank">{entry.rank ?? '—'}</span>
							<span class="identity-name">
								<strong>{entry.friendlyName ?? 'VerusID'}</strong>
								<code>{entry.playerIAddress.slice(0, 9)}…{entry.playerIAddress.slice(-5)}</code>
							</span>
							<span class="score">
								{entry.status === 'solved'
									? `${entry.guessesUsed}/6`
									: entry.status.replace('_', ' ')}
							</span>
						</li>
					{/each}
				</ol>
			{/if}
			{#if leaderboard.resultRoot}
				<code class="root">root {leaderboard.resultRoot}</code>
			{/if}
		</section>
	{/if}
</section>

<style>
	.daily { --green:#33794a; --amber:#b47b18; --slate:#59635c; width:min(100%,38rem); }
	header { display:flex; justify-content:space-between; gap:1rem; }
	.mode { margin:0; color:#4d7258; font-size:.76rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
	h2 { margin:.15rem 0 0; font-size:clamp(1.45rem,5vw,2rem); }
	.badge { height:max-content; border:1px solid #a7b9aa; border-radius:999px; padding:.35rem .65rem; font-size:.72rem; font-weight:800; }
	.state,.warning { margin-top:1.3rem; padding:1.1rem; border:1px solid #cbd8ce; border-radius:.8rem; background:#fbfdf9; }
	.state h3,.warning h3 { margin:.1rem 0 .55rem; }
	.state p,.warning li { color:#5e6d62; line-height:1.5; }
	.warning ul { padding-left:1.2rem; }
	.warning label { display:flex; gap:.6rem; margin:1rem 0; font-weight:700; line-height:1.4; }
	.warning button,.retry { width:100%; border:0; border-radius:.6rem; padding:.8rem; background:#173e25; color:white; font-weight:800; cursor:pointer; }
	button:disabled { opacity:.45; cursor:not-allowed; }
	.proof { display:grid; gap:.35rem; margin-top:1rem; padding:.7rem; border-left:3px solid var(--green); background:#e5ede4; font-size:.75rem; }
	.proof code { overflow-wrap:anywhere; color:#5c6d61; }
	.player { color:#647268; font-size:.78rem; }
	.board { display:grid; gap:.36rem; justify-content:center; margin-top:1rem; }
	.guess-row { display:flex; gap:.36rem; }
	.tile { width:clamp(2.7rem,12vw,3.65rem); aspect-ratio:1; display:grid; place-items:center; border:2px solid #cbd8ce; border-radius:.35rem; background:#fbfdf9; font-size:clamp(1.35rem,6vw,1.9rem); font-weight:850; text-transform:uppercase; }
	.tile.filled { border-color:#839489; }
	.correct { background:var(--green)!important; border-color:var(--green)!important; color:white!important; }
	.present { background:var(--amber)!important; border-color:var(--amber)!important; color:white!important; }
	.absent { background:var(--slate)!important; border-color:var(--slate)!important; color:white!important; }
	.message { min-height:1.4rem; text-align:center; color:#8b3a2e; font-weight:700; }
	.message.success { color:var(--green); }
	.keyboard { display:grid; gap:.4rem; user-select:none; }
	.key-row { display:flex; justify-content:center; gap:.28rem; }
	.key { min-width:0; width:2.25rem; height:3.25rem; padding:0; border:0; border-radius:.4rem; background:#dbe2dc; font-size:.85rem; font-weight:800; text-transform:uppercase; cursor:pointer; }
	.key.action { width:3.8rem; font-size:.65rem; }
	.state a { color:#2f6e43; font-weight:800; }
	.leaderboard { margin-top:1.5rem; padding-top:1.2rem; border-top:1px solid #cbd8ce; }
	.leaderboard header { align-items:center; }
	.leaderboard h3 { margin:.1rem 0; font-size:1.25rem; }
	.proof-state { padding:.3rem .55rem; border-radius:999px; background:#e0e9df; color:#3f6549; font-size:.65rem; font-weight:800; text-transform:uppercase; }
	.leaderboard ol { list-style:none; padding:0; margin:.8rem 0 0; display:grid; gap:.35rem; }
	.leaderboard li { display:grid; grid-template-columns:2rem 1fr auto; gap:.65rem; align-items:center; padding:.6rem .7rem; border-radius:.55rem; background:#f8faf6; }
	.rank { font-family:Georgia,serif; font-size:1.2rem; color:#41604a; }
	.identity-name { display:grid; gap:.15rem; min-width:0; }
	.identity-name code { color:#78847b; font-size:.65rem; }
	.score { color:#4e6053; font-size:.75rem; font-weight:800; text-transform:capitalize; }
	.root { display:block; margin-top:.7rem; color:#76827a; font-size:.62rem; overflow-wrap:anywhere; }
	.empty { color:#738078; font-size:.8rem; }
	@media (max-width:430px) {
		.key { width:calc((100vw - 3.6rem)/10); height:3rem; font-size:.7rem; }
		.key.action { width:2.9rem; font-size:.55rem; }
	}
</style>
