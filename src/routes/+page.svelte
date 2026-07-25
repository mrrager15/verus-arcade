<script lang="ts">
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';
	import DailyGame from '$lib/DailyGame.svelte';
	import PracticeGame from '$lib/PracticeGame.svelte';

	type LoginStatus = 'restoring' | 'idle' | 'waiting' | 'verified' | 'error';
	type User = { friendlyName: string; iAddress: string; chain: string };

	const TOKEN_KEY = 'arcade-session-token';
	let status: LoginStatus = $state('restoring');
	let sessionToken = $state('');
	let user = $state<User | null>(null);
	let qrDataUrl = $state('');
	let deepLink = $state('');
	let error = $state('');
	let activeMode = $state<'practice' | 'daily'>('practice');

	onMount(async () => {
		const stored = localStorage.getItem(TOKEN_KEY);
		if (!stored) {
			status = 'idle';
			return;
		}
		try {
			const response = await fetch('/api/v1/me', {
				headers: { authorization: `Bearer ${stored}` }
			});
			if (response.ok) {
				const body = await response.json();
				sessionToken = stored;
				user = body.principal;
				status = 'verified';
				return;
			}
		} catch {
			// A failed restore never blocks anonymous Practice.
		}
		localStorage.removeItem(TOKEN_KEY);
		status = 'idle';
	});

	async function login() {
		status = 'waiting';
		error = '';
		try {
			const response = await fetch('/verus/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ chain: 'vrsctest' })
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? response.statusText);
			deepLink = body.deepLinkPost;
			qrDataUrl = await QRCode.toDataURL(body.deepLinkPost, { width: 300, margin: 1 });
			void poll(body.challengeId);
		} catch (caught) {
			status = 'error';
			error = caught instanceof Error ? caught.message : String(caught);
		}
	}

	async function poll(challengeId: string) {
		while (status === 'waiting') {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const response = await fetch(`/verus/result/${challengeId}`);
			if (!response.ok) {
				status = 'error';
				error = 'The login challenge expired. Please try again.';
				return;
			}
			const body = await response.json();
			if (body.status === 'verified') {
				sessionToken = body.data?.sessionToken ?? '';
				if (!sessionToken) {
					status = 'error';
					error = 'Login completed without a session token.';
					return;
				}
				localStorage.setItem(TOKEN_KEY, sessionToken);
				const me = await fetch('/api/v1/me', {
					headers: { authorization: `Bearer ${sessionToken}` }
				});
				const profile = await me.json();
				user = profile.principal;
				status = 'verified';
			}
		}
	}

	function cancelLogin() {
		status = 'idle';
		qrDataUrl = '';
		deepLink = '';
		error = '';
	}

	function logout() {
		localStorage.removeItem(TOKEN_KEY);
		sessionToken = '';
		user = null;
		status = 'idle';
	}
</script>

<svelte:head>
	<title>Verus Arcade</title>
	<meta
		name="description"
		content="Simple games demonstrating VerusID, VDXF, storage and independently verifiable proofs."
	/>
</svelte:head>

