// Yahoo quote fetch with timeout + retry-with-backoff.
//
// Returns the normalized fields that both schemas need: price, prev,
// hi52, lo52, dayHigh, dayLow, volume, plus the full closes/volumes
// arrays from the 6mo daily series (used by the software schema).
//
// In addition to the chart endpoint, fetchMcapAndShares() pulls the
// real marketCap and sharesOutstanding from Yahoo's quoteSummary v10
// endpoint. That endpoint requires a one-time crumb+cookie dance which
// is done lazily and cached for the process lifetime. If the dance or
// the lookup fails for any reason, callers receive null and should fall
// back to whatever they were doing before (e.g. price-ratio scaling).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10000;
const RETRY_DELAYS = [1000, 3000]; // first retry @ 1s, second @ 3s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Derive the prior-session close used for daily chg/chgPct.
//
// On range=6mo&interval=1d, Yahoo's meta.previousClose is frequently absent,
// so the old code fell back to meta.chartPreviousClose — the close *before
// the first bar of the 6-month window*. That turned chg/chgPct into a
// ~6-month return instead of a daily move (e.g. AMD printed +132%, SNDK
// +738%). The daily series already holds the truth: the second-to-last
// valid close is the prior trading session. Use the meta fields only when
// the series is too short (e.g. a freshly-listed ticker).
function derivePrev(meta, closes) {
  const valid = (closes || []).filter((c) => typeof c === 'number' && c > 0);
  if (valid.length >= 2) return valid[valid.length - 2];
  if (meta && typeof meta.previousClose === 'number' && meta.previousClose > 0) {
    return meta.previousClose;
  }
  if (meta && typeof meta.chartPreviousClose === 'number' && meta.chartPreviousClose > 0) {
    return meta.chartPreviousClose;
  }
  return null;
}

async function fetchOnce(url, timeoutMs = FETCH_TIMEOUT_MS, extraHeaders = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...extraHeaders },
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

  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).map((v) => (typeof v === 'number' ? v : null));
  const volumes = (quote.volume || []).map((v) => (typeof v === 'number' ? v : null));

  // Prior-session close from the daily series (see derivePrev). Falls back to
  // the meta fields only when the series is too short to use.
  const prev = derivePrev(meta, closes);
  if (typeof prev !== 'number' || !(prev > 0)) {
    throw new Error('no previousClose');
  }

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

// ---------- marketCap / sharesOutstanding (quoteSummary endpoint) ----------
//
// Process-wide crumb+cookie cache. The cache is "sticky": once a
// successful pair has been obtained it's reused until the process exits.
// A failed attempt is also remembered (as { error }) so we don't keep
// hammering Yahoo per-ticker when the dance is blocked.
let _crumbState = null; // { crumb, cookie } on success, { error } on failure

async function _doCrumbDance() {
  // Step 1: GET fc.yahoo.com to obtain A1/A1S consent cookies.
  const consentCtl = new AbortController();
  const consentTimer = setTimeout(() => consentCtl.abort(), FETCH_TIMEOUT_MS);
  let cookie = '';
  try {
    const r = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA },
      signal: consentCtl.signal,
      redirect: 'manual',
    });
    // getSetCookie() returns each Set-Cookie header separately; fall back to
    // raw header parsing if the runtime doesn't expose it.
    const setCookies = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
    cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } finally {
    clearTimeout(consentTimer);
  }
  if (!cookie) throw new Error('crumb dance: no consent cookies returned');

  // Step 2: GET getcrumb with the consent cookies → returns a short text token.
  const crumbCtl = new AbortController();
  const crumbTimer = setTimeout(() => crumbCtl.abort(), FETCH_TIMEOUT_MS);
  let crumb;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
      signal: crumbCtl.signal,
    });
    if (!r.ok) throw new Error(`crumb dance: getcrumb HTTP ${r.status}`);
    crumb = (await r.text()).trim();
  } finally {
    clearTimeout(crumbTimer);
  }
  if (!crumb || crumb.length > 64) throw new Error('crumb dance: invalid crumb response');
  return { crumb, cookie };
}

async function ensureCrumb() {
  if (_crumbState && _crumbState.crumb) return _crumbState;
  if (_crumbState && _crumbState.error) throw _crumbState.error;
  try {
    _crumbState = await _doCrumbDance();
    return _crumbState;
  } catch (err) {
    _crumbState = { error: err };
    throw err;
  }
}

// Fetch real marketCap and sharesOutstanding from Yahoo's quoteSummary v10.
// Returns { marketCap, sharesOutstanding } when available, or null on any
// failure (network, crumb-blocked, missing field). Never throws — callers
// fall back to whatever they were doing before.
async function fetchMcapAndShares(ticker) {
  let creds;
  try {
    creds = await ensureCrumb();
  } catch {
    return null;
  }
  const modules = 'summaryDetail,defaultKeyStatistics,price';
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
    `?modules=${modules}&crumb=${encodeURIComponent(creds.crumb)}`;
  try {
    const data = await fetchOnce(url, FETCH_TIMEOUT_MS, { Cookie: creds.cookie });
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return null;
    const mcap =
      r.summaryDetail?.marketCap?.raw ??
      r.price?.marketCap?.raw ??
      null;
    const shares =
      r.defaultKeyStatistics?.sharesOutstanding?.raw ??
      r.price?.sharesOutstanding?.raw ??
      null;
    if (typeof mcap !== 'number' && typeof shares !== 'number') return null;
    return {
      marketCap: typeof mcap === 'number' ? mcap : null,
      sharesOutstanding: typeof shares === 'number' ? shares : null,
    };
  } catch {
    return null;
  }
}

// Test-only hook: reset cached crumb state.
function _resetCrumbCacheForTests() { _crumbState = null; }

module.exports = {
  fetchQuote,
  fetchMcapAndShares,
  sleep,
  derivePrev,
  _resetCrumbCacheForTests,
};
