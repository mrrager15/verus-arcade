/**
 * Speelborden per game (fase 8). Word Grid gebruikt nog zijn eigen scherm
 * (DailyGame.svelte); elke nieuwe game levert alleen een Board-component.
 */
import type { Component } from 'svelte';
import NumberTargetBoard from './number-target/Board.svelte';
import type { BoardProps } from './types';

export const BOARDS: Record<string, Component<BoardProps>> = {
	'number-target': NumberTargetBoard
};
