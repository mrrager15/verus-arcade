// Fase 4: opstart van de losse verifier (zie src/lib/verifier/StandaloneApp.svelte).
import { mount } from 'svelte';
import StandaloneApp from '../src/lib/verifier/StandaloneApp.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app');
mount(StandaloneApp, { target });
