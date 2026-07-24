import assert from 'node:assert/strict';
import test from 'node:test';

import { VerusRpcClient, VerusRpcError } from './rpc-client.mjs';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test('RPC client sends authenticated JSON without exposing credentials in errors', async () => {
  let request;
  const client = new VerusRpcClient({
    url: 'http://127.0.0.1:1234',
    username: 'rpc-user',
    password: 'rpc-password',
    fetchImpl: async (_url, options) => {
      request = options;
      return response({ result: { testnet: true }, error: null });
    },
  });
  assert.deepEqual(await client.call('getinfo'), { testnet: true });
  assert.match(request.headers.authorization, /^Basic /);
  assert.equal(JSON.parse(request.body).method, 'getinfo');
  assert.equal(JSON.stringify(request).includes('rpc-password'), false);
});

test('daemon JSON-RPC rejection is definite, not submission-uncertain', async () => {
  const client = new VerusRpcClient({
    url: 'http://127.0.0.1:1234',
    username: 'user',
    password: 'password',
    fetchImpl: async () =>
      response({ result: null, error: { code: -26, message: 'rejected' } }),
  });
  await assert.rejects(
    () => client.call('sendrawtransaction', ['00']),
    (error) =>
      error instanceof VerusRpcError &&
      error.code === -26 &&
      error.submissionUncertain === false,
  );
});

test('connection loss is uncertain only for transaction submission', async () => {
  const client = new VerusRpcClient({
    url: 'http://127.0.0.1:1234',
    username: 'user',
    password: 'password',
    fetchImpl: async () => {
      throw new TypeError('socket closed');
    },
  });
  await assert.rejects(
    () => client.call('getinfo'),
    (error) =>
      error.code === 'RPC_CONNECTION_FAILED' &&
      error.submissionUncertain === false,
  );
  await assert.rejects(
    () => client.call('sendrawtransaction', ['00']),
    (error) =>
      error.code === 'RPC_CONNECTION_FAILED' &&
      error.submissionUncertain === true,
  );
});
