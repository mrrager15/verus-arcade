import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkRpc, resolveRun, RPC_ALLOWED, RPC_FORBIDDEN } from './relay-policy.mjs';

// Platform-onafhankelijk: path.resolve geeft op Windows C:\repo\..., op Linux /repo/...
const repoRoot = path.resolve('/repo');
const known = new Set([
  path.join(repoRoot, 'scripts', 'integration', 'vrsctest-daily-readiness.mjs'),
  path.join(repoRoot, 'scripts', 'agent', 'relay-client.mjs'),
]);
const exists = (p) => known.has(path.resolve(p));
const opts = { repoRoot, platform: 'linux', exists, execPath: '/usr/bin/node' };

test('whitelist en verboden lijst overlappen niet', () => {
  for (const m of RPC_FORBIDDEN) assert.ok(!RPC_ALLOWED.has(m), `${m} staat in beide lijsten`);
});

test('leesmethodes zijn toegestaan', () => {
  assert.doesNotThrow(() => checkRpc('getinfo', []));
  assert.doesNotThrow(() => checkRpc('getidentity', ['Arcade@']));
  assert.doesNotThrow(() => checkRpc('getidentitycontent', ['Arcade@', 0, 100, false, 100, 'iKey']));
});

test('schrijf- en sleutelmethodes worden geweigerd', () => {
  for (const m of ['updateidentity', 'sendcurrency', 'sendrawtransaction', 'dumpprivkey', 'definecurrency', 'z_getoperationresult']) {
    assert.throws(() => checkRpc(m, []), /verboden/);
  }
  assert.throws(() => checkRpc('onbekendemethode', []), /niet toegestaan/);
});

test('z_getoperationstatus vereist een opid-lijst', () => {
  assert.throws(() => checkRpc('z_getoperationstatus', []), /expliciete lijst/);
  assert.throws(() => checkRpc('z_getoperationstatus', [[]]), /expliciete lijst/);
  assert.doesNotThrow(() => checkRpc('z_getoperationstatus', [['opid-123']]));
});

test('params moet een array zijn', () => {
  assert.throws(() => checkRpc('getinfo', 'x'), /array/);
});

test('npm test is toegestaan, npm publish niet', () => {
  assert.deepEqual(resolveRun({ cmd: 'npm', args: ['test'] }, opts), { cmd: 'npm', args: ['test'], env: {} });
  assert.throws(() => resolveRun({ cmd: 'npm', args: ['publish'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'npm', args: ['run', 'build', '--', '--evil'] }, opts), /niet toegestaan/);
});

test('npm wordt npm.cmd op Windows', () => {
  assert.equal(resolveRun({ cmd: 'npm', args: ['test'] }, { ...opts, platform: 'win32' }).cmd, 'npm.cmd');
});

test('node mag alleen bestaande scripts in de toegestane mappen draaien', () => {
  const ok = resolveRun({ cmd: 'node', args: ['scripts/integration/vrsctest-daily-readiness.mjs'] }, opts);
  assert.equal(ok.cmd, '/usr/bin/node');
  assert.equal(ok.args[0], path.join(repoRoot, 'scripts', 'integration', 'vrsctest-daily-readiness.mjs'));
  assert.throws(() => resolveRun({ cmd: 'node', args: ['scripts/integration/bestaat-niet.mjs'] }, opts), /niet gevonden/);
  assert.throws(() => resolveRun({ cmd: 'node', args: ['server/app.mjs'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'node', args: ['scripts/integration/../../server/app.mjs'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'node', args: ['-e', 'process.exit()'] }, opts), /niet toegestaan/);
});

test('alleen ACK- en ARCADE-variabelen mogen mee', () => {
  assert.doesNotThrow(() => resolveRun({ cmd: 'npm', args: ['test'], env: { VERUS_DAILY_UI_ACK: 'x', ARCADE_NETWORK: 'vrsctest' } }, opts));
  assert.throws(() => resolveRun({ cmd: 'npm', args: ['test'], env: { PATH: '/evil' } }, opts), /omgevingsvariabele/);
  assert.throws(() => resolveRun({ cmd: 'npm', args: ['test'], env: { ARCADE_X: 5 } }, opts), /omgevingsvariabele/);
});

test('andere commando\'s worden geweigerd', () => {
  assert.throws(() => resolveRun({ cmd: 'powershell', args: ['-c', 'dir'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'npm', args: 'test' }, opts), /lijst van strings/);
});

test('git: alleen push naar origin van gewone branches', () => {
  assert.deepEqual(resolveRun({ cmd: 'git', args: ['push', 'origin', 'master', 'feat/foundation'] }, opts), { cmd: 'git', args: ['push', 'origin', 'master', 'feat/foundation'], env: {} });
  assert.throws(() => resolveRun({ cmd: 'git', args: ['push', 'origin', '--force', 'master'] }, opts), /ongeldige branchnaam/);
  assert.throws(() => resolveRun({ cmd: 'git', args: ['push', 'origin', 'master:main'] }, opts), /ongeldige branchnaam/);
  assert.throws(() => resolveRun({ cmd: 'git', args: ['push', 'upstream', 'master'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'git', args: ['push'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'git', args: ['reset', '--hard'] }, opts), /niet toegestaan/);
  assert.throws(() => resolveRun({ cmd: 'git', args: ['push', 'origin', 'x'.repeat(102)] }, opts), /ongeldige branchnaam/);
});
