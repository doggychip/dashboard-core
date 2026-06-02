// Regression test for the v1.0.4 real-marketCap path.
// Run: node lib/update-prices/real-mcap.test.js   (no network required)
//
// Covers:
//  - resolveNewMcap() priority: real mcap > price*shares > ratio-scale > null
//  - rewriteAiLine integration: real mcap path produces correct $X.XB string
//  - rewriteAiLine integration: missing extra falls back to v1.0.3 behavior
//  - the AMD bug case from PR review: scaled $509.4B becomes ~$826B with real
//    shares (1.62B), matching Yahoo's ~$840B within rounding tolerance

const assert = require('assert');
const { resolveNewMcap, rewriteAiLine } = require('./ai-schema');

let n = 0;
const ok = (desc, cond) => { assert.ok(cond, `${desc} FAILED`); n++; };
const eq = (desc, got, want) => { assert.strictEqual(got, want, `${desc}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); n++; };

// ---------- resolveNewMcap priority ----------

eq('1) real mcap wins over everything',
   resolveNewMcap({ real: { marketCap: 826e9, sharesOutstanding: 1.62e9 }, price: 510, oldMcap: 469e9, oldPrice: 220 }),
   826e9);

eq('2) price*shares used when real mcap missing',
   resolveNewMcap({ real: { sharesOutstanding: 1.62e9 }, price: 510, oldMcap: 469e9, oldPrice: 220 }),
   510 * 1.62e9);

const scaled = resolveNewMcap({ real: null, price: 510, oldMcap: 469e9, oldPrice: 220 });
ok('3) ratio-scale fallback returns approx (510/220)*469B', Math.abs(scaled - (469e9 * 510 / 220)) < 1);

eq('4) returns null when nothing usable',
   resolveNewMcap({ real: null, price: 510, oldMcap: null, oldPrice: null }),
   null);

eq('5) ignores zero/negative real values',
   resolveNewMcap({ real: { marketCap: 0, sharesOutstanding: -1 }, price: 100, oldMcap: 50e9, oldPrice: 80 }),
   50e9 * 100 / 80);

// ---------- rewriteAiLine integration ----------

const baseLine =
  "  'AMD': { name:'Advanced Micro Devices', price: 220.00, chg:1.00, chgPct:0.46, mcap:'$469.4B', pe:'40.0', hi52:'$220.00', lo52:'$100.00', layers:['1 GPU'] },";

const q = { price: 510, prev: 505, hi52: 527, lo52: 113 };

// Case A: real mcap supplied — should write $826.0B (1 dp matching baseline)
const outReal = rewriteAiLine(baseLine, q, { marketCap: 826e9, sharesOutstanding: 1.62e9 });
ok('6) real-mcap path produces $826.0B', /mcap:'\$826\.0B'/.test(outReal));
ok('6b) price/chg/chgPct still updated', /price: 510\.00/.test(outReal) && /chgPct:0\.99/.test(outReal));

// Case B: shares only — price * shares = 510 * 1.62e9 = 826.2e9 → "$826.2B"
const outShares = rewriteAiLine(baseLine, q, { sharesOutstanding: 1.62e9 });
ok('7) shares-only path produces $826.2B', /mcap:'\$826\.2B'/.test(outShares));

// Case C: no extra → ratio scaling kicks in (469.4B * 510/220 = 1088.3B → $1.09T)
const outScaled = rewriteAiLine(baseLine, q);
ok('8) missing-extra falls back to ratio scaling (T tier reached)', /mcap:'\$1\.09T'/.test(outScaled));

// Case D: AMD bug case — exact values from PR review (was $509.4B, should be ~$826B)
const amdReal = { marketCap: 826.4e9 };
const amdLine = "  'AMD': { mcap:'$509.4B', price: 240.00 },";
const amdQ = { price: 510.13, prev: 516.10 };
const amdOut = rewriteAiLine(amdLine, amdQ, amdReal);
ok('9) AMD bug fix — outputs $826.4B not $509.4B', /mcap:'\$826\.4B'/.test(amdOut) && !/\$509\.4B/.test(amdOut));

// Case E: legacy line with hi52/lo52 starting with $1 — verify backref fix
// still works alongside the new mcap path.
const tricky = "  'NVDA': { price: 200.00, chg:0, chgPct:0, mcap:'$4.83T', pe:'40.0', hi52:'$212.19', lo52:'$95.04', layers:['1 GPU'] },";
const trickyOut = rewriteAiLine(tricky, { price: 207, prev: 205, hi52: 216.83, lo52: 115.21 },
  { marketCap: 5.05e12 });
ok('10) hi52/lo52 not corrupted', /hi52:'\$216\.83'/.test(trickyOut) && /lo52:'\$115\.21'/.test(trickyOut));
ok('10b) real mcap applied at T tier', /mcap:'\$5\.05T'/.test(trickyOut));

console.log(`all ${n} real-mcap tests passed`);
