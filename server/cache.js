// Tiny LRU-with-TTL cache. We don't use the `lru-cache` npm package to keep
// dashboard-core dependency-light (Express only).
//
// On insert, evicts the oldest entry if size exceeds maxEntries. On read,
// expired entries are deleted lazily.

class TtlCache {
  constructor({ ttlMs = 60_000, maxEntries = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this._m = new Map(); // insertion order doubles as LRU on Map
  }

  ttl(now = Date.now()) {
    if (typeof this.ttlMs === 'function') return this.ttlMs(now);
    return this.ttlMs;
  }

  get(key) {
    const hit = this._m.get(key);
    if (!hit) return null;
    if (Date.now() - hit.t > this.ttl()) {
      this._m.delete(key);
      return null;
    }
    // Touch — move to end (most-recently-used).
    this._m.delete(key);
    this._m.set(key, hit);
    return hit.v;
  }

  set(key, v) {
    if (this._m.has(key)) this._m.delete(key);
    this._m.set(key, { t: Date.now(), v });
    while (this._m.size > this.maxEntries) {
      // Map iteration order is insertion order; first key is the LRU.
      const oldest = this._m.keys().next().value;
      this._m.delete(oldest);
    }
  }

  size() { return this._m.size; }
  clear() { this._m.clear(); }
}

// Helper: dynamic TTL based on whether US equities are in market hours.
// Crude — uses UTC. Good enough for "don't hammer Yahoo overnight."
// 9:30am–4pm ET ≈ 13:30–21:00 UTC during EDT, 14:30–21:00 UTC during EST.
function dynamicTtl({ duringMarketMs = 60_000, afterHoursMs = 15 * 60_000 } = {}) {
  return () => {
    const d = new Date();
    const day = d.getUTCDay(); // 0 Sun, 6 Sat
    if (day === 0 || day === 6) return afterHoursMs;
    const h = d.getUTCHours();
    return (h >= 13 && h < 21) ? duringMarketMs : afterHoursMs;
  };
}

module.exports = { TtlCache, dynamicTtl };
