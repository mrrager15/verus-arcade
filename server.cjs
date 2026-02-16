const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── VerusID Provisioning (QR flow) ──
let VerusId = null;
let primitives = null;
try {
  const verusIdPkg = require('verusid-ts-client');
  VerusId = new verusIdPkg.VerusIdInterface(
    'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', // VRSCTEST system ID
    'https://api.verustest.net'
  );
  primitives = verusIdPkg.primitives;
  console.log('[VERUSID] verusid-ts-client loaded ✓');
} catch (e) {
  console.log('[VERUSID] verusid-ts-client not installed — QR provisioning disabled');
}

const VERUS_ARCADE_IADDRESS = 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P';
const VERUS_ARCADE_WIF = process.env.VERUS_ARCADE_WIF || 'UqRUPT3tLQkwnB5dCEFdd7Cd4B4SuJ7V9Atn8JexEXBGFP4uUFHK';
const SYSTEM_ID = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'; // VRSCTEST
const PROVISIONING_BASE_URL = process.env.PROVISIONING_URL || 'https://api.verusarcade.com/api';

// In-memory storage for QR provisioning challenges
const qrChallenges = new Map(); // challenge_id → { status, gamertag, raddress, timestamp }

// ── Player Storage (persistent across restarts) ──
const PLAYERS_FILE = path.join(__dirname, 'players.json');

function loadPlayers() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[STORAGE] Error loading players.json:', e.message);
  }
  return {};
}

function savePlayers() {
  try {
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(players, null, 2));
  } catch (e) {
    console.error('[STORAGE] Error saving players.json:', e.message);
  }
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}

const players = loadPlayers(); // { gamertag: { pinHash, address, registeredAt, claimed, claimedAddress, freeSavesLeft } }

const app = express();
// Main CORS for frontend
app.use(cors({
  origin: ['https://verusarcade.com', 'https://www.verusarcade.com', 'http://localhost:5173']
}));
app.use(express.json({ limit: '5mb' }));

// Verus Mobile provisioning endpoints need open CORS (mobile app, not browser)
app.options('/api/provisionVerusId', cors());
app.options('/api/verusidloginnewaccount', cors());

// ── Verus RPC Configuration ──
const RPC = {
  host: '127.0.0.1',
  port: 18843,
  user: process.env.RPC_USER || 'fallback',
  pass: process.env.RPC_PASS || 'fallback',
};

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '1.0', id: 'arcade', method, params });
    const options = {
      hostname: RPC.host,
      port: RPC.port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(RPC.user + ':' + RPC.pass).toString('base64'),
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) reject(json.error);
          else resolve(json.result);
        } catch (e) {
          reject({ message: 'Invalid JSON response', raw: body });
        }
      });
    });
    req.on('error', (e) => reject({ message: e.message }));
    req.write(data);
    req.end();
  });
}

// ── Hex helpers ──
function toHex(str) { return Buffer.from(str, 'utf8').toString('hex'); }
function fromHex(hex) { return Buffer.from(hex, 'hex').toString('utf8'); }

// Deterministic key from game name (20-byte hash as hex)
function gameKey(game) {
  // Simple hash to create a 20-byte key (like a VDXF key address)
  let h = 0x811c9dc5;
  const input = 'vrsc::arcade.' + game;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Expand to 20 bytes by repeated hashing
  const bytes = [];
  for (let round = 0; round < 5; round++) {
    h ^= round;
    h = Math.imul(h, 0x01000193);
    const v = h >>> 0;
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }
  return bytes.slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── API Routes ──
app.get('/api/health', async (req, res) => {
  try {
    const info = await rpcCall('getinfo');
    res.json({ status: 'ok', blocks: info.blocks, chain: info.chainid });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message || e });
  }
});

app.get('/api/identity/:name', async (req, res) => {
  try {
    const id = await rpcCall('getidentity', [req.params.name]);
    res.json(id);
  } catch (e) {
    res.status(404).json({ error: 'Identity not found', details: e });
  }
});

app.get('/api/login/challenge', (req, res) => {
  const challenge = {
    message: 'Verus Arcade Login :: ' + Date.now() + ' :: ' + Math.random().toString(36).slice(2),
    timestamp: Date.now(),
  };
  res.json(challenge);
});

app.post('/api/login/verify', async (req, res) => {
  const { identity, message, signature } = req.body;
  if (!identity || !message || !signature) {
    return res.status(400).json({ error: 'Missing identity, message, or signature' });
  }
  try {
    const result = await rpcCall('verifymessage', [identity, signature, message]);
    if (result === true) {
      const idInfo = await rpcCall('getidentity', [identity]);
      res.json({
        verified: true,
        identity: idInfo.identity.name,
        identityaddress: idInfo.identity.identityaddress,
        fullyqualifiedname: idInfo.identity.fullyqualifiedname || idInfo.identity.name + '@',
      });
    } else {
      res.json({ verified: false, error: 'Signature verification failed' });
    }
  } catch (e) {
    res.status(500).json({ verified: false, error: e.message || e });
  }
});

// ── Game Save/Load via contentmultimap ──
// Key: identity's own i-address
// Value: array of hex-encoded JSON strings, one per game
// Structure per game:
// {
//   game: "lemonade",
//   stats: { gamesPlayed, highscore, totalPoints, bestGrade, lastPlayed },
//   proof: { seed, actions, chainHead }   ← only from highscore game
// }

