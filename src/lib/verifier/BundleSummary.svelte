<script lang="ts">
	/**
	 * Fase 5: het oordeel over één verzegelde actie-bundel (shared/independent-bundle.mjs),
	 * als rijen in een lijst. Gebruikt door het onafhankelijke profiel en de naspeelpagina.
	 */
	import type { verifyPlayerBundleIndependently } from '../../../shared/independent-bundle.mjs';

	type BundleCheck = Awaited<ReturnType<typeof verifyPlayerBundleIndependently>>;
	let { check }: { check: BundleCheck } = $props();

	const HEADLINES: Record<string, { tone: string; text: string }> = {
		verified: { tone: 'ok', text: '✓ sealed on chain before the reveal' },
		late: { tone: 'wait', text: 'on chain, but only after the reveal: it proves no timing' },
		invalid: { tone: 'bad', text: '✗ does not check out' },
		unreadable: { tone: 'wait', text: 'something is stored under this round’s bundle key, but the round key does not open it' },
		pending: { tone: 'wait', text: 'sealed; readable once the round is revealed' },
		unavailable: { tone: 'neutral', text: 'could not be read from the chain' },
		'not-found': { tone: 'neutral', text: 'this player did not seal their moves' }
	};
	const headline = $derived(HEADLINES[check.verdict] ?? { tone: 'neutral', text: check.verdict });
	const blocksBefore = $derived(check.height !== null && check.revealHeight !== null ? check.revealHeight - check.height : null);
	const number = (n: number | null) => (n === null ? '?' : n.toLocaleString('en'));
</script>

<dt>Sealed moves</dt>
<dd>
	<span class="chip {headline.tone}">{headline.text}</span>
	{#if check.problems.length > 0}<br /><span class="problem">{check.problems.join('; ')}</span>{/if}
</dd>
{#if check.txid}
	<dt>Stored in identity</dt>
	<dd>
		<code>{check.txid}</code> (block {number(check.height)})
		{#if check.revealHeight !== null && blocksBefore !== null}
			<br />reveal at block {number(check.revealHeight)}{#if blocksBefore > 0}: the moves were on chain {blocksBefore} {blocksBefore === 1 ? 'block' : 'blocks'} earlier{/if}
		{/if}
		{#if check.sealed === false}<br />stored with its viewing key, so it was publicly readable{:else if check.sealed}<br />no viewing key in the identity: unreadable until the reveal{/if}
		{#if check.duplicates > 0}<br />approved {check.duplicates + 1} times; the oldest copy counts{/if}
	</dd>
{/if}
{#if check.actions}
	<dt>Moves in the bundle</dt>
	<dd>{#each check.actions as action, i}<code>{action}</code>{i < check.actions.length - 1 ? ' → ' : ''}{/each}</dd>
{/if}
{#if check.receipt}
	<dt>Receipt</dt>
	<dd>
		{check.receipt === 'valid'
			? '✓ Arcade@ signed for exactly these moves'
			: check.receipt === 'invalid'
				? '✗ no valid signature of Arcade@ for these moves'
				: 'the signature could not be checked'}
	</dd>
{/if}
{#if check.replay}
	<dt>Bundle replay</dt>
	<dd>{check.replay.status} in {check.replay.actionsUsed} {check.replay.actionsUsed === 1 ? 'move' : 'moves'} (game rules, revealed puzzle)</dd>
{/if}
{#if check.matchesResult}
	<dt>Official result</dt>
	<dd>
		{check.matchesResult === 'ok'
			? '✓ same moves and outcome as the official result'
			: check.matchesResult === 'mismatch'
				? '✗ differs from the official result'
				: check.matchesResult === 'absent'
					? '✗ the player is not in the official result'
					: 'not compared here (no proven result to compare with)'}
	</dd>
{/if}

<style>
	dt { color: #5c6d61; }
	dd { margin: 0; }
	code { overflow-wrap: anywhere; font-size: 0.75rem; }
	.chip { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-weight: 700; }
	.ok { background: #dff4e3; color: #155c2b; }
	.wait { background: #fff4d6; color: #6b4a00; }
	.neutral { background: #eef1ef; color: #34423a; }
	.bad { background: #ffe1df; color: #8d2019; }
	.problem { color: #8d2019; }
</style>
