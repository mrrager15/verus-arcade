/**
 * Fase 5, rooktest: kan Verus Mobile een record in de identiteit van de speler
 * zetten dat VERSLEUTELD is naar een adres dat wij kiezen (`encrypttoaddress`)?
 *
 * Zelfde opzet als publish-smoketest.mjs (fase 2), los van een ronde: een klein
 * testrecord onder `Arcade.VRSCTEST.::arcade.test.bundle`, versleuteld naar het
 * adres van een test-salt (shared/round-key.mjs). Daarna lezen we het terug van
 * de chain en openen het met de sleutel uit die salt.
 *
 *   create <i-adres> [--qr <png>] [--ttl-blocks <n>]
 *                        → verzoek aanmaken, wallet-link en QR (ACK CREATE_VRSCTEST_BUNDLE_SMOKETEST)
 *   check [--url <rpc>] [--daemon]
 *                        → op de chain nakijken (alleen lezen; standaard de publieke RPC, geen .env nodig)
 *   accept <url>         → callback-URL van de telefoon verwerken (ACK ACCEPT_VRSCTEST_BUNDLE_SMOKETEST; optioneel)
 *
 * Toestand in server/data/bundle-smoketest.json (git negeert server/data). De
 * test-salt daarin dient alleen voor deze test. Alleen VRSCTEST. Doet niets
 * zonder goedkeuring in de wallet van de speler; raakt Arcade@ niet.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createChainReader, firstUpdateWithValue } from '../../shared/chain-reader.mjs';
import { roundKeyFromSalt } from '../../shared/round-key.mjs';
import { DATA_DESCRIPTOR_KEY, FLAG_ENCRYPTED, FLAG_IVK, readMobileRecord } from '../../shared/verus-decrypt.mjs';

const KEY_NAME = 'arcade.test.bundle';
const STATE_PATH = path.resolve('server', 'data', 'bundle-smoketest.json');
const DEFAULT_QR_PATH = path.resolve('server', 'data', 'bundle-smoketest-qr.png');
const USAGE = 'Gebruik: node scripts/operator/bundle-smoketest.mjs create <i-adres> [--qr <png>] [--ttl-blocks <n>] | check [--url <rpc>] [--daemon] | accept <callback-url>';

const args = process.argv.slice(2);
const action = args[0];
const optionIndex = (name) => args.indexOf(name);
const option = (name, fallback) => (optionIndex(name) >= 0 ? args[optionIndex(name) + 1] : fallback);
const argument = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
const acks = { create: 'CREATE_VRSCTEST_BUNDLE_SMOKETEST', accept: 'ACCEPT_VRSCTEST_BUNDLE_SMOKETEST' };
if (!['create', 'accept', 'check'].includes(action) || (action !== 'check' && !argument)) throw new Error(USAGE);
if (acks[action] && process.env.VERUS_OPERATOR_ACK !== acks[action]) {
  throw new Error(`Zet VERUS_OPERATOR_ACK=${acks[action]} voor ${action}`);
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const writeState = (state) => fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

/** De wallet-laag (service-ID en -sleutel uit .env, daemon uit vrsctest.conf): alleen voor create, accept en --daemon. */
async function loadServices() {
  try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
  const { loadConfig } = await import('../../server/config.mjs');
  const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
  const runtime = loadConfig();
  if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
  const services = createRuntimeServices({ runtime });
  const verus = services.playerPublicationService?.verus;
  if (!verus) { services.close(); throw new Error('Wallet-verzoeken staan uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env'); }
  return { runtime, services, verus };
}

