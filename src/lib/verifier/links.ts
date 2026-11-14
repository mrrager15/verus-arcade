/**
 * Fase 4: waar de verifier-componenten naartoe linken. In de app gewone routes;
 * in de losse verifier (zonder server) hash-routes, en geen links naar pagina's
 * van de Arcade-server.
 */
export type VerifierLinks = {
	home: string;
	round: (roundId: string) => string;
	profile: (playerId: string) => string;
	/** Pagina van de Arcade-server zelf, of null in de losse verifier. */
	arcadeRound: ((roundId: string) => string) | null;
	arcadeProfile: ((playerId: string) => string) | null;
};

const enc = encodeURIComponent;

export const appLinks: VerifierLinks = {
	home: '/',
	round: (id) => `/verify/${enc(id)}/independent`,
	profile: (id) => `/profile/${enc(id)}/independent`,
	arcadeRound: (id) => `/verify/${enc(id)}`,
	arcadeProfile: (id) => `/profile/${enc(id)}`
};

export const standaloneLinks: VerifierLinks = {
	home: '#/',
	round: (id) => `#/round/${enc(id)}`,
	profile: (id) => `#/profile/${enc(id)}`,
	arcadeRound: null,
	arcadeProfile: null
};
