import { sha256Hex as sha256HexBytes } from './browser-safe';
import { verifyRoundReveal as verifyShared } from '../../shared/round-proof.mjs';

/** Schema 2 (fase 8): elke game; de puzzel controleert de game zelf. */
export type HiddenDefinitionV2 = {
	schemaVersion: 2;
	roundId: string;
	chainId: string;
	gameId: string;
	gameVersion: string;
	date: string;
	opensAt: string;
	closesAt: string;
	puzzle: Record<string, unknown>;
	salt: string;
};

export type HiddenDefinitionV1 = {
	schemaVersion: 1;
	roundId: string;
	chainId: string;
	gameId: string;
	gameVersion: string;
	date: string;
	opensAt: string;
	closesAt: string;
	puzzleSeed: string;
	answer: string;
	salt: string;
};

export type HiddenDefinition = HiddenDefinitionV1 | HiddenDefinitionV2;

export type Commitment = {
	schemaVersion: 1;
	roundId: string;
	chainId: string;
	gameId: string;
	gameVersion: string;
	date: string;
	opensAt: string;
	closesAt: string;
	hiddenDefinitionSha256: string;
};

export type Reveal = {
	schemaVersion: 1;
	hiddenDefinition: HiddenDefinition;
	commitmentTxid: string;
};

/**
 * sha256 van een UTF-8-tekst als hex. crypto.subtle ontbreekt op http://<LAN-IP>;
 * browser-safe valt dan terug op pure JS.
 */
export async function sha256Text(value: string): Promise<string> {
	return sha256HexBytes(new TextEncoder().encode(value));
}

/**
 * Klopt de reveal met de commitment? De logica staat sinds fase 4 in
 * shared/round-proof.mjs (dezelfde als op de server en in de losse verifier).
 */
export async function verifyRoundReveal(
	commitment: Commitment,
	reveal: Reveal
): Promise<{ valid: boolean; recomputedSha256: string }> {
	const result = await verifyShared({ commitment, reveal }, sha256Text);
	return { valid: result.valid, recomputedSha256: result.recomputedSha256 ?? '' };
}
