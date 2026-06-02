// Isolated unit test of the merge logic — copies the merge function verbatim
// from live-prices.js and exercises it on both schemas.
function mergeQuote(t, q, schema) {
  if (typeof q.price === 'number' && q.price > 0) t.price = q.price;
  if (schema === 'sw') {
    if (typeof q.previousClose === 'number') t.previousClose = q.previousClose;
    if (typeof q.change === 'number')        t.change       = q.change;
    if (typeof q.changePct === 'number')     t.changePct    = q.changePct;
  } else {
    if (typeof q.change === 'number')    t.chg    = +q.change.toFixed(2);
    if (typeof q.changePct === 'number') t.chgPct = +q.changePct.toFixed(2);
  }
}

const assert = require('assert');
let n = 0;
const ok = (d, c) => { assert.ok(c, d); n++; };

// SW schema
const sw = { price: 400, previousClose: 400, change: 0, changePct: 0 };
mergeQuote(sw, { price: 460.52, previousClose: 458.10, change: 2.42, changePct: 0.53 }, 'sw');
ok('SW: price', sw.price === 460.52);
ok('SW: prev', sw.previousClose === 458.10);
ok('SW: change', sw.change === 2.42);
ok('SW: changePct', sw.changePct === 0.53);

// AI schema
const ai = { price: 200, chg: 0, chgPct: 0 };
mergeQuote(ai, { price: 224.36, change: 13.22, changePct: 6.26 }, 'ai');
ok('AI: price', ai.price === 224.36);
ok('AI: chg (not change)', ai.chg === 13.22 && ai.change === undefined);
ok('AI: chgPct (not changePct)', ai.chgPct === 6.26 && ai.changePct === undefined);

// Guard: missing fields don't overwrite with undefined
const guard = { price: 100, chg: 1, chgPct: 1 };
mergeQuote(guard, { price: 0 }, 'ai');  // price=0 should be ignored (>0 check)
ok('Guard: price=0 ignored, no chg/chgPct change', guard.price === 100 && guard.chg === 1 && guard.chgPct === 1);

// Guard: real partial update (just price)
const partial = { price: 100, chg: 1, chgPct: 1 };
mergeQuote(partial, { price: 150 }, 'ai');
ok('Guard: partial update writes only price', partial.price === 150 && partial.chg === 1 && partial.chgPct === 1);

console.log(`all ${n} merge tests passed`);
