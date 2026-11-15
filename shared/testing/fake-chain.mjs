/**
 * Alleen voor tests: een nagebootste VRSCTEST-RPC met operator-ID's (commitment,
 * resultaten, reveal) en spelers-ID's (records en bundels), voor de controles
 * die meerdere identiteiten lezen (profiel met bundels, naspelen van een ronde).
 *
 * Eén blok per minuut; `anchor` legt vast welke hoogte bij welk tijdstip hoort.
 * Elke waarde van een speler staat in haar eigen update-transactie.
 */
import { createChainReader, VRSCTEST_CHAIN_ID } from '../chain-reader.mjs';
import { testIdentity } from './bundle-receipt.mjs';
import { transactionWithEvidence } from './mobile-record.mjs';

export const fakeTxid = (/** @type {number} */ n) => n.toString(16).padStart(64, '0');
export const hexJson = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('hex');

/**
 * @param {{
 *   anchor: { height: number, timeMs: number },
 *   tip: number,
 *   operators: Record<string, Array<{ height: number, txid: string, cmm: Record<string, unknown[]> }>>,
 *   players: Record<string, { name?: string, updates: Array<{ height: number, keyId: string, record: { value: any, evidenceHex: string } }> }>,
 *   signerKey: any,
 *   down?: boolean,
 * }} input  `operators`: de updates per operator-ID (elke update draagt de volledige content van dat moment);
 *           `signerKey`: de sleutel die `getidentity` als primair adres van elke ID toont (voor ontvangstbewijzen).
 */
export function fakeChain({ anchor, tip, operators, players, signerKey, down = false }) {
  const calls = [];
  let next = 500;
  const playerUpdates = Object.fromEntries(Object.entries(players).map(([id, p]) => [id, p.updates.map((u) => ({ ...u, txid: fakeTxid(next++) }))]));
  const time = (/** @type {number} */ height) => Math.floor(anchor.timeMs / 1000) + (height - anchor.height) * 60;
  const operatorTx = new Map(Object.values(operators).flat().map((e) => [e.txid, e.height]));
  const playerTx = new Map(Object.values(playerUpdates).flat().map((u) => [u.txid, u]));

  const methods = {
    getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: tip, VRSCversion: '1.2.18' }),
    getblock: ([h]) => ({ height: Number(h), time: time(Number(h)) }),
    getidentity: ([id, height]) => testIdentity(id, signerKey, height ?? tip),
    getidentitycontent: ([id, , , , , key]) => {
      const updates = playerUpdates[id] ?? [];
      /** @type {Record<string, unknown[]>} */
      const cmm = {};
      for (const u of updates) if (!key || key === u.keyId) (cmm[u.keyId] ??= []).push(u.record.value);
      return { fullyqualifiedname: players[id]?.name ?? 'speler.VRSCTEST@', identity: { identityaddress: id, contentmultimap: cmm } };
    },
    getidentityhistory: ([id, from, to]) => {
      const entries = operators[id]
        ? operators[id].map((e) => ({ height: e.height, txid: e.txid, cmm: e.cmm }))
        : (playerUpdates[id] ?? []).map((u) => ({ height: u.height, txid: u.txid, cmm: { [u.keyId]: [u.record.value] } }));
      return {
        history: entries.filter((e) => e.height >= from && e.height <= to).sort((a, b) => a.height - b.height)
          .map((e) => ({ height: e.height, blockhash: 'x', output: { txid: e.txid, voutnum: 0 }, identity: { identityaddress: id, contentmultimap: e.cmm } })),
      };
    },
    getrawtransaction: ([t]) => {
      if (operatorTx.has(t)) return { txid: t, confirmations: tip - operatorTx.get(t) + 1, height: operatorTx.get(t) };
      const update = playerTx.get(t);
      if (!update) throw Object.assign(new Error('No information'), { rpcCode: -5 });
      return transactionWithEvidence(t, update.record.evidenceHex, { confirmations: tip - update.height + 1, height: update.height });
    },
  };
  const fetch = async (/** @type {string} */ _url, /** @type {{ body: string }} */ init) => {
    if (down) throw new TypeError('fetch failed');
    const { method, params, id } = JSON.parse(init.body);
    calls.push(method);
    try {
      return new Response(JSON.stringify({ id, result: await methods[method](params), error: null }));
    } catch (error) {
      return new Response(JSON.stringify({ id, result: null, error: { code: error.rpcCode ?? -1, message: error.message } }), { status: 500 });
    }
  };
  return { reader: createChainReader({ fetch, limits: { timeMs: 30_000 } }), calls, playerUpdates };
}
