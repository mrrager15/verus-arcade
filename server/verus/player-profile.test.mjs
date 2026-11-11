import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResultSet, createInclusionProof } from '../result-set.mjs';
import { collectPlayerResults } from './player-profile.mjs';
import { buildPlayerResultRecord, playerResultContentKey, serializePlayerResultRecord } from './player-result.mjs';
import { P } from './requests.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const FQN = 'Arcade.VRSCTEST@';
const PLAYER = 'iQZGcAzSXaeciUhoh3ZbkmcgJHmdy3seBK';
const OTHER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';

function roundFor(date) {
  const id = `word-grid:1.0.0:${date}`;
  return { id, round_id: id, chain_id: 'vrsctest', game_id: 'word-grid', game_version: '1.0.0' };
}
function recordFor(player, round, words) {
  return {
    schemaVersion: 2, roundId: round.round_id, chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', playerIAddress: player,
    status: 'solved', guesses: words.map((w, i) => ({ sequence: i + 1, word: w })), score: { solved: true, guessesUsed: words.length }, playerSignature: null,
  };
}
function publishedJson(player, date, words = ['crane']) {
  const round = roundFor(date);
  const set = buildResultSet([recordFor(player, round, words), recordFor(OTHER === player ? PLAYER : OTHER, round, ['slate'])]);
  const proof = createInclusionProof(set, set.entries.findIndex((e) => e.record.playerIAddress === player));
  const record = buildPlayerResultRecord({ round, proof, resultRootTxid: 'ab'.repeat(32) });
  return serializePlayerResultRecord(record).json;
}
function chainValue(json) {
  const d = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(0), objectdata: Buffer.from(json, 'utf8') });
  return new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: d }] }).toBuffer().toString('hex');
}
const keyFor = (date) => playerResultContentKey({ roundId: `word-grid:1.0.0:${date}`, serviceId: ARCADE, serviceFqn: FQN }).keyId;

test('profiel: alleen geldige records onder de juiste key en voor deze speler, nieuwste eerst', async () => {
  const good1 = chainValue(publishedJson(PLAYER, '2026-11-08', ['crane', 'plane']));
  const good2 = chainValue(publishedJson(PLAYER, '2026-11-09'));
  const wrongKey = chainValue(publishedJson(PLAYER, '2026-11-10'));          // record van ronde 10 onder de key van ronde 09
  const otherPlayer = chainValue(publishedJson(OTHER, '2026-11-11'));        // record van iemand anders onder de juiste key
  const garbage = Buffer.from('hallo').toString('hex');
  const content = {
    fullyqualifiedname: 'testerrr.Verus Arcade.VRSCTEST@',
    identity: { identityaddress: PLAYER, contentmultimap: {
      [keyFor('2026-11-08')]: [good1],
      [keyFor('2026-11-09')]: [good2, wrongKey],
      [keyFor('2026-11-11')]: [otherPlayer],
      'iBPk7CJiyoVSS1enhnJbyKXiqtZGoiNFcx': [garbage], // willekeurige andere key
    } },
  };
  const history = [
    { height: 1500, output: { txid: '11'.repeat(32) }, identity: { contentmultimap: { [keyFor('2026-11-08')]: [good1] } } },
    { height: 1600, output: { txid: '22'.repeat(32) }, identity: { contentmultimap: { [keyFor('2026-11-09')]: [good2] } } },
  ];
  const profile = await collectPlayerResults({ playerId: PLAYER, content, history, serviceId: ARCADE, serviceFqn: FQN });
  assert.equal(profile.results.length, 2);
  assert.equal(profile.ignored, 3);
  assert.deepEqual(profile.results.map((r) => [r.round, r.guesses, r.txid, r.height]), [
    ['word-grid:1.0.0:2026-11-09', 1, '22'.repeat(32), 1600],
    ['word-grid:1.0.0:2026-11-08', 2, '11'.repeat(32), 1500],
  ]);
  assert.match(profile.results[0].recordSha256, /^[0-9a-f]{64}$/);
  assert.equal((await collectPlayerResults({ playerId: PLAYER, content: { identity: { contentmultimap: {} } }, history: [], serviceId: ARCADE, serviceFqn: FQN })).results.length, 0);
});

test('profiel leest ook de versleutelde verwijzing die Verus Mobile schrijft', async () => {
  const json = publishedJson(PLAYER, '2026-11-12', ['crane', 'slate', 'plane']);
  const value = { [P.DataDescriptorKey.vdxfid]: { version: 1, flags: 13, objectdata: 'aa', epk: '8a'.repeat(32), ivk: '0d'.repeat(32) } };
  const content = { identity: { identityaddress: PLAYER, contentmultimap: { [keyFor('2026-11-12')]: [value] } } };
  const history = [{ height: 1700, output: { txid: '33'.repeat(32) }, identity: { contentmultimap: { [keyFor('2026-11-12')]: [value] } } }];
  const decrypt = async (_descriptor, txid) => (txid === '33'.repeat(32)
    ? [{ version: 1, flags: 2, objectdata: Buffer.from(json, 'utf8').toString('hex'), salt: '58'.repeat(32) }]
    : null);
  const profile = await collectPlayerResults({ playerId: PLAYER, content, history, serviceId: ARCADE, serviceFqn: FQN, decrypt });
  assert.equal(profile.results.length, 1);
  assert.equal(profile.results[0].storage, 'encrypted-ref');
  assert.equal(profile.results[0].guesses, 3);
  assert.equal(profile.results[0].txid, '33'.repeat(32));
});
