/* ============================================================
   signals.js — earnings fundamentals + rules-based buy-signal
   ------------------------------------------------------------
   NOT FINANCIAL ADVICE. This computes a transparent, mechanical
   score from objective Yahoo data (EPS beat/miss history, forward
   growth consensus, analyst recommendation, and upside to mean
   price target). Every component and its weight is visible below
   so the score is fully auditable. It is a data summary, not a
   recommendation to buy or sell any security.

   Flow:
     1. On load, fetch /api/fundamentals?symbols=... ONCE (the data
        changes ~quarterly; the server caches it 1h).
     2. Merge each ticker's fundamentals into SW_DATA.tickers[X]
        .fundamentals (or TICKER_DATA[X].fundamentals).
     3. Expose window.computeSignal(tickerObj) and
        window.tickerSignals[symbol] for renderers.
     4. Fire a 'fundamentals-loaded' event and call any registered
        window.dashboardRenderers so tables can draw.

   The signal uses the LIVE polled price (tickerObj.price) for the
   upside-to-PT and valuation components, so it stays current as
   live-prices.js updates prices every 60s.
   ============================================================ */
(function () {
  'use strict';

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

  // ──────────────────────────────────────────────────────────────
  // THE SIGNAL — fully transparent, 5 components, 20 points each.
  //
  // Components with missing data are skipped, and the final score is
  // normalized over the components that DID have data (so a ticker
  // lacking analyst coverage isn't unfairly zeroed). `dataCoverage`
  // reports how many of the 5 components contributed.
  //
  // Returns: { score (0-100|null), label, breakdown[], dataCoverage }
  // ──────────────────────────────────────────────────────────────
  function computeSignal(t) {
    if (!t) return null;
    var f = t.fundamentals;
    if (!f) return null;

    var parts = [];

    // 1. Last-quarter EPS beat (0-20)
    var hist = f.epsHistory || [];
    if (hist.length) {
      var last = hist[hist.length - 1];
      var pts, detail;
      if (last.beat === true) {
        var surp = typeof last.surprisePct === 'number' ? last.surprisePct : 0;
        pts = surp >= 10 ? 20 : (surp >= 2 ? 16 : 12);
        detail = 'Beat by ' + (last.surprisePct != null ? last.surprisePct.toFixed(1) + '%' : '—');
      } else if (last.beat === false) {
        pts = 4;
        detail = 'Missed by ' + (last.surprisePct != null ? Math.abs(last.surprisePct).toFixed(1) + '%' : '—');
      } else { pts = null; detail = 'No estimate'; }
      if (pts != null) parts.push({ label: 'Last-Q EPS', points: pts, max: 20, detail: detail });
    }

    // 2. Beat consistency over available history (0-20): 5 pts per beat, up to 4Q
    if (hist.length) {
      var beats = hist.filter(function (h) { return h.beat === true; }).length;
      var graded = hist.filter(function (h) { return h.beat === true || h.beat === false; }).length;
      if (graded > 0) {
        var consistency = Math.round((beats / Math.min(graded, 4)) * 20);
        parts.push({
          label: 'Beat streak',
          points: Math.min(consistency, 20),
          max: 20,
          detail: beats + '/' + graded + ' quarters beat',
        });
      }
    }

    // 3. Forward EPS growth, next year (0-20)
    var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
    if (fwdG == null && f.analyst && typeof f.analyst.earningsGrowth === 'number') fwdG = f.analyst.earningsGrowth;
    if (fwdG != null) {
      var gp = fwdG >= 25 ? 20 : fwdG >= 15 ? 15 : fwdG >= 5 ? 10 : fwdG > 0 ? 5 : 0;
      parts.push({ label: 'Fwd EPS growth', points: gp, max: 20, detail: fwdG.toFixed(1) + '% YoY' });
    }

    // 4. Analyst consensus (0-20) from recommendationMean (1=Strong Buy … 5=Strong Sell)
    var rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
    if (rm != null) {
      var ap = rm <= 1.5 ? 20 : rm <= 2.0 ? 16 : rm <= 2.5 ? 12 : rm <= 3.0 ? 8 : rm <= 3.5 ? 4 : 0;
      var key = f.analyst.recommendationKey ? f.analyst.recommendationKey.replace(/_/g, ' ') : ('mean ' + rm.toFixed(2));
      var nOp = f.analyst.numberOfAnalystOpinions;
      parts.push({ label: 'Analyst view', points: ap, max: 20, detail: key + (nOp ? ' (' + nOp + ')' : '') });
    }

    // 5. Upside to mean price target (0-20) — uses LIVE price
    var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
    var price = typeof t.price === 'number' ? t.price : null;
    if (pt != null && price != null && price > 0) {
      var upside = ((pt - price) / price) * 100;
      var up = upside >= 25 ? 20 : upside >= 10 ? 15 : upside >= 0 ? 8 : upside >= -10 ? 4 : 0;
      parts.push({ label: 'Upside to PT', points: up, max: 20, detail: (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% to $' + pt.toFixed(0) });
    }

    if (!parts.length) return null;

    var earned = parts.reduce(function (s, p) { return s + p.points; }, 0);
    var possible = parts.reduce(function (s, p) { return s + p.max; }, 0);
    var score = Math.round((earned / possible) * 100);
    var label = score >= 70 ? 'Strong' : score >= 45 ? 'Moderate' : 'Weak';

    return { score: score, label: label, breakdown: parts, dataCoverage: parts.length };
  }

  // Recompute every ticker's signal into window.tickerSignals using the
  // current (live) prices. Cheap; safe to call on every render.
  function recomputeAll() {
    var target = detectSchema();
    if (!target) return;
    var out = {};
    for (var sym in target.tickers) {
      if (!Object.prototype.hasOwnProperty.call(target.tickers, sym)) continue;
      var sig = computeSignal(target.tickers[sym]);
      if (sig) out[sym] = sig;
    }
    window.tickerSignals = out;
  }

  function runRenderers() {
    var rs = window.dashboardRenderers;
    if (!rs || !rs.length) return;
    for (var i = 0; i < rs.length; i++) {
      try { rs[i](); } catch (e) { console.warn('[signals] renderer threw:', e && e.message); }
    }
  }

  async function loadFundamentals() {
    var target = detectSchema();
    if (!target) return;
    var syms = symbolsParam(target.tickers);
    var endpoint = '/api/fundamentals' + (syms ? '?symbols=' + encodeURIComponent(syms) : '');
    try {
      var r = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var payload = await r.json();
      var fund = payload && payload.fundamentals;
      if (!fund || typeof fund !== 'object') throw new Error('malformed payload');

      var n = 0;
      for (var sym in fund) {
        if (!Object.prototype.hasOwnProperty.call(fund, sym)) continue;
        if (target.tickers[sym]) { target.tickers[sym].fundamentals = fund[sym]; n++; }
      }
      recomputeAll();
      runRenderers();
      window.dispatchEvent(new CustomEvent('fundamentals-loaded', {
        detail: { count: n, updatedAt: payload.updatedAt, schema: target.schema }
      }));
      console.info('[signals] fundamentals loaded for ' + n + ' tickers');
    } catch (e) {
      console.warn('[signals] fundamentals load failed:', e && e.message);
    }
  }

  // Recompute signals whenever live-prices.js updates prices (upside-to-PT
  // and valuation shift with price), then let renderers redraw.
  window.addEventListener('live-prices-updated', function () {
    if (window.tickerSignals) { recomputeAll(); }
  });

  // Expose for renderers + ad-hoc console inspection.
  window.computeSignal = computeSignal;
  window.recomputeSignals = recomputeAll;

  function start() { loadFundamentals(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
