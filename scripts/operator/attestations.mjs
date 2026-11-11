/**
 * Fase 2b: attestaties door Arcade@ (operator-commando).
 *
 *   list <ronde>                          → overzicht (alleen lezen; geen waarden/zouten)
 *   create <ronde>                        → attestaties maken en tekenen voor alle spelers met een
 *                                           getekende poging (ACK CREATE_VRSCTEST_ATTESTATIONS).
 *                                           Pas na bevestigde result-root; in rondevolgorde.
 *   disclose <ronde> <speler> <veld,...>  → openbaarmaking van enkele velden (player en round altijd mee).
 *                                           Bevat de zouten van die velden: alleen voor de speler zelf.
 *   publish-create <ronde> <speler> [--ttl-blocks <n>]
 *                                         → verzoek om de VERZEGELDE attestatie (zonder waarden en zouten)
 *                                           in de ID van de speler te zetten (ACK CREATE_VRSCTEST_ATTESTATION_PUBLISH)
 *   publish-accept <callback-url>         → wallet-antwoord verwerken (ACK ACCEPT_VRSCTEST_ATTESTATION_PUBLISH)
 *   publish-check                         → op de chain nakijken (alleen lezen)
 *
 * Toestand van de publicatie in server/data/attestation-publish.json (git negeert server/data).
 * Laadt `.env` zelf (service-ID en WIF blijven in dit proces). Alleen VRSCTEST.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
// ARCADE_TEST_ROUNDS=1 → testdatabase (server/test-rounds.mjs); na .env, zodat de schakelaar wint.
(await import('../../server/test-rounds.mjs')).applyTestRoundEnvironment();
const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { createRoundAttestations, sealedAttestationRecord } = await import('../../server/attestation-service.mjs');
const { discloseAttestation, readAttestationDisclosure } = await import('../../server/attestation.mjs');
const { attestationKeyName, serviceContentKey } = await import('../../server/verus/player-result.mjs');
const { locatePublishedRecord } = await import('../../server/verus/player-result-reader.mjs');
const { parseGenericResponseQuery } = await import('../../server/wallet-return.mjs');
const { GENERIC_RESPONSE_QUERY_KEY, walletCompatibleIdentity } = await import('../../server/verus/requests.mjs');
const { canonicalJson } = await import('../../server/canonical-json.mjs');

const args = process.argv.slice(2);
const ttlFlag = args.indexOf('--ttl-blocks');
const ttlBlocks = ttlFlag === -1 ? 60 : Number(args.splice(ttlFlag, 2)[1]);
const [action, ...rest] = args;
const usage = 'Gebruik: node scripts/operator/attestations.mjs list|create <ronde> | disclose <ronde> <speler> <veld,...> | publish-create <ronde> <speler> [--ttl-blocks n] | publish-accept <url> | publish-check';
const acks = {
  create: 'CREATE_VRSCTEST_ATTESTATIONS',
  'publish-create': 'CREATE_VRSCTEST_ATTESTATION_PUBLISH',
  'publish-accept': 'ACCEPT_VRSCTEST_ATTESTATION_PUBLISH',
};
const arity = { list: 1, create: 1, disclose: 3, 'publish-create': 2, 'publish-accept': 1, 'publish-check': 0 };
if (!(action in arity) || rest.length !== arity[action]) throw new Error(usage);
if (!Number.isSafeInteger(ttlBlocks) || ttlBlocks < 1 || ttlBlocks > 10_000) throw new Error('--ttl-blocks moet tussen 1 en 10000 liggen');
if (acks[action] && process.env.VERUS_OPERATOR_ACK !== acks[action]) throw new Error(`Zet VERUS_OPERATOR_ACK=${acks[action]} voor ${action}`);

const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ runtime });
const STATE_PATH = path.resolve('server', 'data', 'attestation-publish.json');
const readState = () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const writeState = (state) => fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const summary = (a) => ({ player: a.playerIAddress, streak: a.streak, rounds: a.rounds, solved: a.solved, root: a.root, prevRoot: a.prevRoot, signatureHeight: a.signatureHeight });

try {
  const { repository } = services;
  const verus = services.playerPublicationService?.verus;
  const needVerus = () => { if (!verus) throw new Error('Wallet-laag staat uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env'); return verus; };
  const roundOf = (id) => { const r = repository.getRound(id); if (!r) throw new Error('Ronde bestaat niet'); return r; };
  let output;
  if (action === 'list') {
    const round = roundOf(rest[0]);
    output = { operation: 'attestations-list', round: round.id, attestations: repository.listRoundAttestations(round.id).map(summary) };
  } else if (action === 'create') {
    const v = needVerus();
    const signer = { serviceId: v.serviceId, signMmrRoot: (root) => v.signMmrRoot(root) };
    const result = await createRoundAttestations({ repository, signer, roundRecordId: roundOf(rest[0]).id });
    output = { operation: 'attestations-create', ...result };
  } else if (action === 'disclose') {
    const [roundId, player, fields] = rest;
    const attestation = repository.getAttestation({ playerIAddress: player, roundRecordId: roundOf(roundId).id });
    if (!attestation) throw new Error('Geen attestatie voor deze speler en ronde');
    const mmrdescriptor = discloseAttestation(attestation, fields.split(',').filter(Boolean));
    output = { operation: 'attestations-disclose', check: readAttestationDisclosure(mmrdescriptor).fields, disclosure: { mmrdescriptor, signaturedata: attestation.signaturedata, signatureheight: attestation.signatureHeight } };
  } else if (action === 'publish-create') {
    const v = needVerus();
    const [roundId, playerId] = rest;
    const round = roundOf(roundId);
    const attestation = repository.getAttestation({ playerIAddress: playerId, roundRecordId: round.id });
    if (!attestation) throw new Error('Geen attestatie voor deze speler en ronde; eerst create');
    const { height: tip, state: service } = await v.serviceState();
    const { fqn: keyFqn, keyId } = serviceContentKey({ name: attestationKeyName(round.round_id), serviceId: v.serviceId, serviceFqn: service.current?.fullyqualifiedname });
    const player = await v.loadIdentity({ identityId: playerId, signingHeight: tip });
    const identity = player.current?.identity;
    if (!player.currentActive || !identity?.name || !identity?.parent) throw new Error('Spelersidentiteit niet actief of onvolledig');
    const contentFqn = await v.identityContentName({ identityId: playerId, keyId });
    if (!walletCompatibleIdentity({ identityId: playerId, contentFqn })) throw new Error(`Verus Mobile rekent ${contentFqn} verkeerd om (sub-ID op testnet)`);
    const recordJson = canonicalJson(sealedAttestationRecord(attestation, round));
    if (Buffer.byteLength(recordJson) > 2048) throw new Error('Verzegelde attestatie is groter dan 2048 bytes');
    const requestIdHex = crypto.randomBytes(20).toString('hex');
    const built = await v.createPlayerResultRequest({
      playerId, playerName: identity.name, playerParent: identity.parent, keyFqn, keyId, recordJson,
      // Eigen pad dat de webserver niet kent: de pagina mag falen, de URL in de adresbalk bevat het antwoord.
      callbackUrl: `${runtime.origin}/api/v1/attestation-jobs/${requestIdHex}/response`, requestIdHex, responseMode: 'redirect', ttlBlocks,
    });
    const state = {
      round: round.id, playerId, playerName: player.current?.fullyqualifiedname ?? identity.name, keyFqn, keyId, recordJson,
      recordSha256: crypto.createHash('sha256').update(recordJson, 'utf8').digest('hex'),
      requestIdHex, requestHex: built.requestHex, walletUri: built.walletUri, createdHeight: built.height, expiryHeight: built.expiryHeight, receiptTxid: null,
    };
    writeState(state);
    output = { operation: 'attestation-publish-create', playerName: state.playerName, keyFqn, keyId, recordBytes: Buffer.byteLength(recordJson), recordSha256: state.recordSha256, expiryHeight: built.expiryHeight, walletUri: built.walletUri };
  } else if (action === 'publish-accept') {
    const v = needVerus();
    const state = readState();
    const url = new URL(rest[0]);
    const match = url.pathname.match(/\/api\/v1\/attestation-jobs\/([0-9a-f]{40})\/response$/);
    if (!match || match[1] !== state.requestIdHex) throw new Error('Deze URL hoort niet bij het lopende attestatie-verzoek');
    const body = parseGenericResponseQuery(url.searchParams, GENERIC_RESPONSE_QUERY_KEY);
    const verified = await v.verifyPlayerResultResponse({
      body, requestHex: state.requestHex, requestIdHex: state.requestIdHex, playerId: state.playerId, keyId: state.keyId, recordJson: state.recordJson,
    });
    writeState({ ...state, receiptTxid: verified.txid, signingHeight: verified.signingHeight });
    output = { operation: 'attestation-publish-accept', verified };
  } else {
    const v = needVerus();
    const state = readState();
    const { tip, content, history } = await v.readIdentityContent({ identityId: state.playerId, keyId: state.keyId });
    const decrypt = (descriptor, txid) => v.decryptDataDescriptor({ descriptor, txid }).catch(() => null);
    const located = await locatePublishedRecord({ content, history, keyId: state.keyId, recordSha256: state.recordSha256, fallbackTxid: state.receiptTxid, decrypt });
    const receipt = state.receiptTxid ? await v.transactionStatus(state.receiptTxid) : null;
    output = { operation: 'attestation-publish-check', tip, playerName: state.playerName, round: state.round, receiptTxid: state.receiptTxid, receipt, located };
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ operation: `attestations-${action}`, error: error.code ?? error.name, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  services.close();
}
