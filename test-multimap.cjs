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

// Wait for previous tx to confirm
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test() {
  const idAddress = 'iBrnBWkYJvzH6z1SB2TDnxk5mbPc781z1P'; // Verus Arcade@ i-address
  const parentAddress = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'; // VRSCTEST i-address

  // First, let's check what help says about updateidentity
  console.log('=== Checking updateidentity help ===\n');
  try {
    await rpcCall('updateidentity');
  } catch (e) {
    if (e.message) console.log(e.message.substring(0, 500));
  }

  console.log('\n=== Testing contentmultimap formats ===\n');

  // Test A: utf8 vdxftype with identity address key
  console.log('TEST A: {key: [{vdxftype:"utf8", value:"..."}]}');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        [idAddress]: [{ vdxftype: 'utf8', value: 'test A' }]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test B: raw hex string in array
  console.log('\nTEST B: {key: ["hexstring"]}');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        [idAddress]: [toHex('test B')]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test C: single string (not array)
  console.log('\nTEST C: {key: "hexstring"}');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        [idAddress]: toHex('test C')
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test D: using parent (VRSCTEST) address as key
  console.log('\nTEST D: parent address as key, utf8');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        [parentAddress]: [{ vdxftype: 'utf8', value: 'test D' }]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test E: using a friendly name as key
  console.log('\nTEST E: friendly name "Verus Arcade@" as key');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        'Verus Arcade@': [{ vdxftype: 'utf8', value: 'test E' }]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test F: hex vdxftype
  console.log('\nTEST F: {key: [{vdxftype:"hex", value:"..."}]}');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmultimap: {
        [idAddress]: [{ vdxftype: 'hex', value: toHex('test F') }]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Test G: empty contentmap + contentmultimap together
  console.log('\nTEST G: contentmap:{} + contentmultimap:{key:[utf8]}');
  try {
    const txid = await rpcCall('updateidentity', [{
      name: 'Verus Arcade',
      contentmap: {},
      contentmultimap: {
        [idAddress]: [{ vdxftype: 'utf8', value: 'test G' }]
      }
    }]);
    console.log('  ✓ txid:', txid);
    await wait(3000);
  } catch (e) {
    console.log('  ✗', e.message || JSON.stringify(e));
  }

  // Read back
  console.log('\n=== Reading identity ===');
  await wait(5000);
  try {
    const id = await rpcCall('getidentity', ['Verus Arcade@']);
    console.log('\ncontentmap:', JSON.stringify(id.identity.contentmap, null, 2));
    console.log('\ncontentmultimap:', JSON.stringify(id.identity.contentmultimap, null, 2));
  } catch (e) {
    console.log('Read error:', e);
  }
}

test();
