// Offline tests for v1.0.8 — quoteSummaryToFundamentals (server) and
// computeSignal (client logic, re-implemented inline since the client file
// is browser-IIFE). No network required.
//
//   node lib/signals/signals.test.js

const assert = require('assert');
const { quoteSummaryToFundamentals } = require('../../server/yahoo');

let n = 0;
const ok = (d, c) => { assert.ok(c, d); n++; };
const eq = (d, a, b) => { assert.strictEqual(a, b, d + ' (got ' + JSON.stringify(a) + ')'); n++; };

// ── A realistic quoteSummary response (shape per Yahoo v10 docs) ──
const sample = {
  quoteSummary: { result: [{
    earningsHistory: { history: [
      { period: '-4q', quarter: { fmt: '2025-06-30' }, epsActual: { raw: 1.10 }, epsEstimate: { raw: 1.00 }, surprisePercent: { raw: 0.10 } },
      { period: '-3q', quarter: { fmt: '2025-09-30' }, epsActual: { raw: 1.25 }, epsEstimate: { raw: 1.20 }, surprisePercent: { raw: 0.0417 } },
      { period: '-2q', quarter: { fmt: '2025-12-31' }, epsActual: { raw: 1.40 }, epsEstimate: { raw: 1.45 }, surprisePercent: { raw: -0.0345 } },
      { period: '-1q', quarter: { fmt: '2026-03-31' }, epsActual: { raw: 1.60 }, epsEstimate: { raw: 1.42 }, surprisePercent: { raw: 0.1268 } },
    ]},
    earnings: { financialsChart: { quarterly: [
      { date: '2Q2025', revenue: { raw: 20e9 }, earnings: { raw: 5e9 } },
      { date: '3Q2025', revenue: { raw: 22e9 }, earnings: { raw: 5.5e9 } },
      { date: '4Q2025', revenue: { raw: 25e9 }, earnings: { raw: 6e9 } },
      { date: '1Q2026', revenue: { raw: 28e9 }, earnings: { raw: 7e9 } },
    ]}},
    calendarEvents: { earnings: {
      earningsDate: [{ fmt: '2026-06-25' }],
      earningsAverage: { raw: 1.75 },
      revenueAverage: { raw: 30e9 },
      isEarningsDateEstimate: true,
    }},
    earningsTrend: { trend: [
      { period: '0q', growth: { raw: 0.30 }, revenueEstimate: { growth: { raw: 0.25 } } },
      { period: '+1q', growth: { raw: 0.28 } },
      { period: '0y', growth: { raw: 0.40 }, revenueEstimate: { growth: { raw: 0.35 } } },
      { period: '+1y', growth: { raw: 0.22 }, revenueEstimate: { growth: { raw: 0.18 } } },
    ]},
    financialData: {
      recommendationKey: 'strong_buy', recommendationMean: { raw: 1.4 },
      numberOfAnalystOpinions: { raw: 42 },
      targetMeanPrice: { raw: 520 }, targetMedianPrice: { raw: 530 },
      currentPrice: { raw: 460 }, revenueGrowth: { raw: 0.28 }, earningsGrowth: { raw: 0.35 },
      grossMargins: { raw: 0.74 },
    },
    summaryDetail: { trailingPE: { raw: 28.8 }, forwardPE: { raw: 22.1 }, profitMargins: { raw: 0.41 } },
    defaultKeyStatistics: {},
  }]},
};

// ── quoteSummaryToFundamentals ──
const f = quoteSummaryToFundamentals(sample);
ok('fundamentals not null', f != null);
eq('epsHistory has 4 entries', f.epsHistory.length, 4);
eq('-1q beat flag true', f.epsHistory[3].beat, true);
eq('-2q beat flag false (missed)', f.epsHistory[2].beat, false);
eq('-1q surprisePct scaled to %', f.epsHistory[3].surprisePct, 12.68);
eq('revenueHistory has 4 entries', f.revenueHistory.length, 4);
eq('revenueHistory 1Q2026 revenue', f.revenueHistory[3].revenue, 28e9);
eq('nextEarningsDate parsed', f.nextEarningsDate, '2026-06-25');
eq('isEarningsDateEstimate flag', f.isEarningsDateEstimate, true);
eq('forward nextY EPS growth scaled', f.forward.epsGrowthNextY, 22);
eq('forward currentY rev growth scaled', f.forward.revGrowthCurrentY, 35);
eq('analyst recommendationKey', f.analyst.recommendationKey, 'strong_buy');
eq('analyst targetMeanPrice', f.analyst.targetMeanPrice, 520);
eq('trailingPE', f.trailingPE, 28.8);
eq('forwardPE', f.forwardPE, 22.1);

