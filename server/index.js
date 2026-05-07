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
const { fetchYahooChart, fetchYahooOptions, chartToQuote, chartToBars, UA } = require('./yahoo');

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

  const validateOpts = { max: maxSymbolsPerRequest };

  const app = express();

  // ── Static layering ────────────────────────────────────────────
  // Package client/ is mounted FIRST so /dashboard_enhancements.js
  // resolves to the package's copy. Dashboard's publicDir is mounted
  // SECOND for HTML pages and dashboard-specific data files.
  app.use(express.static(path.join(__dirname, '..', 'client')));
  app.use(express.static(publicDir));

  // ── Single-quote ───────────────────────────────────────────────
  app.get('/api/quote/:symbol', async (req, res) => {
    let sym;
    try {
      sym = validateTicker(req.params.symbol);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const yahooSym = symbolAliases[sym] || sym;
      const data = await fetchYahooChart(yahooSym, '6mo', '1d', { timeoutMs: fetchTimeoutMs });
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
          const data = await fetchYahooChart(yahooSym, '1d', '1d', { timeoutMs: fetchTimeoutMs });
          const q = chartToQuote(data);
          if (q) quotes[sym] = q;
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
