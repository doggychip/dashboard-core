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
  var MIN_COVERAGE = 3;
  var HISTORY_FRESH_DAYS = 14; // ~10 trading sessions

  // The 20d-momentum component divides live price by priceHistory[len-21] —
  // but priceHistory only changes on update-prices runs. If the baseline is
  // stale, "20 sessions" silently becomes months. update-prices >= v1.0.10
  // stamps SW_DATA.refreshedAt (YYYY-MM-DD); momentum only counts when that
  // stamp exists and is recent. Unstamped or old data → component skipped
  // (normalization excludes it), so staleness is visible, never silent.
  function historyIsFresh() {
    var d = window.SW_DATA && window.SW_DATA.refreshedAt;
    if (!d) return false;
    var ms = Date.parse(d);
    if (isNaN(ms)) return false;
    return (Date.now() - ms) <= HISTORY_FRESH_DAYS * 86400000;
  }

  function computeSignal(t, historyFresh) {
    if (historyFresh === undefined) historyFresh = historyIsFresh();
    if (!t) return null;
    var f = t.fundamentals;
    if (!f) return null;

    var parts = [];

    // Defensive copy + sort by quarter date (server sorts too; don't trust it).
    var hist = (f.epsHistory || []).slice().sort(function (a, b) {
      if (a.quarter && b.quarter) return a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0;
      return 0;
    });

    // 1. Last-quarter EPS beat (0-20)
    if (hist.length) {
      var last = hist[hist.length - 1];
      var pts = null, detail;
      if (last.beat === true) {
        var surp = typeof last.surprisePct === 'number' ? last.surprisePct : 0;
        pts = surp >= 10 ? 20 : (surp >= 2 ? 16 : 12);
        detail = 'Beat by ' + (last.surprisePct != null ? last.surprisePct.toFixed(1) + '%' : '—');
      } else if (last.beat === false) {
        pts = 4;
        detail = 'Missed by ' + (last.surprisePct != null ? Math.abs(last.surprisePct).toFixed(1) + '%' : '—');
      }
      if (pts != null) parts.push({ label: 'Last-Q EPS', points: pts, max: 20, detail: detail });
    }

    // 2. Beat streak over PRIOR quarters — excludes the latest quarter so the
    //    same beat isn't counted in both #1 and #2.
    if (hist.length > 1) {
      var prior = hist.slice(0, -1);
      var beats = prior.filter(function (h) { return h.beat === true; }).length;
      var graded = prior.filter(function (h) { return h.beat === true || h.beat === false; }).length;
      if (graded > 0) {
        var consistency = Math.round((beats / Math.min(graded, 3)) * 20);
        parts.push({
          label: 'Beat streak',
          points: Math.min(consistency, 20),
          max: 20,
          detail: beats + '/' + graded + ' prior quarters beat',
        });
      }
    }

    // 3. Forward EPS growth, next year (0-20). Falls back to latest-quarter
    //    YoY earnings growth — a different horizon, so the detail says so.
    var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
    var fwdSrc = 'next-yr est';
    if (fwdG == null && f.analyst && typeof f.analyst.earningsGrowth === 'number') {
      fwdG = f.analyst.earningsGrowth;
      fwdSrc = 'latest-Q YoY';
    }
    if (fwdG != null) {
      var gp = fwdG >= 25 ? 20 : fwdG >= 15 ? 15 : fwdG >= 5 ? 10 : fwdG > 0 ? 5 : 0;
      parts.push({ label: 'Fwd EPS growth', points: gp, max: 20, detail: fwdG.toFixed(1) + '% (' + fwdSrc + ')' });
    }

    // 4. Analyst consensus (0-20) — recommendationMean 1=Strong Buy … 5=Strong Sell.
    //    NOTE: sell-side consensus skews bullish; this is why the label needs
    //    MIN_COVERAGE and why #5 is capped at 10.
    var rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
    if (rm != null) {
      var ap = rm <= 1.5 ? 20 : rm <= 2.0 ? 16 : rm <= 2.5 ? 12 : rm <= 3.0 ? 8 : rm <= 3.5 ? 4 : 0;
      var key = f.analyst.recommendationKey ? f.analyst.recommendationKey.replace(/_/g, ' ') : ('mean ' + rm.toFixed(2));
      var nOp = f.analyst.numberOfAnalystOpinions;
      parts.push({ label: 'Analyst view', points: ap, max: 20, detail: key + (nOp ? ' (' + nOp + ')' : '') });
    }

    // 5. Upside to mean price target (0-10, uses LIVE price). Half-weight:
    //    PTs lag price, so upside mechanically inflates after a crash.
    var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
    var price = typeof t.price === 'number' ? t.price : null;
    if (pt != null && price != null && price > 0) {
      var upside = ((pt - price) / price) * 100;
      var up = upside >= 25 ? 10 : upside >= 10 ? 7 : upside >= 0 ? 4 : upside >= -10 ? 2 : 0;
      parts.push({ label: 'Upside to PT', points: up, max: 10, detail: (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% to $' + pt.toFixed(0) });
    }

    // 6. 20-day momentum (0-20) — from priceHistory (daily closes) when the
    //    dashboard carries it (SW schema does; AI schema doesn't). Uses the
    //    live price as the endpoint so it tracks intraday. This is the
    //    counterweight to #5: a crashing stock loses momentum points as its
    //    "upside" expands.
    var ph = t.priceHistory;
    if (historyFresh && Array.isArray(ph) && ph.length >= 21 && price != null && price > 0) {
      var then = ph[ph.length - 21];
      if (typeof then === 'number' && then > 0) {
        var mom = ((price - then) / then) * 100;
        var mp = mom >= 15 ? 20 : mom >= 5 ? 15 : mom >= 0 ? 10 : mom >= -10 ? 5 : 0;
        parts.push({ label: '20d momentum', points: mp, max: 20, detail: (mom >= 0 ? '+' : '') + mom.toFixed(1) + '% over 20 sessions' });
      }
    }

    if (!parts.length) return null;

    var earned = parts.reduce(function (s, p) { return s + p.points; }, 0);
    var possible = parts.reduce(function (s, p) { return s + p.max; }, 0);
    var score = Math.round((earned / possible) * 100);
    var label;
    if (parts.length < MIN_COVERAGE) {
      label = 'Low data';
    } else {
      label = score >= 70 ? 'Strong' : score >= 45 ? 'Moderate' : 'Weak';
    }

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
