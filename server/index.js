// createDashboardServer — the factory each dashboard's server.js calls.
//
// Returns an Express app with all the dashboard routes mounted. The dashboard
// is responsible for binding the port (so dashboards can do their own logging,
// graceful shutdown, etc.).

const express = require('express');
const path = require('path');
const fs = require('fs');

const { validateTicker, validateSymbols, mapLimit } = require('./helpers');
const { TtlCache, dynamicTtl } = require('./cache');
const { fetchYahooChart, fetchYahooOptions, fetchQuoteSummary, chartToQuote, chartToBars, quoteSummaryToExtras, quoteSummaryToFundamentals, UA } = require('./yahoo');

function loadTickerData(tickerData) {
  if (!tickerData) return [];
  if (typeof tickerData === 'object') {
    return Object.keys(tickerData.tickers || {}).sort();
  }
  if (typeof tickerData === 'string') {
    try {
      const json = JSON.parse(fs.readFileSync(tickerData, 'utf8'));
      return Object.keys(json.tickers || {}).sort();
    } catch (err) {
      console.warn(`[dashboard-core] could not load tickerData from ${tickerData}: ${err.message}`);
      return [];
    }
  }
  return [];
}

function createDashboardServer(opts = {}) {
  const {
    publicDir,
    tickerData = null,
    symbolAliases = {},
    skipLive = [],
    newsDataPath = null,
    dashboardName = 'Dashboard',
    enableOptions = true,
    cacheTtlMs = null, // null → dynamic
    fetchTimeoutMs = 10000,
    fetchConcurrency = 5,
    maxSymbolsPerRequest = 200,
  } = opts;

  if (!publicDir) throw new Error('createDashboardServer: publicDir is required');

  const SKIP_LIVE = new Set((skipLive || []).map(s => String(s).toUpperCase()));
  const CANONICAL_TICKERS = loadTickerData(tickerData);

  const cache = new TtlCache({
    ttlMs: cacheTtlMs == null ? dynamicTtl() : cacheTtlMs,
    maxEntries: 500,
  });

  // Separate long-TTL cache for /api/fundamentals — earnings history changes
  // at most once a quarter, so a 1h TTL is plenty and spares Yahoo the load
  // of re-fetching ~8 quoteSummary modules per ticker on every page load.
  const fundamentalsCache = new TtlCache({ ttlMs: 3600_000, maxEntries: 500 });

  const validateOpts = { max: maxSymbolsPerRequest };

  const app = express();

  // ── Static layering ────────────────────────────────────────────
  // Package client/ is mounted FIRST so /dashboard_enhancements.js
  // resolves to the package's copy. Dashboard's publicDir is mounted
  // SECOND for HTML pages and dashboard-specific data files.
  app.use(express.static(path.join(__dirname, '..', 'client')));
  app.use(express.static(publicDir));

  // ── Single-quote ───────────────────────────────────────────────
  // Honors optional ?range= and ?interval= (whitelisted). Previously the
  // route silently ignored them and always fetched 6mo/1d, which broke
  // callers requesting 1d/5m: on a 6mo response meta.previousClose is
  // frequently absent, so clients falling back to chartPreviousClose got
  // the close from ~6 months ago and rendered it as the daily change.
  const QUOTE_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']);
  const QUOTE_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1d', '1wk']);
  app.get('/api/quote/:symbol', async (req, res) => {
    let sym;
    try {
      sym = validateTicker(req.params.symbol);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const range = QUOTE_RANGES.has(req.query.range) ? req.query.range : '6mo';
    const interval = QUOTE_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    try {
      const yahooSym = symbolAliases[sym] || sym;
      const data = await fetchYahooChart(yahooSym, range, interval, { timeoutMs: fetchTimeoutMs });
      res.json(data);
    } catch (err) {
      console.error(`[dashboard-core] /api/quote/${sym}:`, err.message);
      res.status(502).json({ error: 'upstream fetch failed' });
    }
  });

  // ── Multi-quote (batch) ────────────────────────────────────────
  app.get('/api/quotes', async (req, res) => {
    let requested;
    try {
      requested = validateSymbols(req.query.symbols, validateOpts);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const symbols = requested.length ? requested : CANONICAL_TICKERS;
      if (!symbols.length) return res.json({ updatedAt: Date.now(), quotes: {} });

      const cacheKey = 'quotes:' + symbols.join(',');
      const hit = cache.get(cacheKey);
      if (hit) {
        res.set('cache-control', 'public, max-age=60');
        return res.json(hit);
      }

      const quotes = {};
      await mapLimit(symbols, fetchConcurrency, async (sym) => {
        if (SKIP_LIVE.has(sym)) return;
        const yahooSym = symbolAliases[sym] || sym;
        try {
          // Fetch chart (price/chg/chgPct) and quoteSummary (eps, pe, divYield,
          // 52w, dayHi/Lo, volume, analyst PT, recommendation) in parallel.
          // quoteSummary returns null on any failure (crumb-blocked, network)
          // and the rest of the response is unaffected.
          const [chartData, summaryData] = await Promise.all([
            fetchYahooChart(yahooSym, '1d', '1d', { timeoutMs: fetchTimeoutMs }),
            fetchQuoteSummary(yahooSym, { timeoutMs: fetchTimeoutMs }),
          ]);
          const q = chartToQuote(chartData);
          if (q) {
            const extras = summaryData ? quoteSummaryToExtras(summaryData) : null;
            if (extras) q.extras = extras;
            quotes[sym] = q;
          }
        } catch (err) {
          console.warn(`[dashboard-core] /api/quotes ${sym}:`, err.message);
        }
      });

      const payload = { updatedAt: Date.now(), quotes };
      cache.set(cacheKey, payload);
      res.set('cache-control', 'public, max-age=60');
      res.json(payload);
    } catch (err) {
      console.error('[dashboard-core] /api/quotes:', err.message);
      res.status(502).json({ error: 'upstream fetch failed' });
    }
  });

  // ── Fundamentals (earnings history + analyst + forward growth) ──
  // Heavier and slower-changing than price, so this has its own long-TTL
  // cache (1h) and is meant to be fetched ONCE on page load, not polled.
  // Returns per-ticker { epsHistory[], revenueHistory[], nextEarningsDate,
  // forward{}, analyst{}, trailingPE, forwardPE }. The client computes the
  // buy-signal scorecard from this + the live polled price.
  const FUNDAMENTALS_MODULES =
    'earningsHistory,calendarEvents,earningsTrend,earnings,financialData,defaultKeyStatistics,summaryDetail,price';
  app.get('/api/fundamentals', async (req, res) => {
    let requested;
    try {
      requested = validateSymbols(req.query.symbols, validateOpts);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const symbols = requested.length ? requested : CANONICAL_TICKERS;
      if (!symbols.length) return res.json({ updatedAt: Date.now(), fundamentals: {} });

      const cacheKey = 'fundamentals:' + symbols.join(',');
      const hit = fundamentalsCache.get(cacheKey);
      if (hit) {
        res.set('cache-control', 'public, max-age=3600');
        return res.json(hit);
      }

      const fundamentals = {};
      await mapLimit(symbols, fetchConcurrency, async (sym) => {
        if (SKIP_LIVE.has(sym)) return;
        const yahooSym = symbolAliases[sym] || sym;
        try {
          const data = await fetchQuoteSummary(yahooSym, {
            timeoutMs: fetchTimeoutMs,
            modules: FUNDAMENTALS_MODULES,
          });
          if (!data) return;
          const f = quoteSummaryToFundamentals(data);
          if (f) fundamentals[sym] = f;
        } catch (err) {
          console.warn(`[dashboard-core] /api/fundamentals ${sym}:`, err.message);
        }
      });

      const payload = { updatedAt: Date.now(), fundamentals };
      fundamentalsCache.set(cacheKey, payload);
      res.set('cache-control', 'public, max-age=3600');
      res.json(payload);
    } catch (err) {
      console.error('[dashboard-core] /api/fundamentals:', err.message);
      res.status(502).json({ error: 'upstream fetch failed' });
    }
  });

  // ── Single-history ─────────────────────────────────────────────
  app.get('/api/history/:sym', async (req, res) => {
    let sym;
    try {
      sym = validateTicker(req.params.sym);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const range = String(req.query.range || '6mo');
      const interval = String(req.query.interval || '1d');
      const cacheKey = `history:${sym}:${range}:${interval}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        res.set('cache-control', 'public, max-age=300');
        return res.json(hit);
      }
      const yahooSym = symbolAliases[sym] || sym;
      const data = await fetchYahooChart(yahooSym, range, interval, { timeoutMs: fetchTimeoutMs });
      const bars = chartToBars(data);
      if (!bars.length) return res.status(404).json({ symbol: sym, bars: [] });
      const payload = { symbol: sym, bars };
      cache.set(cacheKey, payload);
      res.set('cache-control', 'public, max-age=300');
      res.json(payload);
    } catch (err) {
      console.error(`[dashboard-core] /api/history/${sym}:`, err.message);
      res.status(502).json({ error: 'upstream fetch failed' });
    }
  });

  // ── Multi-history (batch) ──────────────────────────────────────
  app.get('/api/history', async (req, res) => {
    let requested;
    try {
      requested = validateSymbols(req.query.symbols, validateOpts);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const symbols = requested.length ? requested : CANONICAL_TICKERS;
      const range = String(req.query.range || '6mo');
      const interval = String(req.query.interval || '1d');
      if (!symbols.length) return res.json({});

      const out = {};
      await mapLimit(symbols, fetchConcurrency, async (sym) => {
        if (SKIP_LIVE.has(sym)) return;
        const cacheKey = `history:${sym}:${range}:${interval}`;
        const hit = cache.get(cacheKey);
        if (hit) { out[sym] = hit.bars; return; }
        const yahooSym = symbolAliases[sym] || sym;
        try {
          const data = await fetchYahooChart(yahooSym, range, interval, { timeoutMs: fetchTimeoutMs });
          const bars = chartToBars(data);
          if (bars.length) {
            cache.set(cacheKey, { symbol: sym, bars });
            out[sym] = bars;
          }
        } catch (err) {
          console.warn(`[dashboard-core] /api/history ${sym}:`, err.message);
        }
      });
      res.set('cache-control', 'public, max-age=300');
      res.json(out);
    } catch (err) {
      console.error('[dashboard-core] /api/history:', err.message);
      res.status(502).json({ error: 'upstream fetch failed' });
    }
  });

  // ── News (optional) ────────────────────────────────────────────
  // Read on each request so update_prices / external cron can refresh
  // news_data.json without needing a server restart.
  if (newsDataPath) {
    app.get('/api/news', (req, res) => {
      try {
        const json = JSON.parse(fs.readFileSync(newsDataPath, 'utf8'));
        res.json(json);
      } catch (err) {
        console.error('[dashboard-core] /api/news:', err.message);
        res.status(500).json({ error: 'could not load news' });
      }
    });
  }

  // ── Options (optional) ─────────────────────────────────────────
  if (enableOptions) {
    app.get('/api/options/:ticker', async (req, res) => {
      let sym;
      try {
        sym = validateTicker(req.params.ticker);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const yahooSym = symbolAliases[sym] || sym;
      try {
        const j = await fetchYahooOptions(yahooSym, { timeoutMs: fetchTimeoutMs });
        res.set('cache-control', 'public, max-age=60');
        res.json(j);
      } catch (err) {
        console.error(`[dashboard-core] /api/options/${sym}:`, err.message);
        res.status(502).json({ error: 'upstream fetch failed' });
      }
    });

    app.get('/api/options-flow', async (req, res) => {
      let requested;
      try {
        requested = validateSymbols(req.query.symbols, validateOpts);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const symbols = requested.length ? requested : CANONICAL_TICKERS;
      if (!symbols.length) return res.status(400).json({ error: 'symbols required' });

      const unusualMinVol  = +req.query.unusualMinVol  || 500;
      const unusualVolToOI = +req.query.unusualVolToOI || 3;

      const cacheKey = `options-flow:${symbols.join(',')}:${unusualMinVol}:${unusualVolToOI}`;
      const hit = cache.get(cacheKey);
      if (hit) {
        res.set('cache-control', 'public, max-age=120');
        return res.json(hit);
      }

      const perTicker = {};
      await mapLimit(symbols, fetchConcurrency, async (sym) => {
        if (SKIP_LIVE.has(sym)) return;
        const yahooSym = symbolAliases[sym] || sym;
        try {
          const j = await fetchYahooOptions(yahooSym, { timeoutMs: fetchTimeoutMs });
          const result = j?.optionChain?.result?.[0];
          if (!result) return;

          const quote = result.quote || {};
          const chain = result.options?.[0]; // nearest expiration
          if (!chain) return;

          let callVol = 0, putVol = 0, callPrem = 0, putPrem = 0;
          let callOI = 0, putOI = 0;
          const unusual = [];

          const scan = (legs, side) => {
            for (const c of legs || []) {
              const v  = c.volume || 0;
              const oi = c.openInterest || 0;
              const last = c.lastPrice || 0;
              const prem = v * last * 100;
              if (side === 'CALL') { callVol += v; callOI += oi; callPrem += prem; }
              else                 { putVol  += v; putOI  += oi; putPrem  += prem; }
              if (oi > 0 && v > oi * unusualVolToOI && v > unusualMinVol) {
                unusual.push({ side, strike: c.strike, volume: v, openInterest: oi, last, premium: prem, iv: c.impliedVolatility, exp: chain.expirationDate });
              }
            }
          };
          scan(chain.calls, 'CALL');
          scan(chain.puts,  'PUT');

          perTicker[sym] = {
            price: quote.regularMarketPrice,
            expiration: chain.expirationDate,
            callVol, putVol, callPrem, putPrem, callOI, putOI,
            pcRatio: callVol ? +(putVol / callVol).toFixed(3) : null,
            totalPrem: callPrem + putPrem,
            totalVol: callVol + putVol,
            unusual: unusual.sort((a, b) => b.premium - a.premium).slice(0, 3),
          };
        } catch (err) {
          console.warn(`[dashboard-core] /api/options-flow ${sym}:`, err.message);
        }
      });

      const payload = { asOf: Date.now(), tickers: perTicker };
      cache.set(cacheKey, payload);
      res.set('cache-control', 'public, max-age=120');
      res.json(payload);
    });
  }

  // ── Health ─────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      dashboard: dashboardName,
      tickerCount: CANONICAL_TICKERS.length,
      cacheSize: cache.size(),
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

module.exports = { createDashboardServer };
