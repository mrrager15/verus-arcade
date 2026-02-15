const http = require('http');

const RPC = {
  host: '127.0.0.1',
  port: 18843,
  user: 'user787555433',  // ← pas aan
  pass: 'pass1530fe87fc666953017d00b8a5c8a1c0c681625584c7bd752ec13ec77373e06bec',  // ← pas aan
};

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '1.0', id: 'test', method, params });
    const options = {
      hostname: RPC.host, port: RPC.port, method: 'POST',
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
        } catch (e) { reject(body); }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

function toHex(str) { return Buffer.from(str, 'utf8').toString('hex'); }
function fromHex(hex) { return Buffer.from(hex, 'hex').toString('utf8'); }

function makeKey(label) {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bytes = [];
  for (let round = 0; round < 5; round++) {
    h ^= round;
    h = Math.imul(h, 0x01000193);
    const v = h >>> 0;
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }
  return bytes.slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function test() {
  // Full 14-day action log
  const actionLog = [];
  for (let d = 1; d <= 14; d++) {
    actionLog.push({
      day: d,
      buys: { lemons: 10, sugar: 20, cups: 20, ice: 15 },
      recipeIndex: 2,
      price: 1.50,
      hash: makeKey('hash' + d).slice(0, 8),
    });
  }

  const fullPayload = JSON.stringify({
    seed: "Verus Arcade",
    actions: actionLog,
    chainHead: "abcd1234",
    score: 256,
  });

  console.log('Full payload size:', fullPayload.length, 'bytes');
  console.log('Full payload hex size:', toHex(fullPayload).length, 'hex chars\n');

  // ═══ TEST 1: Single contentmap key (full payload) ═══
  console.log('=== TEST 1: Single contentmap key (full data) ===');
  try {
    const key1 = makeKey('arcade.lemonade.full');
    const cm = {};
    cm[key1] = toHex(fullPayload);
    console.log('Key:', key1, '| Hex size:', cm[key1].length);
    const txid = await rpcCall('updateidentity', [{ name: 'Verus Arcade', contentmap: cm }]);
    console.log('SUCCESS txid:', txid, '\n');
  } catch (e) {
    console.log('FAILED:', e.message || JSON.stringify(e), '\n');
  }

  // ═══ TEST 2: Split across multiple contentmap keys ═══
  console.log('=== TEST 2: Multiple contentmap keys (split) ===');
  try {
    const meta = JSON.stringify({ seed: "Verus Arcade", chainHead: "abcd1234", score: 256, parts: 2 });
    const half = Math.ceil(actionLog.length / 2);
    const part1 = JSON.stringify(actionLog.slice(0, half));
    const part2 = JSON.stringify(actionLog.slice(half));
    console.log('Meta:', meta.length, 'b | Part1:', part1.length, 'b | Part2:', part2.length, 'b');

    const cm = {};
    cm[makeKey('arcade.lemonade.meta')] = toHex(meta);
    cm[makeKey('arcade.lemonade.act.1')] = toHex(part1);
    cm[makeKey('arcade.lemonade.act.2')] = toHex(part2);

    const txid = await rpcCall('updateidentity', [{ name: 'Verus Arcade', contentmap: cm }]);
    console.log('SUCCESS txid:', txid, '\n');
  } catch (e) {
    console.log('FAILED:', e.message || JSON.stringify(e), '\n');
  }

  // ═══ TEST 3: contentmultimap with utf8 ═══
  console.log('=== TEST 3: contentmultimap (utf8, identity key) ===');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P': [
          { vdxftype: 'utf8', value: 'hello world' }
        ]
      }
    }]);
    console.log('SUCCESS txid:', txid, '\n');
  } catch (e) {
    console.log('FAILED:', e.message || JSON.stringify(e), '\n');
  }

  // ═══ TEST 4: contentmultimap with hex array ═══
  console.log('=== TEST 4: contentmultimap (hex value) ===');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P': [
          toHex('test data')
        ]
      }
    }]);
    console.log('SUCCESS txid:', txid, '\n');
  } catch (e) {
    console.log('FAILED:', e.message || JSON.stringify(e), '\n');
  }

  // ═══ Read back ═══
  console.log('=== Reading identity in 3 seconds... ===');
  await new Promise(r => setTimeout(r, 3000));
  try {
    const id = await rpcCall('getidentity', ['Verus Arcade@']);
    console.log('\ncontentmap keys:', Object.keys(id.identity.contentmap || {}));
    for (const [k, v] of Object.entries(id.identity.contentmap || {})) {
      try {
        const decoded = fromHex(v);
        console.log('[' + k + '] (' + v.length + ' hex):', decoded.substring(0, 150) + (decoded.length > 150 ? '...' : ''));
      } catch {}
    }
    console.log('\ncontentmultimap:', JSON.stringify(id.identity.contentmultimap, null, 2));
  } catch (e) {
    console.log('Read error:', e);
  }
}

test();
