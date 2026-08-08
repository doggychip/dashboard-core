// Yahoo Finance v8 chart + v7 options + v10 quoteSummary endpoint wrappers.
//
// CAVEAT: all three are unofficial. v10 quoteSummary requires a crumb+cookie
// token obtained via fc.yahoo.com → /v1/test/getcrumb. The User-Agent header
// is required on every endpoint to avoid 403.
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

// ─── crumb+cookie cache for quoteSummary v10 ─────────────────────────────
// Process-wide. Sticky: a successful crumb is reused until process exits;
// a failed dance is also remembered to avoid per-ticker hammering.
let _crumbState = null; // { crumb, cookie } | { error }

async function _doCrumbDance() {
  // Step 1: GET fc.yahoo.com to obtain A1/A1S consent cookies.
  const consent = await fetchWithTimeout('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  }, 10000);
  const setCookies = typeof consent.headers.getSetCookie === 'function'
    ? consent.headers.getSetCookie()
    : (consent.headers.get('set-cookie') ? [consent.headers.get('set-cookie')] : []);
  const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('crumb dance: no consent cookies');

  // Step 2: GET getcrumb with the consent cookies → returns a short text token.
  const crumbRes = await fetchWithTimeout('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  }, 10000);
  if (!crumbRes.ok) throw new Error(`crumb dance: getcrumb HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
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

// Fetch quoteSummary modules for a single symbol. Returns null on any failure
// (network, crumb-blocked, missing modules) so callers can gracefully degrade.
async function fetchQuoteSummary(symbol, { timeoutMs = 10000, modules = 'summaryDetail,defaultKeyStatistics,financialData,price' } = {}) {
  let creds;
  try { creds = await ensureCrumb(); }
  catch { return null; }
  const url =
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=${modules}&crumb=${encodeURIComponent(creds.crumb)}`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Cookie: creds.cookie },
    }, timeoutMs);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Convert a quoteSummary response to the flat per-ticker `extras` shape we
// expose on /api/quotes. Numeric raw values only; clients format their own way.
function quoteSummaryToExtras(data) {
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;
  const sd = r.summaryDetail || {};
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const pr = r.price || {};

  const num = (n) => (typeof n?.raw === 'number' ? n.raw : (typeof n === 'number' ? n : null));

  const out = {
    marketCap:           num(sd.marketCap)          ?? num(pr.marketCap),
    sharesOutstanding:   num(ks.sharesOutstanding),
    trailingEps:         num(ks.trailingEps),
    forwardEps:          num(ks.forwardEps),
    trailingPE:          num(sd.trailingPE),
    forwardPE:           num(sd.forwardPE)          ?? num(ks.forwardPE),
    divYield:            num(sd.dividendYield),
    fiftyTwoWeekHigh:    num(sd.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:     num(sd.fiftyTwoWeekLow),
    dayHigh:             num(sd.dayHigh)            ?? num(pr.regularMarketDayHigh),
    dayLow:              num(sd.dayLow)             ?? num(pr.regularMarketDayLow),
    regularMarketVolume: num(sd.volume)             ?? num(pr.regularMarketVolume),
    averageVolume:       num(sd.averageVolume)      ?? num(sd.averageVolume10days),
    targetMeanPrice:     num(fd.targetMeanPrice),
    targetMedianPrice:   num(fd.targetMedianPrice),
    targetHighPrice:     num(fd.targetHighPrice),
    targetLowPrice:      num(fd.targetLowPrice),
    recommendationKey:   typeof fd.recommendationKey === 'string' ? fd.recommendationKey : null,
    recommendationMean:  num(fd.recommendationMean),
    numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions),
  };

  // Strip nulls so JSON is compact and clients can `typeof === 'number'` check
  // without explicit nulls overwriting existing data on merge.
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return Object.keys(out).length ? out : null;
}

// Convert a quoteSummary response (with earnings modules) to the per-ticker
// `fundamentals` shape exposed on /api/fundamentals. Includes the last-4-quarter
// EPS beat/miss history, quarterly revenue trend, next earnings date, and
// forward EPS/revenue growth consensus — everything the client signal needs.
//
// Required modules: earningsHistory,calendarEvents,earningsTrend,earnings,
//                   financialData,defaultKeyStatistics,summaryDetail,price
function quoteSummaryToFundamentals(data) {
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;
  const num = (n) => (typeof n?.raw === 'number' ? n.raw : (typeof n === 'number' ? n : null));

  const out = {};

  // ── EPS beat/miss history (last 4 quarters) ──
  // earningsHistory.history is nominally ordered oldest→newest ("-4q".."-1q"),
  // but we sort by quarter date explicitly rather than trust the array order —
  // "last quarter" logic downstream depends on it.
  const hist = r.earningsHistory?.history;
  if (Array.isArray(hist) && hist.length) {
    out.epsHistory = hist.map((h) => ({
      period: h.period || null,                          // e.g. "-1q"
      quarter: h.quarter?.fmt || null,                   // e.g. "2026-03-31"
      epsActual: num(h.epsActual),
      epsEstimate: num(h.epsEstimate),
      surprisePct: num(h.surprisePercent) != null ? +(num(h.surprisePercent) * 100).toFixed(2) : null,
      beat: (num(h.epsActual) != null && num(h.epsEstimate) != null)
        ? num(h.epsActual) >= num(h.epsEstimate)
        : null,
    })).filter((e) => e.epsActual != null)
      .sort((a, b) => {
        if (a.quarter && b.quarter) return a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0;
        return 0; // no dates → keep incoming order
      });
  }

  // ── Quarterly revenue + earnings trend ──
  const fc = r.earnings?.financialsChart?.quarterly;
  if (Array.isArray(fc) && fc.length) {
    out.revenueHistory = fc.map((q) => ({
      date: q.date || null,                              // e.g. "1Q2026"
      revenue: num(q.revenue),
      earnings: num(q.earnings),
    })).filter((q) => q.revenue != null);
  }

  // ── Next earnings date ──
  // calendarEvents.earnings.earningsDate is an array of 1–2 epoch entries.
  const cal = r.calendarEvents?.earnings;
  if (cal && Array.isArray(cal.earningsDate) && cal.earningsDate.length) {
    out.nextEarningsDate = cal.earningsDate[0]?.fmt || null;
    out.nextEarningsDateEnd = cal.earningsDate[1]?.fmt || null; // range upper bound, if any
    out.nextEpsEstimate = num(cal.earningsAverage);
    out.nextRevenueEstimate = num(cal.revenueAverage);
    out.isEarningsDateEstimate = cal.isEarningsDateEstimate === true;
  }

  // ── Forward growth consensus (earningsTrend) ──
  // trend[] periods: "0q" current Q, "+1q", "0y" current year, "+1y" next year.
  const trend = r.earningsTrend?.trend;
  if (Array.isArray(trend)) {
    const byPeriod = {};
    for (const t of trend) if (t.period) byPeriod[t.period] = t;
    const g = (p) => num(byPeriod[p]?.growth);
    const revG = (p) => num(byPeriod[p]?.revenueEstimate?.growth);
    out.forward = {
      epsGrowthCurrentQ: g('0q') != null ? +(g('0q') * 100).toFixed(2) : null,
      epsGrowthNextQ: g('+1q') != null ? +(g('+1q') * 100).toFixed(2) : null,
      epsGrowthCurrentY: g('0y') != null ? +(g('0y') * 100).toFixed(2) : null,
      epsGrowthNextY: g('+1y') != null ? +(g('+1y') * 100).toFixed(2) : null,
      revGrowthCurrentY: revG('0y') != null ? +(revG('0y') * 100).toFixed(2) : null,
      revGrowthNextY: revG('+1y') != null ? +(revG('+1y') * 100).toFixed(2) : null,
    };
    // drop if entirely empty
    if (Object.values(out.forward).every((v) => v == null)) delete out.forward;
  }

  // ── Analyst + valuation snapshot (for the signal) ──
  const fd = r.financialData || {};
  const sd = r.summaryDetail || {};
  const analyst = {
    recommendationKey: typeof fd.recommendationKey === 'string' ? fd.recommendationKey : null,
    recommendationMean: num(fd.recommendationMean),
    numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions),
    targetMeanPrice: num(fd.targetMeanPrice),
    targetMedianPrice: num(fd.targetMedianPrice),
    currentPrice: num(fd.currentPrice),
    revenueGrowth: num(fd.revenueGrowth) != null ? +(num(fd.revenueGrowth) * 100).toFixed(2) : null,
    earningsGrowth: num(fd.earningsGrowth) != null ? +(num(fd.earningsGrowth) * 100).toFixed(2) : null,
    grossMargins: num(fd.grossMargins) != null ? +(num(fd.grossMargins) * 100).toFixed(2) : null,
    profitMargins: num(sd.profitMargins ?? r.defaultKeyStatistics?.profitMargins) != null
      ? +(num(sd.profitMargins ?? r.defaultKeyStatistics?.profitMargins) * 100).toFixed(2) : null,
  };
  for (const k of Object.keys(analyst)) if (analyst[k] == null) delete analyst[k];
  if (Object.keys(analyst).length) out.analyst = analyst;

  out.trailingPE = num(sd.trailingPE);
  out.forwardPE  = num(sd.forwardPE) ?? num(r.defaultKeyStatistics?.forwardPE);
  for (const k of ['trailingPE', 'forwardPE']) if (out[k] == null) delete out[k];

  return Object.keys(out).length ? out : null;
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
  fetchQuoteSummary,
  ensureCrumb,
  chartToQuote,
  chartToBars,
  quoteSummaryToExtras,
  quoteSummaryToFundamentals,
};
