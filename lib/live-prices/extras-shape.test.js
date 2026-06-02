// Run from dashboard-core root:
//   node lib/live-prices/extras-shape.test.js
const { quoteSummaryToExtras } = require('../../server/yahoo');
const assert = require('assert');

let n = 0;
const ok = (d, c) => { assert.ok(c, d); n++; };

// Yahoo's actual quoteSummary response shape (verified per public docs)
const sample = {
  quoteSummary: {
    result: [{
      summaryDetail: {
        marketCap: { raw: 3420900000000 },
        trailingPE: { raw: 28.84 },
        dividendYield: { raw: 0.00846 },
        fiftyTwoWeekHigh: { raw: 555.45 },
        fiftyTwoWeekLow: { raw: 356.28 },
        dayHigh: { raw: 466.32 },
        dayLow: { raw: 458.27 },
        volume: { raw: 52107975 },
        averageVolume: { raw: 33637117 },
      },
      defaultKeyStatistics: {
        sharesOutstanding: { raw: 7428000000 },
        trailingEps: { raw: 15.97 },
        forwardPE: { raw: 26.5 },
      },
      financialData: {
        targetMeanPrice: { raw: 525.34 },
        targetMedianPrice: { raw: 530 },
        targetHighPrice: { raw: 600 },
        targetLowPrice: { raw: 420 },
        recommendationKey: 'buy',
        recommendationMean: { raw: 1.7 },
        numberOfAnalystOpinions: { raw: 45 },
      },
      price: { marketCap: { raw: 3420900000000 } },
    }],
  },
};
const e = quoteSummaryToExtras(sample);
ok('marketCap parsed', e.marketCap === 3420900000000);
ok('trailingEps parsed', e.trailingEps === 15.97);
ok('trailingPE parsed', e.trailingPE === 28.84);
ok('forwardPE fallback to ks works', e.forwardPE === 26.5);
ok('divYield parsed', e.divYield === 0.00846);
ok('fiftyTwoWeekHigh parsed', e.fiftyTwoWeekHigh === 555.45);
ok('fiftyTwoWeekLow parsed', e.fiftyTwoWeekLow === 356.28);
ok('dayHigh parsed', e.dayHigh === 466.32);
ok('targetMeanPrice parsed', e.targetMeanPrice === 525.34);
ok('recommendationKey is string', e.recommendationKey === 'buy');
ok('numberOfAnalystOpinions parsed', e.numberOfAnalystOpinions === 45);

// Null/missing handling
ok('null on missing result', quoteSummaryToExtras({}) === null);
ok('null on undefined data', quoteSummaryToExtras(undefined) === null);

// Strip nulls — partial data should still return something useful
const partial = {
  quoteSummary: {
    result: [{
      summaryDetail: { marketCap: { raw: 1e12 } },
      defaultKeyStatistics: {},
      financialData: {},
      price: {},
    }],
  },
};
const ep = quoteSummaryToExtras(partial);
ok('partial: marketCap present', ep.marketCap === 1e12);
ok('partial: nulls stripped from output', !('trailingEps' in ep) && !('divYield' in ep));

console.log(`all ${n} extras-shape tests passed`);
