/**
 * Contracttest: elke geregistreerde game moet hieraan voldoen (gamecontract v1).
 * Een nieuwe game toevoegen zonder dat deze test slaagt, kan niet.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GameNotRegisteredError, gameRules, registeredGames, rulesPath } from './index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPORTS = ['validatePuzzle', 'publicPuzzle', 'normalizeAction', 'newState', 'applyAction', 'isTerminal', 'score', 'revealOnEnd'];
// Woorden die in een regelbestand niet mogen voorkomen: imports, toeval, tijd, I/O.
const FORBIDDEN = [/^\s*import\s/m, /\bimport\s*\(/, /\brequire\s*\(/, /^\s*export\s[^;]*\bfrom\s/m, /Math\.random/, /\bDate\b/, /\bprocess\./, /\bfetch\s*\(/, /\bglobalThis\b/, /\bcrypto\b/];

/** Speelt een vector na; geeft de waargenomen uitkomst in dezelfde vorm als de vector. */
function replay(rules, vector) {
  let state = rules.newState(vector.puzzle);
  const feedback = [];
  for (let i = 0; i < vector.actions.length; i++) {
    try {
      const out = rules.applyAction(state, vector.actions[i]);
      state = out.state;
      feedback.push(out.feedback);
    } catch (error) {
      return { errorAt: i, message: error.message };
    }
  }
  return { feedback, score: rules.score(state), terminal: rules.isTerminal(state), state };
}

test('register: onbekende game of versie geeft GAME_NOT_REGISTERED', () => {
  assert.throws(() => gameRules('nope', '1.0.0'), GameNotRegisteredError);
  assert.throws(() => gameRules('word-grid', '9.9.9'), (error) => error.code === 'GAME_NOT_REGISTERED');
  assert.throws(() => gameRules('__proto__', 'x'), GameNotRegisteredError);
});

for (const { slug, version, rules } of registeredGames()) {
  const dir = path.join(root, 'shared', 'games', slug, version);

  test(`${slug}@${version}: exports en meta volgen contract v1`, () => {
    for (const name of EXPORTS) assert.equal(typeof rules[name], 'function', `${name} ontbreekt`);
    assert.equal(rules.meta.contract, 1);
    assert.equal(rules.meta.slug, slug);
    assert.equal(rules.meta.version, version);
    assert.match(slug, /^[a-z][a-z0-9-]{1,30}$/);
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number.isSafeInteger(rules.meta.maxActions) && rules.meta.maxActions >= 1 && rules.meta.maxActions <= 50);
    assert.equal(typeof rules.meta.name, 'string');
    assert.ok(Object.isFrozen(rules.meta));
  });

  test(`${slug}@${version}: regelbestand is op zichzelf staand en deterministisch`, () => {
    const file = path.join(root, rulesPath(slug, version));
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `verboden in rules.mjs: ${pattern}`);
    assert.ok(fs.existsSync(path.join(dir, 'generator.mjs')), 'generator.mjs ontbreekt');
  });

  test(`${slug}@${version}: alle vectoren kloppen (≥ 20)`, () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
    assert.equal(vectors.contract, 1);
    assert.equal(vectors.slug, slug);
    assert.equal(vectors.version, version);
    assert.ok(vectors.cases.length >= 20, `minstens 20 gevallen, nu ${vectors.cases.length}`);
    assert.ok(vectors.cases.some((c) => c.errorAt !== undefined), 'minstens één ongeldige zet');
    assert.ok(vectors.cases.some((c) => c.score?.status === 'solved'), 'minstens één opgeloste ronde');
    assert.ok(vectors.cases.some((c) => c.score?.status === 'unsolved' && c.terminal), 'minstens één verloren ronde');
    for (const vector of vectors.cases) {
      const got = replay(rules, vector);
      if (vector.errorAt !== undefined) {
        assert.equal(got.errorAt, vector.errorAt, `${vector.name}: fout verwacht bij zet ${vector.errorAt}`);
        continue;
      }
      assert.equal(got.errorAt, undefined, `${vector.name}: onverwachte fout ${got.message}`);
      assert.deepEqual(got.feedback, vector.feedback, `${vector.name}: feedback`);
      assert.deepEqual(got.score, vector.score, `${vector.name}: score`);
      assert.equal(got.terminal, vector.terminal, `${vector.name}: einde`);
    }
  });

  test(`${slug}@${version}: zelfde invoer geeft dezelfde uitkomst; toestand en feedback zijn JSON`, () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
    for (const vector of vectors.cases.filter((c) => c.errorAt === undefined)) {
      const a = replay(rules, vector);
      const b = replay(rules, structuredClone(vector));
      assert.equal(JSON.stringify(a), JSON.stringify(b), vector.name);
      assert.deepEqual(JSON.parse(JSON.stringify(a.state)), a.state, `${vector.name}: toestand is geen zuivere JSON`);
      // Een zet past in het compacte record (komma als scheidingsteken) en in een tekenbericht.
      for (const action of vector.actions) {
        const canonical = rules.normalizeAction(action);
        assert.equal(typeof canonical, 'string');
        assert.doesNotMatch(canonical, /[,\s]/, `${vector.name}: canonieke zet bevat komma of witruimte`);
        assert.equal(rules.normalizeAction(canonical), canonical, `${vector.name}: normaliseren is niet idempotent`);
      }
      // newState verandert de puzzel niet, applyAction verandert de oude toestand niet.
      const puzzle = structuredClone(vector.puzzle);
      const state = rules.newState(puzzle);
      const before = JSON.stringify(state);
      rules.applyAction(state, vector.actions[0]);
      assert.equal(JSON.stringify(state), before, `${vector.name}: applyAction muteert de toestand`);
      assert.deepEqual(puzzle, vector.puzzle);
    }
  });

  test(`${slug}@${version}: generator maakt geldige puzzels`, async () => {
    const generator = await import(`./${slug}/${version}/generator.mjs`);
    let seed = 7;
    const random = { int: (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; } };
    for (let i = 0; i < 25; i++) {
      const puzzle = generator.createPuzzle({ random });
      assert.doesNotThrow(() => rules.validatePuzzle(puzzle));
      assert.deepEqual(JSON.parse(JSON.stringify(rules.publicPuzzle(puzzle))), rules.publicPuzzle(puzzle));
    }
  });
}
