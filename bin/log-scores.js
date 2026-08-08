#!/usr/bin/env node
// Daily evidence-score snapshot logger — appends one JSONL line per ticker so
// the scorer's meaning can eventually be validated against forward returns
// (rank-IC). Until months of this history exist, the score remains labeled
// descriptive-only.
//
// Usage:
//   log-scores <public/sw_data.json | public/index.html> --out history/scores.jsonl
//
// Data source is auto-detected: a .json file is read as the SW schema
// ({tickers:{...}, refreshedAt}); an .html file is scanned for the inline
// AI-schema `const TICKER_DATA = {...}` (prices only, no priceHistory).
//
// Best-effort by design: fundamentals fetch failures skip the ticker, and a
// blocked crumb dance exits 0 with a warning — logging must never break the
// price-refresh workflow it rides along with.

'use strict';

const fs = require('fs');
const path = require('path');
const { fetchQuoteSummary, quoteSummaryToFundamentals } = require('../server/yahoo');
const { computeScore } = require('../lib/signals/score');

const FUNDAMENTALS_MODULES =
  'earningsHistory,calendarEvents,earningsTrend,earnings,financialData,defaultKeyStatistics,summaryDetail,price';
const DELAY_MS = 150;
const HISTORY_FRESH_DAYS = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (args.length < 1 || outIdx === -1 || !args[outIdx + 1]) {
    console.error('usage: log-scores <sw_data.json | index.html> --out <scores.jsonl>');
    process.exit(2);
  }
  return { source: args[0], out: args[outIdx + 1] };
}

function loadTickers(source) {
  const raw = fs.readFileSync(source, 'utf8');
  if (source.endsWith('.json')) {
    const d = JSON.parse(raw);
    const out = {};
    for (const [sym, t] of Object.entries(d.tickers || {})) {
      if (t.status === 'acquired' || t.status === 'delisted') continue;
      out[sym] = { price: t.price, priceHistory: t.priceHistory };
    }
    let historyFresh = false;
    if (d.refreshedAt) {
      const ms = Date.parse(d.refreshedAt);
      historyFresh = !isNaN(ms) && (Date.now() - ms) <= HISTORY_FRESH_DAYS * 86400000;
    }
    return { tickers: out, historyFresh };
  }
  // AI schema: one ticker per line inside `const TICKER_DATA = {...}`.
  const out = {};
  for (const m of raw.matchAll(/'([A-Z0-9.]{1,10})':\s*\{ name:[^\n]*?price:\s*(-?\d+(?:\.\d+)?)/g)) {
    const price = parseFloat(m[2]);
    if (price > 0 && /^[A-Z][A-Z0-9.-]{0,9}$/.test(m[1])) out[m[1]] = { price };
  }
  return { tickers: out, historyFresh: false };
}

async function main() {
  const { source, out } = parseArgs();
  const { tickers, historyFresh } = loadTickers(source);
  const syms = Object.keys(tickers);
  if (!syms.length) { console.warn('[log-scores] no tickers found — nothing to log'); return; }

  const day = new Date().toISOString().slice(0, 10);
  const lines = [];
  let fetched = 0, skipped = 0;

  for (const sym of syms) {
    const data = await fetchQuoteSummary(sym, { modules: FUNDAMENTALS_MODULES });
    if (!data) { skipped++; await sleep(DELAY_MS); continue; }
    const f = quoteSummaryToFundamentals(data);
    if (!f) { skipped++; await sleep(DELAY_MS); continue; }
    const t = { price: tickers[sym].price, priceHistory: tickers[sym].priceHistory, fundamentals: f };
    const sig = computeScore(t, { historyFresh });
    if (sig) {
      lines.push(JSON.stringify({
        d: day, t: sym, s: sig.score, st: sig.status, c: sig.dataCoverage, p: tickers[sym].price,
      }));
      fetched++;
    } else skipped++;
    await sleep(DELAY_MS);
  }

  if (!lines.length) {
    console.warn('[log-scores] fundamentals unavailable for every ticker (crumb blocked?) — nothing appended');
    return; // exit 0: never break the refresh workflow
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, lines.join('\n') + '\n');
  console.log(`[log-scores] appended ${fetched} snapshots for ${day} (${skipped} skipped) → ${out}`);
}

main().catch((err) => {
  console.warn('[log-scores] failed:', err.message, '— continuing (best-effort)');
});
