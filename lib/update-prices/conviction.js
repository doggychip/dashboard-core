// Conviction-list rules — v1.0.9 revision of the original reverse-engineered
// screen. Changes vs v1:
//
//  - 'Profitable' criterion removed: it was implied by the old 0<pe<50 gate
//    (positive P/E with positive price ⟹ positive EPS), so every candidate
//    got the point — a dead rule that inflated all scores equally.
//  - The hard P/E gate is now a *criterion* ('Reasonable P/E', 0<pe<50)
//    instead of a prerequisite, so high-growth names with rich or negative
//    P/E can still qualify on other merits. The only prerequisite left is
//    having a usable price.
//  - 'Strong momentum' now means the 20-session return from priceHistory
//    (>= +5%), not a single day's changePct — one green day is noise, and
//    the old rule made the list churn depending on refresh day.
//  - 'High relative volume' is direction-aware: volRatio >= 1.2 only counts
//    when the day's change is non-negative (heavy volume on a crash is not
//    a conviction signal).
//  - Ties are broken by 20d momentum desc, then market cap desc — the old
//    stable-sort tie-break was JSON insertion order, i.e. arbitrary.

const CONVICTION_RULES = {
  reasonablePeMax: 50,
  largeCapMin: 50e9,
  highVolRatio: 1.2,
  momentum20dPct: 5.0,
  topN: 15,
};

// 20-session % return from a daily-close history array, using the live price
// as the endpoint when present. Returns null when there isn't enough history.
function momentum20d(t) {
  const ph = t.priceHistory;
  if (!Array.isArray(ph) || ph.length < 21) return null;
  const endPrice = typeof t.price === 'number' && t.price > 0 ? t.price : ph[ph.length - 1];
  const then = ph[ph.length - 21];
  if (typeof then !== 'number' || then <= 0 || typeof endPrice !== 'number' || endPrice <= 0) return null;
  return ((endPrice - then) / then) * 100;
}

function rebuildConviction(data, rules = CONVICTION_RULES) {
  const r = rules;
  const candidates = [];
  for (const [ticker, t] of Object.entries(data.tickers)) {
    // Acquired/delisted names carry frozen data — never conviction candidates.
    if (t.status === 'acquired' || t.status === 'delisted') continue;
    if (typeof t.price !== 'number' || t.price <= 0) continue;

    const reasons = [];
    if (typeof t.pe === 'number' && t.pe > 0 && t.pe < r.reasonablePeMax) reasons.push('Reasonable P/E');
    if (typeof t.marketCap === 'number' && t.marketCap >= r.largeCapMin) reasons.push('Large cap');
    const mom = momentum20d(t);
    if (mom != null && mom >= r.momentum20dPct) reasons.push('Sustained 20d momentum');
    if (
      typeof t.volRatio === 'number' && t.volRatio >= r.highVolRatio &&
      typeof t.changePct === 'number' && t.changePct >= 0
    ) reasons.push('High relative volume (up day)');

    if (!reasons.length) continue;

    candidates.push({
      ticker,
      name: t.name,
      layer: t.layer,
      score: reasons.length + 1,
      reasons,
      price: t.price,
      pe: t.pe,
      marketCap: t.marketCap,
      changePct: t.changePct,
      momentum20d: mom != null ? +mom.toFixed(2) : null,
    });
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const am = a.momentum20d ?? -Infinity;
    const bm = b.momentum20d ?? -Infinity;
    if (bm !== am) return bm - am;
    return (b.marketCap ?? 0) - (a.marketCap ?? 0);
  });
  return candidates.slice(0, r.topN);
}

module.exports = { CONVICTION_RULES, rebuildConviction, momentum20d };
