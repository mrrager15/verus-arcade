/** Wat het platform aan het speelbord van een game geeft (gamecontract v1, UI-kant). */
export type BoardAction = { sequence: number; value: string; feedback: any };

export type BoardProps = {
	/** Het openbare deel van de puzzel (publicPuzzle van de regels). */
	puzzle: any;
	/** Geaccepteerde zetten met de feedback van de server. */
	actions: BoardAction[];
	terminal: boolean;
	solved: boolean;
	/** Na afloop: revealOnEnd van de regels (bv. een voorbeeldoplossing). */
	reveal: any | null;
	maxActions: number;
	/** True terwijl een zet onderweg is; het bord neemt dan geen invoer. */
	busy: boolean;
	/** Stuur een zet in (de server normaliseert en controleert hem). */
	onsubmit: (value: string) => void;
};
