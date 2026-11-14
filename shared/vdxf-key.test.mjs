import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { encodeBase58Check, vdxfDataKey } from './vdxf-key.mjs';
import { decodeBase58Check } from './verus-signature.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';

test('vdxf-key: gelijk aan de SDK (getDataKey) voor onze key-namen', () => {
  const names = [
    'arcade.player.result.word-grid:1.0.0:2026-11-10',
    'arcade.player.result.number-target:1.0.0:2026-11-11',
    'arcade.player.attestation.word-grid:1.0.0:2026-11-11T1524',
    'arcade.player.result.WORD-GRID:1.0.0:2026-11-10',
    'single',
  ];
  for (const name of names) {
    assert.equal(vdxfDataKey(name, ARCADE), P.getDataKey(name, ARCADE, P.TESTNET_VERUS_CHAINID).id, name);
  }
  // en via de volledig gekwalificeerde naam (zoals de server dubbel controleert)
  assert.equal(vdxfDataKey(names[0], ARCADE), P.getDataKey(`Arcade.VRSCTEST.::${names[0]}`, ARCADE, P.TESTNET_VERUS_CHAINID).id);
});

test('vdxf-key: echte keys uit een spelers-ID (profiel 14 nov)', () => {
  assert.equal(vdxfDataKey('arcade.player.result.number-target:1.0.0:2026-11-11', ARCADE), 'iEuZnEKAh4gq6BUTB3Xb6cV9uf9X3uPgVH');
  assert.equal(vdxfDataKey('arcade.player.result.word-grid:1.0.0:2026-11-10', ARCADE), 'iCmHPmeRpdFGduzdiA7hRYUMoPrBdLgzh4');
  assert.equal(vdxfDataKey('arcade.player.result.word-grid:1.0.0:2026-11-11', ARCADE), 'iGuRuBpdaBbxe7S9pJ2ASqF5Z1UiXz2FM9');
});

test('vdxf-key: base58check heen en terug; vreemde namen geweigerd', () => {
  const { hash } = decodeBase58Check(ARCADE);
  assert.equal(encodeBase58Check(hash, 102), ARCADE);
  assert.equal(encodeBase58Check(decodeBase58Check('R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp').hash, 60), 'R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp');
  for (const bad of ['', 'a b', 'Arcade.VRSCTEST.::x', 'x.', 'naam@']) assert.throws(() => vdxfDataKey(bad, ARCADE), bad);
  assert.throws(() => vdxfDataKey('x', 'R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp'), /i-address/);
});
