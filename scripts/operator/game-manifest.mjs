/**
 * Fase 8: manifesten van games maken, laten tekenen, publiceren op de
 * operator-ID en controleren vanaf de chain.
 *
 *   node scripts/operator/game-manifest.mjs list
 *   node scripts/operator/game-manifest.mjs show <slug>[@versie] [--developer <i-adres>]
 *   VERUS_OPERATOR_ACK=SIGN_VRSCTEST_GAME_MANIFEST         … sign-service <slug>[@versie]
 *   VERUS_OPERATOR_ACK=REQUEST_VRSCTEST_MANIFEST_SIGNATURE … sign-request <slug>[@versie] --developer <i-adres>
 *   VERUS_OPERATOR_ACK=PUBLISH_VRSCTEST_GAME_MANIFEST      … publish-prepare|publish-submit|publish-reconcile <slug>[@versie]
 *   node scripts/operator/game-manifest.mjs verify <slug>[@versie]   (alleen lezen: chain → handtekening + regels-hash)
 *
 * sign-service: Arcade@ is zelf de ontwikkelaar (de server tekent met de service-WIF).
 * sign-request: wallet-link voor een externe ontwikkelaar; het antwoord komt binnen
 * op de webserver (/api/v1/manifest-jobs/…), die dus moet draaien.
 * Publiceren is één identity-update op de operator-ID (journaal, zoals de rondes);
 * nooit tegelijk met de nachtcyclus. Met ARCADE_TEST_ROUNDS=1: testdatabase en
 * test-operator arcade-storage-poc@.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

// .env (service-WIF) laden vóór de servermodules, zoals publications-reconcile.mjs.
try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* geen .env: dan moet de omgeving het leveren */ }
const { applyTestRoundEnvironment } = await import('../../server/test-rounds.mjs');
const mode = applyTestRoundEnvironment();
const { loadConfig } = await import('../../server/config.mjs');
const { canonicalJson } = await import('../../server/canonical-json.mjs');
const { manifestKeyName } = await import('../../server/game-manifest.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { parseGameOption } = await import('../../server/games/generators.mjs');
const { VerusGateway } = await import('../../server/verus/gateway.mjs');
const { rpc } = await import('../../server/rpc.mjs');

const ACKS = {
  'sign-service': 'SIGN_VRSCTEST_GAME_MANIFEST',
  'sign-request': 'REQUEST_VRSCTEST_MANIFEST_SIGNATURE',
  'publish-prepare': 'PUBLISH_VRSCTEST_GAME_MANIFEST',
  'publish-submit': 'PUBLISH_VRSCTEST_GAME_MANIFEST',
  'publish-reconcile': 'PUBLISH_VRSCTEST_GAME_MANIFEST',
};
const [action, target, ...rest] = process.argv.slice(2);
const option = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
if (!['list', 'show', 'verify', ...Object.keys(ACKS)].includes(action)) {
  throw new Error('Gebruik: game-manifest.mjs list | show|verify|sign-service|sign-request|publish-prepare|publish-submit|publish-reconcile <slug>[@versie] [--developer <i-adres>]');
}
if (ACKS[action] && process.env.VERUS_OPERATOR_ACK !== ACKS[action]) throw new Error(`Zet VERUS_OPERATOR_ACK=${ACKS[action]} voor ${action}`);

const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ databasePath: mode.databasePath, runtime });
const out = (value) => console.log(JSON.stringify(value, null, 2));
try {
  const { repository, gameManifestService: service } = services;
  if (!service) throw new Error('Manifesten vereisen ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF in .env');
  if (action === 'list') {
    out({ operation: 'game-manifest-list', databasePath: mode.databasePath, manifests: repository.listGameManifests().map(({ slug, gameVersion, developer, status, requestIdHex, updatedAt }) => ({ slug, gameVersion, developer, status, requestIdHex, updatedAt: new Date(updatedAt).toISOString() })) });
  } else {
    if (!target) throw new Error('Geef de game: <slug>[@versie]');
    const { gameId: slug, gameVersion: version } = parseGameOption(target);
    const keyName = manifestKeyName(slug);
    const keyId = (await rpc('getvdxfid', [keyName])).vdxfid;
    const operationKey = `vrsctest:game-manifest:${slug}@${version}:v1`;
    const gateway = new VerusGateway({
      rpc: { call: rpc }, repository, network: 'vrsctest',
      identityName: mode.operator.name, identityIAddress: mode.operator.iAddress, minimumConfirmations: 1,
    });
    const journal = () => { const e = repository.getChainOperation(operationKey); return e ? { state: e.state, txid: e.txid, error: e.error_code ?? null } : null; };
    if (action === 'show') {
      const built = service.build({ slug, version, developer: option('--developer') ?? service.verus.serviceId });
      out({ operation: 'game-manifest-show', keyName, keyId, ...built, stored: repository.getGameManifest(slug, version)?.status ?? null, journal: journal() });
    } else if (action === 'sign-service') {
      const row = await service.signAsService({ slug, version });
      out({ operation: 'game-manifest-sign-service', status: row.status, manifest: row.signed });
    } else if (action === 'sign-request') {
      const developer = option('--developer');
      if (!developer) throw new Error('sign-request vereist --developer <i-adres>');
      const row = await service.createDeveloperRequest({ slug, version, developer });
      out({ operation: 'game-manifest-sign-request', status: row.status, developer, message: row.message, requestIdHex: row.requestIdHex, expiresHeight: row.expiresHeight, walletUri: row.walletUri, deeplinkLength: row.walletUri.length });
    } else if (action === 'publish-prepare') {
      const row = repository.getGameManifest(slug, version);
      if (row?.status !== 'signed') throw new Error('Eerst een getekend manifest (sign-service of sign-request)');
      await service.verifySigned(row.signed);
      const json = canonicalJson(row.signed);
      const prepared = await gateway.prepareIdentityUpdate({
        journalId: crypto.randomUUID(), operationType: 'game-manifest', operationKey,
        changes: { [keyId]: [Buffer.from(json, 'utf8').toString('hex')] }, now: Date.now(),
      });
      out({ operation: 'game-manifest-publish-prepare', operator: mode.operator.name, keyName, keyId, bytes: Buffer.byteLength(json), journal: { state: prepared.entry.state, txid: prepared.entry.txid } });
    } else if (action === 'publish-submit') {
      await gateway.submit({ operationKey, now: Date.now() });
      out({ operation: 'game-manifest-publish-submit', journal: journal() });
    } else if (action === 'publish-reconcile') {
      await gateway.reconcile({ operationKey, now: Date.now() });
      out({ operation: 'game-manifest-publish-reconcile', journal: journal() });
    } else if (action === 'verify') {
      const identity = await rpc('getidentity', [mode.operator.iAddress]);
      const values = identity?.identity?.contentmultimap?.[keyId] ?? [];
      if (values.length === 0) throw new Error(`Geen manifest onder ${keyName} op ${mode.operator.name}`);
      const raw = typeof values[0] === 'string' ? values[0] : Object.values(values[0])[0];
      const signed = JSON.parse(Buffer.from(raw, 'hex').toString('utf8'));
      const check = await service.verifySigned(signed);
      out({ operation: 'game-manifest-verify', operator: mode.operator.name, keyName, keyId, manifest: signed, check });
    }
  }
} finally {
  services.close();
}