app.post('/api/game/save', async (req, res) => {
  const { identity, game, actionLog, chainHead, score, grade, isNewHigh } = req.body;
  if (!identity || !game) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const idName = identity.replace(/@$/, '').replace(/\.vrsctest$/i, '');
    const shortName = idName.split('.')[0];

    // Check save permissions based on free saves
    const player = players[shortName];
    if (player) {
      if (player.freeSavesLeft <= 0) {
        const msg = player.tier === 2
          ? 'No free saves remaining. You own this ID — fund saves from your own wallet.'
          : 'No free saves remaining. Claim your ID to keep playing, or create a new account.';
        return res.status(403).json({
          error: msg,
          freeSavesLeft: 0,
          tier: player.tier,
          canClaim: player.tier === 3 && !player.claimed,
        });
      }
      // Decrement free saves
      player.freeSavesLeft--;
      savePlayers();
      console.log(`[SAVE] Tier ${player.tier} player ${shortName}: ${player.freeSavesLeft} free saves remaining`);

      // If Tier 2 and free saves just hit 0, remove server as co-signer
      if (player.tier === 2 && player.freeSavesLeft === 0 && player.playerAddress) {
        console.log(`[SAVE] Tier 2 player ${shortName}: free saves exhausted — removing server co-signer`);
        setTimeout(async () => {
          try {
            const updateData = {
              name: shortName,
              parent: 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P',
              primaryaddresses: [player.playerAddress],
              minimumsignatures: 1,
            };
            const txid = await rpcCall('updateidentity', [updateData]);
            console.log(`[SAVE] ✅ Server removed as co-signer for ${shortName}.Verus Arcade@ | txid: ${txid}`);
          } catch (e) {
            console.error(`[SAVE] Failed to remove server co-signer for ${shortName}:`, e);
          }
        }, 5000);
      }
    }

    console.log('[SAVE] Identity:', identity, '| Game:', game, '| Score:', score, '| NewHigh:', isNewHigh);

    // Read existing contentmultimap
    let idAddress = '';
    let existingEntries = [];
    try {
      const idInfo = await rpcCall('getidentity', [identity]);
      idAddress = idInfo.identity.identityaddress;
      const cmm = idInfo.identity.contentmultimap || {};
      if (cmm[idAddress]) {
        existingEntries = Array.isArray(cmm[idAddress]) ? cmm[idAddress] : [cmm[idAddress]];
      }
    } catch (e) {
      // Check if this is a pending registration
      const shortName = idName.split('.')[0];
      if (pendingRegistrations.has(shortName)) {
        const entry = pendingRegistrations.get(shortName);
        return res.status(503).json({
          error: 'Identity is still being created on-chain. Try saving again in a minute.',
          status: entry.status,
          pending: true,
        });
      }
      console.log('[SAVE] Could not read existing identity:', e.message || e);
      return res.status(500).json({ error: 'Could not read identity' });
    }

    // Find existing data for this game (if any)
    let existingGameData = null;
    const otherGames = [];
    for (const hexEntry of existingEntries) {
      try {
        const entry = JSON.parse(fromHex(hexEntry));
        if (entry.game === game) {
          existingGameData = entry;
        } else {
          otherGames.push(hexEntry);
        }
      } catch {
        otherGames.push(hexEntry);
      }
    }

    // Build updated stats
    const prevStats = existingGameData?.stats || { gamesPlayed: 0, highscore: 0, totalPoints: 0, bestGrade: "F" };
    const gradeRank = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
    const newStats = {
      gamesPlayed: prevStats.gamesPlayed + 1,
      highscore: Math.max(prevStats.highscore, score),
      totalPoints: prevStats.totalPoints + score,
      bestGrade: (gradeRank[grade] || 0) > (gradeRank[prevStats.bestGrade] || 0) ? grade : prevStats.bestGrade,
      lastPlayed: Math.floor(Date.now() / 1000),
    };

    // Build new game entry
    const gameData = { game, stats: newStats };

    // Only update proof if new highscore
    if (isNewHigh) {
      gameData.proof = {
        seed: idName,
        actions: actionLog || [],
        chainHead: chainHead,
      };
      console.log('[SAVE] Including proof (new highscore) | Actions:', (actionLog || []).length);
    } else if (existingGameData?.proof) {
      // Keep existing proof from previous highscore
      gameData.proof = existingGameData.proof;
      console.log('[SAVE] Keeping existing proof (not a new highscore)');
    }

    // Build new array: other games + updated game
    const newEntries = [...otherGames, toHex(JSON.stringify(gameData))];

    // For subIDs (name contains dot), use separate parent field
    const updateData = { contentmultimap: {} };
    if (idName.includes('.')) {
      const parts = idName.split('.');
      updateData.name = parts[0];
      updateData.parent = 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P';
    } else {
      updateData.name = idName;
    }
    updateData.contentmultimap[idAddress] = newEntries;

    const txid = await rpcCall('updateidentity', [updateData]);
    console.log('[SAVE] Success! txid:', txid, '| Stats:', JSON.stringify(newStats));
    const updatedPlayer = players[shortName];
    res.json({ success: true, txid, stats: newStats, freeSavesLeft: updatedPlayer ? updatedPlayer.freeSavesLeft : null });
  } catch (e) {
    console.error('[SAVE] Error:', e);
    res.status(500).json({ error: e.message || JSON.stringify(e) });
  }
});

app.get('/api/game/load/:identity/:game', async (req, res) => {
  try {
    const idInfo = await rpcCall('getidentity', [req.params.identity]);
    const idAddress = idInfo.identity.identityaddress;
    const cmm = idInfo.identity.contentmultimap || {};
    const game = req.params.game;

    console.log('[LOAD] Identity:', req.params.identity, '| Game:', game, '| Address:', idAddress);

    const entries = cmm[idAddress] ? (Array.isArray(cmm[idAddress]) ? cmm[idAddress] : [cmm[idAddress]]) : [];

    for (const hexEntry of entries) {
      try {
        const entry = JSON.parse(fromHex(hexEntry));
        if (entry.game === game) {
          console.log('[LOAD] Found! Stats:', JSON.stringify(entry.stats));
          return res.json({
            found: true,
            stats: entry.stats || {},
            proof: entry.proof || null,
            // Backwards compat
            score: entry.stats?.highscore || entry.score || 0,
          });
        }
      } catch {}
    }

    console.log('[LOAD] No data found for game:', game);
    res.json({ found: false, score: null });
  } catch (e) {
    console.error('[LOAD] Error:', e);
    res.status(500).json({ error: e.message || e });
  }
});

