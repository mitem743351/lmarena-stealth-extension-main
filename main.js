/* ============================================================================
 * LMArena Stealth — page-world (MAIN) hook
 * ----------------------------------------------------------------------------
 * Runs at document_start in the page's own JS context, BEFORE any Arena script.
 *
 * Jobs:
 *  1. Unlock the catalog: Arena hides models with "userSelectable": false inside
 *     the React Flight (RSC) payload, plus an Opus kill-switch flag. Rewrite those
 *     on the fly, for inline pushes and for later RSC fetches.
 *  2. Stealth select: rewrite the outgoing evaluation request so `modelAId` is the
 *     hidden model you picked, even when the UI would never offer it.
 *  3. Feed the panel: find the catalog wherever it actually arrives — inline
 *     pushes, RSC fetches, XHR, or a bare /models response — and post it to the
 *     isolated world. This is what fixes "0 models": the panel must not depend on
 *     the payload being inline.
 *  4. Report back: how many models were unlocked, and which model actually ran
 *     (the `a2:{"type":"routed_model",…}` event in the answer stream).
 *
 * Config arrives through localStorage, which both worlds share.
 * ========================================================================== */
(function () {
  'use strict';

  var CFG_KEY = 'lm_stealth_cfg';
  var DEFAULTS = {
    e: true,          // extension active
    o: true,          // restore opus (kill the disable-opus flag)
    h: true,          // reveal all hidden (userSelectable: false -> true)
    forceOn: false,   // rewrite outgoing evaluation requests
    forceId: '',      // model id to force
    forceName: ''     // label, for the status line
  };

  var EVAL_RE = /\/nextjs-api\/stream\/(?:create|post-to)-evaluation/;
  var MAX_BUF = 16 * 1024 * 1024;
  var MAX_DECODE = 6 * 1024 * 1024;   // enough for the escaped catalog (~0.6 MB)

  // the hook may be executed in a context without a full document (tests), so
  // never assume one exists
  var doc = null;
  try { doc = window.document || null; } catch (e) { doc = null; }

  function readCfg() {
    var got = {};
    try { got = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (x) { got = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = Object.prototype.hasOwnProperty.call(got, k) ? got[k] : DEFAULTS[k];
    return out;
  }

  var cfg = readCfg();

  function send(type, payload) {
    try {
      var msg = { __lmStealth: true, from: 'page', type: type };
      if (payload) for (var k in payload) msg[k] = payload[k];
      window.postMessage(msg, '*');
    } catch (e) {}
  }

  window.addEventListener('storage', function (ev) {
    if (!ev || ev.key !== CFG_KEY) return;
    cfg = readCfg();
    send('cfg', { cfg: cfg });
    if (cfg.forceOn) send('status', { note: 'forcing ' + (cfg.forceName || cfg.forceId) });
  });

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.__lmStealth !== true || d.from === 'page') return;
    if (d.type === 'cfg') {
      cfg = readCfg();
    } else if (d.type === 'get-catalog') {
      sendCatalog(lastCatalog, lastCatalogSource, true);
      sendDiag();
    } else if (d.type === 'fetch-catalog') {
      fetchCatalogFromRoute();
    } else if (d.type === 'diag') {
      sendDiag();
    } else if (d.type === 'ping') {
      send('ready', { url: window.location.href, alive: true });
    }
  });

  /* ==================================================================== *
   * Catalog extraction (mirrors models-scan.js — the MAIN world cannot
   * reach the isolated world's copy, so the core is repeated here)
   * ==================================================================== */

  function looksLikeModels(arr) {
    if (!arr || !arr.length) return false;
    for (var i = 0; i < Math.min(arr.length, 5); i++) {
      var m = arr[i];
      if (!m || typeof m !== 'object') return false;
      if (typeof m.publicName === 'string' || typeof m.displayName === 'string') return true;
      if (typeof m.id === 'string' && typeof m.userSelectable !== 'undefined') return true;
    }
    return false;
  }

  function matchArray(text, open) {
    var depth = 0, inStr = false, esc = false;
    for (var i = open; i < text.length; i++) {
      var c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function unescapeJs(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c !== '\\') { out += c; continue; }
      var n = s[i + 1];
      if (n === undefined) { out += c; break; }
      if (n === '"') { out += '"'; i++; }
      else if (n === '\\') { out += '\\'; i++; }
      else if (n === 'n') { out += '\n'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'u') {
        var hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; }
        else out += c;
      } else out += c;
    }
    return out;
  }

  function sliceAt(text, open) {
    try {
      var close = matchArray(text, open);
      if (close === -1) return null;
      var parsed = JSON.parse(text.slice(open, close + 1));
      return looksLikeModels(parsed) ? parsed : null;
    } catch (e) { return null; }
  }

  var KEYS = ['initialModels', 'availableModels', 'modelList', 'models'];

  function extractCatalog(text) {
    if (typeof text !== 'string' || text.length < 40) return null;
    if (text.indexOf('publicName') === -1 && text.indexOf('userSelectable') === -1 && text.indexOf('displayName') === -1) return null;

    for (var k = 0; k < KEYS.length; k++) {
      var key = KEYS[k];
      var from = 0;
      for (var guard = 0; guard < 8; guard++) {
        var at = text.indexOf(key, from);
        if (at === -1) break;
        from = at + key.length;
        var open = text.indexOf('[', at + key.length - 1);
        if (open === -1 || open - at > 24) continue;
        var arr = sliceAt(text, open);
        if (arr) return arr;
        var decoded = unescapeJs(text.slice(open, open + MAX_DECODE));
        var o2 = decoded.indexOf('[');
        if (o2 >= 0 && o2 <= 4) {
          arr = sliceAt(decoded, o2);
          if (arr) return arr;
        }
      }
    }
    var trimmed = text.replace(/^\s+/, '');
    if (trimmed.charAt(0) === '[') {
      var a = sliceAt(trimmed, 0);
      if (a) return a;
      var dec = unescapeJs(trimmed.slice(0, MAX_DECODE));
      var o = dec.indexOf('[');
      if (o >= 0 && o <= 4) { a = sliceAt(dec, o); if (a) return a; }
    }
    return null;
  }

  /* ==================================================================== *
   * Catalog delivery to the panel
   * ==================================================================== */

  var lastCatalog = null;
  var lastCatalogSource = '';
  var lastSentCount = -1;
  var lastSentAt = 0;

  var diag = {
    pushes: 0, pushBytes: 0, fetchSeen: 0, inspected: 0, xhrSeen: 0,
    catalogHits: 0, domScans: 0, evalSeen: 0, sources: [], errors: []
  };

  function noteError(where, e) {
    try {
      if (diag.errors.length < 8) diag.errors.push(where + ': ' + ((e && e.message) || e));
    } catch (x) {}
  }

  function sendCatalog(models, source, force) {
    if (!models || !models.length) return;
    var now = Date.now();
    if (!force && models.length === lastSentCount && now - lastSentAt < 30000) return;
    lastSentCount = models.length;
    lastSentAt = now;
    send('catalog', { models: models, count: models.length, source: source || 'unknown' });
  }

  function huntCatalog(text, source) {
    try {
      var found = extractCatalog(text);
      if (!found) return null;
      diag.catalogHits++;
      if (diag.sources.length < 12) diag.sources.push(source + ':' + found.length);
      lastCatalog = found;
      lastCatalogSource = source;
      sendCatalog(found, source, true);
      return found;
    } catch (e) { noteError('hunt', e); return null; }
  }

  function sendDiag() {
    send('diag', {
      diag: diag,
      hasCatalog: !!lastCatalog,
      catalogCount: lastCatalog ? lastCatalog.length : 0,
      catalogSource: lastCatalogSource,
      url: window.location.href
    });
  }

  /* ==================================================================== *
   * 1. Unlocking (escape-aware rewrites of the Flight payload)
   * ==================================================================== */

  function flipAllUserSelectable(text) {
    return text.replace(/(\\?)"userSelectable(\\?)"(\s*:\s*)false/g, function (all, a, b, sep) {
      return a + '"userSelectable' + b + '"' + sep + 'true';
    });
  }

  function killDisableOpus(text) {
    return text.replace(
      /(\\?)"disable-opus(\\?)"(\s*:\s*)(\\?)"disable-opus(\\?)"/g,
      function (all, a, b, sep, c, d) {
        return a + '"disable-opus' + b + '"' + sep + c + '"$undefined' + d + '"';
      }
    );
  }

  function flipOpusScoped(text) {
    var re = /(\\?)"(?:publicName|name|displayName|slug)(\\?)"(\s*:\s*)(\\?)"[^"\\]*opus[^"\\]*(\\?)"[\s\S]{0,600}?(\\?)"userSelectable(\\?)"(\s*:\s*)false/gi;
    return text.replace(re, function (all) {
      return all.replace(/(\\?)"userSelectable(\\?)"(\s*:\s*)false$/, function (m, r1, r2, r3) {
        return r1 + '"userSelectable' + r2 + '"' + r3 + 'true';
      });
    });
  }

  var unlockStats = { lastCount: 0, total: 0, patched: 0 };

  function patchFlight(text) {
    if (typeof text !== 'string' || text.length < 40) return text;
    if (cfg.e === false) return text;
    if (text.indexOf('userSelectable') === -1 && text.indexOf('disable-opus') === -1) return text;
    var out = text;
    var before = (out.match(/(\\?)"userSelectable(\\?)"(\s*:\s*)false/g) || []).length;
    try {
      if (cfg.o) out = killDisableOpus(out);
      if (cfg.o) out = flipOpusScoped(out);
      if (cfg.h) out = flipAllUserSelectable(out);
      var after = (out.match(/(\\?)"userSelectable(\\?)"(\s*:\s*)false/g) || []).length;
      if (after !== before) {
        unlockStats.lastCount = before - after;
        unlockStats.total += unlockStats.lastCount;
        unlockStats.patched++;
        send('unlocked', { now: unlockStats.lastCount, total: unlockStats.total, chunks: unlockStats.patched });
      }
    } catch (e) { noteError('patch', e); }
    return out;
  }

  /* ==================================================================== *
   * __next_f: the inline Flight chunks React uses to hydrate.
   * The pushed strings are also accumulated here, because RSC splits a payload
   * across pushes and only the decoded concatenation contains the catalog.
   * ==================================================================== */
  var pushBuf = '';
  var huntScheduled = false;
  var huntRuns = 0;

  // Pushes arrive in bursts; scanning the whole buffer on each one would be
  // wasteful, so coalesce them into at most one attempt every 40 ms.
  function scheduleHunt() {
    if (huntScheduled || lastCatalog) return;
    huntScheduled = true;
    setTimeout(function () {
      huntScheduled = false;
      if (lastCatalog) return;
      huntRuns++;
      if (huntRuns > 400) return;
      huntCatalog(pushBuf, 'next_f');
    }, 40);
  }

  function installNextF() {
    var push = Array.prototype.push;

    function mapArgs(args) {
      for (var i = 0; i < args.length; i++) {
        if (Array.isArray(args[i])) {
          for (var j = 1; j < args[i].length; j++) {
            if (typeof args[i][j] === 'string') args[i][j] = patchFlight(args[i][j]);
          }
        }
      }
      return args;
    }

    function harvest(args) {
      for (var i = 0; i < args.length; i++) {
        if (!Array.isArray(args[i])) continue;
        for (var j = 1; j < args[i].length; j++) {
          var s = args[i][j];
          if (typeof s !== 'string' || !s.length) continue;
          diag.pushes++;
          diag.pushBytes += s.length;
          if (pushBuf.length < MAX_BUF) pushBuf += s;
        }
      }
      // cheap check on the newest chunk only; hashing 16 MB per push is not free
      for (var n = 0; n < args.length; n++) {
        if (!Array.isArray(args[n])) continue;
        for (var q = 1; q < args[n].length; q++) {
          var str = args[n][q];
          if (typeof str === 'string' && (str.indexOf('publicName') !== -1 || str.indexOf('displayName') !== -1 || str.indexOf('initialModels') !== -1)) {
            scheduleHunt();
            return;
          }
        }
      }
    }

    function patchedPush() {
      harvest(arguments);
      return push.apply(this, mapArgs(arguments));
    }
    try { patchedPush.length = push.length; } catch (e) {}

    function prime(arr) {
      if (!Array.isArray(arr)) return arr;
      for (var i = 0; i < arr.length; i++) {
        if (Array.isArray(arr[i])) {
          for (var j = 1; j < arr[i].length; j++) {
            if (typeof arr[i][j] === 'string') arr[i][j] = patchFlight(arr[i][j]);
          }
        }
      }
      try { arr.push = patchedPush; } catch (e) {}
      return arr;
    }

    var real = window.__next_f;
    try {
      Object.defineProperty(window, '__next_f', {
        configurable: true,
        enumerable: true,
        get: function () { return real; },
        set: function (v) { real = prime(v); }
      });
    } catch (e) {
      var t = setInterval(function () {
        if (window.__next_f && window.__next_f.push !== patchedPush) {
          prime(window.__next_f);
          clearInterval(t);
        }
      }, 2);
      setTimeout(function () { clearInterval(t); }, 15000);
    }
    if (real) {
      prime(real);
      harvest(real);
    }
    // whatever was already in the DOM before we got here
    setTimeout(sweepDom, 0);
  }

  /* ==================================================================== *
   * 2. Stealth select: rewrite the outgoing evaluation request
   * ==================================================================== */

  function pickModelId() {
    return cfg.forceOn && cfg.forceId ? String(cfg.forceId) : '';
  }

  function rewriteEvalBody(json, modelId) {
    var body;
    try { body = JSON.parse(json); } catch (e) { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    var touched = false;
    if (typeof body.modelAId === 'string' || !('modelAId' in body)) { body.modelAId = modelId; touched = true; }
    if ('model_a' in body) { body.model_a = modelId; touched = true; }
    if ('modelId' in body) { body.modelId = modelId; touched = true; }
    return touched ? JSON.stringify(body) : null;
  }

  function unframe(body) {
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return null;
    var bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (bytes.length < 5) return null;
    var len = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
    if (len === 0 || 5 + len > bytes.length) return null;
    return { type: bytes[0], json: new TextDecoder().decode(bytes.subarray(5, 5 + len)), rest: bytes.subarray(5 + len) };
  }

  function frame(t, payload, rest) {
    var out = new Uint8Array(5 + payload.length + rest.length);
    out[0] = t;
    new DataView(out.buffer).setUint32(1, payload.length);
    out.set(payload, 5);
    out.set(rest, 5 + payload.length);
    return out;
  }

  function rewriteBody(body, modelId) {
    try {
      if (typeof body === 'string') {
        var out = rewriteEvalBody(body, modelId);
        if (out) { send('sent', { modelId: modelId }); return out; }
        return body;
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        if (!body.has('modelAId') && !body.has('model_a')) return body;
        body.set('modelAId', modelId);
        send('sent', { modelId: modelId });
        return body;
      }
      var parts = unframe(body);
      if (parts) {
        var rewritten = rewriteEvalBody(parts.json, modelId);
        if (!rewritten) return body;
        send('sent', { modelId: modelId });
        return frame(parts.type, new TextEncoder().encode(rewritten), parts.rest);
      }
    } catch (e) { noteError('rewriteBody', e); }
    return body;
  }

  /* ==================================================================== *
   * 3. Response handling: routed_model tap + catalog hunting
   * ==================================================================== */

  function scanStreamLine(line) {
    if (!line) return;
    var i = line.indexOf('routed_model');
    if (i === -1) return;
    var start = line.lastIndexOf('{', i);
    if (start === -1) return;
    var depth = 0, end = -1;
    for (var k = start; k < line.length; k++) {
      if (line[k] === '{') depth++;
      else if (line[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end === -1) return;
    try {
      var obj = JSON.parse(line.slice(start, end + 1));
      send('routed', {
        org: obj.organization || obj.org || '',
        name: obj.publicName || obj.name || obj.model || obj.modelId || '',
        raw: obj
      });
    } catch (e) {}
  }

  function tapEvalStream(res) {
    try {
      if (!res || !res.body || typeof res.body.tee !== 'function') return res;
      var tee = res.body.tee();
      var reader = tee[1].getReader();
      var dec = new TextDecoder();
      var buf = '';
      (function pump() {
        reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) scanStreamLine(lines[i]);
          pump();
        }).catch(function () {});
      })();
      return new Response(tee[0], { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) { return res; }
  }

  function contentTypeOf(res) {
    try { return (res && res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch (e) { return ''; }
  }

  // Should this response be read (and possibly rewritten)?
  function inspectable(res, url) {
    if (cfg.e === false || !res || res.body === null) return false;
    if (typeof res.clone !== 'function') return false;
    var ct = contentTypeOf(res);
    if (ct.indexOf('event-stream') !== -1) return false;             // the answer stream
    if (ct.indexOf('image') !== -1 || ct.indexOf('video') !== -1) return false;
    var ok = ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1 ||
             ct.indexOf('x-component') !== -1 || ct === '';
    if (!ok) return false;
    return url.indexOf('/_next/') === -1 || ct.indexOf('x-component') !== -1;
  }

  /* Read a response once: hunt for the catalog, rewrite the payload if it carries
   * hidden flags, and hand back a usable Response either way. */
  function inspectResponse(res, url) {
    if (!inspectable(res, url)) return null;
    diag.inspected++;
    return res.clone().text().then(function (text) {
      if (typeof text !== 'string' || text.length < 40) return res;
      var found = null;
      if (text.indexOf('publicName') !== -1 || text.indexOf('displayName') !== -1 || text.indexOf('initialModels') !== -1) {
        found = huntCatalog(text, 'fetch:' + shortUrl(url));
      }
      var patched = text;
      if (text.indexOf('userSelectable') !== -1 || text.indexOf('disable-opus') !== -1) {
        patched = patchFlight(text);
      }
      if (patched === text) return res;
      return new Response(patched, { status: res.status, statusText: res.statusText, headers: res.headers });
    }).catch(function (e) { noteError('inspect', e); return res; });
  }

  function shortUrl(u) {
    try {
      var x = String(u).replace(/^https?:\/\/[^/]+/, '');
      return x.split('?')[0].slice(0, 60) || '/';
    } catch (e) { return String(u).slice(0, 40); }
  }

  /* ==================================================================== *
   * fetch / XHR hooks
   * ==================================================================== */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && (input.url || String(input))) || '';
        if (url && url.charAt(0) === '/') url = window.location.origin + url;
      } catch (e) {}

      var isEval = EVAL_RE.test(url);
      if (isEval) diag.evalSeen++;

      try {
        var modelId = pickModelId();
        if (init && init.body !== undefined && init.body !== null) {
          if (modelId && isEval) {
            var newBody = rewriteBody(init.body, modelId);
            return nativeFetch.call(this, input, Object.assign({}, init, { body: newBody }))
              .then(function (res) { return tapEvalStream(res); });
          }
        } else if (input && typeof Request !== 'undefined' && input instanceof Request && modelId && isEval) {
          var req = input;
          return req.clone().text().then(function (text) {
            return nativeFetch.call(this, new Request(req, { body: rewriteEvalBody(text, modelId) || text }), init);
          }.bind(this)).then(function (res) { return tapEvalStream(res); });
        }
      } catch (e) { noteError('fetchRewrite', e); }

      var out = nativeFetch.apply(this, arguments);
      if (!out || typeof out.then !== 'function') return out;
      return out.then(function (res) {
        try {
          diag.fetchSeen++;
          if (isEval) { diag.evalSeen++; return tapEvalStream(res); }
          var inspected = inspectResponse(res, url);
          if (inspected) return inspected.then(function (r) { return r; }, function () { return res; });
          return res;
        } catch (e) { return res; }
      });
    };
    try { window.fetch.toString = nativeFetch.toString.bind(nativeFetch); } catch (e) {}
  }

  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var XO = XHR.prototype.open;
    var XS = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__lmUrl = String(url); } catch (e) {}
      return XO.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      var url = '';
      try { url = String(this.__lmUrl || ''); if (url && url.charAt(0) === '/') url = window.location.origin + url; } catch (e) {}
      var self = this;
      try {
        if (!this.__lmLoadHooked) {
          this.__lmLoadHooked = true;
          this.addEventListener('load', function () {
            try {
              diag.xhrSeen++;
              var rt = self.responseType;
              if (rt && rt !== 'text' && rt !== 'json' && rt !== '') return;
              var txt = self.responseType === 'json' ? (self.response && JSON.stringify(self.response)) : self.responseText;
              if (typeof txt !== 'string' || txt.length < 40) return;
              if (txt.indexOf('publicName') !== -1 || txt.indexOf('displayName') !== -1 || txt.indexOf('initialModels') !== -1) {
                huntCatalog(txt, 'xhr:' + shortUrl(url));
              }
            } catch (e) { noteError('xhr', e); }
          });
        }
      } catch (e) {}

      try {
        var modelId = pickModelId();
        if (modelId && url && EVAL_RE.test(url) && body) body = rewriteBody(body, modelId);
      } catch (e) {}
      return XS.call(this, body);
    };
  }

  /* ==================================================================== *
   * Fallbacks: sweep the DOM, and ask the route for its own flight payload
   * ==================================================================== */

  function sweepDom() {
    try {
      diag.domScans++;
      if (!doc || !doc.querySelectorAll) return;
      var scripts = doc.querySelectorAll('script');
      var joined = '';
      for (var i = 0; i < scripts.length; i++) {
        var txt = scripts[i].textContent || '';
        if (txt.indexOf('publicName') === -1 && txt.indexOf('displayName') === -1 && txt.indexOf('initialModels') === -1) continue;
        joined += '\n' + txt;
        if (joined.length > MAX_BUF) break;
      }
      if (joined && huntCatalog(joined, 'dom')) return;
      if (lastCatalog) return;
      var html = doc.documentElement && doc.documentElement.outerHTML;
      if (html && (html.indexOf('publicName') !== -1 || html.indexOf('initialModels') !== -1)) {
        huntCatalog(html, 'dom-html');
      }
    } catch (e) { noteError('sweep', e); }
  }

  var routeFetchTried = false;
  /* Next's RSC endpoint is the same URL with an RSC header, so the page can ask
   * for its own flight payload — which is where the catalog normally lives. */
  function fetchCatalogFromRoute() {
    if (routeFetchTried) return;
    routeFetchTried = true;
    try {
      nativeFetch.call(window, window.location.href, {
        headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
        credentials: 'include'
      }).then(function (res) {
        diag.fetchSeen++;
        try { return res.clone().text(); } catch (e) { return ''; }
      }).then(function (text) {
        if (typeof text === 'string' && text.length > 40) huntCatalog(text, 'route-rsc');
      }).catch(function (e) { noteError('routeFetch', e); });
    } catch (e) { noteError('routeFetch', e); }
  }

  installNextF();

  // If nothing showed up inline, pull it, then keep sweeping for late hydration.
  setTimeout(function () {
    if (!lastCatalog) fetchCatalogFromRoute();
    sweepDom();
  }, 1200);
  var sweeps = 0;
  var sweepTimer = setInterval(function () {
    sweeps++;
    if (lastCatalog) { clearInterval(sweepTimer); return; }   // done, stop working
    sweepDom();
    if (sweeps === 5) fetchCatalogFromRoute();
    if (sweeps >= 20) clearInterval(sweepTimer);
  }, 1500);
  try {
    if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sweepDom);
  } catch (e) {}

  send('ready', { url: window.location.href });
})();