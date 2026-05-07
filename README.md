# dashboard-core

Shared core for the value-chain research dashboards: [`software-supply-chain`](https://github.com/doggychip/software-supply-chain), [`ai-supply-chain`](https://github.com/doggychip/ai-supply-chain), and [`semi-equipment`](https://github.com/doggychip/semi-equipment).

Provides:

- **`createDashboardServer(options)`** — Express app factory with all the dashboard routes mounted (`/api/quote`, `/api/quotes`, `/api/history`, `/api/news`, `/api/options`, `/api/options-flow`, `/api/health`).
- **Client assets** — `dashboard_enhancements.{js,css}` served at the same URL paths existing dashboards already use, so HTML files don't need to change.
- **`update-prices` CLI** — refreshes ticker prices from Yahoo Finance into the dashboard's data file (auto-detects inline `TICKER_DATA`, inline `SW_DATA`, or external `*_data.json` schemas).

---

## Install

Each dashboard depends on this package via a git tag — no npm publishing required.

```json
{
  "dependencies": {
    "dashboard-core": "git+https://github.com/doggychip/dashboard-core.git#v1.0.0"
  }
}
```

To upgrade across all three dashboards: tag a new release here, bump the tag in each dashboard's `package.json`, run `npm install`, ship.

---

## Usage

```js
// server.js
const path = require('path');
const { createDashboardServer } = require('dashboard-core');

const app = createDashboardServer({
  publicDir: path.join(__dirname, 'public'),
  tickerData: path.join(__dirname, 'public', 'sw_data.json'),
  symbolAliases: { SQ: 'XYZ' },
  skipLive: ['CYBR'],
  newsDataPath: path.join(__dirname, 'news_data.json'),
  dashboardName: 'Software Stack',
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `publicDir` | `string` (path) | required | Dashboard's HTML/data assets |
| `tickerData` | `string` \| `object` \| `null` | `null` | Path to JSON file, or `{ tickers: {...} }`, or null |
| `symbolAliases` | `object` | `{}` | Yahoo lookup → exposed symbol (e.g. `{SQ: 'XYZ'}`) |
| `skipLive` | `string[]` | `[]` | Tickers to never fetch live |
| `newsDataPath` | `string` (path) \| `null` | `null` | If set, mounts `/api/news` reading from this file on each request |
| `dashboardName` | `string` | `'Dashboard'` | Used in `/api/health` and console |
| `enableOptions` | `boolean` | `true` | Mount `/api/options*` routes |
| `cacheTtlMs` | `number` \| `null` | `null` | `null` → dynamic (60s during market, 15min after) |
| `fetchTimeoutMs` | `number` | `10000` | AbortController timeout per Yahoo call |
| `fetchConcurrency` | `number` | `5` | mapLimit cap on batch endpoints |
| `maxSymbolsPerRequest` | `number` | `200` | Reject batch requests with more than N symbols |

---

## Update prices

```bash
# In your dashboard's package.json:
"scripts": {
  "update-prices": "update-prices ./public/index.html",
  "update-prices:dry": "update-prices ./public/index.html --dry-run"
}
```

The CLI auto-detects:

1. `const TICKER_DATA = {` inline in HTML (the AI-supply-chain schema)
2. `var SW_DATA = {` inline in HTML (the original software-supply-chain schema)
3. External `sw_data.json`, `semi_data.json`, or `ai_data.json` adjacent to the HTML (the modern schema)

Editorial fields (`thesis`, `tags`, `layer`, `name`, `eps`, `divYield`, `macro`, etc.) are never touched. Live fields (`price`, `previousClose`, `change`, `changePct`, `dayHigh`, `dayLow`, `yearHigh`, `yearLow`, `volume`, `avgVolume`, `volRatio`, `priceHistory`) are refreshed. `marketCap` is scaled by the price ratio (assumes shares outstanding constant). `pe` is recomputed from new price and existing `eps`.

Each Yahoo request has a 10-second AbortController timeout and up to 2 retries with backoff (1s, then 3s).

---

## Static asset layering

`createDashboardServer` mounts assets in this order:

1. The package's `client/` directory (this package's `dashboard_enhancements.js`, `dashboard_enhancements.css`)
2. The dashboard's `publicDir` (its HTML pages, sector-specific data JSON, etc.)

Because `express.static` middlewares are tried in order, requests for `/dashboard_enhancements.js` resolve to the package's copy. **HTML files that reference `dashboard_enhancements.js` (relative path) keep working unchanged.**

If a dashboard ever ships its own `dashboard_enhancements.js` (e.g., during local development), put it in `publicDir` and add a route ahead of the static layer to override.

---

## Local development

```bash
git clone https://github.com/doggychip/dashboard-core.git
cd dashboard-core
npm install
npm test  # runs node --check on every JS file
```

To test against a real dashboard locally without tagging a release:

```bash
# In dashboard-core:
npm link

# In e.g. semi-equipment:
npm link dashboard-core
npm start
```

---

## License

MIT — see [LICENSE](LICENSE).
