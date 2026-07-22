<script lang="ts">
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';
	import Game from '$lib/Game.svelte';

	type LoginStatus = 'restoring' | 'idle' | 'waiting' | 'verified' | 'error';

	let status: LoginStatus = $state('restoring');
	let qrDataUrl = $state('');
	let deepLink = $state('');
	let error = $state('');
	let sessionToken = $state('');
	let user = $state<{ friendlyName: string; iAddress: string; chainName: string } | null>(null);

	const TOKEN_KEY = 'arcade-session-token';

	// Restore a previous session: the backend recognises the stored token and
	// /api/state answers with a `you` block — no wallet interaction needed.
	onMount(async () => {
		const stored = localStorage.getItem(TOKEN_KEY);
		if (!stored) {
			status = 'idle';
			return;
		}
		try {
			const r = await fetch('/api/state', { headers: { Authorization: `Bearer ${stored}` } });
			const body = await r.json();
			if (r.ok && body.you) {
				sessionToken = stored;
				user = { friendlyName: body.you.friendlyName, iAddress: body.you.iAddress, chainName: 'VRSCTEST' };
				status = 'verified';
				return;
			}
		} catch {
			/* fall through to login */
		}
		localStorage.removeItem(TOKEN_KEY);
		status = 'idle';
	});

	let chain = $state(localStorage?.getItem('arcade-chain') ?? 'vrsc');

	async function login() {
		status = 'waiting';
		error = '';
		user = null;
		localStorage.setItem('arcade-chain', chain);
		try {
			const r = await fetch('/verus/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chain })
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body.error ?? r.statusText);
			deepLink = body.deepLinkPost;
			qrDataUrl = await QRCode.toDataURL(body.deepLinkPost, { width: 320, margin: 1 });
			void poll(body.challengeId);
		} catch (e) {
			status = 'error';
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function poll(challengeId: string) {
		while (status === 'waiting') {
			await new Promise((res) => setTimeout(res, 1500));
			const r = await fetch(`/verus/result/${challengeId}`);
			if (!r.ok) {
				status = 'error';
				error = 'Challenge expired — please try again.';
				return;
			}
			const data = await r.json();
			if (data.status === 'verified') {
				user = data;
				sessionToken = data.data?.sessionToken ?? '';
				if (sessionToken) localStorage.setItem(TOKEN_KEY, sessionToken);
				status = 'verified';
				return;
			}
		}
	}

	function reset() {
		status = 'idle';
		qrDataUrl = '';
		deepLink = '';
		user = null;
		error = '';
		sessionToken = '';
		localStorage.removeItem(TOKEN_KEY);
	}
</script>

<main>
	<h1>🕹️ Verus Arcade</h1>
	<p class="tagline">Provably fair skill games — your name, streak and rating on-chain forever.</p>

	{#if status === 'restoring'}
		<p class="hint">Restoring session…</p>
	{:else if status === 'idle'}
		<button onclick={login}>Login with VerusID</button>
		<p class="chain-pick">
			<label><input type="radio" bind:group={chain} value="vrsc" /> VRSC (mainnet)</label>
			<label><input type="radio" bind:group={chain} value="vrsctest" /> VRSCTEST</label>
		</p>
		<p class="hint">Scan the QR with Verus Mobile to log in — any VerusID works, login is free and off-chain.</p>
	{:else if status === 'waiting'}
		{#if qrDataUrl}
			<img src={qrDataUrl} alt="Login QR code" />
			<p class="hint">Scan with Verus Mobile and approve the login request…</p>
			<details>
				<summary>deeplink (same device)</summary>
				<a href={deepLink}>Open in wallet</a>
			</details>
		{:else}
			<p>Creating challenge…</p>
		{/if}
		<button class="secondary" onclick={reset}>Cancel</button>
	{:else if status === 'verified' && user}
		<Game token={sessionToken} friendlyName={user.friendlyName} />
		<button class="secondary" onclick={reset}>Log out</button>
	{:else if status === 'error'}
		<p class="error">⚠ {error}</p>
		<button onclick={login}>Try again</button>
	{/if}
</main>

<style>
	main {
		max-width: 28rem;
		margin: 10vh auto;
		text-align: center;
		font-family: system-ui, sans-serif;
	}
	h1 {
		font-size: 2.2rem;
		margin-bottom: 0.25rem;
	}
	.tagline {
		color: #666;
		margin-bottom: 2rem;
	}
	button {
		font-size: 1.1rem;
		padding: 0.7rem 1.6rem;
		border-radius: 0.5rem;
		border: none;
		background: #3165d4;
		color: white;
		cursor: pointer;
	}
	button:hover {
		background: #2851a8;
	}
	button.secondary {
		background: transparent;
		color: #3165d4;
		margin-top: 1rem;
	}
	img {
		border: 1px solid #ddd;
		border-radius: 0.75rem;
		padding: 0.5rem;
		background: white;
	}
	.hint {
		color: #888;
		font-size: 0.9rem;
	}
	.chain-pick {
		display: flex;
		gap: 1.2rem;
		justify-content: center;
		font-size: 0.9rem;
		color: #555;
	}
	.error {
		color: #c0392b;
	}
	details {
		margin-top: 0.5rem;
		font-size: 0.85rem;
	}
</style>
