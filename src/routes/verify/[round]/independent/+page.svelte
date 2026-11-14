<script lang="ts">
	// Fase 4: de rondecontrole zelf staat in $lib/verifier (ook gebruikt door de losse verifier).
	import { page } from '$app/state';
	import RoundCheck from '$lib/verifier/RoundCheck.svelte';
	import { appLinks } from '$lib/verifier/links';

	const roundId = $derived(page.params.round ?? '');
</script>

{#key roundId}
	<RoundCheck {roundId} links={appLinks} />
{/key}