// ── Player Profile (all games) ──
app.get('/api/profile/:identity', async (req, res) => {
  try {
    const idInfo = await rpcCall('getidentity', [req.params.identity]);
    const id = idInfo.identity;
    const idAddress = id.identityaddress;
    const cmm = id.contentmultimap || {};

    console.log('[PROFILE] Identity:', req.params.identity, '| Address:', idAddress);

    const entries = cmm[idAddress] ? (Array.isArray(cmm[idAddress]) ? cmm[idAddress] : [cmm[idAddress]]) : [];

    const games = {};
    let totalXP = 0;
    let totalGames = 0;

    for (const hexEntry of entries) {
      try {
        const entry = JSON.parse(fromHex(hexEntry));
        if (entry.game && entry.stats) {
          games[entry.game] = {
            stats: entry.stats,
            hasProof: !!entry.proof,
            proofActions: entry.proof?.actions?.length || 0,
            proofChainHead: entry.proof?.chainHead || null,
          };
          totalXP += entry.stats.totalPoints || 0;
          totalGames += entry.stats.gamesPlayed || 0;
        }
      } catch {}
    }

    console.log('[PROFILE] Games found:', Object.keys(games).length, '| Total XP:', totalXP);

    res.json({
      identity: {
        name: id.name,
        address: idAddress,
        fullyqualifiedname: id.fullyqualifiedname || id.name + '@',
      },
      games,
      totals: { totalXP, totalGames },
    });
  } catch (e) {
    console.error('[PROFILE] Error:', e);
    res.status(500).json({ error: e.message || e });
  }
});

// ── IP Rate Limiting for Registration ──
const registeredIPs = new Map(); // IP → { gamertag, timestamp }

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// ── Name Validation ──
function validateGamertag(name) {
  if (!name || typeof name !== 'string') return 'Gamertag is required';
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length < 3) return 'Gamertag must be at least 3 characters';
  if (trimmed.length > 20) return 'Gamertag must be 20 characters or less';
  if (!/^[a-z0-9_-]+$/.test(trimmed)) return 'Only lowercase letters, numbers, hyphens and underscores allowed';
  if (/^[_-]|[_-]$/.test(trimmed)) return 'Cannot start or end with hyphen/underscore';
  return null; // valid
}

// Helper: wait for N seconds
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper: wait for tx to get 1 confirmation (no timeout — blocks can take up to 10min)
async function waitForConfirmation(txid) {
  while (true) {
    try {
      const tx = await rpcCall('getrawtransaction', [txid, 1]);
      if (tx.confirmations && tx.confirmations >= 1) return true;
    } catch {}
    await sleep(5000);
  }
}

// ── Check if gamertag is available ──
app.get('/api/register/check/:name', async (req, res) => {
  const error = validateGamertag(req.params.name);
  if (error) return res.json({ available: false, error });

  const name = req.params.name.trim().toLowerCase();
  try {
    await rpcCall('getidentity', [name + '.Verus Arcade@']);
    res.json({ available: false, error: 'Name already taken' });
  } catch {
    res.json({ available: true, name });
  }
});

// ── Pending registrations (background processing) ──
const pendingRegistrations = new Map(); // name → { status, address, commitment, error, txid }

// Background worker: completes registration after commitment confirms
async function completeRegistration(name, address, commitment, playerAddress = null) {
  const entry = pendingRegistrations.get(name);
  if (!entry) return;

  try {
    // Wait for commitment confirmation
    entry.status = 'waiting_block';
    console.log(`[REGISTER] Waiting for commitment confirmation: ${name}`);
    const confirmed = await waitForConfirmation(commitment.txid);
    console.log(`[REGISTER] Commitment confirmed: ${name}`);

    // Register the identity
    entry.status = 'registering';

    // Tier 2: dual-address (player + server), either can sign
    // Tier 3: server-only address (custodial)
    const primaryAddresses = playerAddress
      ? [playerAddress, address]  // Tier 2: player first, server second
      : [address];                // Tier 3: server only

    const idDef = {
      txid: commitment.txid,
      namereservation: commitment.namereservation,
      identity: {
        name: commitment.namereservation.name,
        primaryaddresses: primaryAddresses,
        minimumsignatures: 1,
        parent: 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P',
      },
    };

    const regTxid = await rpcCall('registeridentity', [idDef]);
    entry.status = 'confirming';
    entry.txid = regTxid;
    console.log(`[REGISTER] Identity tx sent: ${name} | txid: ${regTxid}`);

    // Wait for identity confirmation
    await waitForConfirmation(regTxid);
    entry.status = 'ready';
    console.log(`[REGISTER] ✅ Identity ready: ${name}.Verus Arcade@`);
  } catch (e) {
    entry.status = 'error';
    entry.error = e.message || JSON.stringify(e);
    console.error(`[REGISTER] Error completing: ${name}`, e);
  }
}

