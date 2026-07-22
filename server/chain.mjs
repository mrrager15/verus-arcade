/**
 * On-chain publication for Verus Arcade rounds — the phase-0 recipe in code.
 *
 * Data model (hex-encoded JSON in Arcade@'s contentmultimap, one VDXF key per
 * kind — see fase0-runbook.md):
 *   arcade::round.commit   { round, date, sha256 }            — before round start
 *   arcade::round.reveal   { round, word, salt }              — after round ends
 *   arcade::round.results  { round, players, solved, top }    — after round ends
 *
 * IMPORTANT (phase-0 lesson #3): updateidentity REPLACES the identity's current
 * contentmultimap state. Every update therefore carries the latest value for
 * ALL keys. Historical values stay on-chain and remain queryable via the
 * identity history.
 */
import crypto from 'node:crypto';
import { rpc } from './rpc.mjs';

export const ARCADE_ID = 'Arcade@';

// Generated with `getvdxfid` on vrsctest (phase 0). Re-derive when migrating
// to mainnet — key i-addresses can differ per parent namespace.
export const VDXF_KEYS = {
  commit: 'i8em3RrCxxbGYGXHzFhZe9NLsKPrGvAyDn', // arcade::round.commit
  reveal: 'iNUaEEzeD5e1aVu3GcSwxDfzKKMoNeYU4p', // arcade::round.reveal
  results: 'iQkPoHuVWQV9kH3ULMF6QhFgiMq8EMXVgs', // arcade::round.results
};

const toHex = (s) => Buffer.from(s, 'utf8').toString('hex');

export const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export const randomSalt = () => crypto.randomBytes(32).toString('hex');

/**
 * Publish the current state of all round keys in one updateidentity call.
 * Pass plain objects; anything undefined is omitted (only do that when the
 * key has never been written, otherwise you'd erase its current value).
 * Returns the txid.
 */
export async function publishState({ commit, reveal, results }) {
  const contentmultimap = {};
  if (commit) contentmultimap[VDXF_KEYS.commit] = [toHex(JSON.stringify(commit))];
  if (reveal) contentmultimap[VDXF_KEYS.reveal] = [toHex(JSON.stringify(reveal))];
  if (results) contentmultimap[VDXF_KEYS.results] = [toHex(JSON.stringify(results))];
  return rpc('updateidentity', [{ name: ARCADE_ID, contentmultimap }]);
}
