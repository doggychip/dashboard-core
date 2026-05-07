// Conviction-list rules — reverse-engineered from the existing list:
//   - "Reasonable P/E" is a hard prerequisite (0 < pe < 50)
//   - Each additional criterion adds one point to the score
//   - Final score = reasons.length + 1 (base point for being eligible)
//   - Top N sorted by score desc; ties broken by insertion order

const CONVICTION_RULES = {
  reasonablePeMax: 50,
  largeCapMin: 50e9,
  highVolRatio: 1.2,
  strongMomentumPct: 3.0,
  topN: 15,
};

function rebuildConviction(data, rules = CONVICTION_RULES) {
  const r = rules;
  const candidates = [];
  for (const [ticker, t] of Object.entries(data.tickers)) {
    if (typeof t.pe !== 'number' || t.pe <= 0 || t.pe >= r.reasonablePeMax) continue;
    const reasons = ['Reasonable P/E'];
    if (typeof t.marketCap === 'number' && t.marketCap >= r.largeCapMin) reasons.push('Large cap');
    if (typeof t.eps === 'number' && t.eps > 0) reasons.push('Profitable');
    if (typeof t.volRatio === 'number' && t.volRatio >= r.highVolRatio) reasons.push('High relative volume');
    if (typeof t.changePct === 'number' && t.changePct >= r.strongMomentumPct) reasons.push('Strong momentum');

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
    });
  }
  candidates.sort((a, b) => b.score - a.score); // stable sort preserves insertion order
  return candidates.slice(0, r.topN);
}

module.exports = { CONVICTION_RULES, rebuildConviction };
