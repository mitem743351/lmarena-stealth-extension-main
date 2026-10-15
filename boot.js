/* ============================================================================
 * LMArena Stealth — isolated-world config bridge (document_start)
 * ----------------------------------------------------------------------------
 * chrome.storage is not reachable from the page world, but localStorage is
 * shared between both worlds. So we mirror the settings into localStorage and
 * let main.js (world: MAIN) read them synchronously before Arena boots.
 * ========================================================================== */
'use strict';

(function () {
  var KEY = 'lm_stealth_cfg';
  var DEFAULTS = { e: true, o: true, h: true, forceOn: false, forceId: '', forceName: '' };

  function merge(base, patch) {
    var out = {};
    for (var k in base) out[k] = base[k];
    if (patch) for (var j in patch) if (patch[j] !== undefined) out[j] = patch[j];
    return out;
  }

  function localRead() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function localWrite(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
    announce(cfg);
  }

  function announce(cfg) {
    try { window.postMessage({ __lmStealth: true, from: 'panel', type: 'cfg', cfg: cfg }, '*'); } catch (e) {}
  }

  var cfg = merge(DEFAULTS, localRead());
  localWrite(cfg);

  var api = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) ? chrome.storage.sync : null;

  if (api) {
    // sync storage is the source of truth once it answers
    api.get(DEFAULTS, function (stored) {
      cfg = merge(cfg, stored);
      localWrite(cfg);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      var patch = {};
      for (var k in changes) patch[k] = changes[k].newValue;
      cfg = merge(cfg, patch);
      localWrite(cfg);
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (!msg) return;
      if (msg.t === 's') {           // popup wrote a toggle
        cfg = merge(cfg, msg.d || {});
        localWrite(cfg);
        respond({ ok: 1 });
        return true;
      }
      if (msg.t === 'g') {           // popup asks for current state
        respond(cfg);
        return true;
      }
    });
  }
})();