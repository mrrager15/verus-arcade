import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsSha256, buildAttemptMessage, parseAttemptMessage, attemptMessageMatches, ATTEMPT_MESSAGE_TITLE } from './attempt-message.mjs';

const ROUND = 'word-grid:1.0.0:2026-10-20';
const PLAYER = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const GUESSES = [{ sequence: 1, word: 'CRANE' }, { sequence: 2, word: 'SLOTH' }];

test('actionsSha256 is deterministisch en negeert extra velden en volgorde van keys', () => {
  const a = actionsSha256(GUESSES);
  const b = actionsSha256([{ word: 'CRANE', sequence: 1, extra: true }, { word: 'SLOTH', sequence: 2 }]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, actionsSha256([{ sequence: 1, word: 'CRANE' }]));
  assert.notEqual(a, actionsSha256([{ sequence: 1, word: 'SLOTH' }, { sequence: 2, word: 'CRANE' }]));
  assert.equal(actionsSha256([]), actionsSha256([]));
});

test('actionsSha256 weigert ongeldige of ongesorteerde gokken', () => {
  assert.throws(() => actionsSha256('x'), /array/);
  assert.throws(() => actionsSha256([{ sequence: 0, word: 'A' }]), /invalid guess/);
  assert.throws(() => actionsSha256([{ sequence: 1, word: '' }]), /invalid guess/);
  assert.throws(() => actionsSha256([{ sequence: 2, word: 'A' }, { sequence: 1, word: 'B' }]), /strictly increasing/);
  assert.throws(() => actionsSha256([{ sequence: 1, word: 'A' }, { sequence: 1, word: 'B' }]), /strictly increasing/);
});

test('buildAttemptMessage geeft exact vier regels in het vaste profiel', () => {
  const hash = actionsSha256(GUESSES);
  const message = buildAttemptMessage({ roundId: ROUND, playerIAddress: PLAYER, actionsSha256: hash });
  const lines = message.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], ATTEMPT_MESSAGE_TITLE);
  assert.equal(lines[1], `round:${ROUND}`);
  assert.equal(lines[2], `player:${PLAYER}`);
  assert.equal(lines[3], `actions:sha256:${hash}`);
  assert.ok(!message.endsWith('\n'));
});

test('buildAttemptMessage weigert ongeldige onderdelen', () => {
  const hash = actionsSha256(GUESSES);
  assert.throws(() => buildAttemptMessage({ roundId: 'Word Grid 2026', playerIAddress: PLAYER, actionsSha256: hash }), /roundId/);
  assert.throws(() => buildAttemptMessage({ roundId: ROUND, playerIAddress: 'R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp', actionsSha256: hash }), /playerIAddress/);
  assert.throws(() => buildAttemptMessage({ roundId: ROUND, playerIAddress: PLAYER, actionsSha256: hash.toUpperCase() }), /actions hash/);
});

test('parseAttemptMessage herkent alleen het exacte profiel', () => {
  const hash = actionsSha256(GUESSES);
  const message = buildAttemptMessage({ roundId: ROUND, playerIAddress: PLAYER, actionsSha256: hash });
  assert.deepEqual(parseAttemptMessage(message), { roundId: ROUND, playerIAddress: PLAYER, actionsSha256: hash });
  assert.equal(parseAttemptMessage(message + '\n'), null);
  assert.equal(parseAttemptMessage(message.replace('v1', 'v2')), null);
  assert.equal(parseAttemptMessage(message.replace('\n', '\r\n')), null);
  assert.equal(parseAttemptMessage(`${message}\nextra:1`), null);
  assert.equal(parseAttemptMessage('Vatermark image authentication v2\nsha256:' + hash), null);
  assert.equal(parseAttemptMessage(42), null);
  assert.equal(parseAttemptMessage('x'.repeat(401)), null);
});

test('attemptMessageMatches bindt bericht aan ronde, speler en invoer', () => {
  const message = buildAttemptMessage({ roundId: ROUND, playerIAddress: PLAYER, actionsSha256: actionsSha256(GUESSES) });
  assert.equal(attemptMessageMatches(message, { roundId: ROUND, playerIAddress: PLAYER, guesses: GUESSES }), true);
  assert.equal(attemptMessageMatches(message, { roundId: 'word-grid:1.0.0:2026-10-21', playerIAddress: PLAYER, guesses: GUESSES }), false);
  assert.equal(attemptMessageMatches(message, { roundId: ROUND, playerIAddress: 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN', guesses: GUESSES }), false);
  assert.equal(attemptMessageMatches(message, { roundId: ROUND, playerIAddress: PLAYER, guesses: [GUESSES[0]] }), false);
  assert.equal(attemptMessageMatches('onzin', { roundId: ROUND, playerIAddress: PLAYER, guesses: GUESSES }), false);
});
