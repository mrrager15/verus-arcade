<script lang="ts">
	/**
	 * Fase 2b: mijn attestaties. Arcade@ tekent na elke afgesloten Daily je stats
	 * (alleen getekende pogingen tellen). Hier kies je welke velden je deelt;
	 * de link toont alleen die velden, plus speler en ronde. De rest blijft verborgen.
	 */
	import { onMount } from 'svelte';
	import PublishResult from '$lib/PublishResult.svelte';

	const TOKEN_KEY = 'arcade-session-token';
	const SHAREABLE = ['streak', 'rounds', 'solved', 'prev'] as const;
	type Field = (typeof SHAREABLE)[number];
	type Attestation = {
		roundRecordId: string;
		attemptId: string;
		publication: 'pending' | 'receipt' | 'published' | 'expired' | 'mismatch' | null;
		round: string;
		streak: number;
		rounds: number;
		solved: number;
		root: string;
		prevRoot: string | null;
		signatureHeight: number;
	};

	let token = $state<string | null>(null);
	let attestations = $state<Attestation[] | null>(null);
	let error = $state('');
	let chosen = $state<Record<string, Field[]>>({});
	let links = $state<Record<string, string>>({});
	let copied = $state('');
	let playerName = $state('');
	let publishing = $state<Record<string, boolean>>({});

	const headers = () => ({ authorization: `Bearer ${token}` });

	onMount(async () => {
		token = localStorage.getItem(TOKEN_KEY);
		if (!token) {
			error = 'Log in on the home page first.';
			return;
		}
		try {
			const response = await fetch('/api/v1/attestations', { headers: headers() });
			const body = await response.json();
			if (!response.ok) {
				error = body.error?.message ?? 'Attestations are unavailable.';
				return;
			}
			attestations = body.attestations;
			const me = await fetch('/api/v1/me', { headers: headers() });
			if (me.ok) {
				const principal = (await me.json()).principal;
				playerName = principal?.friendlyName ?? principal?.iAddress ?? '';
			}
			for (const a of body.attestations as Attestation[]) chosen[a.roundRecordId] = ['streak'];
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Attestations are unavailable.';
		}
	});

	function toggle(id: string, field: Field) {
		const current = chosen[id] ?? [];
		chosen[id] = current.includes(field) ? current.filter((f) => f !== field) : [...current, field];
		delete links[id];
	}

	async function share(a: Attestation) {
		error = '';
		const fields = (chosen[a.roundRecordId] ?? []).join(',');
		const response = await fetch(
			`/api/v1/attestations/${encodeURIComponent(a.roundRecordId)}/disclosure?fields=${encodeURIComponent(fields)}`,
			{ headers: headers() }
		);
		const body = await response.json();
		if (!response.ok) {
			error = body.error?.message ?? 'Could not create the link.';
			return;
		}
		links[a.roundRecordId] = `${location.origin}/verify/attestation#${body.link}`;
	}

	async function copy(id: string) {
		try {
			await navigator.clipboard.writeText(links[id]);
			copied = id;
		} catch {
			copied = '';
		}
	}
</script>

<svelte:head>
	<title>Verus Arcade · My attestations</title>
</svelte:head>

<main class="page">
	<p class="eyebrow">My attestations · signed by Arcade@</p>
	<h1>Prove a stat without showing the rest</h1>
	<p class="intro">
		After every Daily, Arcade@ signs your stats as a set of separately sealed fields. Only attempts you signed with
		your VerusID count. Pick what to share: the link reveals just those fields (plus player and round), and anyone can
		check Arcade@'s signature. The other fields stay hidden.
	</p>
	{#if error}
		<p class="error">{error}</p>
	{/if}
	{#if attestations === null && !error}
		<p>Loading…</p>
	{:else if attestations && attestations.length === 0}
		<p class="empty">No attestations yet. They are created after a Daily you signed has closed.</p>
	{:else if attestations}
		<ul class="list">
			{#each attestations as a (a.roundRecordId)}
				<li>
					<div class="head">
						<span class="round">{a.round}</span>
						<span class="streak">streak {a.streak}</span>
					</div>
					<p class="meta">
						{a.rounds} signed {a.rounds === 1 ? 'round' : 'rounds'} · {a.solved} solved · signed at block {a.signatureHeight}
						{#if a.publication === 'published'} · <strong>in your VerusID</strong>{/if}
					</p>
					<fieldset>
						<legend>Share</legend>
						{#each SHAREABLE as field (field)}
							<label>
								<input
									type="checkbox"
									checked={(chosen[a.roundRecordId] ?? []).includes(field)}
									onchange={() => toggle(a.roundRecordId, field)}
								/>
								{field === 'prev' ? 'link to previous attestation' : field}
							</label>
						{/each}
					</fieldset>
					<button class="share" onclick={() => share(a)}>Create share link</button>
					{#if token && (publishing[a.roundRecordId] || (a.publication !== null && a.publication !== 'expired'))}
						<PublishResult {token} attemptId={a.attemptId} {playerName} kind="attestation" />
					{:else}
						<button class="secondary" onclick={() => (publishing[a.roundRecordId] = true)}>Put in my VerusID…</button>
					{/if}
					{#if links[a.roundRecordId]}
						<div class="link">
							<input readonly value={links[a.roundRecordId]} />
							<button onclick={() => copy(a.roundRecordId)}>{copied === a.roundRecordId ? 'Copied' : 'Copy'}</button>
							<a href={links[a.roundRecordId]} target="_blank" rel="noreferrer">Open</a>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<a class="back" href="/">← Back to the Arcade</a>
</main>

<style>
	.page { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; gap: 0.8rem; }
	.eyebrow { margin: 0; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #3f6549; }
	h1 { margin: 0; font-family: Georgia, serif; font-weight: 500; font-size: 1.8rem; }
	.intro, .meta, .empty { margin: 0; font-size: 0.85rem; color: #5c6d61; }
	.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.8rem; }
	.list li { padding: 0.9rem; border: 1px solid #c7d1c7; border-radius: 0.9rem; background: #f4f7f2; display: grid; gap: 0.5rem; }
	.head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
	.round { font-weight: 700; overflow-wrap: anywhere; }
	.streak { padding: 0.2rem 0.6rem; border-radius: 999px; background: #193d26; color: white; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
	fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.85rem; }
	legend { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: #3f6549; margin-bottom: 0.2rem; }
	.secondary { justify-self: start; padding: 0.45rem 0.9rem; border: 1px solid #193d26; border-radius: 999px; background: transparent; color: #193d26; font-weight: 700; cursor: pointer; }
	.share, .link button { justify-self: start; padding: 0.45rem 0.9rem; border: 0; border-radius: 999px; background: #193d26; color: white; font-weight: 700; cursor: pointer; }
	.link { display: grid; grid-template-columns: 1fr auto auto; gap: 0.5rem; align-items: center; }
	.link input { min-width: 0; font-size: 0.75rem; padding: 0.4rem; border: 1px solid #c7d1c7; border-radius: 0.5rem; }
	.back { font-size: 0.85rem; }
	.error { color: #8b2b2b; }
	@media (max-width: 30rem) { .link { grid-template-columns: 1fr; } }
</style>
