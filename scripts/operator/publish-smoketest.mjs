/**
 * Rooktest van het hele wallet-pad van fase 2, los van een ronde:
 * een klein testrecord onder `Arcade.VRSCTEST.::arcade.test.ping` in de
 * identiteit van de speler zetten via een IdentityUpdateRequest.
 *
 * Waarom: zo testen we Verus Mobile (verzoek inlezen, transactie maken en
 * betalen, antwoord terugsturen), onze verificatie en het teruglezen van de
 * chain, zonder te wachten tot een ronde afgesloten is.
 *
 *   create <i-adres>   → verzoek aanmaken, wallet-link tonen (ACK CREATE_VRSCTEST_SMOKETEST)
 *   accept <url>       → callback-URL van de telefoon verwerken (ACK ACCEPT_VRSCTEST_SMOKETEST)
 *   check              → op de chain nakijken of het record er staat (alleen lezen)
 *
 * Toestand in server/data/publish-smoketest.json (git negeert server/data).
 * Alleen VRSCTEST. Doet niets zonder goedkeuring in de wallet van de speler.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { parseGenericResponseQuery } = await import('../../server/wallet-return.mjs');
const { serviceNamespace } = await import('../../server/verus/player-result.mjs');
const { locatePublishedRecord } = await import('../../server/verus/player-result-reader.mjs');
const { GENERIC_RESPONSE_QUERY_KEY, P, TESTNET_SYSTEM_ID, walletCompatibleIdentity } = await import('../../server/verus/requests.mjs');
const { canonicalJson } = await import('../../server/canonical-json.mjs');

const KEY_NAME = 'arcade.test.ping';
const STATE_PATH = path.resolve('server', 'data', 'publish-smoketest.json');
const [action, argument] = process.argv.slice(2);
const acks = { create: 'CREATE_VRSCTEST_SMOKETEST', accept: 'ACCEPT_VRSCTEST_SMOKETEST' };
if (!['create', 'accept', 'check'].includes(action) || (action !== 'check' && !argument)) {
  throw new Error('Gebruik: node scripts/operator/publish-smoketest.mjs create <i-adres> | accept <callback-url> | check');
}
if (acks[action] && process.env.VERUS_OPERATOR_ACK !== acks[action]) {
  throw new Error(`Zet VERUS_OPERATOR_ACK=${acks[action]} voor ${action}`);
}

const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ runtime });
const readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const writeState = (state) => fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

try {
  const verus = services.playerPublicationService?.verus;
  if (!verus) throw new Error('Wallet-verzoeken staan uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env');
  let output;
  if (action === 'create') {
    const playerId = argument;
    const { height: tip, state: service } = await verus.serviceState();
    const serviceFqn = service.current?.fullyqualifiedname;
    const keyFqn = `${serviceNamespace(serviceFqn)}::${KEY_NAME}`;
    const keyId = P.getDataKey(KEY_NAME, verus.serviceId, TESTNET_SYSTEM_ID).id;
    if (P.getDataKey(keyFqn, verus.serviceId, TESTNET_SYSTEM_ID).id !== keyId) throw new Error('Namespace-key klopt niet');
    const player = await verus.loadIdentity({ identityId: playerId, signingHeight: tip });
    const identity = player.current?.identity;
    if (!player.currentActive || !identity?.name || !identity?.parent) throw new Error('Spelersidentiteit niet actief of onvolledig');
    const contentFqn = await verus.identityContentName({ identityId: playerId, keyId });
    if (!walletCompatibleIdentity({ identityId: playerId, contentFqn })) {
      throw new Error(`Verus Mobile rekent ${contentFqn} verkeerd om (sub-ID op testnet); kies een naam.VRSCTEST@-ID`);
    }
    const recordJson = canonicalJson({
      schema: 'arcade-smoketest', version: 1, identity: playerId, createdAtHeight: tip, nonce: crypto.randomBytes(8).toString('hex'),
    });
    const requestIdHex = crypto.randomBytes(20).toString('hex');
    const built = await verus.createPlayerResultRequest({
      playerId, playerName: identity.name, playerParent: identity.parent, keyFqn, keyId, recordJson,
      callbackUrl: `${runtime.origin}/api/v1/publish-jobs/${requestIdHex}/response`, requestIdHex, responseMode: 'redirect', ttlBlocks: 60,
    });
    const state = {
      playerId, playerName: player.current?.fullyqualifiedname ?? identity.name, keyFqn, keyId, recordJson,
      recordSha256: crypto.createHash('sha256').update(recordJson, 'utf8').digest('hex'),
      requestIdHex, requestHex: built.requestHex, walletUri: built.walletUri, createdHeight: built.height, expiryHeight: built.expiryHeight,
      receiptTxid: null,
    };
    writeState(state);
    output = { operation: 'smoketest-create', playerName: state.playerName, keyFqn, keyId, recordJson, expiryHeight: built.expiryHeight, walletUri: built.walletUri };
  } else if (action === 'accept') {
    const state = readState();
    const url = new URL(argument);
    const match = url.pathname.match(/\/api\/v1\/publish-jobs\/([0-9a-f]{40})\/response$/);
    if (!match || match[1] !== state.requestIdHex) throw new Error('Deze URL hoort niet bij het lopende rooktest-verzoek');
    const body = parseGenericResponseQuery(url.searchParams, GENERIC_RESPONSE_QUERY_KEY);
    const verified = await verus.verifyPlayerResultResponse({
      body, requestHex: state.requestHex, requestIdHex: state.requestIdHex, playerId: state.playerId, keyId: state.keyId, recordJson: state.recordJson,
    });
    writeState({ ...state, receiptTxid: verified.txid, signingHeight: verified.signingHeight });
    output = { operation: 'smoketest-accept', verified };
  } else {
    const state = readState();
    const { tip, content, history } = await verus.readIdentityContent({ identityId: state.playerId, keyId: state.keyId });
    const located = locatePublishedRecord({ content, history, keyId: state.keyId, recordSha256: state.recordSha256 });
    const receipt = state.receiptTxid ? await verus.transactionStatus(state.receiptTxid) : null;
    output = { operation: 'smoketest-check', tip, playerName: state.playerName, receiptTxid: state.receiptTxid, receipt, located };
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ operation: `smoketest-${action}`, error: error.code ?? error.name, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  services.close();
}
