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
  // THE SIGNAL — fully transparent, 6 components, normalized.
  //
  //   1. Last-Q EPS beat ................ max 20
  //   2. Beat streak (PRIOR quarters,
  //      excludes the latest so it isn't
  //      double-counted with #1) ........ max 20
  //   3. Forward EPS growth ............. max 20
  //   4. Analyst consensus .............. max 20
  //   5. Upside to mean price target .... max 10  (halved: analyst PTs lag
  //      price, so raw upside rewards falling knives; momentum offsets)
  //   6. 20-day momentum from
  //      priceHistory (when present) .... max 20
  //
  // Components with missing data are skipped and the score is normalized
  // over the max-points of the components that DID have data. A result
  // with fewer than MIN_COVERAGE components gets no Strong/Moderate/Weak
  // label (label='Low data') — the remaining components are typically the
  // analyst-derived ones, which skew bullish.
  //
  // Returns: { score (0-100), label, breakdown[], dataCoverage }
  // ──────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────
  // UNIFIED EVIDENCE SCORER — identical math to lib/signals/score.js
  // (the canonical, unit-tested copy). If you change one, change both;
  // the test suite runs a parity check across fixtures.
  //
  // Descriptive evidence summary — NOT a return forecast, and not
  // historically validated. Piecewise-linear anchors, no step cliffs.
  // ──────────────────────────────────────────────────────────────
  var MIN_COVERAGE = 4;
  var HISTORY_FRESH_DAYS = 14;

  function historyIsFresh() {
    var d = window.SW_DATA && window.SW_DATA.refreshedAt;
    if (!d) return false;
    var ms = Date.parse(d);
    if (isNaN(ms)) return false;
    return (Date.now() - ms) <= HISTORY_FRESH_DAYS * 86400000;
  }

  function lerp(anchors, x) {
    if (x <= anchors[0][0]) return anchors[0][1];
    var last = anchors[anchors.length - 1];
    if (x >= last[0]) return last[1];
    for (var i = 1; i < anchors.length; i++) {
      var x1 = anchors[i - 1][0], y1 = anchors[i - 1][1];
      var x2 = anchors[i][0], y2 = anchors[i][1];
      if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
    }
    return last[1];
  }

  var CURVES = {
    lastQ: [[-10, 0], [10, 20]],
    fwdGrowth: [[0, 0], [25, 20]],
    analystMean: [[1, 15], [3, 5], [4.5, 0]],
    ptGap: [[-10, 0], [0, 4], [25, 10]],
    momentum: [[-10, 0], [0, 10], [15, 20]],
  };

  function computeSignal(t, historyFresh) {
    if (historyFresh === undefined) historyFresh = historyIsFresh();
    if (!t || !t.fundamentals) return null;
    var f = t.fundamentals;
    var parts = [];

    var hist = (f.epsHistory || []).slice().sort(function (a, b) {
      if (a.quarter && b.quarter) return a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0;
      return 0;
    });

    if (hist.length) {
      var last = hist[hist.length - 1];
      if (last.beat === true || last.beat === false) {
        var surprise = typeof last.surprisePct === 'number' ? last.surprisePct : (last.beat ? 0.01 : -0.01);
        parts.push({ label: 'Last-Q EPS', points: lerp(CURVES.lastQ, surprise), max: 20,
          detail: (last.beat ? 'Beat ' : 'Miss ') + Math.abs(surprise).toFixed(1) + '%' });
      }
    }

    if (hist.length > 1) {
      var prior = hist.slice(0, -1);
      var graded = prior.filter(function (h) { return h.beat === true || h.beat === false; });
      if (graded.length) {
        var beats = graded.filter(function (h) { return h.beat === true; }).length;
        parts.push({ label: 'Prior-Q consistency', points: (beats / graded.length) * 15, max: 15,
          detail: beats + '/' + graded.length + ' prior quarters beat' });
      }
    }

    var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
    var fwdSrc = 'next-yr est';
    if (fwdG == null && f.analyst && typeof f.analyst.earningsGrowth === 'number') {
      fwdG = f.analyst.earningsGrowth; fwdSrc = 'latest-Q YoY';
    }
    if (fwdG != null) {
      parts.push({ label: 'Fwd EPS growth', points: lerp(CURVES.fwdGrowth, fwdG), max: 20,
        detail: fwdG.toFixed(1) + '% (' + fwdSrc + ')' });
    }

    var rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
    if (rm != null) {
      var key = f.analyst.recommendationKey ? f.analyst.recommendationKey.replace(/_/g, ' ') : ('mean ' + rm.toFixed(2));
      var nOp = f.analyst.numberOfAnalystOpinions;
      parts.push({ label: 'Analyst view', points: lerp(CURVES.analystMean, rm), max: 15,
        detail: key + (nOp ? ' (' + nOp + ')' : '') });
    }

    var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
    var price = typeof t.price === 'number' ? t.price : null;
    if (pt != null && price != null && price > 0) {
      var upside = ((pt - price) / price) * 100;
      parts.push({ label: 'PT gap', points: lerp(CURVES.ptGap, upside), max: 10,
        detail: (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% to $' + pt.toFixed(0) });
    }

    var ph = t.priceHistory;
    if (historyFresh && Array.isArray(ph) && ph.length >= 21 && price != null && price > 0) {
      var then = ph[ph.length - 21];
      if (typeof then === 'number' && then > 0) {
        var mom = ((price - then) / then) * 100;
        parts.push({ label: '20d momentum', points: lerp(CURVES.momentum, mom), max: 20,
          detail: (mom >= 0 ? '+' : '') + mom.toFixed(1) + '% over 20 sessions' });
      }
    }

    if (!parts.length) return null;
    var rounded = parts.map(function (p) { return { label: p.label, points: Math.round(p.points * 10) / 10, max: p.max, detail: p.detail }; });
    if (parts.length < MIN_COVERAGE) {
      return { score: null, label: 'Insufficient data', status: 'insufficient', breakdown: rounded, dataCoverage: parts.length };
    }
    var earned = parts.reduce(function (s2, p) { return s2 + p.points; }, 0);
    var possible = parts.reduce(function (s2, p) { return s2 + p.max; }, 0);
    var score = Math.round((earned / possible) * 100);
    var label = score >= 70 ? 'Higher evidence' : score >= 45 ? 'Mixed evidence' : 'Lower evidence';
    return { score: score, label: label, status: 'rated', breakdown: rounded, dataCoverage: parts.length };
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
