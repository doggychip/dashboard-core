// Offline tests for v1.0.9 — quoteSummaryToFundamentals (server),
// computeSignal (client rules, mirrored inline), and rebuildConviction.
// No network required.
//
//   node lib/signals/signals.test.js

const assert = require('assert');
const { quoteSummaryToFundamentals } = require('../../server/yahoo');
const { rebuildConviction, momentum20d } = require('../update-prices/conviction');

let n = 0;
const ok = (d, c) => { assert.ok(c, d); n++; };
const eq = (d, a, b) => { assert.strictEqual(a, b, d + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); n++; };

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
      { date: '1Q2026', revenue: { raw: 28e9 }, earnings: { raw: 7e9 } },
    ]}},
    calendarEvents: { earnings: {
      earningsDate: [{ fmt: '2026-06-25' }],
      earningsAverage: { raw: 1.75 },
      isEarningsDateEstimate: true,
    }},
    earningsTrend: { trend: [
      { period: '0y', growth: { raw: 0.40 }, revenueEstimate: { growth: { raw: 0.35 } } },
      { period: '+1y', growth: { raw: 0.22 }, revenueEstimate: { growth: { raw: 0.18 } } },
    ]},
    financialData: {
      recommendationKey: 'strong_buy', recommendationMean: { raw: 1.4 },
      numberOfAnalystOpinions: { raw: 42 },
      targetMeanPrice: { raw: 520 },
      currentPrice: { raw: 460 }, revenueGrowth: { raw: 0.28 }, earningsGrowth: { raw: 0.35 },
    },
    summaryDetail: { trailingPE: { raw: 28.8 }, forwardPE: { raw: 22.1 } },
    defaultKeyStatistics: {},
  }]},
};

// ── extractor ──
const f = quoteSummaryToFundamentals(sample);
ok('fundamentals not null', f != null);
eq('epsHistory 4 entries', f.epsHistory.length, 4);
eq('-1q beat true', f.epsHistory[3].beat, true);
eq('-1q surprisePct scaled', f.epsHistory[3].surprisePct, 12.68);
eq('nextEarningsDate', f.nextEarningsDate, '2026-06-25');
eq('forward nextY scaled', f.forward.epsGrowthNextY, 22);
eq('analyst PT', f.analyst.targetMeanPrice, 520);

// Sort robustness: shuffle Yahoo's array — extractor must sort by quarter date
const shuffled = JSON.parse(JSON.stringify(sample));
shuffled.quoteSummary.result[0].earningsHistory.history.reverse(); // newest first
const fs2 = quoteSummaryToFundamentals(shuffled);
eq('sorted: oldest first', fs2.epsHistory[0].quarter, '2025-06-30');
eq('sorted: newest last', fs2.epsHistory[3].quarter, '2026-03-31');
eq('sorted: last entry is the real -1q', fs2.epsHistory[3].surprisePct, 12.68);

eq('null on empty', quoteSummaryToFundamentals({}), null);
eq('null on undefined', quoteSummaryToFundamentals(undefined), null);

