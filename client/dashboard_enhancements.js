/* ============================================================
   DashboardEnhancements — Shared JS Module
   Features: Global Search, Watchlist, Dark/Light Toggle, Quick Compare
   Version: 1.0.0
   ============================================================ */
(function(root) {
  'use strict';

  // ── Storage helper (uses page's safeStorage if available) ──
  var store = (typeof safeStorage !== 'undefined') ? safeStorage
    : (typeof localStorage !== 'undefined') ? localStorage
    : { _m: {}, getItem: function(k){ return this._m[k] || null; }, setItem: function(k,v){ this._m[k] = v; }, removeItem: function(k){ delete this._m[k]; } };

  // ── i18n helper ──
  function t(key) {
    // Use page's own t() if present, otherwise return key
    if (typeof root.t === 'function' && root.t !== t) {
      return root.t(key);
    }
    // Fallback: check I18N object directly
    if (typeof root.I18N !== 'undefined' && typeof root.I18N_LANG !== 'undefined' && root.I18N_LANG !== 'en') {
      var entry = root.I18N[key];
      if (entry && entry.zh) return entry.zh;
    }
    return key;
  }

  // ── Chart.js color sequences for compare ──
  var COMPARE_COLORS = [
    { line: '#5b9cf6', bg: 'rgba(91,156,246,0.08)' },
    { line: '#56cc84', bg: 'rgba(86,204,132,0.08)' },
    { line: '#f5a454', bg: 'rgba(245,164,84,0.08)' },
  ];

  // ── SVG icons ──
  var ICONS = {
    search: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    star: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    sun: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    moon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    compare: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  // ── Module state ──
  var _config = null;
  var _tickers = {};       // {SYM: {name, layer, ...}}
  var _priceData = {};     // {SYM: [{d,c,v},...]}
  var _tickerList = [];    // [{sym, name, layer}, ...]
  var _watchlist = [];
  var _compareSelected = [];
  var _compareChart = null;
  var _searchActiveIdx = -1;

  // ============================================================
  // PUBLIC API
  // ============================================================
  var DE = {};

  /**
   * Initialize the enhancement module.
   * @param {Object} config
   * @param {Object} config.tickers - {SYM: {name, layer?, ...}}
   * @param {Object} config.priceData - {SYM: [{d,c,v},...]} (optional)
   * @param {Function} config.onTickerSelect - callback(sym) when search/compare selects a ticker
   * @param {string} config.dashboardType - 'ai' | 'sw' | 'semi'
   */
  DE.init = function(config) {
    _config = config || {};
    _tickers = _config.tickers || {};
    _priceData = _config.priceData || {};
    _config.onTickerSelect = _config.onTickerSelect || function() {};
    _config.dashboardType = _config.dashboardType || 'ai';

    // Build ticker list for search
    _tickerList = [];
    var syms = Object.keys(_tickers);
    for (var i = 0; i < syms.length; i++) {
      var sym = syms[i];
      var td = _tickers[sym];
      _tickerList.push({
        sym: sym,
        name: td.name || '',
        layer: td.layer || td.layers && td.layers[0] || '',
        layerColor: td.layerColor || ''
      });
    }
    // Sort alphabetically by symbol
    _tickerList.sort(function(a, b) { return a.sym.localeCompare(b.sym); });

    // Load watchlist from storage
    _loadWatchlist();

    // Inject UI
    _injectNavTools();
    _injectSearchOverlay();
    _injectCompareOverlay();
    _bindKeyboard();
    _injectStarButtons();

    // Observe DOM for dynamically added tickers
    _observeDOM();
  };

  /**
   * Get current watchlist
   * @returns {string[]}
   */
  DE.getWatchlist = function() {
    return _watchlist.slice();
  };

  /**
   * Check if a ticker is in watchlist
   * @param {string} sym
   * @returns {boolean}
   */
  DE.isWatched = function(sym) {
    return _watchlist.indexOf(sym) !== -1;
  };

  /**
   * Toggle watchlist status for a ticker
   * @param {string} sym
   */
  DE.toggleWatch = function(sym) {
    var idx = _watchlist.indexOf(sym);
    if (idx === -1) {
      _watchlist.push(sym);
    } else {
      _watchlist.splice(idx, 1);
    }
    _saveWatchlist();
    _updateAllStars();
    _updateWatchlistCount();
  };

  /**
   * Open the search overlay
   */
  DE.openSearch = function() {
    var overlay = document.getElementById('de-search-overlay');
    if (overlay) {
      overlay.classList.add('open');
      var input = document.getElementById('de-search-input');
      if (input) {
        input.value = '';
        input.focus();
      }
      _renderSearchResults('');
    }
  };

  /**
   * Close the search overlay
   */
  DE.closeSearch = function() {
    var overlay = document.getElementById('de-search-overlay');
    if (overlay) overlay.classList.remove('open');
    _searchActiveIdx = -1;
  };

  /**
   * Open compare mode
   */
  DE.openCompare = function() {
    _compareSelected = [];
    var overlay = document.getElementById('de-compare-overlay');
    if (overlay) {
      overlay.classList.add('open');
      _renderCompareUI();
    }
  };

  /**
   * Close compare mode
   */
  DE.closeCompare = function() {
    var overlay = document.getElementById('de-compare-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('de-compare-mode');
    _compareSelected = [];
    if (_compareChart) {
      _compareChart.destroy();
      _compareChart = null;
    }
  };

  /**
   * Get list of i18n keys used by this module
   * @returns {string[]}
   */
  DE.getI18nKeys = function() {
    return [
      'Search tickers...', 'No results found', 'Navigate', 'Select', 'Close',
      'Watchlist', 'Compare', 'Dark Mode', 'Light Mode',
      'Quick Compare', 'Select 2-3 tickers to compare normalized performance',
      'Click tickers below to select (max 3)', 'No price data available for comparison',
      'Normalized Performance (% Change)', 'Select at least 2 tickers',
      'Search', 'Toggle theme', 'Show watchlist only', 'Remove from compare'
    ];
  };

  // ============================================================
  // PRIVATE: WATCHLIST
  // ============================================================
  function _loadWatchlist() {
    try {
      var raw = store.getItem('dashboard_watchlist');
      _watchlist = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(_watchlist)) _watchlist = [];
    } catch (e) {
      _watchlist = [];
    }
  }

  function _saveWatchlist() {
    try {
      store.setItem('dashboard_watchlist', JSON.stringify(_watchlist));
    } catch (e) {}
  }

  function _updateWatchlistCount() {
    var badge = document.getElementById('de-watchlist-count');
    if (badge) {
      badge.textContent = _watchlist.length > 0 ? _watchlist.length : '';
    }
  }

  function _updateAllStars() {
    var stars = document.querySelectorAll('.de-star-btn');
    for (var i = 0; i < stars.length; i++) {
      var sym = stars[i].getAttribute('data-ticker');
      if (_watchlist.indexOf(sym) !== -1) {
        stars[i].classList.add('starred');
      } else {
        stars[i].classList.remove('starred');
      }
    }
  }

  function _createStarButton(sym) {
    var btn = document.createElement('button');
    btn.className = 'de-star-btn' + (DE.isWatched(sym) ? ' starred' : '');
    btn.setAttribute('data-ticker', sym);
    btn.setAttribute('title', t('Watchlist'));
    btn.innerHTML = ICONS.star;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      DE.toggleWatch(sym);
    });
    return btn;
  }

  function _injectStarButtons() {
    // Strategy: find all elements with ticker symbols and inject stars nearby
    // 1. Table rows with .ticker class
    var tickerEls = document.querySelectorAll('.ticker, .sc-ticker, .chain-ticker');
    for (var i = 0; i < tickerEls.length; i++) {
      var el = tickerEls[i];
      var sym = el.textContent.trim();
      if (!_tickers[sym]) continue;
      // Check if already has a star
      if (el.parentNode && el.parentNode.querySelector('.de-star-btn[data-ticker="' + sym + '"]')) continue;
      var star = _createStarButton(sym);
      // For table cells, insert before the ticker
      if (el.tagName === 'TD' || el.closest && el.closest('td')) {
        el.parentNode.insertBefore(star, el);
      } else {
        // For card-style tickers, insert after
        if (el.nextSibling) {
          el.parentNode.insertBefore(star, el.nextSibling);
        } else {
          el.parentNode.appendChild(star);
        }
      }
    }

    // 2. Heatmap cells
    var heatCells = document.querySelectorAll('.heatmap-ticker');
    for (var j = 0; j < heatCells.length; j++) {
      var hel = heatCells[j];
      var hsym = hel.textContent.trim();
      if (!_tickers[hsym]) continue;
      if (hel.parentNode && hel.parentNode.querySelector('.de-star-btn[data-ticker="' + hsym + '"]')) continue;
      var hstar = _createStarButton(hsym);
      hstar.style.position = 'absolute';
      hstar.style.top = '2px';
      hstar.style.right = '2px';
      var parent = hel.parentNode;
      if (parent) {
        parent.style.position = 'relative';
        parent.appendChild(hstar);
      }
    }

    // Mark rows for watchlist filter
    _markWatchlistRows();
  }

  function _markWatchlistRows() {
    // Mark table rows and card containers
    var stars = document.querySelectorAll('.de-star-btn');
    for (var i = 0; i < stars.length; i++) {
      var sym = stars[i].getAttribute('data-ticker');
      var row = stars[i].closest('tr') || stars[i].closest('.sc') || stars[i].closest('.chain-box') || stars[i].closest('.heatmap-cell');
      if (row) {
        if (_watchlist.indexOf(sym) !== -1) {
          row.classList.remove('de-not-watched');
        } else {
          row.classList.add('de-not-watched');
        }
      }
    }
  }

  function _toggleWatchlistFilter() {
    document.body.classList.toggle('de-watchlist-filter');
    var btn = document.getElementById('de-watchlist-btn');
    if (btn) btn.classList.toggle('active');
    _markWatchlistRows();
  }

  // ============================================================
  // PRIVATE: OBSERVE DOM (for dynamic content)
  // ============================================================
  function _observeDOM() {
    if (typeof MutationObserver === 'undefined') return;
    var debounce = null;
    var observer = new MutationObserver(function() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function() {
        _injectStarButtons();
      }, 300);
    });
    var main = document.querySelector('.page-body') || document.querySelector('.main') || document.querySelector('.content') || document.body;
    observer.observe(main, { childList: true, subtree: true });
  }

  // ============================================================
  // PRIVATE: NAV TOOLS INJECTION
  // ============================================================
  function _injectNavTools() {
    var nav = document.querySelector('.dash-nav');
    if (!nav) return;

    // Check if already injected
    if (document.getElementById('de-nav-tools')) return;

    var container = document.createElement('div');
    container.id = 'de-nav-tools';
    container.className = 'de-nav-tools';

    // Search button
    var searchBtn = document.createElement('button');
    searchBtn.className = 'de-icon-btn';
    searchBtn.setAttribute('title', t('Search') + ' (Ctrl+K)');
    searchBtn.innerHTML = ICONS.search;
    searchBtn.addEventListener('click', function() { DE.openSearch(); });
    container.appendChild(searchBtn);

    // Watchlist button
    var wlBtn = document.createElement('button');
    wlBtn.id = 'de-watchlist-btn';
    wlBtn.className = 'de-icon-btn';
    wlBtn.setAttribute('title', t('Show watchlist only'));
    wlBtn.innerHTML = ICONS.star + '<span id="de-watchlist-count" class="de-watchlist-count"></span>';
    wlBtn.addEventListener('click', function() { _toggleWatchlistFilter(); });
    container.appendChild(wlBtn);
    _updateWatchlistCount();

    // Theme toggle
    var themeBtn = document.createElement('button');
    themeBtn.id = 'de-theme-btn';
    themeBtn.className = 'de-icon-btn';
    themeBtn.setAttribute('title', t('Toggle theme'));
    themeBtn.innerHTML = '<span class="de-theme-icon de-theme-sun">' + ICONS.sun + '</span>'
      + '<span class="de-theme-icon de-theme-moon">' + ICONS.moon + '</span>';
    themeBtn.addEventListener('click', function() { _toggleTheme(); });
    container.appendChild(themeBtn);

    // Compare button
    var cmpBtn = document.createElement('button');
    cmpBtn.className = 'de-text-btn';
    cmpBtn.setAttribute('data-i18n', 'Compare');
    cmpBtn.textContent = t('Compare');
    cmpBtn.addEventListener('click', function() { DE.openCompare(); });
    container.appendChild(cmpBtn);

    // Insert: if there's a dash-nav-link, insert before the first one; else append
    var navLink = nav.querySelector('.dash-nav-link');
    if (navLink) {
      nav.insertBefore(container, navLink);
    } else {
      nav.appendChild(container);
    }
  }

  // ============================================================
  // PRIVATE: SEARCH
  // ============================================================
  function _injectSearchOverlay() {
    if (document.getElementById('de-search-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'de-search-overlay';
    overlay.className = 'de-search-overlay';
    overlay.innerHTML =
      '<div class="de-search-backdrop" id="de-search-backdrop"></div>'
      + '<div class="de-search-box">'
      +   '<div class="de-search-input-wrap">'
      +     ICONS.search
      +     '<input type="text" id="de-search-input" class="de-search-input" placeholder="' + t('Search tickers...') + '" autocomplete="off" spellcheck="false">'
      +     '<span class="de-search-kbd">ESC</span>'
      +   '</div>'
      +   '<div id="de-search-results" class="de-search-results"></div>'
      +   '<div class="de-search-hint">'
      +     '<kbd>↑↓</kbd> <span data-i18n="Navigate">' + t('Navigate') + '</span>'
      +     '&nbsp;&nbsp;<kbd>↵</kbd> <span data-i18n="Select">' + t('Select') + '</span>'
      +     '&nbsp;&nbsp;<kbd>esc</kbd> <span data-i18n="Close">' + t('Close') + '</span>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(overlay);

    // Events
    document.getElementById('de-search-backdrop').addEventListener('click', function() { DE.closeSearch(); });
    document.getElementById('de-search-input').addEventListener('input', function(e) {
      _searchActiveIdx = -1;
      _renderSearchResults(e.target.value);
    });
    document.getElementById('de-search-input').addEventListener('keydown', function(e) {
      var results = document.querySelectorAll('.de-search-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _searchActiveIdx = Math.min(_searchActiveIdx + 1, results.length - 1);
        _highlightSearchItem(results);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _searchActiveIdx = Math.max(_searchActiveIdx - 1, 0);
        _highlightSearchItem(results);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_searchActiveIdx >= 0 && results[_searchActiveIdx]) {
          var sym = results[_searchActiveIdx].getAttribute('data-sym');
          _selectSearchResult(sym);
        } else if (results.length === 1) {
          _selectSearchResult(results[0].getAttribute('data-sym'));
        }
      } else if (e.key === 'Escape') {
        DE.closeSearch();
      }
    });
  }

  function _renderSearchResults(query) {
    var container = document.getElementById('de-search-results');
    if (!container) return;

    query = (query || '').trim().toUpperCase();
    if (!query) {
      // Show all tickers (limited to 20)
      var all = _tickerList.slice(0, 20);
      container.innerHTML = _buildSearchItems(all);
      return;
    }

    var matches = [];
    for (var i = 0; i < _tickerList.length; i++) {
      var item = _tickerList[i];
      var symMatch = item.sym.toUpperCase().indexOf(query) !== -1;
      var nameMatch = item.name.toUpperCase().indexOf(query) !== -1;
      if (symMatch || nameMatch) {
        // Rank: exact symbol start > symbol contains > name contains
        var rank = symMatch ? (item.sym.toUpperCase().indexOf(query) === 0 ? 0 : 1) : 2;
        matches.push({ item: item, rank: rank });
      }
    }
    matches.sort(function(a, b) { return a.rank - b.rank; });

    if (matches.length === 0) {
      container.innerHTML = '<div class="de-search-empty" data-i18n="No results found">' + t('No results found') + '</div>';
      return;
    }

    var items = [];
    for (var j = 0; j < Math.min(matches.length, 20); j++) {
      items.push(matches[j].item);
    }
    container.innerHTML = _buildSearchItems(items);
  }

  function _buildSearchItems(items) {
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      html += '<div class="de-search-item" data-sym="' + item.sym + '" data-idx="' + i + '">'
        + '<span class="de-search-item-sym">' + item.sym + '</span>'
        + '<span class="de-search-item-name">' + _escHtml(item.name) + '</span>'
        + (item.layer ? '<span class="de-search-item-layer">' + _escHtml(item.layer) + '</span>' : '')
        + '</div>';
    }
    // Bind click events after insertion (via delegation)
    setTimeout(function() {
      var results = document.querySelectorAll('.de-search-item');
      for (var k = 0; k < results.length; k++) {
        (function(el) {
          el.addEventListener('click', function() {
            _selectSearchResult(el.getAttribute('data-sym'));
          });
        })(results[k]);
      }
    }, 0);
    return html;
  }

  function _highlightSearchItem(results) {
    for (var i = 0; i < results.length; i++) {
      results[i].classList.remove('de-search-active');
    }
    if (_searchActiveIdx >= 0 && results[_searchActiveIdx]) {
      results[_searchActiveIdx].classList.add('de-search-active');
      results[_searchActiveIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  function _selectSearchResult(sym) {
    DE.closeSearch();
    if (_config && typeof _config.onTickerSelect === 'function') {
      _config.onTickerSelect(sym);
    }
    // Also try the page's openPanel function
    if (typeof root.openPanel === 'function') {
      root.openPanel(sym);
    }
  }

  // ============================================================
  // PRIVATE: THEME TOGGLE
  // ============================================================
  function _toggleTheme() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme') || 'dark';
    var next = current === 'dark' ? 'light' : 'dark';

    // Smooth transition
    html.classList.add('theme-transitioning');
    html.setAttribute('data-theme', next);
    store.setItem('dashboard_theme', next);
    // Also write to the page's theme storage key
    store.setItem('theme', next);

    // Update all Chart.js instances
    _updateChartsForTheme(next);

    // Call the page's renderCharts if it exists
    if (typeof root.renderCharts === 'function') {
      try { root.renderCharts(); } catch(e) {}
    }
    if (typeof root.renderAll === 'function') {
      try { root.renderAll(); } catch(e) {}
    }

    // Remove transition class after animation
    setTimeout(function() {
      html.classList.remove('theme-transitioning');
    }, 350);
  }

  function _updateChartsForTheme(theme) {
    if (typeof Chart === 'undefined') return;
    var isDark = theme === 'dark';
    var gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
    var textColor = isDark ? '#7a7e96' : '#5c617a';

    // Get all Chart.js instances
    var instances = [];
    try {
      // Chart.js 4.x
      if (Chart.instances) {
        var keys = Object.keys(Chart.instances);
        for (var i = 0; i < keys.length; i++) {
          instances.push(Chart.instances[keys[i]]);
        }
      }
    } catch(e) {}

    for (var j = 0; j < instances.length; j++) {
      var chart = instances[j];
      if (!chart || !chart.options) continue;
      try {
        // Update scale colors
        if (chart.options.scales) {
          var scaleKeys = Object.keys(chart.options.scales);
          for (var s = 0; s < scaleKeys.length; s++) {
            var scale = chart.options.scales[scaleKeys[s]];
            if (scale.grid) scale.grid.color = gridColor;
            if (scale.ticks) scale.ticks.color = textColor;
          }
        }
        // Update legend colors
        if (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
          chart.options.plugins.legend.labels.color = textColor;
        }
        chart.update('none');
      } catch(e) {}
    }
  }

  // ============================================================
  // PRIVATE: QUICK COMPARE
  // ============================================================
  function _injectCompareOverlay() {
    if (document.getElementById('de-compare-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'de-compare-overlay';
    overlay.className = 'de-compare-overlay';
    overlay.innerHTML =
      '<div class="de-compare-backdrop" id="de-compare-backdrop"></div>'
      + '<div class="de-compare-modal">'
      +   '<div class="de-compare-header">'
      +     '<div class="de-compare-title">' + ICONS.compare + ' <span data-i18n="Quick Compare">' + t('Quick Compare') + '</span></div>'
      +     '<button class="de-compare-close" id="de-compare-close">' + ICONS.x + '</button>'
      +   '</div>'
      +   '<div class="de-compare-body">'
      +     '<div class="de-compare-instructions" data-i18n="Click tickers below to select (max 3)">' + t('Click tickers below to select (max 3)') + '</div>'
      +     '<div class="de-compare-picks" id="de-compare-picks"></div>'
      +     '<div id="de-compare-grid" class="de-compare-grid"></div>'
      +     '<div class="de-compare-chart-area" id="de-compare-chart-area">'
      +       '<canvas id="de-compare-canvas"></canvas>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(overlay);

    document.getElementById('de-compare-backdrop').addEventListener('click', function() { DE.closeCompare(); });
    document.getElementById('de-compare-close').addEventListener('click', function() { DE.closeCompare(); });
  }

  function _renderCompareUI() {
    _renderCompareGrid();
    _renderComparePicks();
    _renderCompareChart();
  }

  function _renderCompareGrid() {
    var container = document.getElementById('de-compare-grid');
    if (!container) return;

    var html = '';
    for (var i = 0; i < _tickerList.length; i++) {
      var item = _tickerList[i];
      var isSelected = _compareSelected.indexOf(item.sym) !== -1;
      html += '<div class="de-compare-grid-item' + (isSelected ? ' selected' : '') + '" data-sym="' + item.sym + '">'
        + '<div class="de-cg-sym">' + item.sym + '</div>'
        + '<div class="de-cg-name">' + _escHtml(_truncate(item.name, 18)) + '</div>'
        + '</div>';
    }
    container.innerHTML = html;

    // Bind clicks
    var items = container.querySelectorAll('.de-compare-grid-item');
    for (var j = 0; j < items.length; j++) {
      (function(el) {
        el.addEventListener('click', function() {
          var sym = el.getAttribute('data-sym');
          _toggleCompareSelect(sym);
        });
      })(items[j]);
    }
  }

  function _toggleCompareSelect(sym) {
    var idx = _compareSelected.indexOf(sym);
    if (idx !== -1) {
      _compareSelected.splice(idx, 1);
    } else {
      if (_compareSelected.length >= 3) return; // max 3
      _compareSelected.push(sym);
    }
    _renderCompareGrid();
    _renderComparePicks();
    _renderCompareChart();
  }

  function _renderComparePicks() {
    var container = document.getElementById('de-compare-picks');
    if (!container) return;

    if (_compareSelected.length === 0) {
      container.innerHTML = '';
      return;
    }
    var html = '';
    for (var i = 0; i < _compareSelected.length; i++) {
      var sym = _compareSelected[i];
      html += '<div class="de-compare-chip">'
        + sym
        + '<span class="de-compare-chip-x" data-sym="' + sym + '" title="' + t('Remove from compare') + '">&times;</span>'
        + '</div>';
    }
    container.innerHTML = html;

    // Bind remove clicks
    var xBtns = container.querySelectorAll('.de-compare-chip-x');
    for (var j = 0; j < xBtns.length; j++) {
      (function(el) {
        el.addEventListener('click', function() {
          _toggleCompareSelect(el.getAttribute('data-sym'));
        });
      })(xBtns[j]);
    }
  }

  function _renderCompareChart() {
    var canvas = document.getElementById('de-compare-canvas');
    if (!canvas) return;
    if (typeof Chart === 'undefined') return;

    // Destroy old chart
    if (_compareChart) {
      _compareChart.destroy();
      _compareChart = null;
    }

    if (_compareSelected.length < 2) {
      // Show message
      var area = document.getElementById('de-compare-chart-area');
      if (area && !area.querySelector('.de-compare-empty')) {
        // Keep canvas but it's blank
      }
      return;
    }

    // Gather price data and normalize to % change
    var datasets = [];
    var maxLen = 0;
    var validSyms = [];

    for (var i = 0; i < _compareSelected.length; i++) {
      var sym = _compareSelected[i];
      var prices = _getPriceArray(sym);
      if (prices && prices.length > 1) {
        validSyms.push(sym);
        if (prices.length > maxLen) maxLen = prices.length;
      }
    }

    if (validSyms.length < 2) {
      // Not enough price data
      return;
    }

    var labels = [];
    for (var l = 0; l < maxLen; l++) {
      labels.push(l);
    }

    for (var k = 0; k < validSyms.length; k++) {
      var s = validSyms[k];
      var p = _getPriceArray(s);
      var basePrice = p[0];
      var normalized = [];
      for (var n = 0; n < p.length; n++) {
        normalized.push(((p[n] / basePrice) - 1) * 100);
      }
      var ci = k % COMPARE_COLORS.length;
      datasets.push({
        label: s,
        data: normalized,
        borderColor: COMPARE_COLORS[ci].line,
        backgroundColor: COMPARE_COLORS[ci].bg,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.3,
        fill: false
      });
    }

    var isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
    var gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
    var textColor = isDark ? '#7a7e96' : '#5c617a';

    _compareChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: textColor,
              font: { size: 11, family: "'Inter', sans-serif" },
              boxWidth: 12,
              padding: 14,
              usePointStyle: true
            }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ': ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(2) + '%';
              }
            }
          }
        },
        scales: {
          x: {
            display: false
          },
          y: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { size: 10, family: "'JetBrains Mono', monospace" },
              callback: function(val) { return (val >= 0 ? '+' : '') + val.toFixed(0) + '%'; }
            },
            title: {
              display: true,
              text: t('Normalized Performance (% Change)'),
              color: textColor,
              font: { size: 10, family: "'Inter', sans-serif" }
            }
          }
        }
      }
    });
  }

  function _getPriceArray(sym) {
    // Try various price data formats
    var pd = _priceData[sym];
    if (pd) {
      // Array of objects: [{d, c, v}] — use 'c' (close)
      if (Array.isArray(pd) && pd.length > 0) {
        if (typeof pd[0] === 'object' && pd[0] !== null && 'c' in pd[0]) {
          return pd.map(function(item) { return item.c; });
        }
        // Array of numbers
        if (typeof pd[0] === 'number') {
          return pd;
        }
      }
    }
    // Try ticker data priceHistory (SW dashboard style)
    var td = _tickers[sym];
    if (td && td.priceHistory && Array.isArray(td.priceHistory)) {
      return td.priceHistory;
    }
    return null;
  }

  // ============================================================
  // PRIVATE: KEYBOARD SHORTCUTS
  // ============================================================
  function _bindKeyboard() {
    document.addEventListener('keydown', function(e) {
      // Ctrl+K or Cmd+K to open search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        DE.openSearch();
      }
      // Escape to close overlays
      if (e.key === 'Escape') {
        var searchOverlay = document.getElementById('de-search-overlay');
        if (searchOverlay && searchOverlay.classList.contains('open')) {
          DE.closeSearch();
          return;
        }
        var compareOverlay = document.getElementById('de-compare-overlay');
        if (compareOverlay && compareOverlay.classList.contains('open')) {
          DE.closeCompare();
          return;
        }
      }
    });
  }

  // ============================================================
  // PRIVATE: UTILITIES
  // ============================================================
  function _escHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function _truncate(str, max) {
    if (str.length <= max) return str;
    return str.substring(0, max) + '…';
  }

  // ============================================================
  // AUTO-DETECT: Try to detect ticker data from common page patterns
  // ============================================================
  DE.autoDetect = function() {
    var tickers = null;
    var priceData = null;
    var dashboardType = 'ai';

    // Check for DATA.tickers (semi dashboard)
    if (typeof root.DATA !== 'undefined' && root.DATA && root.DATA.tickers) {
      tickers = root.DATA.tickers;
      dashboardType = 'semi';
    }
    // Check for SW_DATA.tickers (software dashboard)
    if (!tickers && typeof root.SW_DATA !== 'undefined' && root.SW_DATA && root.SW_DATA.tickers) {
      tickers = root.SW_DATA.tickers;
      dashboardType = 'sw';
    }
    // Check for TICKER_DATA (AI dashboard)
    if (!tickers && typeof root.TICKER_DATA !== 'undefined' && root.TICKER_DATA) {
      tickers = root.TICKER_DATA;
      dashboardType = 'ai';
    }
    // Check for PRICE_DATA
    if (typeof root.PRICE_DATA !== 'undefined') {
      priceData = root.PRICE_DATA;
    }

    if (tickers) {
      DE.init({
        tickers: tickers,
        priceData: priceData || {},
        dashboardType: dashboardType,
        onTickerSelect: function(sym) {
          // Default: try openPanel
          if (typeof root.openPanel === 'function') {
            root.openPanel(sym);
          }
        }
      });
      return true;
    }
    return false;
  };

  // ============================================================
  // AUTO-INIT: Wait for DOM + data, then try autoDetect
  // ============================================================
  function _autoInit() {
    // Try immediately
    if (DE.autoDetect()) return;

    // Retry after a delay (data may load async)
    var attempts = 0;
    var interval = setInterval(function() {
      attempts++;
      if (DE.autoDetect() || attempts > 20) {
        clearInterval(interval);
      }
    }, 500);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        // Delay to let page scripts load data
        setTimeout(_autoInit, 300);
      });
    } else {
      setTimeout(_autoInit, 300);
    }
  }

  // Expose to global
  root.DashboardEnhancements = DE;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
