<script lang="ts">
	// Fase 5: een hele ronde naspelen; de controle zelf staat in $lib/verifier.
	import { page } from '$app/state';
	import RoundReplay from '$lib/verifier/RoundReplay.svelte';
	import { appLinks } from '$lib/verifier/links';

	const roundId = $derived(page.params.round ?? '');
</script>

{#key roundId}
	<RoundReplay {roundId} links={appLinks} />
{/key}
