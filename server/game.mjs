/**
 * Verus Arcade — daily word round engine + game API.
 *
 * Round lifecycle (all times UTC):
 *   1. At the first tick of a new day a fresh round is created: a random
 *      answer + salt are drawn and sha256(answer + salt) is COMMITTED on-chain
 *      in Arcade@'s contentmultimap — before anyone can play.
 *   2. Players guess during the day (max 6 guesses, server-side scoring;
 *      the answer never leaves the server).
 *   3. When the next round starts, the previous round is REVEALED on-chain
 *      (answer + salt) together with its RESULTS, so anyone can verify that
 *      sha256(answer + salt) equals the pre-committed hash.
 *
 * State is a JSON file (server/data/state.json) — the chain is the source of
 * truth for commits/reveals; the file is operational state only.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishState, sha256hex, randomSalt } from './chain.mjs';
import { loadConfig } from './config.mjs';
import { SessionStore } from './session-store.mjs';
import { ANSWERS, pickAnswer } from './words.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

// ── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastRound: 0, rounds: {}, plays: {} };
  }
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const state = loadState();

const todayUTC = () => new Date().toISOString().slice(0, 10);

// ── Sessions (issued by the login flow in auth.mjs) ──────────────────────────
// Raw bearer tokens are never persisted. Durable hashed sessions move to SQLite in
// the next foundation slice; until then a restart intentionally logs everyone out.
const runtime = loadConfig();
const sessions = new SessionStore({ ttlSeconds: runtime.sessionTtlSeconds });

export function registerSession(token, user) {
  sessions.register(token, user);
}

export function resolveSession(token) {
  return sessions.resolve(token);
}

// Dev convenience: ARCADE_DEV_TOKEN=xyz node server/auth.mjs registers a fixed
// session for API testing without a wallet. Never set this in production.
if (process.env.ARCADE_DEV_TOKEN) {
  if (runtime.environment === 'production') {
    throw new Error('ARCADE_DEV_TOKEN is forbidden in production');
  }
  sessions.register(process.env.ARCADE_DEV_TOKEN, {
    iAddress: 'iDevTester1111111111111111111111111',
    friendlyName: 'dev.tester@',
    chain: runtime.network,
  });
  console.log('[game] dev session registered (ARCADE_DEV_TOKEN)');
}

function auth(req, res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const user = sessions.resolve(token)?.user;
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// ── Round rotation ───────────────────────────────────────────────────────────

function currentRound() {
  return state.rounds[state.lastRound];
}

function buildResults(round) {
  const plays = state.plays[round.round] ?? {};
  const entries = Object.entries(plays);
  const solvers = entries
    .filter(([, p]) => p.solved)
    .sort((a, b) => a[1].guesses.length - b[1].guesses.length || a[1].finishedAt - b[1].finishedAt)
    .slice(0, 10)
    .map(([iAddress, p]) => ({ id: p.friendlyName ?? iAddress, guesses: p.guesses.length }));
  return {
    round: round.round,
    date: round.date,
    players: entries.length,
    solved: entries.filter(([, p]) => p.solved).length,
    top: solvers,
    playsSha256: sha256hex(JSON.stringify(plays)),
  };
}

/** Create today's round if needed; reveal + publish results of the previous one. */
async function ensureRound() {
  const today = todayUTC();
  const cur = currentRound();
  if (cur && cur.date === today) return;

  const prev = cur;
  const roundNo = state.lastRound + 1;
  const word = pickAnswer();
  const salt = randomSalt();
  const commit = { round: roundNo, date: today, sha256: sha256hex(word + salt) };

  const newRound = {
    round: roundNo,
    date: today,
    word,
    salt,
    commit,
    commitTxid: null,
    revealTxid: null,
  };

  // One updateidentity per day: commit of the NEW round + reveal/results of the
  // PREVIOUS one (updateidentity replaces current multimap state, so we always
  // send the full picture).
  const reveal = prev ? { round: prev.round, date: prev.date, word: prev.word, salt: prev.salt } : undefined;
  const results = prev ? buildResults(prev) : undefined;

  try {
    const txid = await publishState({ commit, reveal, results });
    newRound.commitTxid = txid;
    if (prev) prev.revealTxid = txid;
    console.log(`[game] round ${roundNo} committed on-chain: ${txid}`);
  } catch (err) {
    // Chain publication failing must not block play; we retry on the next tick.
    console.error('[game] on-chain publish failed (will retry):', err.message);
    newRound.commitTxid = null;
  }

  state.lastRound = roundNo;
  state.rounds[roundNo] = newRound;
  saveState();
}

/** Retry pending commit if the daemon was unreachable earlier. */
async function retryPendingCommit() {
  const cur = currentRound();
  if (cur && !cur.commitTxid) {
    try {
      const txid = await publishState({ commit: cur.commit });
      cur.commitTxid = txid;
      saveState();
      console.log(`[game] round ${cur.round} commit retried: ${txid}`);
    } catch {
      /* next tick */
    }
  }
}

