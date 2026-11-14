<script lang="ts">
	// Fase 4: de profielcontrole zelf staat in $lib/verifier (ook gebruikt door de losse verifier).
	import { page } from '$app/state';
	import ProfileCheck from '$lib/verifier/ProfileCheck.svelte';
	import { appLinks } from '$lib/verifier/links';

	const playerId = $derived(page.params.id ?? '');
</script>

{#key playerId}
	<ProfileCheck {playerId} links={appLinks} />
{/key}
