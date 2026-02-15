const express = require('express');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

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

app.post('/api/game/save', async (req, res) => {
  const { identity, game, actionLog, chainHead, score } = req.body;
  if (!identity || !game || !actionLog) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const updateData = {
      name: identity,
      contentmultimap: {
        ['vrsc::arcade.' + game + '.actions']: [{ vdxftype: 'utf8', value: JSON.stringify(actionLog) }],
        ['vrsc::arcade.' + game + '.chainhead']: [{ vdxftype: 'utf8', value: chainHead }],
        ['vrsc::arcade.' + game + '.score']: [{ vdxftype: 'utf8', value: String(score) }],
        ['vrsc::arcade.' + game + '.timestamp']: [{ vdxftype: 'utf8', value: String(Date.now()) }],
      },
    };
    const txid = await rpcCall('updateidentity', [updateData]);
    res.json({ success: true, txid });
  } catch (e) {
    res.status(500).json({ error: e.message || e });
  }
});

app.get('/api/game/load/:identity/:game', async (req, res) => {
  try {
    const idInfo = await rpcCall('getidentity', [req.params.identity]);
    const cmap = idInfo.identity.contentmultimap || {};
    const game = req.params.game;
    const actions = cmap['vrsc::arcade.' + game + '.actions'];
    const chainHead = cmap['vrsc::arcade.' + game + '.chainhead'];
    const score = cmap['vrsc::arcade.' + game + '.score'];
    res.json({
      found: !!actions,
      actions: actions ? JSON.parse(actions[0].value || actions[0]) : null,
      chainHead: chainHead ? (chainHead[0].value || chainHead[0]) : null,
      score: score ? Number(score[0].value || score[0]) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || e });
  }
});

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
  console.log('   Chain:   vrsctest\n');
});
