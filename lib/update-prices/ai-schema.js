// AI schema updater — operates on inline `const TICKER_DATA = { ... }` in index.html.
//
// Each line in the TICKER_DATA block has the form:
//   '<TICKER>': { price: 123.45, chg: 1.23, chgPct: 1.0, mcap: '$1.2T', pe: '28.5', ... },
//
// We update price/chg/chgPct/hi52/lo52, and (best-effort) scale mcap and pe
// by the price ratio so they stay roughly in sync. Editorial fields
// (name, layers, thesis, tags) are untouched.

const { fetchQuote, sleep } = require('./fetch');

const DELAY_MS = 150;

const TICKER_BLOCK_START = /^const TICKER_DATA = \{\s*$/m;
const TICKER_LINE = /^(\s*)'([^']+)':\s*\{\s*(.*)\}\s*,?\s*$/;

function parseMcapStr(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/([\d.]+)\s*([TBM])/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (isNaN(val)) return null;
  const unit = m[2].toUpperCase();
  return val * (unit === 'T' ? 1e12 : unit === 'B' ? 1e9 : 1e6);
}

function formatMcap(value, oldStr) {
  const prefix = oldStr.startsWith('~') ? '~$' : '$';
  const digitsMatch = oldStr.match(/(\d+(?:\.\d+)?)\s*[TBM]/i);
  const origDp = digitsMatch ? digitsMatch[1].split('.')[1]?.length ?? 0 : 1;
  if (value >= 1e12) {
    return `${prefix}${(value / 1e12).toFixed(Math.max(2, origDp))}T`;
  }
  if (value >= 1e9) {
    return `${prefix}${(value / 1e9).toFixed(Math.max(1, origDp))}B`;
  }
  return `${prefix}${(value / 1e6).toFixed(0)}M`;
}

function rewriteAiLine(line, q) {
  const oldPriceM = line.match(/price:\s*(-?\d+(?:\.\d+)?)/);
  const oldPrice = oldPriceM ? parseFloat(oldPriceM[1]) : null;
  const fmt = (n) => n.toFixed(2);
  let out = line;

  // Scale mcap and pe BEFORE updating price (uses oldPrice as the reference).
  if (oldPrice && oldPrice > 0 && q.price > 0) {
    const ratio = q.price / oldPrice;

    const mcapM = out.match(/mcap:'([^']*)'/);
    if (mcapM) {
      const oldMcap = parseMcapStr(mcapM[1]);
      if (oldMcap != null && oldMcap > 0) {
        const newStr = formatMcap(oldMcap * ratio, mcapM[1]);
        out = out.replace(/mcap:'[^']*'/, `mcap:'${newStr}'`);
      }
    }

    const peM = out.match(/pe:'([^']*)'/);
    if (peM && /^-?\d+(?:\.\d+)?$/.test(peM[1])) {
      const oldPe = parseFloat(peM[1]);
      if (!isNaN(oldPe) && Math.abs(oldPe) > 0) {
        const dp = peM[1].includes('.') ? peM[1].split('.')[1].length : 1;
        const newStr = (oldPe * ratio).toFixed(Math.max(1, Math.min(2, dp)));
        out = out.replace(/pe:'[^']*'/, `pe:'${newStr}'`);
      }
    }
  }

  const chg = q.price - q.prev;
  const chgPct = (chg / q.prev) * 100;
  out = out.replace(/(price:\s*)-?\d+(?:\.\d+)?/, `$1${fmt(q.price)}`);
  out = out.replace(/(chg:\s*)-?\d+(?:\.\d+)?/, `$1${fmt(chg)}`);
  out = out.replace(/(chgPct:\s*)-?\d+(?:\.\d+)?/, `$1${fmt(chgPct)}`);
  // Function replacers — string-form replacement would parse `$1` inside
  // values like `'$115.21'` as a backreference to capture group 1, corrupting
  // any 52w price starting `$1`–`$9` into `'hi52:5.21'` / `'lo52:5.21'`.
  if (typeof q.hi52 === 'number') {
    out = out.replace(/(hi52:\s*)'[^']*'/, (_, p1) => `${p1}'$${fmt(q.hi52)}'`);
  }
  if (typeof q.lo52 === 'number') {
    out = out.replace(/(lo52:\s*)'[^']*'/, (_, p1) => `${p1}'$${fmt(q.lo52)}'`);
  }
  return out;
}

function aiCurrentPrice(line) {
  const m = line.match(/price:\s*(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

async function runAiSchema(src) {
  const lines = src.split('\n');
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (TICKER_BLOCK_START.test(lines[i])) {
      blockStart = i + 1;
      break;
    }
  }
  if (blockStart === -1) return null;

  const updates = [];
  for (let i = blockStart; i < lines.length; i++) {
    if (/^\};/.test(lines[i])) break;
    const m = lines[i].match(TICKER_LINE);
    if (!m) continue;
    const price = aiCurrentPrice(lines[i]);
    if (price === 0 || price === null) continue;
    updates.push({ i, ticker: m[2] });
  }

  console.log(`[ai schema] Updating ${updates.length} tickers from Yahoo Finance...`);
  let ok = 0;
  let fail = 0;
  for (const { i, ticker } of updates) {
    try {
      const q = await fetchQuote(ticker);
      lines[i] = rewriteAiLine(lines[i], q);
      console.log(
        `  ✓ ${ticker.padEnd(12)} $${q.price.toFixed(2)} ` +
          `(prev $${q.prev.toFixed(2)}, 52w $${q.lo52?.toFixed(2) ?? '?'}–$${q.hi52?.toFixed(2) ?? '?'})`
      );
      ok++;
    } catch (err) {
      console.warn(`  ✗ ${ticker.padEnd(12)} ${err.message}`);
      fail++;
    }
    await sleep(DELAY_MS);
  }
  console.log(`\n${ok} updated, ${fail} failed.`);
  if (ok === 0) return null;
  return lines.join('\n');
}

module.exports = { runAiSchema, rewriteAiLine, parseMcapStr, formatMcap };
