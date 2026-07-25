<script lang="ts">
	import { applyGuess, MAX_GUESSES, WORD_LENGTH } from '../../shared/word-grid.mjs';

	type Mark = 'g' | 'y' | 'x';
	type Guess = { word: string; pattern: Mark[] };

	const PRACTICE_WORDS = [
		'apple', 'beach', 'brain', 'chain', 'charm', 'cloud', 'crane', 'dream',
		'flame', 'grape', 'green', 'heart', 'house', 'light', 'magic', 'ocean',
		'pearl', 'piano', 'plant', 'proof', 'quest', 'river', 'slate', 'solar',
		'space', 'stone', 'storm', 'sugar', 'tiger', 'train', 'trust', 'water',
		'whale', 'world', 'youth', 'zebra'
	];
	const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

	let answer = $state('');
	let guesses = $state<Guess[]>([]);
	let current = $state('');
	let message = $state('');
	let terminal = $state(false);
	let solved = $state(false);
	let gamesPlayed = $state(0);

	function randomIndex(length: number): number {
		const ceiling = Math.floor(0x1_0000_0000 / length) * length;
		const values = new Uint32Array(1);
		do crypto.getRandomValues(values); while (values[0] >= ceiling);
		return values[0] % length;
	}

	function newGame() {
		answer = PRACTICE_WORDS[randomIndex(PRACTICE_WORDS.length)];
		guesses = [];
		current = '';
		message = '';
		terminal = false;
		solved = false;
	}

	newGame();

	const keyStatus = $derived.by(() => {
		const status: Record<string, Mark> = {};
		const rank = { x: 1, y: 2, g: 3 };
		for (const guess of guesses) {
			guess.word.split('').forEach((letter, index) => {
				const next = guess.pattern[index];
				if (!status[letter] || rank[next] > rank[status[letter]]) status[letter] = next;
			});
		}
		return status;
	});

	function submit() {
		if (terminal) return;
		if (current.length !== WORD_LENGTH) {
			message = 'Enter five letters.';
			return;
		}
		const result = applyGuess({
			guess: current,
			answer,
			sequence: guesses.length + 1
		});
		guesses = [...guesses, { word: result.word, pattern: result.pattern as Mark[] }];
		current = '';
		solved = result.solved;
		terminal = result.terminal;
		message = result.solved
			? `Solved in ${result.guessesUsed} ${result.guessesUsed === 1 ? 'guess' : 'guesses'}!`
			: result.terminal
				? `The word was ${answer.toUpperCase()}.`
				: '';
		if (terminal) gamesPlayed++;
	}

	function input(key: string) {
		if (terminal) return;
		message = '';
		if (key === 'enter') submit();
		else if (key === 'backspace') current = current.slice(0, -1);
		else if (/^[a-z]$/.test(key) && current.length < WORD_LENGTH) current += key;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const key = event.key.toLowerCase();
		if (key === 'enter' || key === 'backspace' || /^[a-z]$/.test(key)) {
			event.preventDefault();
			input(key);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<section class="practice" aria-label="Word Grid Practice">
	<header>
		<div>
			<p class="mode">Practice · Word Grid v1.0.0</p>
			<h2>Find the five-letter word</h2>
		</div>
		<span class="badge">Unranked</span>
	</header>

	<p class="rules">
		Green is correct, amber is misplaced. Practice is unlimited and never stored on-chain.
	</p>

	<div class="board" aria-label="Guess board">
		{#each Array(MAX_GUESSES) as _, row}
			<div class="guess-row">
				{#each Array(WORD_LENGTH) as _, column}
					{@const accepted = guesses[row]}
					{@const active = row === guesses.length && !terminal}
					{@const letter = accepted?.word[column] ?? (active ? current[column] : '') ?? ''}
					<div
						class="tile"
						class:filled={Boolean(letter)}
						class:correct={accepted?.pattern[column] === 'g'}
						class:present={accepted?.pattern[column] === 'y'}
						class:absent={accepted?.pattern[column] === 'x'}
						aria-label={letter ? `${letter}, ${accepted?.pattern[column] ?? 'entered'}` : 'empty'}
					>
						{letter}
					</div>
				{/each}
			</div>
		{/each}
	</div>

	<p class="message" class:success={solved} aria-live="polite">{message || ' '}</p>

	{#if terminal}
		<button class="new-game" onclick={newGame}>Play another</button>
	{:else}
		<div class="keyboard" aria-label="On-screen keyboard">
			{#each KEY_ROWS as row, index}
				<div class="key-row">
					{#if index === 2}
						<button class="key action" onclick={() => input('enter')}>Enter</button>
					{/if}
					{#each row as letter}
						<button
							class="key"
							class:correct={keyStatus[letter] === 'g'}
							class:present={keyStatus[letter] === 'y'}
							class:absent={keyStatus[letter] === 'x'}
							onclick={() => input(letter)}
						>{letter}</button>
					{/each}
					{#if index === 2}
						<button class="key action" aria-label="Backspace" onclick={() => input('backspace')}>⌫</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<footer>
		<span>{gamesPlayed} completed this session</span>
		<span>Fresh random puzzle each game</span>
	</footer>
</section>

<style>
	.practice { --ink:#17231b; --line:#cbd8ce; --paper:#fbfdf9; --green:#33794a; --amber:#b47b18; --slate:#59635c; width:min(100%, 38rem); }
	header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
	h2 { margin:.15rem 0 0; font-size:clamp(1.45rem, 5vw, 2rem); color:var(--ink); }
	.mode { margin:0; color:#4d7258; font-size:.76rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
	.badge { border:1px solid #a7b9aa; border-radius:999px; padding:.35rem .65rem; color:#46634d; font-size:.75rem; font-weight:700; white-space:nowrap; }
	.rules { color:#5c6a60; font-size:.9rem; line-height:1.5; margin:.75rem 0 1.25rem; }
	.board { display:grid; gap:.36rem; justify-content:center; }
	.guess-row { display:flex; gap:.36rem; }
	.tile { width:clamp(2.7rem, 12vw, 3.65rem); aspect-ratio:1; display:grid; place-items:center; border:2px solid var(--line); border-radius:.35rem; background:var(--paper); color:var(--ink); font-size:clamp(1.35rem, 6vw, 1.9rem); font-weight:850; text-transform:uppercase; transition:transform .12s, background .2s; }
	.tile.filled { border-color:#839489; transform:scale(1.025); }
	.correct { background:var(--green)!important; border-color:var(--green)!important; color:white!important; }
	.present { background:var(--amber)!important; border-color:var(--amber)!important; color:white!important; }
	.absent { background:var(--slate)!important; border-color:var(--slate)!important; color:white!important; }
	.message { min-height:1.4rem; margin:.75rem 0; text-align:center; color:#8b3a2e; font-weight:700; }
	.message.success { color:var(--green); }
	.keyboard { display:grid; gap:.4rem; user-select:none; }
	.key-row { display:flex; justify-content:center; gap:.28rem; }
	.key { min-width:0; width:2.25rem; height:3.25rem; padding:0; border:0; border-radius:.4rem; background:#dbe2dc; color:#1d2920; font-size:.85rem; font-weight:800; text-transform:uppercase; cursor:pointer; touch-action:manipulation; }
	.key:hover { filter:brightness(.96); }
	.key.action { width:3.8rem; font-size:.65rem; }
	.new-game { display:block; margin:.5rem auto 0; border:0; border-radius:.65rem; padding:.8rem 1.25rem; background:#163e25; color:white; font-weight:800; cursor:pointer; }
	footer { display:flex; justify-content:space-between; gap:1rem; margin-top:1.1rem; padding-top:.8rem; border-top:1px solid #dce5de; color:#718077; font-size:.72rem; }
	@media (max-width:430px) {
		.practice { width:100%; }
		.key { width:calc((100vw - 3.6rem) / 10); height:3rem; font-size:.7rem; }
		.key.action { width:2.9rem; font-size:.55rem; }
		footer { flex-direction:column; gap:.25rem; text-align:center; }
	}
</style>