async function create() {
  const { serviceNamespace } = await import('../../server/verus/player-result.mjs');
  const { P, TESTNET_SYSTEM_ID, walletCompatibleIdentity } = await import('../../server/verus/requests.mjs');
  const { canonicalJson } = await import('../../server/canonical-json.mjs');
  const QRCode = (await import('qrcode')).default;
  const { runtime, services, verus } = await loadServices();
  try {
    const playerId = argument;
    const ttlBlocks = Number(option('--ttl-blocks', '120'));
    const { height: tip, state: service } = await verus.serviceState();
    const keyFqn = `${serviceNamespace(service.current?.fullyqualifiedname)}::${KEY_NAME}`;
    const keyId = P.getDataKey(KEY_NAME, verus.serviceId, TESTNET_SYSTEM_ID).id;
    if (P.getDataKey(keyFqn, verus.serviceId, TESTNET_SYSTEM_ID).id !== keyId) throw new Error('Namespace-key klopt niet');
    const player = await verus.loadIdentity({ identityId: playerId, signingHeight: tip });
    const identity = player.current?.identity;
    if (!player.currentActive || !identity?.name || !identity?.parent) throw new Error('Spelersidentiteit niet actief of onvolledig');
    const contentFqn = await verus.identityContentName({ identityId: playerId, keyId });
    if (!walletCompatibleIdentity({ identityId: playerId, contentFqn })) {
      throw new Error(`Verus Mobile rekent ${contentFqn} verkeerd om (sub-ID op testnet); kies een naam.VRSCTEST@-ID`);
    }
    // De "ronde" van deze test: een verse salt, daaruit adres en leessleutel.
    const salt = crypto.randomBytes(32).toString('hex');
    const key = roundKeyFromSalt(salt);
    const recordJson = canonicalJson({
      schema: 'arcade-smoketest-bundle', version: 1, identity: playerId, createdAtHeight: tip, nonce: crypto.randomBytes(8).toString('hex'),
    });
    const requestIdHex = crypto.randomBytes(20).toString('hex');
    const built = await verus.createPlayerResultRequest({
      playerId, playerName: identity.name, playerParent: identity.parent, keyFqn, keyId, recordJson, encryptToAddress: key.address,
      callbackUrl: `${runtime.origin}/api/v1/publish-jobs/${requestIdHex}/response`, requestIdHex, responseMode: 'redirect', ttlBlocks,
    });
    const qrPath = path.resolve(option('--qr', DEFAULT_QR_PATH));
    // Foutcorrectie L en groot: een lange deeplink moet scanbaar blijven (les van 9 nov).
    await QRCode.toFile(qrPath, built.walletUri, { errorCorrectionLevel: 'L', width: 900, margin: 4 });
    writeState({
      playerId, playerName: player.current?.fullyqualifiedname ?? identity.name, keyFqn, keyId, recordJson, recordSha256: sha256(recordJson),
      salt, encryptToAddress: key.address,
      requestIdHex, requestHex: built.requestHex, walletUri: built.walletUri, createdHeight: built.height, expiryHeight: built.expiryHeight,
      receiptTxid: null,
    });
    return {
      operation: 'bundle-smoketest-create', playerName: player.current?.fullyqualifiedname ?? identity.name, keyFqn, keyId,
      encryptToAddress: key.address, recordJson, createdHeight: built.height, expiryHeight: built.expiryHeight,
      walletUriLength: built.walletUri.length, qrPath, walletUri: built.walletUri,
    };
  } finally {
    services.close();
  }
}

async function accept() {
  const { parseGenericResponseQuery } = await import('../../server/wallet-return.mjs');
  const { GENERIC_RESPONSE_QUERY_KEY } = await import('../../server/verus/requests.mjs');
  const { services, verus } = await loadServices();
  try {
    const state = readState();
    const url = new URL(argument);
    const match = url.pathname.match(/\/api\/v1\/publish-jobs\/([0-9a-f]{40})\/response$/);
    if (!match || match[1] !== state.requestIdHex) throw new Error('Deze URL hoort niet bij het lopende rooktest-verzoek');
    const body = parseGenericResponseQuery(url.searchParams, GENERIC_RESPONSE_QUERY_KEY);
    const verified = await verus.verifyPlayerResultResponse({
      body, requestHex: state.requestHex, requestIdHex: state.requestIdHex, playerId: state.playerId, keyId: state.keyId,
      recordJson: state.recordJson, encryptToAddress: state.encryptToAddress,
    });
    writeState({ ...state, receiptTxid: verified.txid, signingHeight: verified.signingHeight });
    return { operation: 'bundle-smoketest-accept', verified };
  } finally {
    services.close();
  }
}

const MEANING = {
  ga: 'GA: het record staat in de ID, versleuteld naar ons adres, zonder leessleutel erbij, en wij lezen het met de sleutel uit de salt.',
  public: 'NIET GOED: het record staat er, maar MET een leessleutel in de ID (publiek leesbaar). De wallet of de node negeerde encrypttoaddress → plan B.',
  unreadable: 'ONDUIDELIJK: er staat een nieuwe waarde onder de key, maar onze sleutel opent ze niet. Bytes bewaren en vergelijken met de droge proef.',
  'not-found': 'NOG NIETS: geen nieuwe waarde onder de key. Nog niet gescand, transactie nog niet in een blok, of geweigerd door de wallet.',
};

