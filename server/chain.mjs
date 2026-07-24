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
export const ARCADE_ID = 'Arcade@';

// Generated with `getvdxfid` on vrsctest (phase 0). Re-derive when migrating
// to mainnet — key i-addresses can differ per parent namespace.
export const VDXF_KEYS = {
  commit: 'i8em3RrCxxbGYGXHzFhZe9NLsKPrGvAyDn', // arcade::round.commit
  reveal: 'iNUaEEzeD5e1aVu3GcSwxDfzKKMoNeYU4p', // arcade::round.reveal
  results: 'iQkPoHuVWQV9kH3ULMF6QhFgiMq8EMXVgs', // arcade::round.results
};

export const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export const randomSalt = () => crypto.randomBytes(32).toString('hex');

/**
 * Publish the current state of all round keys in one updateidentity call.
 * Pass plain objects; anything undefined is omitted (only do that when the
 * key has never been written, otherwise you'd erase its current value).
 * Returns the txid.
 */
export async function publishState({ commit, reveal, results }) {
  void commit;
  void reveal;
  void results;
  throw new Error(
    'Legacy publisher is disabled: it cannot safely merge identity content. Use the transaction journal and Verus gateway.',
  );
}
