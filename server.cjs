const express = require('express');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors({
  origin: ['https://verusarcade.com', 'https://www.verusarcade.com', 'http://localhost:5173']
}));
app.use(express.json({ limit: '5mb' }));

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
    res.json({ success: true, txid, stats: newStats });
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
async function completeRegistration(name, address, commitment) {
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
    const idDef = {
      txid: commitment.txid,
      namereservation: commitment.namereservation,
      identity: {
        name: commitment.namereservation.name,
        primaryaddresses: [address],
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
  const { gamertag } = req.body;
  const ip = getClientIP(req);

  // Validate name
  const nameError = validateGamertag(gamertag);
  if (nameError) return res.status(400).json({ error: nameError });

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

    // Generate new address
    const address = await rpcCall('getnewaddress');
    console.log(`[REGISTER] Generated address: ${address}`);

    // Register name commitment
    const commitment = await rpcCall('registernamecommitment', [
      name, address, '', 'Verus Arcade',
    ]);
    console.log(`[REGISTER] Name commitment txid: ${commitment.txid}`);

    // Record IP immediately
    registeredIPs.set(ip, { gamertag: name, timestamp: Date.now() });

    // Track pending registration
    pendingRegistrations.set(name, {
      status: 'committed',
      address,
      commitment,
      error: null,
      txid: null,
    });

    // Start background processing (don't await!)
    completeRegistration(name, address, commitment);

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

// ── Custodial Login (for subID players) ──
app.post('/api/login/custodial', async (req, res) => {
  const { gamertag } = req.body;
  if (!gamertag) return res.status(400).json({ error: 'Missing gamertag' });

  const name = gamertag.trim().toLowerCase();
  const fullName = name + '.Verus Arcade@';

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
    });
  } catch (e) {
    res.status(404).json({ verified: false, error: 'Gamertag not found. Register first!' });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log('\n⛓  Verus Arcade Backend');
  console.log('   Server:  http://localhost:' + PORT);
  console.log('   RPC:     ' + RPC.host + ':' + RPC.port);
  console.log('   Chain:   vrsctest');
  console.log('   Storage: contentmultimap (per-game entries)');
  console.log('');
});
