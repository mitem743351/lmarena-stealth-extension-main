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

  function slugOf(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function linkFor(mode, model) {
    var base = 'https://arena.ai' + mode.url;
    if (!mode.param || !model) return base;
    var v = slugOf(model.publicName) || model.id;
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

  function isHidden(m) { return m && m.userSelectable === false; }
  function orgOf(m) { return (m && (m.organization || m.organizationName)) || 'unknown'; }
  function capsOf(m) {
    try { return window.KnowModel.caps(m); } catch (e) { return []; }
  }

  function applyCatalog(models) {
    if (!Array.isArray(models) || !models.length) return;
    models.sort(function (a, b) {
      var ah = isHidden(a) ? 0 : 1, bh = isHidden(b) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return String(a.publicName || '').localeCompare(String(b.publicName || ''));
    });
    state.models = models;
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
      var caps = capsOf(m).join(' ').toLowerCase();
      var t = state.capFilter;
      var map = { text: '文本', image: '生图', search: '搜索', video: '视频' };
      if (t === 'text' && caps.indexOf('文本') === -1) return false;
      if (t === 'image' && caps.indexOf('生图') === -1) return false;
      if (t === 'search' && caps.indexOf('搜索') === -1) return false;
      if (t === 'video' && caps.indexOf('视频') === -1) return false;
      void map;
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
      list.appendChild(el('div', 'lm-empty', 'No models match. Toggle filters or hit ↻ to rescan.'));
    }
    shown.slice(0, 400).forEach(function (m) {
      var row = el('div', 'lm-row' + (state.selected && state.selected.id === m.id ? ' lm-sel' : ''));
      var name = el('div', 'lm-name', String(m.publicName || m.id));
      if (isHidden(m)) name.appendChild(el('span', 'lm-tag', 'hidden'));
      var meta = el('div', 'lm-org', orgOf(m) + (capsOf(m).length ? ' · ' + capsOf(m).join('/') : ''));
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
    var idr = el('div', 'lm-links');
    var a2 = el('a', 'lm-link lm-link-alt', 'Direct link using raw id');
    a2.href = linkForId(MODES[0], m);
    a2.target = '_blank';
    a2.rel = 'noopener';
    idr.appendChild(a2);
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
    } else if (d.type === 'ready') {
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