// ── null / partial handling ──
eq('null on empty', quoteSummaryToFundamentals({}), null);
eq('null on undefined', quoteSummaryToFundamentals(undefined), null);
const partial = { quoteSummary: { result: [{ earningsHistory: { history: [
  { period: '-1q', quarter: { fmt: '2026-03-31' }, epsActual: { raw: 2.0 }, epsEstimate: { raw: 1.8 }, surprisePercent: { raw: 0.111 } },
]}}]}};
const fp = quoteSummaryToFundamentals(partial);
ok('partial: epsHistory present', fp.epsHistory.length === 1);
ok('partial: no analyst key when absent', !('analyst' in fp));
ok('partial: no forward key when absent', !('forward' in fp));

// ── computeSignal (inline copy of the client rules, kept in sync) ──
function computeSignal(t) {
  if (!t || !t.fundamentals) return null;
  var f = t.fundamentals, parts = [];
  var hist = f.epsHistory || [];
  if (hist.length) {
    var last = hist[hist.length - 1], pts, detail;
    if (last.beat === true) { var s = last.surprisePct || 0; pts = s >= 10 ? 20 : s >= 2 ? 16 : 12; }
    else if (last.beat === false) { pts = 4; }
    else pts = null;
    if (pts != null) parts.push({ label: 'Last-Q EPS', points: pts, max: 20 });
  }
  if (hist.length) {
    var beats = hist.filter(h => h.beat === true).length;
    var graded = hist.filter(h => h.beat === true || h.beat === false).length;
    if (graded > 0) parts.push({ label: 'Beat streak', points: Math.min(Math.round((beats / Math.min(graded, 4)) * 20), 20), max: 20 });
  }
  var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
  if (fwdG != null) parts.push({ label: 'Fwd EPS growth', points: fwdG >= 25 ? 20 : fwdG >= 15 ? 15 : fwdG >= 5 ? 10 : fwdG > 0 ? 5 : 0, max: 20 });
  var rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
  if (rm != null) parts.push({ label: 'Analyst view', points: rm <= 1.5 ? 20 : rm <= 2.0 ? 16 : rm <= 2.5 ? 12 : rm <= 3.0 ? 8 : rm <= 3.5 ? 4 : 0, max: 20 });
  var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
  var price = typeof t.price === 'number' ? t.price : null;
  if (pt != null && price != null && price > 0) {
    var up = ((pt - price) / price) * 100;
    parts.push({ label: 'Upside to PT', points: up >= 25 ? 20 : up >= 10 ? 15 : up >= 0 ? 8 : up >= -10 ? 4 : 0, max: 20 });
  }
  if (!parts.length) return null;
  var earned = parts.reduce((s, p) => s + p.points, 0);
  var possible = parts.reduce((s, p) => s + p.max, 0);
  var score = Math.round((earned / possible) * 100);
  return { score, label: score >= 70 ? 'Strong' : score >= 45 ? 'Moderate' : 'Weak', breakdown: parts, dataCoverage: parts.length };
}

// Full-data ticker at live price $460 → all 5 components present
const sig = computeSignal({ price: 460, fundamentals: f });
ok('signal computed', sig != null);
eq('all 5 components covered', sig.dataCoverage, 5);
// Last-Q beat +12.68% → 20; streak 3/4 → 15; fwd 22% → 15; rec 1.4 → 20; upside (520-460)/460=13% → 15
// earned = 20+15+15+20+15 = 85 / 100 = 85
eq('score = 85', sig.score, 85);
eq('label Strong', sig.label, 'Strong');

// Same ticker but price spiked to $530 → upside negative, lower score
const sig2 = computeSignal({ price: 530, fundamentals: f });
ok('higher price → lower or equal score', sig2.score <= sig.score);

// Partial-data ticker (only epsHistory) → normalized over 2 components
const sigP = computeSignal({ price: 100, fundamentals: fp });
eq('partial coverage = 2', sigP.dataCoverage, 2);
ok('partial still scores', typeof sigP.score === 'number');

// No fundamentals → null
eq('no fundamentals → null', computeSignal({ price: 100 }), null);

console.log('all ' + n + ' signal/fundamentals tests passed');
