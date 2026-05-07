// Validation + fan-out helpers shared across all routes.
//
// These are deliberately framework-agnostic so they can be unit-tested
// without spinning up Express.

// 1–10 chars, leading letter, allow letters/digits/dot/dash (BRK.B, RDS-A).
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

function validateTicker(s) {
  if (s == null) throw new Error('ticker required');
  const u = String(s).toUpperCase().trim();
  if (!TICKER_RE.test(u)) throw new Error(`invalid ticker: ${s}`);
  return u;
}

function validateSymbols(raw, { max = 200 } = {}) {
  const list = String(raw || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (list.length > max) throw new Error(`too many symbols (max ${max})`);
  for (const s of list) if (!TICKER_RE.test(s)) throw new Error(`invalid ticker: ${s}`);
  return list;
}

// AbortController-based timeout. Native fetch in Node 18+ supports `signal`.
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Concurrency-limited Promise.all replacement. Yahoo rate-limits aggressively
// at high parallelism — we cap at 5 concurrent requests by default.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  TICKER_RE,
  validateTicker,
  validateSymbols,
  fetchWithTimeout,
  mapLimit,
};