await ensureRound();
setInterval(() => ensureRound().then(retryPendingCommit).catch((e) => console.error('[game] tick error:', e.message)), 60_000);

// ── Guess evaluation (classic Wordle rules) ──────────────────────────────────

/** Returns an array of 'g' (correct), 'y' (elsewhere), 'x' (absent). */
export function evaluate(guess, answer) {
  const result = new Array(WORD_LENGTH).fill('x');
  const remaining = {};
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === answer[i]) {
      result[i] = 'g';
    } else {
      remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1;
    }
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === 'g') continue;
    if (remaining[guess[i]] > 0) {
      result[i] = 'y';
      remaining[guess[i]]--;
    }
  }
  return result;
}

// ── API routes ───────────────────────────────────────────────────────────────

export const gameRouter = express.Router();
gameRouter.use(express.json({ limit: '2kb' }));

function playFor(roundNo, iAddress) {
  state.plays[roundNo] ??= {};
  return state.plays[roundNo][iAddress];
}

/** Public round info + (when logged in) your own progress. */
gameRouter.get('/state', (req, res) => {
  const cur = currentRound();
  if (!cur) return res.status(503).json({ error: 'No active round yet' });

  const base = {
    round: cur.round,
    date: cur.date,
    wordLength: WORD_LENGTH,
    maxGuesses: MAX_GUESSES,
    commitSha256: cur.commit.sha256,
    commitTxid: cur.commitTxid,
    rankedAvailable: Boolean(cur.commitTxid),
  };

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const user = sessions.resolve(token)?.user;
  if (user) {
    const play = playFor(cur.round, user.iAddress);
    base.you = {
      friendlyName: user.friendlyName,
      iAddress: user.iAddress,
      guesses: play?.guesses ?? [],
      solved: play?.solved ?? false,
    };
  }
  res.json(base);
});

gameRouter.post('/guess', auth, (req, res) => {
  const cur = currentRound();
  if (!cur) return res.status(503).json({ error: 'No active round' });
  if (!cur.commitTxid) {
    return res.status(503).json({
      error: 'Daily Seed is unavailable until its commitment is confirmed',
      code: 'COMMITMENT_NOT_CONFIRMED',
    });
  }

  const guess = String(req.body?.guess ?? '').toLowerCase();
  if (!/^[a-z]{5}$/.test(guess)) {
    return res.status(400).json({ error: 'Guess must be 5 letters (a-z)' });
  }

  state.plays[cur.round] ??= {};
  const plays = state.plays[cur.round];
  plays[req.user.iAddress] ??= {
    friendlyName: req.user.friendlyName,
    guesses: [],
    solved: false,
    finishedAt: null,
  };
  const play = plays[req.user.iAddress];

  if (play.solved) return res.status(409).json({ error: 'Already solved today' });
  if (play.guesses.length >= MAX_GUESSES) {
    return res.status(409).json({ error: 'Out of guesses for today' });
  }

  const pattern = evaluate(guess, cur.word);
  const solved = pattern.every((p) => p === 'g');
  play.guesses.push({ guess, pattern, at: Date.now() });
  if (solved) {
    play.solved = true;
    play.finishedAt = Date.now();
  }
  saveState();

  res.json({
    pattern,
    solved,
    guessesUsed: play.guesses.length,
    guessesLeft: MAX_GUESSES - play.guesses.length,
    // Only disclose the answer once the player is done (solved or out of guesses)
    ...(solved || play.guesses.length >= MAX_GUESSES ? { answer: cur.word } : {}),
  });
});

/** Today's leaderboard (live). */
gameRouter.get('/leaderboard', (req, res) => {
  const cur = currentRound();
  if (!cur) return res.json({ round: null, entries: [] });
  const plays = state.plays[cur.round] ?? {};
  const entries = Object.values(plays)
    .filter((p) => p.solved)
    .sort((a, b) => a.guesses.length - b.guesses.length || a.finishedAt - b.finishedAt)
    .map((p, i) => ({ rank: i + 1, name: p.friendlyName, guesses: p.guesses.length }));
  res.json({ round: cur.round, date: cur.date, entries });
});

/** Verification info for a finished round (public provable-fairness endpoint). */
gameRouter.get('/verify/:round', (req, res) => {
  const round = state.rounds[req.params.round];
  if (!round) return res.status(404).json({ error: 'Unknown round' });
  const finished = round.round < state.lastRound;
  res.json({
    round: round.round,
    date: round.date,
    commitSha256: round.commit.sha256,
    commitTxid: round.commitTxid,
    ...(finished
      ? {
          word: round.word,
          salt: round.salt,
          revealTxid: round.revealTxid,
          check: `sha256(word + salt) === commitSha256 → ${sha256hex(round.word + round.salt) === round.commit.sha256}`,
        }
      : { note: 'Round still active — word and salt are revealed after the round ends.' }),
  });
});
