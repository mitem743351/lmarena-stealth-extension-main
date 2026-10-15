/* LMArena Stealth — popup: toggles + cached catalog preview. */
'use strict';

(function () {
  var DEFAULTS = { e: true, o: true, h: true, forceOn: false, forceId: '', forceName: '' };
  var toggles = {
    e: document.getElementById('e'),
    o: document.getElementById('o'),
    h: document.getElementById('h'),
    f: document.getElementById('f')
  };
  var statEl = document.getElementById('stat');
  try { document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  var listEl = document.getElementById('models');
  var models = [];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function activeTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      cb(tabs && tabs[0]);
    });
  }

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, function (cfg) {
      toggles.e.checked = !!cfg.e;
      toggles.o.checked = !!cfg.o;
      toggles.h.checked = !!cfg.h;
      toggles.f.checked = !!cfg.forceOn;
      renderStat(cfg);
      activeTab(function (tab) {
        if (!tab || !tab.id) return;
        try {
          chrome.tabs.sendMessage(tab.id, { t: 's', d: cfg }, function () { void chrome.runtime.lastError; });
        } catch (e) {}
      });
    });
  }

  function loadModels() {
    chrome.storage.local.get(['lmarenaModels'], function (r) {
      models = (r && r.lmarenaModels) || [];
      renderModels();
      renderStat(null);
    });
  }

  function renderStat(cfg) {
    var hidden = models.filter(function (m) { return m.userSelectable === false; }).length;
    var html = 'Cached catalog: <b>' + models.length + '</b> models';
    if (hidden) html += ' · <b>' + hidden + '</b> hidden';
    if (cfg && cfg.forceOn && cfg.forceId) html += '<br><span class="hi">forcing: ' + esc(cfg.forceName || cfg.forceId) + '</span>';
    statEl.innerHTML = html;
  }

  function renderModels() {
    listEl.innerHTML = '';
    var hidden = models.filter(function (m) { return m.userSelectable === false; });
    var shown = (hidden.length ? hidden : models).slice(0, 60);
    if (!shown.length) {
      listEl.innerHTML = '<div class="m"><span class="n">No catalog cached — open arena.ai first.</span></div>';
      return;
    }
    shown.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'm';
      row.title = m.id + '  (click to copy)';
      var tag = m.userSelectable === false ? '<span class="t">hidden</span>' : '';
      row.innerHTML = '<span class="n">' + esc(m.publicName || m.id) + '</span>' +
        '<span class="o">' + esc(m.organization || '') + '</span>' + tag;
      row.addEventListener('click', function () {
        try { navigator.clipboard.writeText(m.id); } catch (e) {}
        row.style.opacity = '.5';
      });
      listEl.appendChild(row);
    });
  }

  function save(patch, after) {
    chrome.storage.sync.set(patch, function () {
      activeTab(function (tab) {
        if (!tab || !tab.id) return;
        try {
          chrome.tabs.sendMessage(tab.id, { t: 's', d: patch }, function () { void chrome.runtime.lastError; });
        } catch (e) {}
      });
      if (after) after();
    });
  }

  toggles.e.addEventListener('change', function () { save({ e: this.checked }); });
  toggles.o.addEventListener('change', function () { save({ o: this.checked }); });
  toggles.h.addEventListener('change', function () { save({ h: this.checked }); });
  // "Force on send" only flips the switch; the model id is set by the panel
  // (or by arena.ai Plus-style selection below) and rides along in sync storage.
  toggles.f.addEventListener('change', function () {
    var on = this.checked;
    save({ forceOn: on }, function () {
      chrome.storage.sync.get(DEFAULTS, function (cfg) { renderStat(cfg); });
    });
  });

  document.getElementById('reload').addEventListener('click', function () {
    activeTab(function (tab) { if (tab && tab.id) chrome.tabs.reload(tab.id); });
    window.close();
  });

  document.getElementById('clear').addEventListener('click', function () {
    chrome.storage.local.remove(['lmarenaModels', 'lmarenaLastScan'], function () {
      models = [];
      renderModels();
      renderStat(null);
    });
  });

  loadSettings();
  loadModels();
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.lmarenaModels) loadModels();
    if (area === 'sync') loadSettings();
  });
})();