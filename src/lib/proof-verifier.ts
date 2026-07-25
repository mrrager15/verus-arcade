export type HiddenDefinition = {
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

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('Non-finite number');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(',')}}`;
	}
	throw new Error('Unsupported JSON value');
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function verifyRoundReveal(
	commitment: Commitment,
	reveal: Reveal
): Promise<{ valid: boolean; recomputedSha256: string }> {
	const definition = reveal.hiddenDefinition;
	const recomputedSha256 = await sha256Hex(canonicalJson(definition));
	const requiredKeys = [
		'schemaVersion',
		'roundId',
		'chainId',
		'gameId',
		'gameVersion',
		'date',
		'opensAt',
		'closesAt',
		'puzzleSeed',
		'answer',
		'salt'
	];
	const schemaValid =
		definition?.schemaVersion === 1 &&
		Object.keys(definition).length === requiredKeys.length &&
		requiredKeys.every((key) => key in definition) &&
		/^\d{4}-\d{2}-\d{2}$/.test(definition.date) &&
		/^[0-9a-f]{64}$/.test(definition.puzzleSeed) &&
		/^[a-z]{5}$/.test(definition.answer) &&
		/^[0-9a-f]{64}$/.test(definition.salt) &&
		Number.isFinite(Date.parse(definition.opensAt)) &&
		Date.parse(definition.closesAt) > Date.parse(definition.opensAt);
	const valid =
		schemaValid &&
		reveal.schemaVersion === 1 &&
		/^[0-9a-f]{64}$/.test(reveal.commitmentTxid) &&
		commitment.roundId === definition.roundId &&
		commitment.chainId === definition.chainId &&
		commitment.gameId === definition.gameId &&
		commitment.gameVersion === definition.gameVersion &&
		commitment.date === definition.date &&
		commitment.opensAt === definition.opensAt &&
		commitment.closesAt === definition.closesAt &&
		recomputedSha256 === commitment.hiddenDefinitionSha256;
	return { valid, recomputedSha256 };
}
