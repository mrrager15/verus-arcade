const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3001/api'
  : 'https://api.verusarcade.com/api';

export async function getChainHealth() {
  const res = await fetch(`${API}/health`);
  return res.json();
}

export async function getIdentity(name) {
  const res = await fetch(`${API}/identity/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function getLoginChallenge() {
  const res = await fetch(`${API}/login/challenge`);
  return res.json();
}

export async function verifyLogin(identity, message, signature) {
  const res = await fetch(`${API}/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, message, signature }),
  });
  return res.json();
}

export async function saveGame(identity, game, actionLog, chainHead, score) {
  const res = await fetch(`${API}/game/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, game, actionLog, chainHead, score }),
  });
  return res.json();
}

export async function loadGame(identity, game) {
  const res = await fetch(`${API}/game/load/${encodeURIComponent(identity)}/${game}`);
  return res.json();
}

export async function getProfile(identity) {
  const res = await fetch(`${API}/profile/${encodeURIComponent(identity)}`);
  return res.json();
}

export async function checkGamertag(name) {
  const res = await fetch(`${API}/register/check/${encodeURIComponent(name)}`);
  return res.json();
}

export async function registerPlayer(gamertag, pin, raddress) {
  const body = { gamertag };
  if (pin) body.pin = pin;
  if (raddress) body.raddress = raddress;
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function custodialLogin(gamertag, pin) {
  const res = await fetch(`${API}/login/custodial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamertag, pin }),
  });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error || 'Login failed' };
  return data;
}

// Tier 2: request a challenge to sign with wallet
export async function tier2LoginChallenge(gamertag) {
  const res = await fetch(`${API}/login/tier2/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamertag }),
  });
  const data = await res.json();
  if (!res.ok) return { error: data.error || 'Failed to get challenge' };
  return data;
}

// Tier 2: verify signature
export async function tier2LoginVerify(gamertag, signature) {
  const res = await fetch(`${API}/login/tier2/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamertag, signature }),
  });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error || 'Verification failed' };
  return data;
}

export async function getRegistrationStatus(name) {
  const res = await fetch(`${API}/register/status/${encodeURIComponent(name)}`);
  return res.json();
}

export async function getLeaderboard(game, period = 'allTime') {
  const res = await fetch(`${API}/leaderboard/${game}?period=${period}`);
  return res.json();
}

export async function getAchievementDefs(game) {
  const res = await fetch(`${API}/achievements/${game}`);
  return res.json();
}

export async function getPlayerAchievements(game, identity) {
  const res = await fetch(`${API}/achievements/${game}/${encodeURIComponent(identity)}`);
  return res.json();
}
