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

async function test() {
  console.log('Testing contentmultimap write...\n');

  // Test data - simulates a small action log
  const testActionLog = [
    { day: 1, buys: { lemons: 10, sugar: 20, cups: 20, ice: 15 }, recipeIndex: 2, price: 1.50, hash: "abc123" },
    { day: 2, buys: { lemons: 5, sugar: 10, cups: 10, ice: 10 }, recipeIndex: 2, price: 1.75, hash: "def456" },
  ];

  const gameData = {
    seed: "Verus Arcade",
    actions: testActionLog,
    chainHead: "def456",
    score: 150,
    timestamp: Date.now(),
  };

  const updateParams = {
    name: "Verus Arcade",
    contentmultimap: {
      "iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P": [
        { vdxftype: "utf8", value: JSON.stringify(gameData) }
      ]
    }
  };

  console.log('Payload size:', JSON.stringify(gameData).length, 'bytes');
  console.log('Update params:', JSON.stringify(updateParams, null, 2));

  try {
    const txid = await rpcCall('updateidentity', [updateParams]);
    console.log('\n✓ Success! txid:', txid);

    // Wait a moment and read it back
    console.log('\nWaiting 2 seconds then reading back...');
    await new Promise(r => setTimeout(r, 2000));

    const identity = await rpcCall('getidentity', ['Verus Arcade@']);
    console.log('\ncontentmultimap:', JSON.stringify(identity.identity.contentmultimap, null, 2));
  } catch (e) {
    console.error('\n✗ Error:', e);
  }
}

test();