// ── computeSignal (v1.0.9 rules, mirrored from client/signals.js) ──
const MIN_COVERAGE = 3;
function computeSignal(t, historyFresh) {
  if (historyFresh === undefined) historyFresh = true;
  if (!t || !t.fundamentals) return null;
  var f = t.fundamentals, parts = [];
  var hist = (f.epsHistory || []).slice().sort(function (a, b) {
    if (a.quarter && b.quarter) return a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0;
    return 0;
  });
  if (hist.length) {
    var last = hist[hist.length - 1], pts = null;
    if (last.beat === true) { var s = last.surprisePct || 0; pts = s >= 10 ? 20 : s >= 2 ? 16 : 12; }
    else if (last.beat === false) pts = 4;
    if (pts != null) parts.push({ label: 'Last-Q EPS', points: pts, max: 20 });
  }
  if (hist.length > 1) {
    var prior = hist.slice(0, -1);
    var beats = prior.filter(h => h.beat === true).length;
    var graded = prior.filter(h => h.beat === true || h.beat === false).length;
    if (graded > 0) parts.push({ label: 'Beat streak', points: Math.min(Math.round((beats / Math.min(graded, 3)) * 20), 20), max: 20 });
  }
  var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY : null;
  if (fwdG == null && f.analyst && typeof f.analyst.earningsGrowth === 'number') fwdG = f.analyst.earningsGrowth;
  if (fwdG != null) parts.push({ label: 'Fwd EPS growth', points: fwdG >= 25 ? 20 : fwdG >= 15 ? 15 : fwdG >= 5 ? 10 : fwdG > 0 ? 5 : 0, max: 20 });
  var rm = f.analyst && typeof f.analyst.recommendationMean === 'number' ? f.analyst.recommendationMean : null;
  if (rm != null) parts.push({ label: 'Analyst view', points: rm <= 1.5 ? 20 : rm <= 2.0 ? 16 : rm <= 2.5 ? 12 : rm <= 3.0 ? 8 : rm <= 3.5 ? 4 : 0, max: 20 });
  var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
  var price = typeof t.price === 'number' ? t.price : null;
  if (pt != null && price != null && price > 0) {
    var up = ((pt - price) / price) * 100;
    parts.push({ label: 'Upside to PT', points: up >= 25 ? 10 : up >= 10 ? 7 : up >= 0 ? 4 : up >= -10 ? 2 : 0, max: 10 });
  }
  var ph = t.priceHistory;
  if (historyFresh && Array.isArray(ph) && ph.length >= 21 && price != null && price > 0) {
    var then = ph[ph.length - 21];
    if (typeof then === 'number' && then > 0) {
      var mom = ((price - then) / then) * 100;
      parts.push({ label: '20d momentum', points: mom >= 15 ? 20 : mom >= 5 ? 15 : mom >= 0 ? 10 : mom >= -10 ? 5 : 0, max: 20 });
    }
  }
  if (!parts.length) return null;
  var earned = parts.reduce((s, p) => s + p.points, 0);
  var possible = parts.reduce((s, p) => s + p.max, 0);
  var score = Math.round((earned / possible) * 100);
  var label = parts.length < MIN_COVERAGE ? 'Low data'
    : score >= 70 ? 'Strong' : score >= 45 ? 'Moderate' : 'Weak';
  return { score, label, breakdown: parts, dataCoverage: parts.length };
}

// priceHistory ending at 426 → live price 460 gives +8.0% 20d momentum
const ph21 = Array(20).fill(430); ph21.unshift(426); // [426, 430 x20]
const phFlat = [426].concat(Array(20).fill(430));
// Build explicit: index length-21 = value 20 sessions ago
const hist21 = []; for (let i = 0; i < 22; i++) hist21.push(426); // 22 entries of 426

// SW-style full ticker: price 460, priceHistory flat at 426 → +7.98% momentum
const swT = { price: 460, priceHistory: hist21, fundamentals: f };
const sig = computeSignal(swT, true);
ok('signal computed', sig != null);
eq('SW: 6 components covered', sig.dataCoverage, 6);
// C1: beat 12.68 → 20 | C2: prior 3 (beat,beat,miss) → round(2/3*20)=13
// C3: 22% → 15 | C4: 1.4 → 20 | C5: +13.0% upside → 7 | C6: +7.98% → 15
// earned = 90, possible = 110 → 81.8 → 82
eq('SW full score = 82', sig.score, 82);
eq('label Strong', sig.label, 'Strong');
const upPart = sig.breakdown.find(p => p.label === 'Upside to PT');
eq('upside max is 10 (halved)', upPart.max, 10);

// AI-style ticker (no priceHistory): 5 components, max 90
const aiT = { price: 460, fundamentals: f };
const sigAi = computeSignal(aiT);
eq('AI: 5 components', sigAi.dataCoverage, 5);
// earned = 20+13+15+20+7 = 75 / 90 → 83.3 → 83
eq('AI score = 83', sigAi.score, 83);

// ★ FALLING-KNIFE REGRESSION: crash to 322 (-30%) must LOWER the score.
// Old v1.0.8 logic would have RAISED it (upside 61% → max points).
const crashHist = hist21.slice(); // 20d ago still 426
const crashT = { price: 322, priceHistory: crashHist, fundamentals: f };
const sigCrash = computeSignal(crashT, true);
// C5: upside (520-322)/322 = 61.5% → 10 | C6: (322-426)/426 = -24.4% → 0
// earned = 20+13+15+20+10+0 = 78 / 110 → 70.9 → 71
eq('crash score = 71', sigCrash.score, 71);
ok('CRASH LOWERS SCORE (falling-knife fixed)', sigCrash.score < sig.score);

// Double-count fix: a ticker with ONLY one quarter of history gets no streak component
const oneQ = { price: 100, fundamentals: { epsHistory: [
  { period: '-1q', quarter: '2026-03-31', epsActual: 2, epsEstimate: 1.8, surprisePct: 11.1, beat: true },
]}};
const sigOneQ = computeSignal(oneQ);
ok('1-quarter: no Beat streak component', !sigOneQ.breakdown.find(p => p.label === 'Beat streak'));
eq('1-quarter: coverage 1 → Low data', sigOneQ.label, 'Low data');

