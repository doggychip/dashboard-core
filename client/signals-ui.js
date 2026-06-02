/* ============================================================
   signals-ui.js — renders the "Earnings & Signals" section
   ------------------------------------------------------------
   Companion to signals.js. Purely additive: injects its own nav
   button + section into the page (no edits to existing markup),
   renders a table of live earnings data + the rules-based signal,
   and rebuilds any stale hardcoded earnings calendar with live
   next-earnings dates. Degrades to a no-op if the page structure
   it expects isn't found.

   NOT FINANCIAL ADVICE — the signal column is a mechanical score
   from objective Yahoo data; see signals.js for the exact rules.
   ============================================================ */
(function () {
  'use strict';

  var SECTION_ID = 's-signals';
  var injected = false;

  function tickersObj() {
    if (window.SW_DATA && window.SW_DATA.tickers) return window.SW_DATA.tickers;
    if (window.TICKER_DATA && Object.keys(window.TICKER_DATA).length) return window.TICKER_DATA;
    return null;
  }

  // ── one-time injection of nav button + empty section ──
  function injectShell() {
    if (injected) return true;
    var content = document.querySelector('.content') || document.querySelector('main.main') || document.querySelector('main');
    if (!content) return false;

    var sec = document.createElement('div');
    sec.id = SECTION_ID;
    sec.className = 'section';
    sec.innerHTML =
      '<div class="section-header"><div>' +
      '<div class="section-title">📊 Earnings &amp; Signals</div>' +
      '<div class="section-desc">Live earnings results + a transparent, rules-based signal. ' +
      '<strong>Not financial advice</strong> — a mechanical score from Yahoo data ' +
      '(EPS beat/miss, forward growth, analyst consensus, upside to price target). ' +
      'Updated <span data-dynamic-date="full"></span>.</div></div></div>' +
      '<div id="signalsTableWrap" style="overflow-x:auto"><div style="padding:24px;color:var(--muted,#888);font-size:13px">Loading live earnings data…</div></div>';
    content.appendChild(sec);

    // Nav button — append into the last sidebar section if present.
    var groups = document.querySelectorAll('.sb-section');
    if (groups.length) {
      var btn = document.createElement('button');
      btn.className = 'sb-item';
      btn.setAttribute('onclick', "nav(this,'" + SECTION_ID + "')");
      btn.innerHTML = '<span class="dot" style="background:var(--warn,#f0ad4e)"></span><span>Earnings &amp; Signals</span>';
      // If nav() isn't defined for some reason, fall back to scrollIntoView.
      btn.addEventListener('click', function () {
        if (typeof window.nav !== 'function') {
          document.getElementById(SECTION_ID).scrollIntoView({ behavior: 'smooth' });
        }
      });
      groups[groups.length - 1].appendChild(btn);
    }

    injected = true;
    return true;
  }

  function fmtPct(v) {
    if (typeof v !== 'number') return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function fmtBn(v) {
    if (typeof v !== 'number') return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
    return '$' + v.toFixed(0);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // 4-quarter beat/miss dots, oldest→newest.
  function beatDots(hist) {
    if (!hist || !hist.length) return '<span style="color:var(--faint,#888)">—</span>';
    return hist.map(function (h) {
      var c = h.beat === true ? 'var(--success,#56cc84)' : h.beat === false ? 'var(--error,#f07070)' : 'var(--faint,#888)';
      var t = (h.period || '') + ': ' + (h.epsActual != null ? h.epsActual : '?') +
        ' vs ' + (h.epsEstimate != null ? h.epsEstimate : '?') +
        (h.surprisePct != null ? ' (' + (h.surprisePct >= 0 ? '+' : '') + h.surprisePct + '%)' : '');
      return '<span title="' + esc(t) + '" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + c + ';margin-right:3px"></span>';
    }).join('');
  }

  function signalBadge(sig) {
    if (!sig) return '<span style="color:var(--faint,#888)">—</span>';
    var color = sig.label === 'Strong' ? 'var(--success,#56cc84)'
      : sig.label === 'Moderate' ? 'var(--warn,#f0ad4e)' : 'var(--error,#f07070)';
    var tip = sig.breakdown.map(function (b) { return b.label + ': ' + b.points + '/' + b.max + (b.detail ? ' — ' + b.detail : ''); }).join('\n');
    return '<span title="' + esc(tip) + '" style="display:inline-flex;align-items:center;gap:6px;font-weight:700">' +
      '<span style="font-variant-numeric:tabular-nums;color:' + color + '">' + sig.score + '</span>' +
      '<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:color-mix(in srgb,' + color + ' 18%,transparent);color:' + color + '">' + sig.label + '</span>' +
      '</span>';
  }

  function nextEarn(f) {
    if (!f || !f.nextEarningsDate) return '<span style="color:var(--faint,#888)">—</span>';
    var d = f.nextEarningsDate;
    var est = f.isEarningsDateEstimate ? ' <span style="font-size:9px;color:var(--faint,#888)">(est)</span>' : '';
    return '<span style="font-variant-numeric:tabular-nums">' + esc(d) + '</span>' + est;
  }

  function render() {
    if (!injectShell()) return;
    var tickers = tickersObj();
    var wrap = document.getElementById('signalsTableWrap');
    if (!tickers || !wrap) return;

    var sigs = window.tickerSignals || {};
    var rows = Object.keys(tickers).filter(function (sym) {
      return tickers[sym] && tickers[sym].fundamentals;
    });
    if (!rows.length) {
      wrap.innerHTML = '<div style="padding:24px;color:var(--muted,#888);font-size:13px">No live earnings data available yet. ' +
        'If this persists, Yahoo’s fundamentals endpoint may be temporarily blocked — prices still update live.</div>';
      return;
    }

    // Sort by signal score desc (tickers with a signal first), then alpha.
    rows.sort(function (a, b) {
      var sa = sigs[a] ? sigs[a].score : -1, sb = sigs[b] ? sigs[b].score : -1;
      if (sb !== sa) return sb - sa;
      return a < b ? -1 : 1;
    });

    var html = '<table class="val-table" style="width:100%;font-size:12px">' +
      '<thead><tr>' +
      '<th style="text-align:left">Ticker</th>' +
      '<th style="text-align:left">Next Earnings</th>' +
      '<th style="text-align:left" title="Last 4 quarters: green=beat, red=miss (oldest → newest)">Last 4Q EPS</th>' +
      '<th style="text-align:right">Rev Growth (YoY)</th>' +
      '<th style="text-align:right">Fwd EPS Growth</th>' +
      '<th style="text-align:left">Analyst</th>' +
      '<th style="text-align:right" title="Upside to mean price target at the live price">Upside</th>' +
      '<th style="text-align:right" title="Mechanical score 0–100 from the columns at left. Hover for the breakdown. Not financial advice.">Signal</th>' +
      '</tr></thead><tbody>';

    rows.forEach(function (sym) {
      var t = tickers[sym], f = t.fundamentals, sig = sigs[sym];
      var revG = f.analyst && typeof f.analyst.revenueGrowth === 'number' ? f.analyst.revenueGrowth
        : (f.forward && typeof f.forward.revGrowthCurrentY === 'number' ? f.forward.revGrowthCurrentY : null);
      var fwdG = f.forward && typeof f.forward.epsGrowthNextY === 'number' ? f.forward.epsGrowthNextY
        : (f.analyst && typeof f.analyst.earningsGrowth === 'number' ? f.analyst.earningsGrowth : null);
      var pt = f.analyst && typeof f.analyst.targetMeanPrice === 'number' ? f.analyst.targetMeanPrice : null;
      var upside = (pt != null && typeof t.price === 'number' && t.price > 0) ? ((pt - t.price) / t.price) * 100 : null;
      var rec = f.analyst && f.analyst.recommendationKey ? f.analyst.recommendationKey.replace(/_/g, ' ') : '—';

      html += '<tr>' +
        '<td class="lticker" style="font-weight:700">' + esc(sym) + '</td>' +
        '<td>' + nextEarn(f) + '</td>' +
        '<td>' + beatDots(f.epsHistory) + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtPct(revG) + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtPct(fwdG) + '</td>' +
        '<td style="text-transform:capitalize">' + esc(rec) + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + (upside != null ? fmtPct(upside) : '—') + '</td>' +
        '<td style="text-align:right">' + signalBadge(sig) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Refresh the dynamic date stamp in the section description.
    var now = new Date();
    var full = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.querySelectorAll('#' + SECTION_ID + ' [data-dynamic-date="full"]').forEach(function (el) { el.textContent = full; });
  }

  // ── rebuild stale hardcoded earnings calendar with live dates ──
  // Many dashboards ship a #ecalContainer rendered from a hardcoded EARNINGS
  // map whose dates have since passed. If we have live nextEarningsDate data,
  // rebuild that container from the live data (best-effort, additive).
  function rebuildEarningsCalendar() {
    var container = document.getElementById('ecalContainer');
    if (!container) return;
    var tickers = tickersObj();
    if (!tickers) return;

    var entries = [];
    Object.keys(tickers).forEach(function (sym) {
      var f = tickers[sym] && tickers[sym].fundamentals;
      if (!f || !f.nextEarningsDate) return;
      var d = new Date(f.nextEarningsDate + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      entries.push({ ticker: sym, dateObj: d, est: f.isEarningsDateEstimate });
    });
    if (!entries.length) return; // keep the existing (stale) render rather than blanking it
    entries.sort(function (a, b) { return a.dateObj - b.dateObj; });

    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var now = new Date(); now.setHours(0, 0, 0, 0);

    var byMonth = {};
    entries.forEach(function (e) {
      var key = e.dateObj.getFullYear() + '-' + String(e.dateObj.getMonth()).padStart(2, '0');
      (byMonth[key] = byMonth[key] || []).push(e);
    });

    container.innerHTML = '';
    Object.keys(byMonth).sort().forEach(function (key) {
      var items = byMonth[key], d0 = items[0].dateObj;
      var monthDiv = document.createElement('div');
      monthDiv.innerHTML = '<div class="ecal-month-title">' + MONTHS[d0.getMonth()] + ' ' + d0.getFullYear() +
        ' <span class="ecal-count">(' + items.length + ' reports)</span></div>';
      var grid = document.createElement('div');
      grid.className = 'ecal-grid';
      items.forEach(function (e) {
        var days = Math.round((e.dateObj - now) / 86400000);
        var cls = days < 0 ? 'ec-later' : days <= 7 ? 'ec-urgent' : days <= 30 ? 'ec-soon' : 'ec-later';
        var prox = days < 0 ? 'Reported' : days === 0 ? 'Today' : days <= 7 ? 'In ' + days + 'd' : days <= 30 ? 'In ' + days + 'd' : MONTHS[e.dateObj.getMonth()].slice(0, 3);
        grid.innerHTML += '<div class="ecal-card ' + cls + '">' +
          '<div class="ecal-date-box"><span class="ecal-day">' + e.dateObj.getDate() + '</span><span class="ecal-dow">' + DOW[e.dateObj.getDay()] + '</span></div>' +
          '<div class="ecal-info"><span class="ecal-ticker lticker">' + e.ticker + '</span>' +
          '<div class="ecal-period">' + (e.est ? 'Estimated date' : 'Confirmed') + '</div></div>' +
          '<span class="ecal-prox-badge">' + prox + '</span></div>';
      });
      monthDiv.appendChild(grid);
      container.appendChild(monthDiv);
    });
  }

  function renderAll() { render(); rebuildEarningsCalendar(); }

  window.addEventListener('fundamentals-loaded', renderAll);
  window.addEventListener('live-prices-updated', function () { if (window.tickerSignals) render(); });
  (window.dashboardRenderers = window.dashboardRenderers || []).push(renderAll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectShell(); });
  } else {
    injectShell();
  }
})();
