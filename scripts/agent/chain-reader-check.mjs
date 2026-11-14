#!/usr/bin/env node
/**
 * Fase 4: de chain-lezer tegen een echte RPC (standaard de publieke VRSCTEST-RPC).
 * Alleen lezen, alleen over Arcade@ (publieke operator-ID). Geen .env nodig.
 *
 *   node scripts/agent/chain-reader-check.mjs [ronde-id] [--url https://...] [--days 2]
 *
 * Zoekt het hoogtevenster rond de rondedatum, leest de drie .v1-keys, koppelt de
 * waarden van deze ronde aan hun transactie en toont aanroepen en tijd.
 */
import { createChainReader, decodeHexJson, firstUpdateWithValue } from '../../shared/chain-reader.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const KEYS = {
  commitment: 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7',
  results: 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA',
  reveal: 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj',
};
const DAY = 86_400_000;

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const roundId = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'word-grid:1.0.0:2026-11-13';
const date = roundId.split(':')[2]?.slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error(`Geen datum in ronde-ID ${roundId}`);
const marginDays = Number(option('--days', '2'));

const reader = createChainReader({ url: option('--url', undefined) });
const out = { roundId, rpc: reader.url };
try {
  const info = await reader.info();
  out.tip = info.tip;
  const opensMs = Date.parse(`${date}T00:00:00Z`);
  const before = reader.stats().calls;
  const window = await reader.windowForTimes({ fromMs: opensMs - marginDays * DAY, toMs: opensMs + DAY + marginDays * DAY });
  out.window = { ...window, blocks: window.toHeight - window.fromHeight, heightSearchCalls: reader.stats().calls - before };
  const history = await reader.identityHistory({ identityId: ARCADE, fromHeight: window.fromHeight, toHeight: window.toHeight });
  out.historyEntries = history.length;
  out.parts = {};
  for (const [part, keyId] of Object.entries(KEYS)) {
    const { values } = await reader.identityContent({ identityId: ARCADE, keyId, fromHeight: window.fromHeight, toHeight: window.toHeight });
    const unique = [...new Set(values.map((v) => JSON.stringify(v)))];
    const mine = values.filter((v) => JSON.stringify(decodeHexJson(v) ?? null).includes(`"${roundId}"`));
    const entry = mine[0] === undefined ? null : firstUpdateWithValue(history, keyId, mine[0]);
    const tx = entry ? await reader.transaction(entry.txid) : null;
    out.parts[part] = {
      valuesInWindow: values.length, uniqueValues: unique.length, matchesForRound: mine.length,
      txid: entry?.txid ?? null, height: entry?.height ?? null, confirmations: tx?.confirmations ?? null,
      fields: mine[0] === undefined ? null : Object.keys(decodeHexJson(mine[0]) ?? {}),
    };
  }
} catch (error) {
  out.error = { code: error.code ?? null, message: error.message };
}
out.stats = reader.stats();
console.log(JSON.stringify(out, null, 2));
