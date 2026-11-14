<script lang="ts">
	/**
	 * Generieke Daily-schil (fase 8): ronde laden, poging reserveren, zetten
	 * insturen (met dezelfde actie-ID bij opnieuw proberen), tekenen, publiceren
	 * en het klassement. Het speelbord komt van de game zelf (src/lib/games).
	 */
	import { onMount } from 'svelte';
	import SignAttempt from './SignAttempt.svelte';
	import PublishResult from './PublishResult.svelte';
	import { randomId } from './browser-safe';
	import { BOARDS } from './games/boards';
	import type { BoardAction } from './games/types';

	let {
		token,
		friendlyName,
		game
	}: {
		token: string;
		friendlyName: string;
		game: { slug: string; version: string; name: string; maxActions: number; inputHint: string };
	} = $props();

	type Round = {
		id: string;
		roundId: string;
		gameVersion: string;
		availability: 'open' | 'scheduled' | 'commitment-pending' | 'closed';
		opensAt: number;
		closesAt: number;
		puzzle?: any;
		commitment: { sha256: string; transaction: { status: string; txid: string | null } };
	};
	type Leaderboard = {
		state: 'live' | 'finalized' | 'chain-verified';
		entries: Array<{
			rank: number | null;
			playerIAddress: string;
			friendlyName: string | null;
			status: 'solved' | 'unsolved' | 'abandoned' | 'in_progress';
			guessesUsed: number;
		}>;
	};

	const Board = $derived(BOARDS[game.slug]);
	const headers = () => ({ authorization: `Bearer ${token}` });

	let loading = $state(true);
	let round = $state<Round | null>(null);
	let attempt = $state<{ id: string; status: string } | null>(null);
	let actions = $state<BoardAction[]>([]);
	let terminal = $state(false);
	let solved = $state(false);
	let reveal = $state<any>(null);
	let message = $state('');
	let acceptedWarning = $state(false);
	let reserving = $state(false);
	let submitting = $state(false);
	let pending = $state<{ actionId: string; sequence: number; value: string } | null>(null);
	let leaderboard = $state<Leaderboard | null>(null);

	onMount(load);

	async function load() {
		loading = true;
		message = '';
		try {
			const response = await fetch(`/api/v1/games/${encodeURIComponent(game.slug)}/rounds/current`);
			if (response.status === 404) {
				round = null;
				return;
			}
			const body = await response.json();
			if (!response.ok) throw new Error(body.error?.message ?? 'Daily round unavailable.');
			round = body.round;
			await loadLeaderboard();
			const existing = await fetch(`/api/v1/rounds/${encodeURIComponent(body.round.id)}/attempt`, { headers: headers() });
			if (existing.ok) {
				const existingBody = await existing.json();
				if (existingBody.attempt) restore(existingBody.attempt);
			}
		} catch (caught) {
			message = caught instanceof Error ? caught.message : String(caught);
		} finally {
			loading = false;
		}
	}

	async function loadLeaderboard() {
		if (!round) return;
		const response = await fetch(`/api/v1/rounds/${encodeURIComponent(round.id)}/leaderboard`);
		if (response.ok) leaderboard = await response.json();
	}

	function restore(value: any) {
		attempt = { id: value.id, status: value.status };
		actions = (value.actions ?? []).map((a: any) => ({ sequence: a.sequence, value: a.value, feedback: a.feedback }));
		terminal = value.status === 'completed' || ['abandoned', 'expired', 'failed'].includes(value.status);
		solved = value.terminalResult?.solved === true;
		reveal = value.terminalResult?.reveal ?? null;
	}

	async function start() {
		if (!round || !acceptedWarning || reserving) return;
		reserving = true;
		message = '';
		try {
			const response = await fetch(`/api/v1/rounds/${encodeURIComponent(round.id)}/attempts`, { method: 'POST', headers: headers() });
			const body = await response.json();
			if (!response.ok) throw new Error(body.error?.message ?? 'Could not reserve Daily attempt.');
			const full = await fetch(`/api/v1/attempts/${encodeURIComponent(body.attempt.id)}`, { headers: headers() });
			const fullBody = await full.json();
			if (!full.ok) throw new Error(fullBody.error?.message ?? 'Could not load attempt.');
			restore(fullBody.attempt);
		} catch (caught) {
			message = caught instanceof Error ? caught.message : String(caught);
		} finally {
			reserving = false;
		}
	}

	async function submit(value: string) {
		if (!attempt || !round || terminal || submitting) return;
		const action = pending ?? { actionId: randomId(), sequence: actions.length + 1, value };
		pending = action;
		submitting = true;
		message = '';
		try {
			const response = await fetch(`/api/v1/attempts/${encodeURIComponent(attempt.id)}/actions`, {
				method: 'POST',
				headers: { ...headers(), 'content-type': 'application/json' },
				body: JSON.stringify({
					actionId: action.actionId,
					sequence: action.sequence,
					type: 'action',
					payload: { value: action.value },
					gameVersion: round.gameVersion
				})
			});
			const body = await response.json();
			if (!response.ok) {
				if (response.status < 500) pending = null;
				throw new Error(body.error?.message ?? 'That move was not accepted.');
			}
			actions = [...actions, { sequence: action.sequence, value: body.result.value ?? action.value, feedback: body.result.feedback }];
			pending = null;
			terminal = body.result.terminal;
			solved = body.result.solved;
			reveal = body.result.reveal ?? null;
			if (terminal) attempt = { ...attempt, status: 'completed' };
			await loadLeaderboard();
		} catch (caught) {
			message = (caught instanceof Error ? caught.message : String(caught)) + (pending ? ' Retry will reuse the same action ID.' : '');
		} finally {
			submitting = false;
		}
	}