// Coverage gating: analyst-only ticker (2 components) gets Low data, not Strong
const analystOnly = { price: 100, fundamentals: { analyst: {
  recommendationMean: 1.2, recommendationKey: 'strong_buy', targetMeanPrice: 150,
}}};
const sigAn = computeSignal(analystOnly);
eq('analyst-only coverage = 2', sigAn.dataCoverage, 2);
eq('analyst-only label = Low data', sigAn.label, 'Low data');
ok('analyst-only raw score is high (the bias MIN_COVERAGE guards against)', sigAn.score >= 90);

// Client-side sort defence: hand the signal a newest-first epsHistory
const revHist = JSON.parse(JSON.stringify(f.epsHistory)).reverse();
const sigRev = computeSignal({ price: 460, fundamentals: { ...f, epsHistory: revHist } });
const lastQ = sigRev.breakdown.find(p => p.label === 'Last-Q EPS');
eq('reversed input: last-Q still the beat (20 pts)', lastQ.points, 20);

eq('no fundamentals → null', computeSignal({ price: 100 }), null);

// ── rebuildConviction (v1.0.9 rules) ──
const mk = (price, pe, mcap, volR, chgPct, ph) => ({
  name: 'x', layer: 'L', price, pe, marketCap: mcap, volRatio: volR, changePct: chgPct, priceHistory: ph,
});
// 21 entries so index length-21 (=0) is the close 20 sessions ago.
const up20 = [100].concat(Array(20).fill(110));    // 20d ago 100 → +10% at price 110
const flat20 = Array(21).fill(100);

const conv = rebuildConviction({ tickers: {
  // 4 criteria: reasonable PE + large cap + momentum + volume-on-up-day → score 5
  AAA: mk(110, 30, 100e9, 1.5, 1.0, up20),
  // high-PE growth name — old logic EXCLUDED it entirely; now qualifies on mcap+momentum → score 3
  BBB: mk(110, 120, 200e9, 0.8, 0.5, up20),
  // crash day heavy volume: volRatio 2.0 but changePct -8 → volume must NOT count; PE ok → score 2
  CCC: mk(100, 20, 10e9, 2.0, -8, flat20),
  // one green day (old 'momentum'), flat 20d → momentum must NOT count; PE+mcap → score 3
  DDD: mk(100, 25, 60e9, 1.0, 4.5, flat20),
  // nothing qualifies: negative PE, small cap, flat, low volume → excluded
  EEE: mk(10, -5, 1e9, 0.5, 0, flat20),
}});
const bySym = Object.fromEntries(conv.map(c => [c.ticker, c]));
eq('AAA scores 5 (4 criteria + base)', bySym.AAA.score, 5);
ok('AAA reasons include direction-aware volume', bySym.AAA.reasons.includes('High relative volume (up day)'));
ok('BBB (PE 120) now included', !!bySym.BBB);
ok('BBB has no Reasonable P/E reason', !bySym.BBB.reasons.includes('Reasonable P/E'));
ok('CCC crash-day volume NOT counted', !bySym.CCC.reasons.includes('High relative volume (up day)'));
ok('DDD one green day is NOT momentum', !bySym.DDD.reasons.includes('Sustained 20d momentum'));
ok('EEE excluded (no criteria)', !bySym.EEE);
ok("no dead 'Profitable' rule anywhere", conv.every(c => !c.reasons.includes('Profitable')));

// Deterministic tie-break: BBB and DDD both score 3 → BBB first (momentum 10% > 0%)
const idxB = conv.findIndex(c => c.ticker === 'BBB');
const idxD = conv.findIndex(c => c.ticker === 'DDD');
ok('tie-break by momentum: BBB before DDD', idxB < idxD);

// momentum20d helper
eq('momentum20d +10%', +momentum20d(mk(110, 10, 1, 1, 0, up20)).toFixed(1), 10.0);
eq('momentum20d null on short history', momentum20d(mk(110, 10, 1, 1, 0, [1, 2, 3])), null);

// ── v1.0.10: staleness gate ──
// Same full SW ticker, but history is NOT fresh → momentum skipped entirely.
const sigStale = computeSignal(swT, false);
eq('stale history: momentum component absent', sigStale.breakdown.find(p => p.label === '20d momentum'), undefined);
eq('stale history: coverage drops to 5', sigStale.dataCoverage, 5);
eq('stale history: score = fresh-AI score (83)', sigStale.score, 83);
ok('fresh history still yields 6 components', computeSignal(swT, true).dataCoverage === 6);

// todayStamp format (sw-schema)
const { todayStamp } = require('../update-prices/sw-schema');
ok('todayStamp is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayStamp()));

console.log('all ' + n + ' v1.0.10 tests passed (audit fixes + staleness gate)');
