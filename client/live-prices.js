/* ============================================================
   live-prices.js — runtime price refresher for dashboard-core
   ------------------------------------------------------------
   Polls /api/quotes every 60s, mutates the page's SW_DATA or
   TICKER_DATA object in place, then calls any render functions
   the page has registered via `window.dashboardRenderers.push(fn)`.

   v1.0.6 change vs v1.0.5: derives the symbol list from the page's
   own data on first poll and sends it as ?symbols=A,B,C so the
   refresh works even when the server was started with tickerData:null
   (in which case /api/quotes with no params returns an empty object).

   Dashboards opt in by:
     1. Loading this script (`<script src="/live-prices.js"></script>`)
     2. At the bottom of each render IIFE, adding:
          (window.dashboardRenderers = window.dashboardRenderers || []).push(renderFn);

   No-op if neither SW_DATA nor TICKER_DATA is present on window.
   ============================================================ */
(function () {
  'use strict';

  var INTERVAL_MS = 60000;          // poll every 60s
  var INITIAL_DELAY_MS = 800;       // small delay so first render finishes
  var MAX_SYMBOLS = 200;            // dashboard-core's /api/quotes cap

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

  // Build the ?symbols=A,B,C list from the page's data, capped at MAX_SYMBOLS.
  // We pass this explicitly so /api/quotes works for dashboards that don't
  // wire up tickerData on the server (e.g. AI dashboard, where TICKER_DATA
  // currently lives inline in HTML rather than an external JSON file).
  function symbolsParam(tickers) {
    var keys = Object.keys(tickers).filter(function (k) {
      // Skip pure-numeric and dot-prefixed quirks that Yahoo doesn't recognise
      // through the chart endpoint (e.g. '005930.KS' on the AI dashboard —
      // that one is left in TICKER_DATA for static display).
      return /^[A-Z][A-Z0-9.-]{0,9}$/.test(k);
    });
    if (keys.length > MAX_SYMBOLS) keys = keys.slice(0, MAX_SYMBOLS);
    return keys.join(',');
  }

  // Merge one fresh quote into the page's per-ticker object, in place.
  // Field names differ between the SW schema (previousClose/change/changePct)
  // and the AI schema (chg/chgPct, no previousClose). marketCap is NOT
  // touched here — /api/quotes returns chart data only; baseline mcaps from
  // sw_data.json / index.html stand until the next full refresh.
  function mergeQuote(t, q, schema) {
    if (typeof q.price === 'number' && q.price > 0) t.price = q.price;
    if (schema === 'sw') {
      if (typeof q.previousClose === 'number') t.previousClose = q.previousClose;
      if (typeof q.change === 'number')        t.change       = q.change;
      if (typeof q.changePct === 'number')     t.changePct    = q.changePct;
    } else { // 'ai'
      if (typeof q.change === 'number')    t.chg    = +q.change.toFixed(2);
      if (typeof q.changePct === 'number') t.chgPct = +q.changePct.toFixed(2);
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
  function updateBadge(count, ts, ok) {
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
    badge.textContent = '● live · ' + count + ' tkrs · ' + hhmmss;
    badge.style.color = '#9ecbff';
  }

  async function refresh() {
    var target = detectSchema();
    if (!target) return; // no data on page, nothing to do

    var syms = symbolsParam(target.tickers);
    var endpoint = '/api/quotes' + (syms ? '?symbols=' + encodeURIComponent(syms) : '');

    try {
      var r = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var payload = await r.json();
      var quotes = payload && payload.quotes;
      if (!quotes || typeof quotes !== 'object') {
        throw new Error('malformed payload');
      }

      var n = 0;
      for (var sym in quotes) {
        if (!Object.prototype.hasOwnProperty.call(quotes, sym)) continue;
        var t = target.tickers[sym];
        var q = quotes[sym];
        if (t && q) { mergeQuote(t, q, target.schema); n++; }
      }

      runRenderers();
      window.dispatchEvent(new CustomEvent('live-prices-updated', {
        detail: { count: n, updatedAt: payload.updatedAt, schema: target.schema }
      }));
      updateBadge(n, payload.updatedAt, true);
    } catch (e) {
      console.warn('[live-prices] refresh failed:', e && e.message);
      updateBadge(0, null, false);
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
