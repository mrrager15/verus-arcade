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

export async function registerPlayer(gamertag) {
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamertag }),
  });
  return res.json();
}

export async function custodialLogin(gamertag) {
  const res = await fetch(`${API}/login/custodial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamertag }),
  });
  return res.json();
}

export async function getRegistrationStatus(name) {
  const res = await fetch(`${API}/register/status/${encodeURIComponent(name)}`);
  return res.json();
}