async function check() {
  const state = readState();
  const key = roundKeyFromSalt(state.salt);
  const wrongKey = roundKeyFromSalt(crypto.randomBytes(32).toString('hex'));
  const reader = createChainReader({ url: option('--url', undefined), limits: { timeMs: 30_000 } });
  const info = await reader.info();
  const content = await reader.call('getidentitycontent', [state.playerId, 0, info.tip, false, info.tip, state.keyId]);
  if (content?.identity?.identityaddress !== state.playerId) throw new Error('De RPC gaf een andere identiteit terug');
  const history = await reader.identityHistory({ identityId: state.playerId, fromHeight: Math.max(0, state.createdHeight - 1), toHeight: info.tip });
  const getTransaction = (txid) => reader.call('getrawtransaction', [txid, 1]);

  const all = content.identity.contentmultimap?.[state.keyId];
  const unique = [...new Map((Array.isArray(all) ? all : []).map((v) => [JSON.stringify(v), v])).values()];
  const values = [];
  for (const value of unique) {
    const entry = firstUpdateWithValue(history, state.keyId, value);
    if (!entry) continue; // ouder dan dit verzoek (een vorige rooktest)
    const descriptor = value?.[DATA_DESCRIPTOR_KEY] ?? {};
    const flags = Number(descriptor.flags);
    const item = {
      txid: entry.txid, height: entry.height, confirmations: null, flags,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0, viewingKeyInIdentity: (flags & FLAG_IVK) !== 0 || 'ivk' in descriptor,
      decryptedWithOurKey: false, equalsRecord: false, wrongKeyOpens: null, error: null,
    };
    try {
      item.confirmations = Number((await getTransaction(entry.txid))?.confirmations ?? 0);
      const record = await readMobileRecord({ value, updateTxid: entry.txid, getTransaction, ivk: key.ivk });
      item.decryptedWithOurKey = true;
      item.equalsRecord = sha256(new TextDecoder().decode(record.bytes)) === state.recordSha256;
      if (!record.ivkPublished) {
        item.wrongKeyOpens = await readMobileRecord({ value, updateTxid: entry.txid, getTransaction, ivk: wrongKey.ivk }).then(() => true, () => false);
      }
    } catch (error) {
      item.error = error.message;
    }
    if (optionIndex('--daemon') >= 0) item.daemon = await daemonCheck(value, entry.txid, key.ivkHex);
    values.push(item);
  }

  const match = values.find((v) => v.equalsRecord);
  const verdict = match
    ? (match.encrypted && !match.viewingKeyInIdentity && match.wrongKeyOpens === false ? 'ga' : 'public')
    : values.length > 0 ? 'unreadable' : 'not-found';
  const receipt = state.receiptTxid ? await getTransaction(state.receiptTxid).then((tx) => ({ confirmations: Number(tx?.confirmations ?? 0) }), () => null) : null;
  return {
    operation: 'bundle-smoketest-check', verdict, meaning: MEANING[verdict], rpc: reader.url, tip: info.tip,
    playerName: state.playerName, keyId: state.keyId, encryptToAddress: state.encryptToAddress,
    requestCreatedHeight: state.createdHeight, requestExpiryHeight: state.expiryHeight, requestExpired: info.tip > state.expiryHeight,
    valuesUnderKey: unique.length, newValues: values, receiptTxid: state.receiptTxid, receipt, rpcCalls: reader.stats().calls,
  };
}

/** Tegenproef op de eigen daemon: `decryptdata` zonder sleutel moet falen, met onze ivk slagen. */
async function daemonCheck(value, txid, ivkHex) {
  const { services, verus } = await loadServices();
  const decrypt = (params) => verus.client.interface.request({ cmd: 'decryptdata', getParams: () => [params] })
    .then((reply) => (reply?.error || reply?.result == null ? { ok: false } : { ok: true, result: reply.result }), () => ({ ok: false }));
  try {
    const descriptor = value[DATA_DESCRIPTOR_KEY];
    const withoutKey = await decrypt({ datadescriptor: descriptor, txid, retrieve: true });
    const withKey = await decrypt({ datadescriptor: descriptor, ivk: ivkHex, txid, retrieve: true });
    return { withoutKey: withoutKey.ok, withIvk: withKey.ok, objectdata: withKey.ok ? JSON.stringify(withKey.result).slice(0, 400) : null };
  } finally {
    services.close();
  }
}

try {
  const output = action === 'create' ? await create() : action === 'accept' ? await accept() : await check();
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ operation: `bundle-smoketest-${action}`, error: error.code ?? error.name, message: error.message }, null, 2));
  process.exitCode = 1;
}
