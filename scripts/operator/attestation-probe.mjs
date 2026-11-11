/**
 * Fase 2b, proef (alleen lezen, geen transactie, niets opgeslagen):
 * bouwt een attestatie voor één speler en één afgesloten Daily uit de database,
 * tekent de wortel met de service-identiteit (Arcade@) via de SDK, en laat de
 * daemon de handtekening onafhankelijk controleren met `verifysignature`.
 *
 *   node scripts/operator/attestation-probe.mjs <speler-i-adres> <ronde-id>
 *
 * Laadt `.env` zelf (service-ID en WIF blijven in dit proces).
 */
import fs from 'node:fs';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');
const { createVerusRequestsFromEnv } = await import('../../server/verus/requests.mjs');
const { buildAttestation, computeDailyStats, discloseAttestation, readAttestationDisclosure } = await import('../../server/attestation.mjs');

const [player, roundRecordId] = process.argv.slice(2);
if (!player || !roundRecordId) throw new Error('Gebruik: node scripts/operator/attestation-probe.mjs <speler-i-adres> <ronde-id>');
const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ runtime });
try {
  const { repository } = services;
  const target = repository.getRound(roundRecordId);
  if (!target) throw new Error('Ronde bestaat niet');
  if (Date.now() < target.closes_at_ms) throw new Error('Ronde is nog niet gesloten');
  // Alle rondes van hetzelfde spel die op of vóór de doelronde sloten (ook lege, ook gemiste).
  const rounds = repository.listRounds({ chainId: target.chain_id, limit: 1000 })
    .filter((r) => r.game_id === target.game_id && r.game_version === target.game_version && r.closes_at_ms <= target.closes_at_ms);
  const attempts = new Map();
  for (const round of rounds) {
    const signed = new Set(repository.listRoundAttemptSignatures(round).map((s) => s.attemptId));
    for (const a of repository.listRoundAttempts(round)) {
      if (a.player_i_address !== player || a.status !== 'completed') continue;
      attempts.set(round.id, { signed: signed.has(a.id), solved: Number(a.solved) === 1 });
    }
  }
  if (!attempts.get(target.id)?.signed) throw new Error('Speler heeft in deze ronde geen getekende poging');
  const stats = computeDailyStats({ roundIds: rounds.map((r) => r.id), attempts });
  const attestation = buildAttestation({ player, roundId: target.id, stats });

  const env = { ...process.env };
  const confText = env.VERUS_RPC_URL ? undefined : fs.readFileSync(runtime.confPath, 'utf8');
  const verus = createVerusRequestsFromEnv({ env, confText });
  const { signaturedata, signatureheight } = await verus.signMmrRoot(attestation.root);
  const daemon = await verus.client.interface.request({
    cmd: 'verifysignature',
    getParams: () => [{ address: signaturedata.identityid, datahash: attestation.root, signature: signaturedata.signature, hashtype: 'sha256' }],
  });
  const disclosure = discloseAttestation(attestation, ['streak']);
  console.log(JSON.stringify({
    operation: 'attestation-probe',
    player,
    round: target.id,
    roundsConsidered: rounds.map((r) => r.id).sort(),
    stats,
    root: attestation.root,
    sealedBytes: Buffer.byteLength(JSON.stringify({ ...attestation.sealed, signaturedata })),
    signatureheight,
    signer: signaturedata.identityid,
    daemonVerifySignature: daemon.result?.signaturestatus ?? daemon.error,
    disclosureStreak: readAttestationDisclosure(disclosure).fields,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ operation: 'attestation-probe', error: error.code ?? error.name, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  services.close();
}
