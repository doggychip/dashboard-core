// Yahoo quote fetch with timeout + retry-with-backoff.
//
// Returns the normalized fields that both schemas need: price, prev,
// hi52, lo52, dayHigh, dayLow, volume, plus the full closes/volumes
// arrays from the 6mo daily series (used by the software schema).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10000;
const RETRY_DELAYS = [1000, 3000]; // first retry @ 1s, second @ 3s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
  }
  throw lastErr;
}

async function fetchQuote(ticker) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=6mo&interval=1d`;
  const data = await fetchWithRetry(url);

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('no chart result');
  const meta = result.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') {
    throw new Error('no meta.regularMarketPrice');
  }
  const prev =
    typeof meta.previousClose === 'number'
      ? meta.previousClose
      : meta.chartPreviousClose;
  if (typeof prev !== 'number' || prev === 0) {
    throw new Error('no previousClose');
  }

  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).map((v) => (typeof v === 'number' ? v : null));
  const volumes = (quote.volume || []).map((v) => (typeof v === 'number' ? v : null));

  return {
    price: meta.regularMarketPrice,
    prev,
    hi52: meta.fiftyTwoWeekHigh,
    lo52: meta.fiftyTwoWeekLow,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    closes,
    volumes,
  };
}

module.exports = { fetchQuote, sleep };