</script>

<section class="daily">
	<header>
		<div>
			<p class="mode">Daily · {game.name} v{game.version}</p>
			<h2>Today's ranked puzzle</h2>
		</div>
		<span class="badge">VRSCTEST</span>
	</header>

	{#if loading}
		<div class="state"><p>Loading the confirmed Daily round…</p></div>
	{:else if !round}
		<div class="state">
			<h3>No {game.name} round scheduled</h3>
			<p>The next round appears here once its commitment is on chain.</p>
		</div>
	{:else if !attempt}
		<div class="proof">
			<span>Commitment {round.commitment.transaction.status}</span>
			<code>{round.commitment.sha256}</code>
		</div>
		{#if round.availability !== 'open'}
			<div class="state">
				<h3>Daily is {round.availability}</h3>
				<p>Opens {new Date(round.opensAt).toLocaleString()} · closes {new Date(round.closesAt).toLocaleString()}.</p>
			</div>
		{:else}
			<div class="warning">
				<h3>Starting consumes today's only ranked attempt</h3>
				<ul>
					<li>You get {game.maxActions} tries. A move the rules reject does not count.</li>
					<li>You can resume this exact attempt before the round closes.</li>
					<li>Your i-address and canonical result enter the permanent result proof.</li>
				</ul>
				<label>
					<input type="checkbox" bind:checked={acceptedWarning} />
					I understand this is my only ranked attempt today.
				</label>
				<button disabled={!acceptedWarning || reserving} onclick={start}>{reserving ? 'Reserving…' : 'Start Daily'}</button>
			</div>
		{/if}
	{:else}
		<p class="player">Playing as <strong>{friendlyName}</strong> · attempt {attempt.id.slice(0, 8)}…</p>
		{#if Board}
			<Board
				puzzle={round.puzzle}
				{actions}
				{terminal}
				{solved}
				{reveal}
				maxActions={game.maxActions}
				busy={submitting || Boolean(pending)}
				onsubmit={submit}
			/>
		{:else}
			<div class="state"><p>This app has no board for {game.name} yet.</p></div>
		{/if}
		<p class="message" class:success={solved} aria-live="polite">{message || ' '}</p>
		{#if pending}
			<button class="retry" disabled={submitting} onclick={() => submit(pending?.value ?? '')}>{submitting ? 'Retrying…' : 'Retry same move'}</button>
		{/if}
		{#if terminal}
			<a class="verify" href={`/verify/${encodeURIComponent(round.id)}`}>Open round verifier →</a>
			{#if attempt.status === 'completed'}
				<SignAttempt {token} attemptId={attempt.id} playerName={friendlyName} />
				<PublishResult {token} attemptId={attempt.id} playerName={friendlyName} />
			{/if}
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
							<span class="score">{entry.status === 'solved' ? `${entry.guessesUsed}/${game.maxActions}` : entry.status.replace('_', ' ')}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}
</section>

<style>
	.daily { width:min(100%,38rem); }
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
	.proof { display:grid; gap:.35rem; margin-top:1rem; padding:.7rem; border-left:3px solid #33794a; background:#e5ede4; font-size:.75rem; }
	.proof code { overflow-wrap:anywhere; color:#5c6d61; }
	.player { color:#647268; font-size:.78rem; }
	.message { min-height:1.4rem; text-align:center; color:#8b3a2e; font-weight:700; }
	.message.success { color:#33794a; }
	.verify { display:block; margin:.5rem 0; color:#2f6e43; font-weight:800; }
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
	.empty { color:#738078; font-size:.8rem; }
</style>