// ── Register new player (fast response, background processing) ──
app.post('/api/register', async (req, res) => {
  const { gamertag, pin, raddress } = req.body;
  const ip = getClientIP(req);

  // Validate name
  const nameError = validateGamertag(gamertag);
  if (nameError) return res.status(400).json({ error: nameError });

  // Validate pin (required only for Tier 3 / custodial — Tier 2 uses wallet signatures)
  const isTier2 = !!raddress;
  if (!isTier2) {
    if (!pin || pin.toString().length < 4 || pin.toString().length > 6) {
      return res.status(400).json({ error: 'Pin must be 4-6 digits' });
    }
    if (!/^\d{4,6}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'Pin must contain only digits' });
    }
  }

  // Validate R-address if provided (Tier 2)
  if (isTier2) {
    if (!/^R[a-zA-Z0-9]{33}$/.test(raddress.trim())) {
      return res.status(400).json({ error: 'Invalid R-address. Must start with R and be 34 characters.' });
    }
  }

  const name = gamertag.trim().toLowerCase();

  // Check IP rate limit
  if (registeredIPs.has(ip)) {
    const existing = registeredIPs.get(ip);
    return res.status(429).json({
      error: `This device already registered: ${existing.gamertag}.Verus Arcade@`,
      existingGamertag: existing.gamertag,
    });
  }

  // Check if already being registered
  if (pendingRegistrations.has(name)) {
    const entry = pendingRegistrations.get(name);
    return res.json({
      success: true,
      gamertag: name,
      fullname: name + '.Verus Arcade@',
      address: entry.address,
      status: entry.status,
    });
  }

  console.log(`[REGISTER] Starting registration for "${name}" from IP ${ip}`);

  try {
    // Check if name is already taken
    try {
      await rpcCall('getidentity', [name + '.Verus Arcade@']);
      return res.status(409).json({ error: 'Name already taken' });
    } catch {
      // Good - name is available
    }

    // Generate server address (used for commitment + as co-signer for Tier 2)
    const address = await rpcCall('getnewaddress');
    console.log(`[REGISTER] Generated address: ${address}${isTier2 ? ' (server co-signer)' : ''}`);

    // Register name commitment (always uses server address for funding)
    const commitment = await rpcCall('registernamecommitment', [
      name, address, '', 'Verus Arcade',
    ]);
    console.log(`[REGISTER] Name commitment txid: ${commitment.txid}`);

    // Record IP immediately
    registeredIPs.set(ip, { gamertag: name, timestamp: Date.now() });

    // Store player record
    const FREE_SAVES = 10;
    players[name] = {
      pinHash: isTier2 ? null : hashPin(pin),
      address,
      playerAddress: isTier2 ? raddress.trim() : null,
      tier: isTier2 ? 2 : 3,
      registeredAt: Date.now(),
      claimed: isTier2, // Tier 2 = already "claimed" (player owns from start)
      claimedAddress: isTier2 ? raddress.trim() : null,
      freeSavesLeft: FREE_SAVES,
    };
    savePlayers();

    if (isTier2) {
      console.log(`[REGISTER] Tier 2: ${name} | Player: ${raddress.trim()} | Free saves: ${FREE_SAVES}`);
    } else {
      console.log(`[REGISTER] Tier 3: ${name} | Custodial | Free saves: ${FREE_SAVES}`);
    }

    // Track pending registration
    pendingRegistrations.set(name, {
      status: 'committed',
      address,
      playerAddress: isTier2 ? raddress.trim() : null,
      commitment,
      error: null,
      txid: null,
    });

    // Start background processing (don't await!)
    completeRegistration(name, address, commitment, isTier2 ? raddress.trim() : null);

    // Respond immediately — player can start playing
    const fullName = name + '.Verus Arcade@';
    res.json({
      success: true,
      gamertag: name,
      fullname: fullName,
      address,
      status: 'committed',
    });

  } catch (e) {
    console.error('[REGISTER] Error:', e);
    res.status(500).json({ error: e.message || JSON.stringify(e) });
  }
});

// ── Check registration status ──
app.get('/api/register/status/:name', (req, res) => {
  const name = req.params.name.trim().toLowerCase();
  const entry = pendingRegistrations.get(name);
  if (!entry) {
    return res.json({ status: 'unknown', name });
  }
  res.json({
    name,
    status: entry.status, // committed → waiting_block → registering → confirming → ready | error
    address: entry.address,
    error: entry.error,
    ready: entry.status === 'ready',
  });
});

// ── Custodial Login (for Tier 3 subID players — pin-based) ──
app.post('/api/login/custodial', async (req, res) => {
  const { gamertag, pin } = req.body;
  if (!gamertag) return res.status(400).json({ error: 'Missing gamertag' });
  if (!pin) return res.status(400).json({ error: 'Missing pin' });

  const name = gamertag.trim().toLowerCase();
  const fullName = name + '.Verus Arcade@';

  // Verify pin
  const player = players[name];
  if (!player) {
    return res.status(404).json({ verified: false, error: 'Gamertag not found. Register first!' });
  }
  if (player.tier === 2) {
    return res.status(400).json({ verified: false, error: 'This is a self-owned ID. Use "Sign with Wallet" to log in.' });
  }
  if (player.pinHash !== hashPin(pin)) {
    return res.status(401).json({ verified: false, error: 'Incorrect pin.' });
  }

  try {
    const idInfo = await rpcCall('getidentity', [fullName]);
    const id = idInfo.identity;
    console.log(`[LOGIN] Custodial login: ${fullName} | Address: ${id.identityaddress}`);

    res.json({
      verified: true,
      identity: id.name,
      identityaddress: id.identityaddress,
      fullyqualifiedname: id.fullyqualifiedname || fullName,
      custodial: true,
      tier: 3,
      freeSavesLeft: player.freeSavesLeft,
    });
  } catch (e) {
    res.status(404).json({ verified: false, error: 'Identity not found on-chain.' });
  }
});

// ── Tier 2 Login (signature-based — for self-owned SubIDs) ──
const tier2LoginChallenges = new Map(); // gamertag → { message, timestamp }

