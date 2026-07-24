import assert from 'node:assert/strict';
import test from 'node:test';

import { MAINNET_ACK, loadConfig } from './config.mjs';

test('defaults to VRSCTEST and disables the legacy publisher', () => {
  const config = loadConfig({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' });
  assert.equal(config.network, 'vrsctest');
  assert.equal(config.isMainnet, false);
  assert.equal(config.legacyPublisherEnabled, false);
  assert.match(config.confPath, /vrsctest[\\/]vrsctest\.conf$/i);
});

test('rejects unknown and ambiguous network configuration', () => {
  assert.throws(() => loadConfig({ ARCADE_NETWORK: 'btc' }), /vrsctest or vrsc/);
  assert.throws(
    () =>
      loadConfig({
        ARCADE_NETWORK: 'vrsctest',
        ARCADE_CHAINS: 'vrsc,vrsctest',
      }),
    /deprecated/,
  );
});

test('mainnet requires production, exact acknowledgement, and HTTPS', () => {
  assert.throws(() => loadConfig({ ARCADE_NETWORK: 'vrsc' }), /NODE_ENV/);
  assert.throws(
    () =>
      loadConfig({
        ARCADE_NETWORK: 'vrsc',
        NODE_ENV: 'production',
        ARCADE_MAINNET_ACK: MAINNET_ACK,
        ARCADE_ORIGIN: 'http://arcade.example',
      }),
    /HTTPS/,
  );
  const config = loadConfig({
    ARCADE_NETWORK: 'vrsc',
    NODE_ENV: 'production',
    ARCADE_MAINNET_ACK: MAINNET_ACK,
    ARCADE_ORIGIN: 'https://arcade.example',
    ARCADE_CONF: '/secure/VRSC.conf',
  });
  assert.equal(config.isMainnet, true);
});

test('validates ports, session TTL, and origin', () => {
  assert.throws(() => loadConfig({ ARCADE_AUTH_PORT: '0' }), /positive integer/);
  assert.throws(
    () => loadConfig({ ARCADE_SESSION_TTL_SECONDS: 'nope' }),
    /positive integer/,
  );
  assert.throws(
    () => loadConfig({ ARCADE_ORIGIN: 'ftp://arcade.example' }),
    /http or https/,
  );
});
