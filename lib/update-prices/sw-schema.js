// Software schema updater — operates on `var SW_DATA = {...};` in index.html.
//
// Updates per ticker: price, previousClose, change, changePct, dayHigh,
// dayLow, yearHigh, yearLow, volume, avgVolume, volRatio, priceHistory.
// Scales marketCap by price ratio (assumes shares outstanding constant).
// Recomputes pe from new price and existing eps.
// Regenerates SW_DATA.conviction (top 15 by score).
// Editorial fields (eps, divYield, name, layer, layerColor, thesis,
// layers, macro) are never touched.
//
// Important: SW_DATA may also live in a separate sw_data.json file that
// the server reads. If the index.html doesn't contain `var SW_DATA = {`,
// fall back to looking for an external data file at
// `<dir-of-index>/sw_data.json` or `<dir-of-index>/semi_data.json`.

const fs = require('fs');
const path = require('path');
const { fetchQuote, sleep } = require('./fetch');
const { rebuildConviction } = require('./conviction');

const DELAY_MS = 150;
const SW_DATA_LINE = /^var SW_DATA = (\{.*\});\s*$/;

function round(n, dp) {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

// JSON.stringify doesn't escape `</` by default — if any field contains
// "</script>" the resulting HTML breaks. Escape defensively.
function safeStringify(data) {
  return JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1');
}

async function updateTickers(data) {
  const tickers = Object.keys(data.tickers);
  console.log(`[software schema] Updating ${tickers.length} tickers from Yahoo Finance...`);

  let ok = 0;
  let fail = 0;
  for (const tk of tickers) {
    try {
      const q = await fetchQuote(tk);
      const t = data.tickers[tk];
      const oldPrice = t.price;

      // Snapshot fields
      t.price = round(q.price, 4);
      t.previousClose = round(q.prev, 4);
      t.change = round(q.price - q.prev, 2);
      t.changePct = round(((q.price - q.prev) / q.prev) * 100, 5);
      if (typeof q.hi52 === 'number') t.yearHigh = round(q.hi52, 4);
      if (typeof q.lo52 === 'number') t.yearLow = round(q.lo52, 4);
      if (typeof q.dayHigh === 'number') t.dayHigh = round(q.dayHigh, 4);
      if (typeof q.dayLow === 'number') t.dayLow = round(q.dayLow, 4);
      if (typeof q.volume === 'number') t.volume = q.volume;

      // Volume metrics from 6mo daily data
      const validVols = q.volumes.filter((v) => v != null && v > 0);
      if (validVols.length >= 10) {
        const avgVol = Math.round(validVols.reduce((a, b) => a + b, 0) / validVols.length);
        t.avgVolume = avgVol;
        if (avgVol > 0 && typeof q.volume === 'number') {
          t.volRatio = round(q.volume / avgVol, 2);
        }
      }

      // Refresh priceHistory with last ~6mo of daily closes (filter nulls)
      const validCloses = q.closes.filter((c) => c != null);
      if (validCloses.length >= 30) {
        t.priceHistory = validCloses.map((c) => round(c, 2));
      }

      // Scale marketCap by price ratio (assumes shares outstanding constant)
      if (typeof t.marketCap === 'number' && oldPrice > 0) {
        t.marketCap = Math.round(t.marketCap * (q.price / oldPrice));
      }

      // Recompute pe from new price and existing eps
      if (typeof t.eps === 'number' && t.eps !== 0) {
        t.pe = round(q.price / t.eps, 2);
      }

      console.log(
        `  ✓ ${tk.padEnd(8)} $${q.price.toFixed(2)} ` +
          `(${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%, ` +
          `volR ${t.volRatio?.toFixed(2) ?? '—'}, hist ${t.priceHistory?.length ?? '—'})`
      );
      ok++;
    } catch (err) {
      console.warn(`  ✗ ${tk.padEnd(8)} ${err.message}`);
      fail++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n${ok} updated, ${fail} failed.`);

  if (ok > 0 && Array.isArray(data.conviction)) {
    data.conviction = rebuildConviction(data);
    console.log(`Regenerated conviction list (${data.conviction.length} entries).`);
  }
  // data.macro is hand-curated (Gartner forecasts, etc.) — left untouched.

  return ok;
}

// In-place update of the `var SW_DATA = {...};` line in index.html.
async function runSoftwareSchemaInline(src) {
  const lines = src.split('\n');
  let lineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('var SW_DATA = {')) {
      lineIdx = i;
      break;
    }
  }
  if (lineIdx === -1) return null;

  const m = lines[lineIdx].match(SW_DATA_LINE);
  if (!m) {
    console.error('Found SW_DATA line but could not extract JSON literal');
    return null;
  }

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    console.error('Failed to parse SW_DATA JSON:', err.message);
    return null;
  }
  if (!data.tickers) {
    console.error('SW_DATA has no .tickers field');
    return null;
  }

  const ok = await updateTickers(data);
  if (ok === 0) return null;

  lines[lineIdx] = `var SW_DATA = ${safeStringify(data)};`;
  return lines.join('\n');
}

// Update an external sw_data.json / semi_data.json file in place.
async function runSoftwareSchemaExternal(jsonPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${jsonPath}:`, err.message);
    return false;
  }
  if (!data.tickers) {
    console.error(`${jsonPath} has no .tickers field`);
    return false;
  }
  const ok = await updateTickers(data);
  if (ok === 0) return false;
  // Pretty-print external JSON files for human-friendly diffs in git.
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${jsonPath}`);
  return true;
}

module.exports = { runSoftwareSchemaInline, runSoftwareSchemaExternal, safeStringify, updateTickers };
