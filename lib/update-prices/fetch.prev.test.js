// Regression test for derivePrev — the prior-session close used for daily change.
// Run: node fetch.prev.test.js   (no network required)

const assert = require('assert');
const { derivePrev } = require('./fetch');

let n = 0;
const ok = (desc, got, want) => { assert.strictEqual(got, want, `${desc}: got ${got}, want ${want}`); n++; };

// 1. Normal case: prev = second-to-last valid daily close (yesterday).
ok('normal series', derivePrev({}, [100, 101, 102, 103]), 102);

// 2. Nulls/holidays in the series are ignored.
ok('nulls ignored', derivePrev({}, [100, null, 102, null, 104]), 102);

// 3. THE BUG: a 6-month series whose meta.previousClose/chartPreviousClose are
//    the window-start value. We must use the series (yesterday=505.0), NOT meta
//    (219.76) — otherwise chg becomes a ~6-month return (+132% instead of +1%).
const sixMo = [219.76, 230, 260, 300, 400, 505.0, 510.13];
ok('ignores window-start meta when series is usable',
   derivePrev({ previousClose: 219.76, chartPreviousClose: 219.76 }, sixMo), 505.0);

// 4. Too few closes -> fall back to meta.previousClose.
ok('fallback to previousClose', derivePrev({ previousClose: 99 }, [105]), 99);

// 5. Too few closes, no previousClose -> chartPreviousClose.
ok('fallback to chartPreviousClose', derivePrev({ chartPreviousClose: 88 }, []), 88);

// 6. Nothing usable -> null (fetchQuote then throws 'no previousClose').
ok('null when nothing usable', derivePrev({}, []), null);

// 7. Zero/negative closes are not valid; fall back appropriately.
ok('skips non-positive closes', derivePrev({ previousClose: 50 }, [0, -1, 42]), 50);

console.log(`all ${n} derivePrev tests passed`);
