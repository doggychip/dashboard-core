// Yahoo Finance v8 chart + v7 options endpoint wrappers.
//
// CAVEAT: both endpoints are unofficial. v7 has been tightening (some paths
// now require a crumb). The User-Agent header is required to avoid 403.
//
// All requests go through fetchWithTimeout — no naked fetch() calls.

const { fetchWithTimeout } = require('./helpers');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchYahooChart(symbol, range = '1d', interval = '1d', { timeoutMs = 10000 } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, timeoutMs);
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

async function fetchYahooOptions(symbol, { timeoutMs = 10000 } = {}) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, timeoutMs);
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  return r.json();
}

// Convert a Yahoo chart response to the shape the dashboard's /api/quotes returns.
function chartToQuote(data) {
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  // Fall back to chartPreviousClose if previousClose is missing.
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return {
    price: meta.regularMarketPrice,
    previousClose: prev,
    change: prev != null ? +(meta.regularMarketPrice - prev).toFixed(4) : 0,
    changePct: prev ? +(((meta.regularMarketPrice - prev) / prev) * 100).toFixed(5) : 0,
    currency: meta.currency,
    exchange: meta.exchangeName,
    asOf: meta.regularMarketTime,
  };
}

// Convert a Yahoo chart response to a [{d,c,v}, ...] history array.
function chartToBars(data) {
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    d: new Date(t * 1000).toISOString().slice(0, 10),
    c: q.close?.[i] == null ? null : +q.close[i].toFixed(2),
    v: q.volume?.[i] ?? 0,
  })).filter(b => b.c != null);
}

module.exports = {
  UA,
  fetchYahooChart,
  fetchYahooOptions,
  chartToQuote,
  chartToBars,
};
