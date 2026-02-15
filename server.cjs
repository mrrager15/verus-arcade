const express = require('express');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Verus RPC Configuration ──
const RPC = {
  host: '127.0.0.1',
  port: 18843,
  user: 'user787555433',
  pass: 'pass1530fe87fc666953017d00b8a5c8a1c0c681625584c7bd752ec13ec77373e06bec',
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

    const updateData = { name: idName, contentmultimap: {} };
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

// ── Sub-ID Registration ──
app.post('/api/register-player', async (req, res) => {
  const { playerName } = req.body;
  if (!playerName) return res.status(400).json({ error: 'Missing playerName' });
  try {
    const address = await rpcCall('getrawchangeaddress');
    const commitment = await rpcCall('registernamecommitment', [playerName, address, '', 'Verus Arcade@']);
    res.json({ success: true, commitment, address });
  } catch (e) {
    res.status(500).json({ error: e.message || e });
  }
});

app.post('/api/register-player/confirm', async (req, res) => {
  const { commitment, address } = req.body;
  if (!commitment || !address) return res.status(400).json({ error: 'Missing data' });
  try {
    const identity = {
      txid: commitment.txid,
      namereservation: commitment.namereservation,
      identity: {
        name: commitment.namereservation.name,
        primaryaddresses: [address],
        minimumsignatures: 1,
        parent: 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P',
      },
    };
    const txid = await rpcCall('registeridentity', [identity]);
    res.json({ success: true, txid });
  } catch (e) {
    res.status(500).json({ error: e.message || e });
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