<main>
	<nav>
		<a class="brand" href="/">VERUS <span>ARCADE</span></a>
		<span class="network">VRSCTEST</span>
	</nav>

	<header class="hero">
		<div>
			<p class="eyebrow">Play · prove · verify</p>
			<h1>Small games.<br /><em>Verifiable results.</em></h1>
			<p class="intro">
				An arcade built to demonstrate VerusID, VDXF and on-chain commitments—starting with
				one carefully tested word game.
			</p>
		</div>
		<div class="capabilities" aria-label="Verus capabilities">
			<span>VerusID login</span><span>Daily commitments</span>
			<span>Result proofs</span><span>Public verification</span>
		</div>
	</header>

	<section class="modes">
		<button
			class="mode-card"
			class:active={activeMode === 'practice'}
			onclick={() => (activeMode = 'practice')}
		>
			<p class="number">01</p>
			<h2>Practice</h2>
			<p>Unlimited local games. No login, ranking or chain write.</p>
			<span>Available now</span>
		</button>
		<button
			class="mode-card"
			class:active={activeMode === 'daily'}
			onclick={() => (activeMode = 'daily')}
		>
			<p class="number">02</p>
			<h2>Daily Seed</h2>
			<p>One server-authoritative ranked attempt per VerusID and day.</p>
			<span>{status === 'verified' ? 'Open Daily' : 'VerusID required'}</span>
		</button>
	</section>

	<section class="play-area">
		{#if activeMode === 'practice'}
			<PracticeGame />
		{:else if status === 'verified' && user}
			<DailyGame token={sessionToken} friendlyName={user.friendlyName ?? user.iAddress} />
		{:else}
			<div class="daily-gate">
				<p class="eyebrow">Daily Seed</p>
				<h2>Authenticate before reserving</h2>
				<p>
					Reading the commitment is public. Reserving the single ranked attempt requires a
					chain-bound VerusID session.
				</p>
				<p>No attempt is consumed by opening this screen or starting the login flow.</p>
			</div>
		{/if}

		<aside>
			<p class="eyebrow">Ranked access</p>
			<h2>Daily Seed uses VerusID</h2>
			<p>Practice never affects Daily eligibility. Reservation happens only after an explicit warning and confirmation.</p>

			{#if status === 'restoring'}
				<p class="muted">Restoring VRSCTEST session…</p>
			{:else if status === 'idle'}
				<button class="login" onclick={login}>Login with VerusID</button>
				<p class="muted">VRSCTEST only. Login is off-chain and free.</p>
			{:else if status === 'waiting'}
				{#if qrDataUrl}
					<img class="qr" src={qrDataUrl} alt="VerusID login QR code" />
					<a class="deeplink" href={deepLink}>Open in Verus Mobile</a>
				{:else}
					<p>Creating wallet challenge…</p>
				{/if}
				<button class="text-button" onclick={cancelLogin}>Cancel</button>
			{:else if status === 'verified' && user}
				<div class="identity">
					<span>Authenticated on {user.chain}</span>
					<strong>{user.friendlyName ?? user.iAddress}</strong>
					<code>{user.iAddress}</code>
				</div>
				<button class="login" onclick={() => (activeMode = 'daily')}>Open Daily Seed</button>
				<button class="text-button" onclick={logout}>Log out</button>
			{:else}
				<p class="error">{error}</p>
				<button class="login" onclick={login}>Try again</button>
				<button class="text-button" onclick={cancelLogin}>Cancel</button>
			{/if}
		</aside>
	</section>

	<footer>
		<p>Built on VRSCTEST first. Mainnet remains disabled during development.</p>
		<a href="https://verus.io/build" rel="noreferrer">Explore Verus development →</a>
	</footer>
</main>

<style>
	:global(*) { box-sizing:border-box; }
	:global(body) { margin:0; background:#f3f5ef; color:#17231b; }
	:global(button), :global(a) { font:inherit; }
	main { min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, sans-serif; }
	nav { display:flex; align-items:center; justify-content:space-between; max-width:76rem; margin:auto; padding:1.4rem 1.5rem; border-bottom:1px solid #ccd6cd; }
	.brand { color:#14261a; text-decoration:none; font-weight:900; letter-spacing:.08em; }
	.brand span { color:#4d7d58; }
	.network { border:1px solid #a9baa9; border-radius:999px; padding:.3rem .65rem; color:#4b6551; font-size:.7rem; font-weight:800; letter-spacing:.08em; }
	.hero { max-width:76rem; margin:auto; padding:clamp(3rem,8vw,7rem) 1.5rem 3rem; display:grid; grid-template-columns:1.5fr .7fr; gap:3rem; align-items:end; }
	.eyebrow { margin:0 0 .65rem; color:#4d7d58; font-size:.72rem; font-weight:850; letter-spacing:.12em; text-transform:uppercase; }
	h1 { margin:0; font-family:Georgia, serif; font-size:clamp(3rem,8vw,6.8rem); line-height:.88; letter-spacing:-.055em; font-weight:500; }
	h1 em { color:#347348; font-weight:500; }
	.intro { max-width:43rem; margin:1.5rem 0 0; color:#58675d; font-size:clamp(1rem,2vw,1.22rem); line-height:1.6; }
	.capabilities { display:grid; grid-template-columns:1fr 1fr; border-top:1px solid #aebbae; }
	.capabilities span { padding:.8rem 0; border-bottom:1px solid #cad4ca; color:#59685e; font-size:.78rem; }
	.modes { max-width:76rem; margin:0 auto 2rem; padding:0 1.5rem; display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
	.mode-card { border:1px solid #c7d1c7; border-radius:1rem; padding:1.25rem; background:#edf0e9; color:#17231b; text-align:left; cursor:pointer; }
	.mode-card.active { background:#193d26; color:white; border-color:#193d26; }
	.mode-card .number { float:right; margin:0; opacity:.55; font-family:monospace; }
	.mode-card h2 { margin:0 0 .4rem; font-family:Georgia,serif; font-size:1.8rem; font-weight:500; }
	.mode-card p:not(.number) { margin:.3rem 0 1rem; opacity:.72; }
	.mode-card span { font-size:.72rem; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
	.mode-card:focus-visible { outline:3px solid #77a582; outline-offset:3px; }
	.play-area { max-width:76rem; margin:auto; padding:2rem 1.5rem 5rem; display:grid; grid-template-columns:minmax(0,1fr) minmax(17rem,.55fr); gap:clamp(2rem,7vw,6rem); align-items:start; }
	aside { position:sticky; top:1rem; border-left:1px solid #becbbe; padding-left:2rem; }
	.daily-gate { align-self:start; padding:clamp(1.5rem,5vw,3rem); border:1px solid #c5d1c6; border-radius:1rem; background:#e8ede6; }
	.daily-gate h2 { margin:.2rem 0 .8rem; font-family:Georgia,serif; font-size:clamp(2rem,6vw,3.5rem); font-weight:500; }
	.daily-gate p:not(.eyebrow) { color:#5c6b60; line-height:1.6; }
	aside h2 { margin:.2rem 0 .8rem; font-family:Georgia,serif; font-size:2rem; font-weight:500; }
	aside > p:not(.eyebrow) { color:#5d6b61; line-height:1.55; }
	.login { width:100%; border:0; border-radius:.65rem; padding:.85rem 1rem; background:#173e25; color:white; font-weight:800; cursor:pointer; }
	.text-button { border:0; background:transparent; color:#3f704c; padding:.7rem 0; cursor:pointer; text-decoration:underline; }
	.muted { color:#77827a!important; font-size:.78rem; }
	.error { color:#8b2e24!important; }
	.qr { display:block; width:min(100%,18rem); margin:1rem auto; border-radius:.8rem; }
	.deeplink { display:block; color:#2e6740; text-align:center; font-weight:700; }
	.identity { display:grid; gap:.4rem; padding:1rem; background:#e4ebe3; border-radius:.7rem; }
	.identity span { color:#617067; font-size:.72rem; text-transform:uppercase; }
	.identity code { overflow-wrap:anywhere; font-size:.68rem; color:#657268; }
	footer { max-width:76rem; margin:auto; padding:1.5rem; border-top:1px solid #ccd6cd; display:flex; justify-content:space-between; gap:1rem; color:#68756c; font-size:.78rem; }
	footer a { color:#356c44; }
	@media (max-width:760px) {
		.hero { grid-template-columns:1fr; gap:2rem; }
		.modes { grid-template-columns:1fr; }
		.play-area { grid-template-columns:1fr; }
		aside { position:static; border-left:0; border-top:1px solid #becbbe; padding:2rem 0 0; }
		footer { flex-direction:column; }
	}
</style>
