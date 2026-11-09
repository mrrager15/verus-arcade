/**
 * Fase 2, operator-hulp voor de wallet-test op afstand (Simon niet thuis):
 * maakt het publicatieverzoek aan en verwerkt het wallet-antwoord ZONDER de
 * draaiende webserver, rechtstreeks op dezelfde database en met dezelfde
 * PlayerPublicationService (zelfde controles als de endpoints).
 *
 *   create <attempt-id>     → nieuw (of bestaand) publicatieverzoek; toont de wallet-link
 *   accept  <callback-url>  → de volledige URL die de telefoon na goedkeuren opende
 *                             (…/api/v1/publish-jobs/<id>/response?<key>=<base64url>)
 *   status  <attempt-id>    → alleen lezen
 *
 * Veilig: het verzoek doet niets zolang de speler het niet zelf in Verus Mobile
 * goedkeurt; `accept` aanvaardt alleen een antwoord dat door de speler getekend is.
 * Laadt `.env` zelf (de relay geeft geen geheimen door).
 */
import fs from 'node:fs';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { parseGenericResponseQuery } = await import('../../server/wallet-return.mjs');
const { GENERIC_RESPONSE_QUERY_KEY } = await import('../../server/verus/requests.mjs');

const [action, argument] = process.argv.slice(2);
const acks = { create: 'CREATE_VRSCTEST_PUBLISH_REQUEST', accept: 'ACCEPT_VRSCTEST_PUBLISH_RESPONSE' };
if (!['create', 'accept', 'status'].includes(action) || !argument) {
  throw new Error('Gebruik: node scripts/operator/publish-request.mjs create|status <attempt-id> | accept <callback-url>');
}
if (acks[action] && process.env.VERUS_OPERATOR_ACK !== acks[action]) {
  throw new Error(`Zet VERUS_OPERATOR_ACK=${acks[action]} voor ${action}`);
}

const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ runtime });
const summary = (publication) => publication && ({
  attemptId: publication.attemptId,
  requestId: publication.requestId,
  status: publication.status,
  contentKeyName: publication.contentKeyName,
  contentKey: publication.contentKey,
  recordSha256: publication.recordSha256,
  recordBytes: Buffer.byteLength(JSON.stringify(publication.record)),
  round: publication.record?.round,
  guesses: publication.record?.guesses,
  expiresHeight: publication.expiresHeight,
  walletUri: publication.walletUri,
  receiptTxid: publication.receiptTxid,
  publishedTxid: publication.publishedTxid,
  publishedHeight: publication.publishedHeight,
});
try {
  const service = services.playerPublicationService;
  if (!service) throw new Error('Publicaties staan uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env');
  let output;
  if (action === 'accept') {
    const url = new URL(argument);
    const match = url.pathname.match(/\/api\/v1\/publish-jobs\/([0-9a-f]{40})\/response$/);
    if (!match) throw new Error('Dit is geen publish-callback-URL');
    const body = parseGenericResponseQuery(url.searchParams, GENERIC_RESPONSE_QUERY_KEY);
    const result = await service.acceptResponse({ requestIdHex: match[1], body });
    output = { operation: 'publish-accept', replayed: result.replayed, publication: summary(result.publication) };
  } else {
    const attempt = services.repository.getAttemptById(argument);
    if (!attempt) throw new Error('Poging bestaat niet');
    const principal = { chain: attempt.chain_id, iAddress: attempt.player_i_address };
    if (action === 'create') {
      const result = await service.createPublishRequest({ principal, attemptId: attempt.id });
      output = { operation: 'publish-create', created: result.created, publication: summary(result.publication) };
    } else {
      const result = await service.getPublishRequest({ principal, attemptId: attempt.id });
      output = { operation: 'publish-status', publication: summary(result.publication) };
    }
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.log(JSON.stringify({ operation: `publish-${action}`, error: error.code ?? error.name, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  services.close();
}
