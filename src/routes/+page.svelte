<script lang="ts">
	import QRCode from 'qrcode';

	type LoginStatus = 'idle' | 'waiting' | 'verified' | 'error';

	let status: LoginStatus = $state('idle');
	let qrDataUrl = $state('');
	let deepLink = $state('');
	let error = $state('');
	let user = $state<{ friendlyName: string; iAddress: string; chainName: string } | null>(null);

	async function login() {
		status = 'waiting';
		error = '';
		user = null;
		try {
			const r = await fetch('/verus/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chain: 'vrsctest' })
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
	}
</script>

<main>
	<h1>🕹️ Verus Arcade</h1>
	<p class="tagline">Provably fair skill games — your name, streak and rating on-chain forever.</p>

	{#if status === 'idle'}
		<button onclick={login}>Login with VerusID</button>
		<p class="hint">Scan the QR with Verus Mobile (testnet mode) to log in.</p>
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
		<div class="welcome">
			<h2>Welcome, {user.friendlyName}</h2>
			<p class="mono">{user.iAddress}</p>
			<p>Signed in via {user.chainName} — cryptographically verified, no password.</p>
		</div>
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
	.mono {
		font-family: monospace;
		font-size: 0.85rem;
		color: #666;
		word-break: break-all;
	}
	.welcome {
		border: 1px solid #e0e0e0;
		border-radius: 0.75rem;
		padding: 1.5rem;
	}
	.error {
		color: #c0392b;
	}
	details {
		margin-top: 0.5rem;
		font-size: 0.85rem;
	}
</style>
