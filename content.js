/* ============================================================================
 * LMArena Stealth — panel (isolated world)
 * ----------------------------------------------------------------------------
 *  - extracts the model catalog from the page's Flight payload
 *  - shows every model, flags the ones Arena hides (userSelectable: false)
 *  - lets you pick one and either open it in a mode (deep link) or force it
 *    into the next message you send on the page you are already on
 * ========================================================================== */
'use strict';

(function () {
  var STORAGE_MODELS = 'lmarenaModels';
  var STORAGE_LAST = 'lmarenaLastScan';
  var PANEL_ID = 'lm-stealth-panel';
  var BTN_ID = 'lm-stealth-btn';
  var VERSION = (function () {
    try { return chrome.runtime.getManifest().version; } catch (e) { return 'dev'; }
  })();

  /* ---------------------------------------------------------------- state */
  var state = {
    models: [],
    filter: '',
    hiddenOnly: true,
    selected: null,
    unlocked: 0,
    routed: '',
    sent: '',
    status: '',
    catalogSource: '',
    diag: null,
    pageAlive: false,
    modes: []
  };

  /* ------------------------------------------------------------ mode links */
  // mode pages the user cares about; `param` = how the model is passed.
  var MODES = [
    { id: 'text-direct', label: 'Text · Direct', url: '/text/direct', param: 'model_a' },
    { id: 'text-sxs', label: 'Text · Side by Side', url: '/text/side-by-side', param: 'model_a' },
    { id: 'code-direct', label: 'Code · Direct', url: '/code/direct', param: 'model_a' },
    { id: 'code-sxs', label: 'Code · Side by Side', url: '/code/side-by-side', param: 'model_a' },
    { id: 'image-direct', label: 'Image · Direct', url: '/image/direct', param: 'model_a' },
    { id: 'image-sxs', label: 'Image · Side by Side', url: '/image/side-by-side', param: 'model_a' },
    { id: 'search-direct', label: 'Search · Direct', url: '/search/direct', param: 'model_a' },
    { id: 'search-sxs', label: 'Search · Side by Side', url: '/search/side-by-side', param: 'model_a' },
    { id: 'image', label: 'Image · Battle', url: '/image', param: null },
    { id: 'search', label: 'Search · Battle', url: '/search', param: null },
    { id: 'video', label: 'Video', url: '/video', param: null },
    { id: 'text', label: 'Text · Battle', url: '/text', param: null },
    { id: 'code', label: 'Code · Battle', url: '/code', param: null },
    { id: 'home', label: 'Home', url: '/', param: null }
  ];

  function linkFor(mode, model) {
    var base = 'https://arena.ai' + mode.url;
    if (!mode.param || !model) return base;
    // Arena takes the publicName as-is (lower-cased), not a slug — see model-utils.js
    var v = window.KnowModel.paramValue(model) || model.id;
    return base + '?' + mode.param + '=' + encodeURIComponent(v);
  }

  function linkForId(mode, model) {
    var base = 'https://arena.ai' + mode.url;
    if (!mode.param || !model) return base;
    return base + '?' + mode.param + '=' + encodeURIComponent(model.id);
  }

  function currentMode() {
    var m = MODES.filter(function (x) {
      return location.pathname === x.url || location.pathname === x.url + '/';
    })[0];
    return m || null;
  }

  /* --------------------------------------------------------------- config */
  function readCfg() {
    try { return JSON.parse(localStorage.getItem('lm_stealth_cfg') || '{}') || {}; } catch (e) { return {}; }
  }

  function writeCfg(patch) {
    var cfg = readCfg();
    for (var k in patch) cfg[k] = patch[k];
    try { localStorage.setItem('lm_stealth_cfg', JSON.stringify(cfg)); } catch (e) {}
    try { window.postMessage({ __lmStealth: true, from: 'panel', type: 'cfg', cfg: cfg }, '*'); } catch (e) {}
    // keep the popup + other arena.ai tabs in step
    try { chrome.storage.sync.set(patch); } catch (e) {}
    return cfg;
  }

  /* -------------------------------------------------------------- catalog */
  function scanCatalog() {
    try {
      var found = window.KnowModelScan.scanModels(document);
      if (Array.isArray(found) && found.length) return found;
    } catch (e) {}
    return null;
  }

  function persist(models) {
    try {
      var payload = {};
      payload[STORAGE_MODELS] = models;
      payload[STORAGE_LAST] = Date.now();
      chrome.storage.local.set(payload);
    } catch (e) {}
    try { chrome.runtime.sendMessage({ t: 'models', n: models.length }); } catch (e) {}
  }

  function hydrate() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_MODELS], function (r) {
          resolve((r && r[STORAGE_MODELS]) || []);
        });
      } catch (e) { resolve([]); }
    });
  }

  function isHidden(m) { return window.KnowModel.isHidden(m); }
  function orgOf(m) { return (m && (m.organization || m.organizationName)) || 'unknown'; }
  function capsOf(m) {
    try { return window.KnowModel.caps(m); } catch (e) { return []; }
  }

  // 102 publicNames appear more than once in the real catalog, so a name link can
  // be ambiguous — flag it and lean on the id link instead.
  function nameCount(name) {
    var n = 0;
    var lower = String(name || '').toLowerCase();
    for (var i = 0; i < state.models.length; i++) {
      if (String(state.models[i].publicName || '').toLowerCase() === lower) n++;
    }
    return n;
  }

  function sortModels() {
    state.models.sort(function (a, b) {
      var ah = isHidden(a) ? 0 : 1, bh = isHidden(b) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return String(a.publicName || '').localeCompare(String(b.publicName || ''));
    });
  }

  function applyCatalog(models) {
    if (!Array.isArray(models) || !models.length) return;
    state.models = models.slice();
    sortModels();
  }

  /* Merge, keyed by id (ids are unique in the real catalog).
   * "hidden" always wins: the copy on the wire may already have been flipped to
   * true by our own hook, and once a model was ever seen hidden it stays flagged. */
  function mergeModels(incoming) {
    if (!Array.isArray(incoming) || !incoming.length) return 0;
    var byId = {};
    for (var i = 0; i < state.models.length; i++) {
      var m = state.models[i];
      if (m && m.id) byId[m.id] = m;
    }
    var added = 0, changed = false;
    for (var j = 0; j < incoming.length; j++) {
      var inc = incoming[j];
      if (!inc || !inc.id) continue;
      var ex = byId[inc.id];
      if (!ex) { byId[inc.id] = inc; added++; changed = true; continue; }
      if (inc.userSelectable === false && ex.userSelectable !== false) { ex.userSelectable = false; changed = true; }
      if (!ex.capabilities && inc.capabilities) { ex.capabilities = inc.capabilities; changed = true; }
      if (!ex.organization && inc.organization) { ex.organization = inc.organization; changed = true; }
      if (!ex.displayName && inc.displayName) { ex.displayName = inc.displayName; changed = true; }
    }
    if (changed) { state.models = Object.keys(byId).map(function (k) { return byId[k]; }); sortModels(); }
    return added;
  }

  /* ------------------------------------------------------------------ UI */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildUI() {
    if (document.getElementById(PANEL_ID)) return;

    var btn = el('button', null, 'Stealth');
    btn.id = BTN_ID;
    btn.title = 'LMArena Stealth Model Selector';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);

    var panel = el('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="lm-head">' +
        '<span class="lm-title">Stealth Models</span>' +
        '<span class="lm-ver">v' + VERSION + '</span>' +
        '<span class="lm-badge" id="lm-count">0</span>' +
        '<button class="lm-x" id="lm-close" title="Close">×</button>' +
      '</div>' +
      '<div class="lm-chips" id="lm-chips">' +
        '<button class="lm-chip lm-on" data-f="hidden">Hidden</button>' +
        '<button class="lm-chip" data-f="text">Text</button>' +
        '<button class="lm-chip" data-f="image">Image</button>' +
        '<button class="lm-chip" data-f="search">Search</button>' +
        '<button class="lm-chip" data-f="video">Video</button>' +
        '<button class="lm-chip" data-f="all">All</button>' +
      '</div>' +
      '<div class="lm-search"><input id="lm-q" type="text" placeholder="Search models, orgs, codenames…"><button id="lm-rescan" title="Rescan page">↻</button></div>' +
      '<div class="lm-status" id="lm-status">…</div>' +
      '<div class="lm-diag" id="lm-diag"></div>' +
      '<div class="lm-list" id="lm-list"></div>' +
      '<div class="lm-detail" id="lm-detail"></div>' +
      '<div class="lm-foot">' +
        '<label class="lm-force"><input type="checkbox" id="lm-force"><span>Force on send</span></label>' +
        '<div class="lm-openrow"><select id="lm-mode"></select><button id="lm-go">Open</button></div>' +
        '<div class="lm-openrow"><input id="lm-custom" type="text" placeholder="or paste any model id…"><button id="lm-custom-go">Force</button></div>' +
      '</div>';

    document.body.appendChild(panel);

    MODES.forEach(function (m) {
      var o = el('option', null, m.label);
      o.value = m.id;
      panel.querySelector('#lm-mode').appendChild(o);
    });

    var cur = currentMode();
    if (cur) panel.querySelector('#lm-mode').value = cur.id;

    panel.querySelector('#lm-close').addEventListener('click', toggle);
    panel.querySelector('#lm-q').addEventListener('input', function () {
      state.filter = this.value.toLowerCase();
      renderList();
    });
    panel.querySelector('#lm-rescan').addEventListener('click', rescan);
    panel.querySelector('#lm-go').addEventListener('click', openSelected);
    panel.querySelector('#lm-force').addEventListener('change', function () {
      var on = this.checked;
      if (on && !state.selected) {
        this.checked = false;
        flash('Pick a model first');
        return;
      }
      writeCfg({
        forceOn: on,
        forceId: on && state.selected ? state.selected.id : '',
        forceName: on && state.selected ? (state.selected.publicName || '') : ''
      });
      flash(on ? 'Forcing next messages to ' + (state.selected.publicName || state.selected.id) : 'Force off');
      renderStatus();
    });

    Array.prototype.forEach.call(panel.querySelectorAll('.lm-chip'), function (chip) {
      chip.addEventListener('click', function () {
        Array.prototype.forEach.call(panel.querySelectorAll('.lm-chip'), function (c) { c.classList.remove('lm-on'); });
        chip.classList.add('lm-on');
        var f = chip.getAttribute('data-f');
        state.hiddenOnly = f === 'hidden';
        state.capFilter = f === 'hidden' || f === 'all' ? null : f;
        renderList();
      });
    });

    panel.querySelector('#lm-custom-go').addEventListener('click', useCustomId);
    panel.querySelector('#lm-custom').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') useCustomId();
    });

    var cfg = readCfg();
    if (cfg.forceOn) panel.querySelector('#lm-force').checked = true;
  }

  // Power user path: an id that never made it into the catalog (retired model,
  // codename you saw elsewhere) can still be forced into the next request.
  function useCustomId() {
    var input = document.getElementById('lm-custom');
    var id = (input && input.value || '').trim();
    if (!id) { flash('Paste a model id first'); return; }
    var known = state.models.filter(function (m) { return m.id === id; })[0];
    state.selected = known || { id: id, publicName: 'custom: ' + short(id) };
    try { navigator.clipboard.writeText(id); } catch (e) {}
    var box = document.getElementById('lm-force');
    if (box) box.checked = true;
    writeCfg({ forceOn: true, forceId: id, forceName: state.selected.publicName });
    renderList();
    renderDetail();
    flash('forcing: ' + state.selected.publicName);
  }

  function toggle() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.classList.toggle('lm-open');
  }

  function flash(msg) {
    state.status = msg;
    renderStatus();
  }

  /* One line of truth about why the list may be empty. */
  function renderDiag(payload) {
    var el2 = document.getElementById('lm-diag');
    if (!el2) return;
    var d = (payload && payload.diag) || state.diag;
    if (!d && !state.pageAlive) {
      el2.innerHTML = '<b>page hook not talking.</b> Reload the arena.ai tab — the hook must be in place before Arena boots.';
      el2.classList.add('lm-open');
      return;
    }
    el2.classList.remove('lm-open');
    if (d) {
      el2.innerHTML = 'hook: pushes=' + (d.pushes || 0) + ' bytes=' + Math.round((d.pushBytes || 0) / 1024) + 'k' +
        ' · responses=' + (d.inspected || 0) + '/' + (d.fetchSeen || 0) +
        ' · xhr=' + (d.xhrSeen || 0) +
        ' · domSweeps=' + (d.domScans || 0) +
        ' · catalogHits=' + (d.catalogHits || 0) +
        ' · evalSeen=' + (d.evalSeen || 0) +
        (d.sources && d.sources.length ? ' · sources=' + d.sources.slice(-3).join(',') : '') +
        (d.errors && d.errors.length ? ' · errors=' + d.errors.slice(-2).join(' | ') : '');
    }
  }

  function reportText() {
    return JSON.stringify({
      url: location.href,
      models: state.models.length,
      hidden: state.models.filter(isHidden).length,
      catalogSource: state.catalogSource,
      pageAlive: state.pageAlive,
      diag: state.diag,
      cfg: readCfg(),
      extension: 'lmarena-stealth',
      version: VERSION
    }, null, 2);
  }

  function askPage(type) {
    try { window.postMessage({ __lmStealth: true, from: 'panel', type: type }, '*'); } catch (e) {}
  }

  function renderStatus() {
    var s = document.getElementById('lm-status');
    if (!s) return;
    var cfg = readCfg();
    var bits = [];
    bits.push(state.models.length + ' models');
    var hidden = state.models.filter(isHidden).length;
    if (hidden) bits.push('<b>' + hidden + ' hidden</b>');
    if (state.unlocked) bits.push('unlocked ' + state.unlocked);
    if (cfg.forceOn && cfg.forceId) bits.push('<span class="lm-hi">forcing: ' + esc(cfg.forceName || cfg.forceId) + '</span>');
    if (state.sent) bits.push('sent: ' + esc(short(state.sent)));
    if (state.routed) bits.push('ran: ' + esc(state.routed));
    if (state.status) bits.push('<span class="lm-hi">' + esc(state.status) + '</span>');
    s.innerHTML = bits.join(' · ');
  }

  function short(s) {
    s = String(s);
    return s.length > 22 ? s.slice(0, 10) + '…' + s.slice(-6) : s;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function matches(m) {
    if (state.hiddenOnly && !isHidden(m)) return false;
    if (state.capFilter) {
      if (capsOf(m).indexOf(state.capFilter) === -1) return false;
    }
    var q = state.filter;
    if (!q) return true;
    var hay = (String(m.publicName || '') + ' ' + orgOf(m) + ' ' + capsOf(m).join(' ') + ' ' + String(m.id || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderList() {
    var list = document.getElementById('lm-list');
    var badge = document.getElementById('lm-count');
    if (!list) return;
    var hidden = state.models.filter(isHidden).length;
    if (badge) badge.textContent = String(hidden || state.models.length);
    var shown = state.models.filter(matches);
    list.innerHTML = '';
    if (!shown.length) {
      var msg = state.models.length
        ? 'No models match these filters — hit “All” or clear the search.'
        : 'No catalog yet. The page hook is watching pushes, fetches and XHR on this tab. ' +
          'If this stays empty: reload the tab, then press “Get catalog”.';
      var box = el('div', 'lm-empty', msg);
      if (!state.models.length) {
        var b1 = el('button', 'lm-link', 'Get catalog');
        b1.addEventListener('click', function () { askPage('fetch-catalog'); askPage('get-catalog'); flash('asking the page for its catalog…'); });
        var b2 = el('button', 'lm-link', 'Copy report');
        b2.addEventListener('click', function () {
          askPage('diag');
          try { navigator.clipboard.writeText(reportText()); } catch (e) {}
          flash('report copied');
        });
        var row = el('div', 'lm-links');
        row.appendChild(b1); row.appendChild(b2);
        box.appendChild(row);
      }
      list.appendChild(box);
    }
    shown.slice(0, 400).forEach(function (m) {
      var row = el('div', 'lm-row' + (state.selected && state.selected.id === m.id ? ' lm-sel' : ''));
      var name = el('div', 'lm-name', String(m.publicName || m.id));
      if (isHidden(m)) name.appendChild(el('span', 'lm-tag', 'hidden'));
      var meta = el('div', 'lm-org', orgOf(m) + (capsOf(m).length ? ' · ' + capsOf(m).join('/') : ''));
      if (nameCount(m.publicName) > 1) meta.textContent += ' · ' + nameCount(m.publicName) + ' share this name';
      row.appendChild(name);
      row.appendChild(meta);
      row.title = m.id;
      row.addEventListener('click', function () { select(m); });
      list.appendChild(row);
    });
    renderStatus();
  }

  function select(m) {
    state.selected = m;
    try { navigator.clipboard.writeText(m.id); } catch (e) {}
    renderList();
    renderDetail();
    var cfg = readCfg();
    if (cfg.forceOn) {
      writeCfg({ forceId: m.id, forceName: m.publicName || '' });
      renderStatus();
    }
  }

  function renderDetail() {
    var d = document.getElementById('lm-detail');
    if (!d) return;
    var m = state.selected;
    if (!m) { d.innerHTML = '<span class="lm-dim">Pick a model — its id lands on your clipboard.</span>'; return; }
    d.innerHTML = '';
    var head = el('div', 'lm-dname', String(m.publicName || m.id));
    d.appendChild(head);
    d.appendChild(el('div', 'lm-did', m.id));
    var links = el('div', 'lm-links');
    MODES.filter(function (x) { return x.param; }).forEach(function (mode) {
      var a = el('a', 'lm-link', mode.label.replace(' · ', '/'));
      a.href = linkFor(mode, m);
      a.target = '_blank';
      a.rel = 'noopener';
      links.appendChild(a);
    });
    d.appendChild(links);
    var dupes = nameCount(m.publicName);
    if (dupes > 1) {
      d.appendChild(el('div', 'lm-warn',
        dupes + ' catalog entries share the name “' + String(m.publicName) + '” — the links above use the ' +
        'shared name, so use the id link below to pin this exact one.'));
    }
    var idr = el('div', 'lm-links');
    var a2 = el('a', 'lm-link lm-link-alt', 'Pin this exact id');
    a2.href = linkForId(MODES[0], m);
    a2.target = '_blank';
    a2.rel = 'noopener';
    idr.appendChild(a2);
    var a3 = el('a', 'lm-link lm-link-alt', 'Copy id');
    a3.href = '#';
    a3.addEventListener('click', function (ev) {
      ev.preventDefault();
      try { navigator.clipboard.writeText(m.id); } catch (e) {}
      flash('id copied');
    });
    idr.appendChild(a3);
    d.appendChild(idr);
  }

  function openSelected() {
    var m = state.selected;
    if (!m) { flash('Pick a model first'); return; }
    var id = document.getElementById('lm-mode').value;
    var mode = MODES.filter(function (x) { return x.id === id; })[0];
    if (!mode) return;
    window.open(linkFor(mode, m), '_blank');
  }

  function rescan() {
    var found = scanCatalog();
    if (found) {
      applyCatalog(found);
      persist(found);
      renderList();
      renderDetail();
      flash('rescanned: ' + found.length + ' models');
    } else {
      flash('no catalog in this page — open arena.ai home or a chat page');
    }
  }

  /* ------------------------------------------------------- message bridge */
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.__lmStealth !== true || d.from !== 'page') return;
    if (d.type === 'unlocked') {
      state.unlocked = d.total || 0;
      renderStatus();
      var badge = document.getElementById(BTN_ID);
      if (badge) badge.setAttribute('data-unlocked', String(d.total || 0));
    } else if (d.type === 'routed') {
      var label = d.name ? String(d.name) : '';
      if (d.org) label += (label ? ' ' : '') + '(' + d.org + ')';
      state.routed = label || 'ok';
      renderStatus();
    } else if (d.type === 'sent') {
      state.sent = d.modelId || '';
      renderStatus();
    } else if (d.type === 'catalog') {
      var added = mergeModels(d.models);
      if (d.source) state.catalogSource = d.source;
      if (added || !state.models.length) {
        persist(state.models);
        renderList();
        renderDetail();
        flash('catalog: ' + state.models.length + ' models via ' + (d.source || 'page'));
      }
    } else if (d.type === 'diag') {
      state.diag = d.diag || null;
      renderDiag(d);
    } else if (d.type === 'ready') {
      state.pageAlive = true;
      renderStatus();
    }
  });

  /* ------------------------------------------------------------- lifecycle */
  var lastHref = location.href;

  var booted = false;

  function boot() {
    if (booted) return;   // never double-boot, or the timers would stack up
    booted = true;
    buildUI();
    var found = scanCatalog();
    if (found) {
      applyCatalog(found);
      persist(found);
      renderList();
    } else {
      hydrate().then(function (cached) {
        applyCatalog(cached);
        renderList();
      });
    }
    renderDetail();
    renderStatus();

    // The page hook may already hold the catalog (it runs before this script).
    askPage('ping');
    askPage('get-catalog');

    // While the list is empty, keep asking — the catalog may arrive late.
    var asks = 0;
    var askTimer = setInterval(function () {
      asks++;
      if (state.models.length || asks > 30) { clearInterval(askTimer); return; }
      askPage('get-catalog');
      renderStatus();
      if (asks === 3) renderDiag(null);
    }, 2000);

    // SPA re-hydration + client-side navigations
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var f = scanCatalog();
      if (f && f.length && f.length !== state.models.length) {
        applyCatalog(f);
        persist(f);
        renderList();
      }
      if (tries > 20) clearInterval(t);
    }, 1500);

    setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      state.routed = '';
      state.sent = '';
      renderStatus();
      askPage('get-catalog');
      setTimeout(function () {
        var f = scanCatalog();
        if (f) { applyCatalog(f); persist(f); renderList(); }
        var cur = currentMode();
        var sel = document.getElementById('lm-mode');
        if (cur && sel) sel.value = cur.id;
      }, 1200);
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();