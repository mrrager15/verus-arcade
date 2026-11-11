import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ATTESTATION_FIELDS, buildAttestation, computeDailyStats, discloseAttestation, readAttestationDisclosure, sealAttestation,
} from './attestation.mjs';
import { decodeMmrHashes } from '../shared/verus-mmr.mjs';

const PLAYER = 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g';
const OTHER = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const day = (d) => `word-grid:1.0.0:2026-11-${String(d).padStart(2, '0')}`;
const SALTS = ATTESTATION_FIELDS.map((_, i) => String(i + 1).repeat(64).slice(0, 64));
const clone = (v) => JSON.parse(JSON.stringify(v));
const stats = (roundIds, entries) => computeDailyStats({ roundIds, attempts: new Map(entries) });

test('attestatie: stats tellen alleen getekende pogingen; streak volgt de rondes', () => {
  const rounds = [day(8), day(9), day(10), day(11)];
  const all = [[day(8), { signed: true, solved: true }], [day(9), { signed: true, solved: true }], [day(10), { signed: true, solved: true }], [day(11), { signed: true, solved: true }]];
  assert.deepEqual(stats(rounds, all), { roundId: day(11), streak: 4, rounds: 4, solved: 4 });
  // volgorde van de invoer maakt niet uit
  assert.deepEqual(stats([...rounds].reverse(), all), { roundId: day(11), streak: 4, rounds: 4, solved: 4 });
  // niet getekend = telt niet en breekt de reeks
  const unsigned = all.map(([id, a]) => [id, id === day(10) ? { signed: false, solved: true } : a]);
  assert.deepEqual(stats(rounds, unsigned), { roundId: day(11), streak: 1, rounds: 3, solved: 3 });
  // gemiste ronde breekt de reeks
  assert.deepEqual(stats(rounds, all.filter(([id]) => id !== day(9))), { roundId: day(11), streak: 2, rounds: 3, solved: 3 });
  // mislukte laatste ronde: streak 0, wel geteld
  const failed = all.map(([id, a]) => [id, id === day(11) ? { signed: true, solved: false } : a]);
  assert.deepEqual(stats(rounds, failed), { roundId: day(11), streak: 0, rounds: 4, solved: 3 });
  // een dag zonder ronde (storing) breekt de reeks niet
  assert.deepEqual(stats([day(8), day(10)], [[day(8), { signed: true, solved: true }], [day(10), { signed: true, solved: true }]]).streak, 2);
  assert.throws(() => stats([day(8), 'word-grid:2.0.0:2026-11-09'], []), /different games/);
  assert.throws(() => stats([day(8), day(8)], []), /Duplicate/);
});

test('attestatie: bouwen, verzegelen en één veld tonen', () => {
  const a = buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 1, rounds: 1, solved: 1 }, salts: SALTS });
  assert.equal(decodeMmrHashes(a.descriptor.mmrhashes.objectdata).length, 6);
  assert.equal(a.values.prev, 'none');
  // deterministisch met vaste zouten, anders bij een ander veld
  assert.equal(buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 1, rounds: 1, solved: 1 }, salts: SALTS }).root, a.root);
  assert.notEqual(buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 1, rounds: 2, solved: 1 }, salts: SALTS }).root, a.root);
  // verse zouten: elke keer een andere wortel
  assert.notEqual(buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 1, rounds: 1, solved: 1 } }).root, a.root);
  // verzegeld: geen waarden, geen zouten
  assert.equal(a.sealed.datadescriptors, undefined);
  assert.doesNotMatch(JSON.stringify(a.sealed), /streak|"salt"/);
  assert.deepEqual(sealAttestation(a.descriptor), a.sealed);
  const shown = readAttestationDisclosure(discloseAttestation(a, ['streak']));
  assert.deepEqual(shown, { root: a.root, fields: { player: PLAYER, round: day(10), streak: '1' } });
  // keten
  const next = buildAttestation({ player: PLAYER, roundId: day(11), stats: { streak: 2, rounds: 2, solved: 2 }, prevRoot: a.root });
  assert.equal(readAttestationDisclosure(discloseAttestation(next, ['prev', 'streak'])).fields.prev, a.root);
  assert.deepEqual(Object.keys(readAttestationDisclosure(discloseAttestation(a, ATTESTATION_FIELDS)).fields), ATTESTATION_FIELDS);
});

test('attestatie: ongeldige invoer en geknoeide openbaarmakingen worden geweigerd', () => {
  assert.throws(() => buildAttestation({ player: 'mrrager@', roundId: day(10), stats: { streak: 0, rounds: 0, solved: 0 } }), /i-address/);
  assert.throws(() => buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 2, rounds: 1, solved: 1 } }), /Inconsistent/);
  assert.throws(() => buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 0, rounds: 0, solved: 0 }, prevRoot: 'abc' }), /prev/);
  assert.throws(() => discloseAttestation(buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 0, rounds: 0, solved: 0 } }), ['rating']), /Unknown field/);

  const a = buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 1, rounds: 1, solved: 1 }, salts: SALTS });
  const base = discloseAttestation(a, ['streak']);
  const cases = {
    'zonder player': (d) => { d.datadescriptors = d.datadescriptors.filter((x) => !Buffer.from(x.objectdata, 'hex').toString().startsWith('player:')); },
    'andere streak': (d) => { d.datadescriptors[2].objectdata = Buffer.from('streak:100').toString('hex'); },
    'andere speler': (d) => { d.datadescriptors[0].objectdata = Buffer.from(`player:${OTHER}`).toString('hex'); },
    'veld twee keer': (d) => { d.datadescriptors.push(clone(d.datadescriptors[2])); },
    'blad van een andere attestatie': (d) => {
      const other = buildAttestation({ player: PLAYER, roundId: day(10), stats: { streak: 9, rounds: 9, solved: 9 }, salts: SALTS });
      d.datadescriptors[2] = discloseAttestation(other, ['streak']).datadescriptors[2];
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const d = clone(base);
    mutate(d);
    assert.throws(() => readAttestationDisclosure(d), (e) => e.code === 'INVALID_ATTESTATION', name);
  }
  // een gewone signdata-MMR (de proef van 9 nov, 3 velden) is geen Arcade-attestatie
  const probe = JSON.parse(fs.readFileSync(new URL('../shared/fixtures/signdata-mmr-2026-11-09.json', import.meta.url), 'utf8'));
  assert.throws(() => readAttestationDisclosure(probe.mmrdescriptor), /field count/);
});
