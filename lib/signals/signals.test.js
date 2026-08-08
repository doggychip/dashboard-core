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

// ── unified scorer (v1.0.12): canonical module, no more inline mirror ──
const { computeScore, lerp, CURVES } = require('./score');

// lerp behavior: clamped, linear, no cliffs
eq('lerp below range clamps', lerp([[0,0],[10,20]], -5), 0);
eq('lerp above range clamps', lerp([[0,0],[10,20]], 15), 20);
eq('lerp midpoint', lerp([[0,0],[10,20]], 5), 10);
ok('no cliff at growth=25 boundary',
   Math.abs(lerp(CURVES.fwdGrowth, 24.9) - lerp(CURVES.fwdGrowth, 25.0)) < 0.1);

const hist21 = Array(22).fill(426);
const swT = { price: 460, priceHistory: hist21, fundamentals: f };

const sig = computeScore(swT, { historyFresh: true });
eq('full coverage = 6', sig.dataCoverage, 6);
eq('full score = 83', sig.score, 83);
eq('label Higher evidence', sig.label, 'Higher evidence');
eq('status rated', sig.status, 'rated');
const ptPart = sig.breakdown.find(p2 => p2.label === 'PT gap');
eq('PT gap max is 10 (half-weight)', ptPart.max, 10);

const sigNoMom = computeScore({ price: 460, fundamentals: f });
eq('no momentum: coverage 5', sigNoMom.dataCoverage, 5);
eq('no momentum: score 85', sigNoMom.score, 85);

// ★ falling-knife regression: -30% crash must lower the score
const sigCrash = computeScore({ price: 322, priceHistory: hist21, fundamentals: f }, { historyFresh: true });
eq('crash score = 71', sigCrash.score, 71);
ok('crash lowers score', sigCrash.score < sig.score);

// staleness gate: same ticker, stale history → momentum skipped
const sigStale = computeScore(swT, { historyFresh: false });
eq('stale: momentum absent', sigStale.breakdown.find(p2 => p2.label === '20d momentum'), undefined);
eq('stale: coverage 5', sigStale.dataCoverage, 5);

// coverage gating: analyst-only (2 comps) → insufficient, score null
const thin = computeScore({ price: 100, fundamentals: { analyst: { recommendationMean: 1.2, targetMeanPrice: 150 } } });
eq('thin: status insufficient', thin.status, 'insufficient');
eq('thin: score null', thin.score, null);

// graded miss: -1% miss scores much better than -15% miss
const missSmall = computeScore({ price: 100, fundamentals: { epsHistory: [
  { quarter: '2026-03-31', beat: false, surprisePct: -1 }], analyst: { recommendationMean: 2, targetMeanPrice: 120 },
  forward: { epsGrowthNextY: 10 } } });
const missBig = computeScore({ price: 100, fundamentals: { epsHistory: [
  { quarter: '2026-03-31', beat: false, surprisePct: -15 }], analyst: { recommendationMean: 2, targetMeanPrice: 120 },
  forward: { epsGrowthNextY: 10 } } });
ok('graded miss: -1% beats -15%', missSmall.score > missBig.score);

// client/signals.js parity: eval the browser IIFE with stubs, compare outputs
const fsMod = require('fs');
(function () {
  const src = fsMod.readFileSync(require('path').join(__dirname, '..', '..', 'client', 'signals.js'), 'utf8');
  const sandbox = {
    window: { SW_DATA: { tickers: {}, refreshedAt: new Date().toISOString().slice(0, 10) }, addEventListener() {}, dispatchEvent() {} },
    document: { readyState: 'complete', addEventListener() {}, createElement: () => ({ style: {} }), body: { appendChild() {} }, querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, json: async () => ({ fundamentals: {} }) }),
    setTimeout: () => {}, setInterval: () => {}, console,
    CustomEvent: function () {}, Date, Math, JSON, Array, Object, isNaN, parseFloat,
  };
  sandbox.window.window = sandbox.window;
  require('vm').runInNewContext(src, Object.assign({}, sandbox, { window: sandbox.window }));
  const clientCompute = sandbox.window.computeSignal;
  ok('client exposes computeSignal', typeof clientCompute === 'function');
  const fixtures = [
    [swT, true], [{ price: 460, fundamentals: f }, false],
    [{ price: 322, priceHistory: hist21, fundamentals: f }, true],
    [{ price: 100, fundamentals: { analyst: { recommendationMean: 1.2, targetMeanPrice: 150 } } }, false],
  ];
  fixtures.forEach(function (fx, i) {
    const a = computeScore(fx[0], { historyFresh: fx[1] });
    const b = clientCompute(fx[0], fx[1]);
    eq('parity fixture ' + i + ': score', b && b.score, a && a.score);
    eq('parity fixture ' + i + ': coverage', b && b.dataCoverage, a && a.dataCoverage);
  });
})();

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

// v1.0.11: acquired tickers never enter the conviction list
const convAcq = rebuildConviction({ tickers: {
  LIVE: mk(110, 30, 100e9, 1.5, 1.0, up20),
  DEAD: Object.assign(mk(408.85, 30, 100e9, 1.5, 1.0, up20), { status: 'acquired' }),
}});
ok('acquired ticker excluded from conviction', !convAcq.find(c => c.ticker === 'DEAD'));
ok('live ticker still included', !!convAcq.find(c => c.ticker === 'LIVE'));

// momentum20d helper
eq('momentum20d +10%', +momentum20d(mk(110, 10, 1, 1, 0, up20)).toFixed(1), 10.0);
eq('momentum20d null on short history', momentum20d(mk(110, 10, 1, 1, 0, [1, 2, 3])), null);

// todayStamp format (sw-schema)
const { todayStamp } = require('../update-prices/sw-schema');
ok('todayStamp is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayStamp()));

console.log('all ' + n + ' v1.0.12 tests passed (unified scorer + parity + logging-era)');
