<script lang="ts">
	// Fase 4: de controle zelf staat in $lib/verifier (ook gebruikt door de losse verifier).
	// De deellink staat na het #-teken (komt dus niet in serverlogs terecht).
	import { onMount } from 'svelte';
	import AttestationCheck from '$lib/verifier/AttestationCheck.svelte';
	import { appLinks } from '$lib/verifier/links';

	let link = $state<string | null>(null);
	onMount(() => {
		link = location.hash.slice(1);
	});
</script>

{#if link !== null}
	<AttestationCheck {link} links={appLinks} />
{/if}
