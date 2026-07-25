import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalLoginPrincipal } from './login-principal.mjs';

test('canonicalizes the wallet chain label to the configured authorization ID', () => {
  assert.deepEqual(
    canonicalLoginPrincipal(
      {
        iAddress: 'i-player',
        friendlyName: 'player.VRSCTEST@',
        chainName: 'VRSCTEST',
      },
      'vrsctest',
    ),
    {
      iAddress: 'i-player',
      friendlyName: 'player.VRSCTEST@',
      chain: 'vrsctest',
    },
  );
});

test('rejects a login reported for a different chain', () => {
  assert.throws(
    () =>
      canonicalLoginPrincipal(
        {
          iAddress: 'i-player',
          friendlyName: 'player@',
          chainName: 'VRSC',
        },
        'vrsctest',
      ),
    /configured chain/,
  );
});
