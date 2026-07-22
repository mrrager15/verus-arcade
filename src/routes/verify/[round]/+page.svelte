<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	type VerifyData = {
		round: number;
		date: string;
		commitSha256: string;
		commitTxid: string | null;
		word?: string;
		salt?: string;
		revealTxid?: string | null;
		note?: string;
	};

	let data = $state<VerifyData | null>(null);
	let error = $state('');
	let recomputed = $state('');
	let match = $state<boolean | null>(null);

	// The point of this page: YOUR browser recomputes the hash — you don't
	// have to trust the server's word for it.
	async function sha256hex(s: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	onMount(async () => {
		try {
			const r = await fetch(`/api/verify/${page.params.round}`);
			const body = await r.json();
			if (!r.ok) {
				error = body.error ?? 'Unknown round';
				return;
			}
			data = body;
			if (body.word && body.salt) {
				recomputed = await sha256hex(body.word + body.salt);
				match = recomputed === body.commitSha256;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<main>
	<h1>🔍 Round verification</h1>

	{#if error}
		<p class="error">⚠ {error}</p>
	{:else if !data}
		<p>Loading…</p>
	{:else}
		<section class="card">
			<h2>Round #{data.round} — {data.date}</h2>

			<h3>1. The commitment (published before play started)</h3>
			<p>
				Before anyone could guess, Verus Arcade published the hash of the answer on the Verus
				testnet blockchain, inside the identity <code>Arcade@</code>:
			</p>
			<p class="mono">sha256(word + salt) = {data.commitSha256}</p>
			{#if data.commitTxid}
				<p class="mono">transaction: {data.commitTxid}</p>
			{/if}

			{#if data.word && data.salt}
				<h3>2. The reveal (published after the round ended)</h3>
				<p class="mono">word = "{data.word}"</p>
				<p class="mono">salt = {data.salt}</p>

				<h3>3. Your browser checks the math</h3>
				<p>
					This page just recomputed <code>sha256("{data.word}" + salt)</code> locally — not on our
					server, but in <em>your</em> browser:
				</p>
				<p class="mono">recomputed = {recomputed}</p>
				{#if match === true}
					<p class="verdict ok">✓ MATCH — the answer provably wasn't changed after the round started.</p>
				{:else if match === false}
					<p class="verdict bad">✗ MISMATCH — the reveal does not correspond to the commitment!</p>
				{/if}

				<h3>4. Don't trust this page either?</h3>
				<p>Verify fully independently against any Verus testnet node:</p>
				<pre>verus -chain=vrsctest getidentitycontent Arcade@
# decode the hex entries under the round.commit / round.reveal keys,
# then: sha256("{data.word}" + "{data.salt.slice(0, 8)}…") and compare.</pre>
			{:else}
				<h3>2. The reveal</h3>
				<p>{data.note}</p>
			{/if}
		</section>
		<p><a href="/">← Back to the game</a></p>
	{/if}
</main>

<style>
	main {
		max-width: 42rem;
		margin: 5vh auto;
		font-family: system-ui, sans-serif;
		padding: 0 1rem;
	}
	h1 {
		text-align: center;
	}
	.card {
		border: 1px solid #e0e0e0;
		border-radius: 0.75rem;
		padding: 1.5rem;
	}
	h3 {
		margin-top: 1.4rem;
		margin-bottom: 0.3rem;
	}
	.mono {
		font-family: monospace;
		font-size: 0.8rem;
		word-break: break-all;
		background: #f6f6f6;
		padding: 0.35rem 0.5rem;
		border-radius: 0.3rem;
	}
	pre {
		font-size: 0.75rem;
		background: #1e1e1e;
		color: #d4d4d4;
		padding: 0.75rem;
		border-radius: 0.4rem;
		overflow-x: auto;
	}
	.verdict {
		font-weight: 700;
		padding: 0.5rem 0.75rem;
		border-radius: 0.4rem;
	}
	.verdict.ok {
		background: #e7f4e4;
		color: #2d6a2d;
	}
	.verdict.bad {
		background: #fdeaea;
		color: #a33;
	}
	.error {
		color: #c0392b;
		text-align: center;
	}
	code {
		background: #f0f0f0;
		padding: 0.1rem 0.3rem;
		border-radius: 0.2rem;
	}
</style>
