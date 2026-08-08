// Unified evidence scorer — the single source of truth for both dashboards.
//
// v1.0.12 merges the two divergent scorers that existed before:
//   - client/signals.js  (had: momentum + staleness gate + no double-count)
//   - SW assessment-trust.js  (had: better framing/labels, stricter coverage)
// keeping the best mechanics of each, plus piecewise-LINEAR interpolation
// between anchor points instead of step buckets (no more 24.9%-vs-25.0%
// scoring cliffs).
//
// Components (max points; total 100 when all present):
//   1. Last-Q EPS surprise ........ 20   lerp on surprise%: -10% → 0, +10% → 20
//   2. Prior-quarter consistency .. 15   beats / graded (last Q EXCLUDED — it
//                                        is already scored by #1)
//   3. Forward EPS growth ......... 20   lerp: 0% → 0, +25% → 20
//   4. Analyst consensus .......... 15   lerp on mean: 1.0 → 15, 3.0 → 5, 4.5 → 0
//   5. Price-target gap ........... 10   lerp: -10% → 0, 0% → 4, +25% → 10
//                                        (deliberately half-weight: PTs lag price)
//   6. 20d momentum ............... 20   lerp: -10% → 0, 0% → 10, +15% → 20
//                                        (requires fresh priceHistory — see
//                                        historyFresh; the falling-knife
//                                        counterweight to #5)
//
// Missing components are skipped and the score is normalized over the max
// points of those present. Fewer than MIN_COVERAGE components → score:null,
// status:'insufficient' — the survivors are typically the analyst-derived
// ones, which skew bullish.
//
// This is a DESCRIPTIVE evidence summary, not a return forecast, and it is
// not historically validated. bin/log-scores.js appends daily score
// snapshots precisely so that claim can eventually be tested.

'use strict';

const MIN_COVERAGE = 4;

// Piecewise-linear interpolation over sorted [x, y] anchors, clamped at ends.
function lerp(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

const CURVES = {
  lastQ: [[-10, 0], [10, 20]],
  fwdGrowth: [[0, 0], [25, 20]],
  analystMean: [[1, 15], [3, 5], [4.5, 0]],
  ptGap: [[-10, 0], [0, 4], [25, 10]],
  momentum: [[-10, 0], [0, 10], [15, 20]],
};

// t: ticker object with { price, priceHistory?, fundamentals }
// opts.historyFresh: whether priceHistory can be trusted as current
//   (callers gate this on the data's refreshedAt stamp).
function computeScore(t, opts = {}) {
  if (!t || !t.fundamentals) return null;
  const historyFresh = opts.historyFresh === undefined ? false : !!opts.historyFresh;
  const f = t.fundamentals;
  const parts = [];

  const hist = (f.epsHistory || []).slice().sort((a, b) => {
    if (a.quarter && b.quarter) return a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0;
    return 0;
  });

  // 1. Last-quarter EPS surprise (graded miss included — a -1% miss ≠ -15%).
  if (hist.length) {
    const last = hist[hist.length - 1];
    if (last.beat === true || last.beat === false) {
      const surprise = typeof last.surprisePct === 'number' ? last.surprisePct
        : (last.beat ? 0.01 : -0.01);
      parts.push({
        label: 'Last-Q EPS', points: lerp(CURVES.lastQ, surprise), max: 20,
        detail: (last.beat ? 'Beat ' : 'Miss ') + Math.abs(surprise).toFixed(1) + '%',
      });
    }
  }

  // 2. Prior-quarter consistency (excludes the latest quarter — no double count).
  if (hist.length > 1) {
    const prior = hist.slice(0, -1);
    const graded = prior.filter((h) => h.beat === true || h.beat === false);
    if (graded.length) {
      const beats = graded.filter((h) => h.beat === true).length;
      parts.push({
        label: 'Prior-Q consistency', points: (beats / graded.length) * 15, max: 15,
        detail: beats + '/' + graded.length + ' prior quarters beat',
      });
    }
  }

  // 3. Forward EPS growth (next-year estimate, else latest-Q YoY — labeled).
  let fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
  let fwdSrc = 'next-yr est';
  if (fwdG == null && f.analyst && typeof f.analyst.earningsGrowth === 'number') {
    fwdG = f.analyst.earningsGrowth;
    fwdSrc = 'latest-Q YoY';
  }
  if (fwdG != null) {
    parts.push({
      label: 'Fwd EPS growth', points: lerp(CURVES.fwdGrowth, fwdG), max: 20,
      detail: fwdG.toFixed(1) + '% (' + fwdSrc + ')',
    });
  }

  // 4. Analyst consensus (bullish-biased source → moderate weight).
  const rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
  if (rm != null) {
    const key = f.analyst.recommendationKey ? f.analyst.recommendationKey.replace(/_/g, ' ') : ('mean ' + rm.toFixed(2));
    const nOp = f.analyst.numberOfAnalystOpinions;
    parts.push({
      label: 'Analyst view', points: lerp(CURVES.analystMean, rm), max: 15,
      detail: key + (nOp ? ' (' + nOp + ')' : ''),
    });
  }

  // 5. Price-target gap at the CURRENT price (half-weight — PTs lag price).
  const pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
  const price = typeof t.price === 'number' ? t.price : null;
  if (pt != null && price != null && price > 0) {
    const upside = ((pt - price) / price) * 100;
    parts.push({
      label: 'PT gap', points: lerp(CURVES.ptGap, upside), max: 10,
      detail: (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% to $' + pt.toFixed(0),
    });
  }

  // 6. 20d momentum (fresh history only — the falling-knife counterweight).
  const ph = t.priceHistory;
  if (historyFresh && Array.isArray(ph) && ph.length >= 21 && price != null && price > 0) {
    const then = ph[ph.length - 21];
    if (typeof then === 'number' && then > 0) {
      const mom = ((price - then) / then) * 100;
      parts.push({
        label: '20d momentum', points: lerp(CURVES.momentum, mom), max: 20,
        detail: (mom >= 0 ? '+' : '') + mom.toFixed(1) + '% over 20 sessions',
      });
    }
  }

  if (!parts.length) return null;

  const roundedParts = parts.map((p) => ({ ...p, points: Math.round(p.points * 10) / 10 }));
  if (parts.length < MIN_COVERAGE) {
    return { score: null, label: 'Insufficient data', status: 'insufficient', breakdown: roundedParts, dataCoverage: parts.length };
  }
  const earned = parts.reduce((s, p) => s + p.points, 0);
  const possible = parts.reduce((s, p) => s + p.max, 0);
  const score = Math.round((earned / possible) * 100);
  const label = score >= 70 ? 'Higher evidence' : score >= 45 ? 'Mixed evidence' : 'Lower evidence';
  return { score, label, status: 'rated', breakdown: roundedParts, dataCoverage: parts.length };
}

module.exports = { computeScore, lerp, CURVES, MIN_COVERAGE };
