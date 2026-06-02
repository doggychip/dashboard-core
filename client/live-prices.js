/* ============================================================
   live-prices.js — runtime price + extras refresher for dashboard-core
   ------------------------------------------------------------
   Polls /api/quotes every 60s, mutates the page's SW_DATA or
   TICKER_DATA object in place, then calls any render functions
   the page has registered via `window.dashboardRenderers.push(fn)`.

   v1.0.7 changes vs v1.0.6:
   - /api/quotes now returns per-ticker `extras` (eps, pe, divYield,
     52w high/low, dayHi/Lo, volume, marketCap, analyst PT,
     recommendation key). Merges those into SW_DATA.tickers[X] so
     the Valuation Table re-renders with live PE/EPS/52w/etc., not
     just price.
   - Extras are SW-schema only at the merge level: AI schema stores
     mcap/pe/hi52/lo52 as pre-formatted strings ($X.XT), so this
     script doesn't touch those — Valuation-Table-style numeric
     fields are SW-only.

   Dashboards opt in by:
     1. Loading this script (`<script src="/live-prices.js"></script>`)
     2. At the bottom of each render IIFE, adding:
          (window.dashboardRenderers = window.dashboardRenderers || []).push(renderFn);
   ============================================================ */
(function () {
  'use strict';

  var INTERVAL_MS = 60000;          // poll every 60s
  var INITIAL_DELAY_MS = 800;
  var MAX_SYMBOLS = 200;

  function detectSchema() {
    if (typeof window.SW_DATA === 'object' && window.SW_DATA && window.SW_DATA.tickers) {
      return { schema: 'sw', tickers: window.SW_DATA.tickers };
    }
    if (typeof window.TICKER_DATA === 'object' && window.TICKER_DATA
        && Object.keys(window.TICKER_DATA).length > 0) {
      return { schema: 'ai', tickers: window.TICKER_DATA };
    }
    return null;
  }

  function symbolsParam(tickers) {
    var keys = Object.keys(tickers).filter(function (k) {
      return /^[A-Z][A-Z0-9.-]{0,9}$/.test(k);
    });
    if (keys.length > MAX_SYMBOLS) keys = keys.slice(0, MAX_SYMBOLS);
    return keys.join(',');
  }

  function mergeQuote(t, q, schema) {
    // Always-live numeric fields (chart-derived, both schemas).
    if (typeof q.price === 'number' && q.price > 0) t.price = q.price;
    if (schema === 'sw') {
      if (typeof q.previousClose === 'number') t.previousClose = q.previousClose;
      if (typeof q.change === 'number')        t.change       = q.change;
      if (typeof q.changePct === 'number')     t.changePct    = q.changePct;
    } else {
      if (typeof q.change === 'number')    t.chg    = +q.change.toFixed(2);
      if (typeof q.changePct === 'number') t.chgPct = +q.changePct.toFixed(2);
    }

    // v1.0.7: merge quoteSummary extras. SW schema stores these as plain
    // numbers, so direct assignment works. AI schema stores mcap/pe/52w as
    // pre-formatted strings ($X.XT / 'N/A'), so we skip those for AI to
    // avoid format mismatches with renderers that expect strings.
    var x = q.extras;
    if (x && schema === 'sw') {
      if (typeof x.marketCap === 'number'           && x.marketCap > 0)         t.marketCap    = x.marketCap;
      if (typeof x.trailingEps === 'number')                                    t.eps          = x.trailingEps;
      if (typeof x.trailingPE === 'number'          && x.trailingPE > 0)        t.pe           = x.trailingPE;
      if (typeof x.divYield === 'number')                                       t.divYield     = x.divYield;
      if (typeof x.fiftyTwoWeekHigh === 'number'    && x.fiftyTwoWeekHigh > 0)  t.yearHigh     = x.fiftyTwoWeekHigh;
      if (typeof x.fiftyTwoWeekLow === 'number'     && x.fiftyTwoWeekLow > 0)   t.yearLow      = x.fiftyTwoWeekLow;
      if (typeof x.dayHigh === 'number'             && x.dayHigh > 0)           t.dayHigh      = x.dayHigh;
      if (typeof x.dayLow === 'number'              && x.dayLow > 0)            t.dayLow       = x.dayLow;
      if (typeof x.regularMarketVolume === 'number' && x.regularMarketVolume > 0) t.volume     = x.regularMarketVolume;
      if (typeof x.averageVolume === 'number'       && x.averageVolume > 0)     t.avgVolume    = x.averageVolume;
      if (typeof t.volume === 'number' && typeof t.avgVolume === 'number' && t.avgVolume > 0) {
        t.volRatio = +(t.volume / t.avgVolume).toFixed(2);
      }
      // Analyst fields — stored but no existing renderer displays them yet.
      // Available for future use (e.g. "Avg PT $X · X% upside" in conviction cards).
      if (typeof x.targetMeanPrice === 'number')         t.targetMeanPrice         = x.targetMeanPrice;
      if (typeof x.targetMedianPrice === 'number')       t.targetMedianPrice       = x.targetMedianPrice;
      if (typeof x.targetHighPrice === 'number')         t.targetHighPrice         = x.targetHighPrice;
      if (typeof x.targetLowPrice === 'number')          t.targetLowPrice          = x.targetLowPrice;
      if (typeof x.recommendationKey === 'string')       t.recommendationKey       = x.recommendationKey;
      if (typeof x.recommendationMean === 'number')      t.recommendationMean      = x.recommendationMean;
      if (typeof x.numberOfAnalystOpinions === 'number') t.numberOfAnalystOpinions = x.numberOfAnalystOpinions;
    } else if (x && schema === 'ai') {
      // For AI, only stash numeric extras that don't conflict with the
      // string-formatted display fields. Renderers that want them can read
      // these (e.g. a future targeted card update).
      if (typeof x.targetMeanPrice === 'number')         t.targetMeanPrice         = x.targetMeanPrice;
      if (typeof x.targetMedianPrice === 'number')       t.targetMedianPrice       = x.targetMedianPrice;
      if (typeof x.recommendationKey === 'string')       t.recommendationKey       = x.recommendationKey;
      if (typeof x.recommendationMean === 'number')      t.recommendationMean      = x.recommendationMean;
      if (typeof x.numberOfAnalystOpinions === 'number') t.numberOfAnalystOpinions = x.numberOfAnalystOpinions;
      if (typeof x.dayHigh === 'number'                  && x.dayHigh > 0)         t.dayHigh                 = x.dayHigh;
      if (typeof x.dayLow === 'number'                   && x.dayLow > 0)          t.dayLow                  = x.dayLow;
      if (typeof x.regularMarketVolume === 'number'      && x.regularMarketVolume > 0) t.volume              = x.regularMarketVolume;
    }
  }

  function runRenderers() {
    var rs = window.dashboardRenderers;
    if (!rs || !rs.length) return;
    for (var i = 0; i < rs.length; i++) {
      try { rs[i](); }
      catch (e) { console.warn('[live-prices] renderer threw:', e && e.message); }
    }
  }

  var badge;
  function updateBadge(count, extrasCount, ts, ok) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'live-prices-badge';
      badge.style.cssText =
        'position:fixed;bottom:6px;right:8px;z-index:9999;' +
        'background:rgba(0,0,0,0.55);color:#9ecbff;' +
        'font:11px/1.2 ui-monospace,monospace;padding:3px 7px;' +
        'border-radius:3px;pointer-events:none;letter-spacing:0.02em;';
      document.body.appendChild(badge);
    }
    if (!ok) {
      badge.textContent = '○ live · offline';
      badge.style.color = '#777';
      return;
    }
    var hhmmss = new Date(ts || Date.now()).toLocaleTimeString();
    var extrasHint = extrasCount > 0 ? ' (' + extrasCount + ' w/ fund)' : '';
    badge.textContent = '● live · ' + count + ' tkrs' + extrasHint + ' · ' + hhmmss;
    badge.style.color = '#9ecbff';
  }

  async function refresh() {
    var target = detectSchema();
    if (!target) return;

    var syms = symbolsParam(target.tickers);
    var endpoint = '/api/quotes' + (syms ? '?symbols=' + encodeURIComponent(syms) : '');

    try {
      var r = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var payload = await r.json();
      var quotes = payload && payload.quotes;
      if (!quotes || typeof quotes !== 'object') throw new Error('malformed payload');

      var n = 0;
      var nExtras = 0;
      for (var sym in quotes) {
        if (!Object.prototype.hasOwnProperty.call(quotes, sym)) continue;
        var t = target.tickers[sym];
        var q = quotes[sym];
        if (t && q) {
          mergeQuote(t, q, target.schema);
          n++;
          if (q.extras) nExtras++;
        }
      }

      runRenderers();
      window.dispatchEvent(new CustomEvent('live-prices-updated', {
        detail: { count: n, extrasCount: nExtras, updatedAt: payload.updatedAt, schema: target.schema }
      }));
      updateBadge(n, nExtras, payload.updatedAt, true);
    } catch (e) {
      console.warn('[live-prices] refresh failed:', e && e.message);
      updateBadge(0, 0, null, false);
    }
  }

  function start() {
    setTimeout(function () {
      refresh();
      setInterval(refresh, INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