app.post('/api/login/tier2/challenge', async (req, res) => {
  const { gamertag } = req.body;
  if (!gamertag) return res.status(400).json({ error: 'Missing gamertag' });

  const name = gamertag.trim().toLowerCase();
  const player = players[name];
  if (!player) {
    return res.status(404).json({ error: 'Gamertag not found. Register first!' });
  }
  if (player.tier !== 2) {
    return res.status(400).json({ error: 'This is a custodial account. Use gamertag + pin to log in.' });
  }

  // Generate challenge
  const message = `login:${name}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  tier2LoginChallenges.set(name, { message, timestamp: Date.now() });

  console.log(`[LOGIN] Tier 2 challenge for ${name} → ${player.playerAddress}`);
  res.json({
    message,
    raddress: player.playerAddress,
    instructions: `Sign this message with your wallet: verus -chain=vrsctest signmessage "${player.playerAddress}" "${message}"`,
  });
});

app.post('/api/login/tier2/verify', async (req, res) => {
  const { gamertag, signature } = req.body;
  if (!gamertag || !signature) {
    return res.status(400).json({ error: 'Missing gamertag or signature' });
  }

  const name = gamertag.trim().toLowerCase();
  const fullName = name + '.Verus Arcade@';
  const player = players[name];

  if (!player) return res.status(404).json({ verified: false, error: 'Gamertag not found.' });
  if (player.tier !== 2) return res.status(400).json({ verified: false, error: 'Not a Tier 2 account.' });

  const challenge = tier2LoginChallenges.get(name);
  if (!challenge) return res.status(400).json({ verified: false, error: 'No pending challenge. Request one first.' });

  // Check timeout (10 minutes)
  if (Date.now() - challenge.timestamp > 10 * 60 * 1000) {
    tier2LoginChallenges.delete(name);
    return res.status(400).json({ verified: false, error: 'Challenge expired. Request a new one.' });
  }

  try {
    const verified = await rpcCall('verifymessage', [player.playerAddress, signature.trim(), challenge.message]);
    if (!verified) {
      return res.status(401).json({ verified: false, error: 'Signature verification failed.' });
    }

    tier2LoginChallenges.delete(name);

    const idInfo = await rpcCall('getidentity', [fullName]);
    const id = idInfo.identity;
    console.log(`[LOGIN] Tier 2 signature login: ${fullName} | Address: ${id.identityaddress}`);

    res.json({
      verified: true,
      identity: id.name,
      identityaddress: id.identityaddress,
      fullyqualifiedname: id.fullyqualifiedname || fullName,
      custodial: false,
      tier: 2,
      freeSavesLeft: player.freeSavesLeft,
    });
  } catch (e) {
    res.status(500).json({ verified: false, error: e.message || 'Verification failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ── QR LOGIN (Tier 2 — Verus Mobile scans QR to prove identity) ──
// ═══════════════════════════════════════════════════════════════════

const qrLoginChallenges = new Map(); // challenge_id → { status, identity, raddress, timestamp }

// Step 1: Frontend requests a QR login deeplink
app.post('/api/login/tier2/qr', async (req, res) => {
  if (!VerusId || !primitives) {
    return res.status(503).json({ error: 'QR login not available — verusid-ts-client not installed' });
  }

  try {
    const challenge_id = generateChallengeID();

    const response = await VerusId.createLoginConsentRequest(
      VERUS_ARCADE_IADDRESS,
      new primitives.LoginConsentChallenge({
        challenge_id: challenge_id,
        requested_access: [
          new primitives.RequestedPermission(primitives.IDENTITY_VIEW.vdxfid),
        ],
        redirect_uris: [
          new primitives.RedirectUri(
            `${PROVISIONING_BASE_URL}/login/tier2/callback`,
            primitives.LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid
          ),
        ],
        subject: [],
        provisioning_info: [],
        created_at: Number((Date.now() / 1000).toFixed(0)),
      }),
      VERUS_ARCADE_WIF
    );

    const deeplink = response.toWalletDeeplinkUri();

    qrLoginChallenges.set(challenge_id, {
      status: 'pending',
      identity: null,
      raddress: null,
      gamertag: null,
      timestamp: Date.now(),
    });

    console.log(`[QR-LOGIN] Challenge created: ${challenge_id}`);
    res.json({ deeplink, challenge_id });
  } catch (e) {
    console.error('[QR-LOGIN] Error generating deeplink:', e);
    res.status(500).json({ error: e.message || 'Failed to generate login QR' });
  }
});

// Step 2: Verus Mobile posts signed login consent response here
app.post('/api/login/tier2/callback', cors(), async (req, res) => {
  console.log('[QR-LOGIN] ═══════════════════════════════════════');
  console.log('[QR-LOGIN] Received login response from Verus Mobile');
  console.log('[QR-LOGIN] Body:', JSON.stringify(req.body, null, 2));
  console.log('[QR-LOGIN] ═══════════════════════════════════════');

  try {
    const body = req.body;

    // Extract identity info from the login consent response
    const challenge_id = body.decision?.request?.challenge?.challenge_id
      || body.challenge?.challenge_id;
    const signingId = body.signing_id;
    const signingAddress = body.decision?.request?.signing_id || signingId;

    console.log(`[QR-LOGIN] challenge_id: ${challenge_id}, signing_id: ${signingId}`);

    if (!challenge_id || !qrLoginChallenges.has(challenge_id)) {
      console.log('[QR-LOGIN] Unknown or missing challenge');
      return res.status(400).json({ error: 'Unknown challenge' });
    }

    // Verify the login consent response
    let verified = false;
    try {
      const loginResponse = new primitives.LoginConsentResponse(body);
      verified = await VerusId.verifyLoginConsentResponse(loginResponse);
      console.log(`[QR-LOGIN] Signature verification: ${verified}`);
    } catch (verifyErr) {
      console.log(`[QR-LOGIN] Verification error: ${verifyErr.message}`);
      // Try to continue even if verification fails — we can match by identity
    }

    // Get identity info from signing_id
    let matchedGamertag = null;
    let matchedPlayer = null;
    let identityInfo = null;

    if (signingId) {
      try {
        identityInfo = await rpcCall('getidentity', [signingId]);
        const primaryAddresses = identityInfo.identity?.primaryaddresses || [];
        console.log(`[QR-LOGIN] Signing identity: ${identityInfo.identity?.name}, addresses: ${primaryAddresses.join(', ')}`);

        // Check if this identity or any of its primary addresses match a registered Tier 2 player
        for (const [name, player] of Object.entries(players)) {
          if (player.tier !== 2) continue;

          // Match by identity address
          const fullName = name + '.Verus Arcade@';
          try {
            const playerIdInfo = await rpcCall('getidentity', [fullName]);
            if (playerIdInfo.identity?.identityaddress === identityInfo.identity?.identityaddress) {
              matchedGamertag = name;
              matchedPlayer = player;
              break;
            }
          } catch { /* identity not found */ }

          // Match by R-address
          if (player.playerAddress && primaryAddresses.includes(player.playerAddress)) {
            matchedGamertag = name;
            matchedPlayer = player;
            break;
          }
        }
      } catch (e) {
        console.log(`[QR-LOGIN] Could not get identity info: ${e.message}`);
      }
    }

    if (matchedGamertag && matchedPlayer) {
      const fullName = matchedGamertag + '.Verus Arcade@';
      const ch = qrLoginChallenges.get(challenge_id);
      ch.status = 'verified';
      ch.gamertag = matchedGamertag;
      ch.identity = signingId;
      ch.raddress = matchedPlayer.playerAddress;
      ch.fullname = fullName;
      ch.freeSavesLeft = matchedPlayer.freeSavesLeft;

      console.log(`[QR-LOGIN] ✅ Login verified: ${fullName}`);
    } else {
      const ch = qrLoginChallenges.get(challenge_id);
      ch.status = 'no_account';
      ch.identity = signingId;
      console.log(`[QR-LOGIN] ✗ No matching Verus Arcade account found for ${signingId}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[QR-LOGIN] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Step 3: Frontend polls this to check login status
app.get('/api/login/tier2/status/:challengeId', (req, res) => {
  const ch = qrLoginChallenges.get(req.params.challengeId);
  if (!ch) return res.json({ status: 'unknown' });

  if (Date.now() - ch.timestamp > 15 * 60 * 1000) {
    qrLoginChallenges.delete(req.params.challengeId);
    return res.json({ status: 'expired' });
  }

  const result = { status: ch.status };
  if (ch.status === 'verified') {
    result.gamertag = ch.gamertag;
    result.fullname = ch.fullname;
    result.identity = ch.identity;
    result.raddress = ch.raddress;
    result.freeSavesLeft = ch.freeSavesLeft;
  }

  res.json(result);
});

// Cleanup old login challenges
setInterval(() => {
  const now = Date.now();
  for (const [id, ch] of qrLoginChallenges) {
    if (now - ch.timestamp > 30 * 60 * 1000) qrLoginChallenges.delete(id);
  }
}, 5 * 60 * 1000);

// ── Claim SubID (transfer ownership to player's R-address) ──
const claimChallenges = new Map(); // gamertag → { message, timestamp }

app.post('/api/claim/challenge', async (req, res) => {
  const { gamertag, pin, raddress } = req.body;
  if (!gamertag || !pin || !raddress) {
    return res.status(400).json({ error: 'Missing gamertag, pin, or raddress' });
  }

  const name = gamertag.trim().toLowerCase();
  const player = players[name];

  if (!player) return res.status(404).json({ error: 'Gamertag not found' });
  if (player.pinHash !== hashPin(pin)) return res.status(401).json({ error: 'Incorrect pin' });
  if (player.claimed) return res.status(400).json({ error: 'ID already claimed' });

  // Validate R-address format (starts with R, 34 chars)
  if (!/^R[a-zA-Z0-9]{33}$/.test(raddress)) {
    return res.status(400).json({ error: 'Invalid R-address format' });
  }

  // Generate challenge
  const message = `claim:${name}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  claimChallenges.set(name, { message, raddress, timestamp: Date.now() });

  console.log(`[CLAIM] Challenge generated for ${name} → ${raddress}`);
  res.json({
    message,
    instructions: `Sign this message with your R-address using: verus -chain=vrsctest signmessage "${raddress}" "${message}"`,
  });
});

app.post('/api/claim/verify', async (req, res) => {
  const { gamertag, signature } = req.body;
  if (!gamertag || !signature) {
    return res.status(400).json({ error: 'Missing gamertag or signature' });
  }

  const name = gamertag.trim().toLowerCase();
  const challenge = claimChallenges.get(name);
  if (!challenge) return res.status(400).json({ error: 'No pending claim. Request a challenge first.' });

  // Check timeout (15 minutes)
  if (Date.now() - challenge.timestamp > 15 * 60 * 1000) {
    claimChallenges.delete(name);
    return res.status(400).json({ error: 'Challenge expired. Request a new one.' });
  }

  try {
    // Verify the signature against the R-address
    const verified = await rpcCall('verifymessage', [challenge.raddress, signature.trim(), challenge.message]);
    if (!verified) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    const fullName = name + '.Verus Arcade@';
    const FREE_SAVES = 10;

    // Update identity: change primary address to player's R-address
    const updateData = {
      name: name,
      parent: 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P',
      primaryaddresses: [challenge.raddress],
      minimumsignatures: 1,
    };

    const txid = await rpcCall('updateidentity', [updateData]);
    console.log(`[CLAIM] ✅ ${fullName} claimed by ${challenge.raddress} | txid: ${txid}`);

    // Update player record
    players[name].claimed = true;
    players[name].claimedAddress = challenge.raddress;
    players[name].freeSavesLeft = FREE_SAVES;
    savePlayers();

    claimChallenges.delete(name);

    res.json({
      success: true,
      txid,
      message: `Your identity ${fullName} is now yours! You have ${FREE_SAVES} free saves remaining.`,
      freeSaves: FREE_SAVES,
    });
  } catch (e) {
    console.error('[CLAIM] Error:', e);
    res.status(500).json({ error: e.message || 'Claim failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ── QR PROVISIONING (Tier 2 — Verus Mobile scans QR to get SubID) ──
// ═══════════════════════════════════════════════════════════════════

function generateChallengeID() {
  try {
    const { I_ADDR_VERSION } = require('verus-typescript-primitives/dist/constants/vdxf.js');
    const buf = crypto.randomBytes(20);
    return primitives.toBase58Check(Buffer.from(buf), I_ADDR_VERSION);
  } catch {
    // Fallback: hex challenge ID
    return 'ch_' + crypto.randomBytes(20).toString('hex');
  }
}

// Step 1: Frontend requests a QR deeplink
app.post('/api/register/tier2/qr', async (req, res) => {
  if (!VerusId || !primitives) {
    return res.status(503).json({ error: 'QR provisioning not available — verusid-ts-client not installed' });
  }

  try {
    const challenge_id = generateChallengeID();

    const response = await VerusId.createLoginConsentRequest(
      VERUS_ARCADE_IADDRESS,
      new primitives.LoginConsentChallenge({
        challenge_id: challenge_id,
        requested_access: [
          new primitives.RequestedPermission(primitives.IDENTITY_VIEW.vdxfid),
        ],
        redirect_uris: [
          new primitives.RedirectUri(
            `${PROVISIONING_BASE_URL}/verusidloginnewaccount`,
            primitives.LOGIN_CONSENT_WEBHOOK_VDXF_KEY.vdxfid
          ),
        ],
        subject: [
          new primitives.Subject(
            SYSTEM_ID,
            primitives.ID_SYSTEMID_VDXF_KEY.vdxfid
          ),
          new primitives.Subject(
            VERUS_ARCADE_IADDRESS,
            primitives.ID_PARENT_VDXF_KEY.vdxfid
          ),
        ],
        provisioning_info: [
          new primitives.ProvisioningInfo(
            `${PROVISIONING_BASE_URL}/provisionVerusId`,
            primitives.LOGIN_CONSENT_ID_PROVISIONING_WEBHOOK_VDXF_KEY.vdxfid
          ),
          new primitives.ProvisioningInfo(
            SYSTEM_ID,
            primitives.ID_SYSTEMID_VDXF_KEY.vdxfid
          ),
          new primitives.ProvisioningInfo(
            VERUS_ARCADE_IADDRESS,
            primitives.ID_PARENT_VDXF_KEY.vdxfid
          ),
        ],
        created_at: Number((Date.now() / 1000).toFixed(0)),
      }),
      VERUS_ARCADE_WIF
    );

    const deeplink = response.toWalletDeeplinkUri();

    // Store challenge for polling
    qrChallenges.set(challenge_id, {
      status: 'pending',
      gamertag: null,
      raddress: null,
      timestamp: Date.now(),
    });

    console.log(`[QR] Challenge created: ${challenge_id}`);
    console.log(`[QR] Deeplink length: ${deeplink.length} chars`);

    res.json({ deeplink, challenge_id });
  } catch (e) {
    console.error('[QR] Error generating deeplink:', e);
    res.status(500).json({ error: e.message || 'Failed to generate QR deeplink' });
  }
});

// Step 2: Verus Mobile calls this to provision the SubID
app.post('/api/provisionVerusId', cors(), async (req, res) => {
  console.log('[PROVISION] ═══════════════════════════════════════');
  console.log('[PROVISION] Received provisioning request from Verus Mobile');
  console.log('[PROVISION] Body:', JSON.stringify(req.body, null, 2));
  console.log('[PROVISION] ═══════════════════════════════════════');

  try {
    // Extract data from Verus Mobile provisioning request
    const body = req.body;

    // Verus Mobile sends: body.challenge.name, body.challenge.challenge_id, body.signing_address
    const challenge_id = body.challenge?.challenge_id;
    const requestedName = body.challenge?.name;
    const userAddress = body.signing_address;

    console.log(`[PROVISION] Extracted → name: ${requestedName}, address: ${userAddress}, challenge: ${challenge_id}`);

    if (!requestedName) {
      console.log('[PROVISION] ⚠ Could not extract name from request');
      return res.status(400).json({ error: 'Missing identity name', received: Object.keys(body) });
    }

    const name = requestedName.trim().toLowerCase();

    // Validate gamertag
    const nameError = validateGamertag(name);
    if (nameError) {
      console.log(`[PROVISION] ✗ Invalid name: ${nameError}`);
      return res.status(400).json({ error: nameError });
    }

    // Check if already taken
    try {
      await rpcCall('getidentity', [name + '.Verus Arcade@']);
      console.log(`[PROVISION] ✗ Name already taken: ${name}`);
      return res.status(409).json({ error: 'Name already taken' });
    } catch {
      // Good — name is available
    }

    // Generate server address for co-signing
    const serverAddress = await rpcCall('getnewaddress');
    console.log(`[PROVISION] Server co-signer address: ${serverAddress}`);

    // Register name commitment
    const commitment = await rpcCall('registernamecommitment', [
      name, serverAddress, '', 'Verus Arcade',
    ]);
    console.log(`[PROVISION] Name commitment: ${commitment.txid}`);

    // Store player record
    const FREE_SAVES = 10;
    players[name] = {
      pinHash: null,
      address: serverAddress,
      playerAddress: userAddress || null,
      tier: 2,
      registeredAt: Date.now(),
      claimed: true,
      claimedAddress: userAddress || null,
      freeSavesLeft: FREE_SAVES,
    };
    savePlayers();

    // Update challenge status
    if (challenge_id && qrChallenges.has(challenge_id)) {
      qrChallenges.set(challenge_id, {
        status: 'provisioning',
        gamertag: name,
        raddress: userAddress,
        timestamp: Date.now(),
      });
    }

    // Track pending registration  
    pendingRegistrations.set(name, {
      status: 'committed',
      address: serverAddress,
      playerAddress: userAddress,
      commitment,
      error: null,
      txid: null,
    });

    // Start background registration
    completeRegistration(name, serverAddress, commitment, userAddress);

    // Update challenge to completed once registration is started
    if (challenge_id && qrChallenges.has(challenge_id)) {
      const ch = qrChallenges.get(challenge_id);
      ch.status = 'registered';
      ch.fullname = name + '.Verus Arcade@';
      ch.address = serverAddress;
    }

    console.log(`[PROVISION] ✅ SubID registration started: ${name}.Verus Arcade@ | Player: ${userAddress}`);

    // Build properly serialized provisioning response for Verus Mobile
    try {
      const ProvisioningRequest = primitives.LoginConsentProvisioningRequest;
      const ProvisioningDecision = primitives.LoginConsentProvisioningDecision;
      const ProvisioningResult = primitives.LoginConsentProvisioningResult;
      const ProvisioningResponse = primitives.LoginConsentProvisioningResponse;

      // Reconstruct the incoming request
      const originalRequest = new ProvisioningRequest({
        signing_address: body.signing_address,
        signature: body.signature,
        challenge: body.challenge,
      });

      // Create decision with result (keep it simple - no parent/txids as toJson() drops them)
      const decision = new ProvisioningDecision({
        decision_id: challenge_id,
        created_at: Number((Date.now() / 1000).toFixed(0)),
        request: originalRequest,
        result: new ProvisioningResult({
          state: primitives.LOGIN_CONSENT_PROVISIONING_RESULT_STATE_PENDINGAPPROVAL.vdxfid,
          fully_qualified_name: name + '.Verus Arcade.VRSCTEST@',
          system_id: SYSTEM_ID,
        }),
      });

      // Build unsigned response first
      const unsignedResponse = new ProvisioningResponse({
        system_id: SYSTEM_ID,
        signing_id: VERUS_ARCADE_IADDRESS,
        decision: decision,
      });

      // CRITICAL: Do a JSON roundtrip BEFORE signing.
      // toJson() drops some fields (e.g. parent in ProvisioningResult).
      // Verus Mobile reconstructs from our JSON, so the hash it computes
      // will be from the JSON-reconstructed object. We must sign THAT hash.
      const jsonOutput = unsignedResponse.toJson();
      const roundtrippedResponse = new ProvisioningResponse(jsonOutput);

      // Now sign the roundtripped version (its hash will match what Verus Mobile computes)
      const signedResponse = await VerusId.signVerusIdProvisioningResponse(
        roundtrippedResponse,
        VERUS_ARCADE_WIF
      );

      console.log(`[PROVISION] Signed VDXF response for challenge ${challenge_id}`);
      res.json(signedResponse.toJson());
    } catch (signErr) {
      console.error('[PROVISION] Warning: could not build VDXF response:', signErr.message);
      console.error('[PROVISION] Stack:', signErr.stack);
      // Fallback — still return success, ID is being created
      res.json({
        success: true,
        name: name,
        fullname: name + '.Verus Arcade@',
        message: `Identity ${name}.Verus Arcade@ is being created (response signing failed)`,
      });
    }
  } catch (e) {
    console.error('[PROVISION] Error:', e);
    res.status(500).json({ error: e.message || 'Provisioning failed' });
  }
});

// Step 3: Login callback after provisioning (Verus Mobile redirect)
app.post('/api/verusidloginnewaccount', cors(), async (req, res) => {
  console.log('[LOGIN-CALLBACK] ═══════════════════════════════════════');
  console.log('[LOGIN-CALLBACK] Body:', JSON.stringify(req.body, null, 2));
  console.log('[LOGIN-CALLBACK] ═══════════════════════════════════════');

  try {
    // Extract challenge_id from the callback
    const challenge_id = req.body?.decision?.request?.challenge?.challenge_id
      || req.body?.challenge_id
      || req.body?.challengeId;

    if (challenge_id && qrChallenges.has(challenge_id)) {
      const ch = qrChallenges.get(challenge_id);
      ch.status = 'completed';
      console.log(`[LOGIN-CALLBACK] Challenge ${challenge_id} → completed for ${ch.gamertag}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[LOGIN-CALLBACK] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Step 4: Frontend polls this to check QR registration progress
app.get('/api/register/tier2/status/:challengeId', (req, res) => {
  const ch = qrChallenges.get(req.params.challengeId);
  if (!ch) return res.json({ status: 'unknown' });

  // Check if timeout (15 minutes)
  if (Date.now() - ch.timestamp > 15 * 60 * 1000) {
    qrChallenges.delete(req.params.challengeId);
    return res.json({ status: 'expired' });
  }

  res.json({
    status: ch.status,
    gamertag: ch.gamertag,
    fullname: ch.fullname || null,
    address: ch.address || null,
    raddress: ch.raddress || null,
  });
});

// Cleanup old challenges periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, ch] of qrChallenges) {
    if (now - ch.timestamp > 30 * 60 * 1000) qrChallenges.delete(id);
  }
}, 5 * 60 * 1000);

const PORT = 3001;
app.listen(PORT, () => {
  console.log('\n⛓  Verus Arcade Backend');
  console.log('   Server:  http://localhost:' + PORT);
  console.log('   RPC:     ' + RPC.host + ':' + RPC.port);
  console.log('   Chain:   vrsctest');
  console.log('   Storage: contentmultimap (per-game entries)');
  console.log('');
});
