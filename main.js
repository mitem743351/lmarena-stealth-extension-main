/* ============================================================================
 * LMArena Stealth — page-world (MAIN) hook
 * ----------------------------------------------------------------------------
 * Runs at document_start in the page's own JS context, BEFORE any Arena script,
 * so it can intercept the model catalog and the evaluation requests.
 *
 * Three jobs:
 *  1. Unlock the catalog: Arena hides models by shipping them with
 *     "userSelectable": false inside the React Flight (RSC) payload, plus an
 *     Opus kill-switch flag. We rewrite those payloads on the fly, both the
 *     inline  self.__next_f.push([1,"..."])  chunks and later RSC fetches.
 *  2. Stealth select: rewrite the outgoing evaluation request body so
 *     `modelAId` is whatever hidden model you picked, even when the UI would
 *     never let you choose it.
 *  3. Report back: how many models were unlocked and which model actually ran
 *     (from the `a2:{"type":"routed_model",...}` event in the answer stream).
 *
 * Config is shared with the isolated-world scripts through localStorage (same
 * origin, so both worlds see it) — no inline <script> injection, which strict
 * CSP would block.
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
  var RSC_RE = /_rsc=|text\/x-component|application\/json|\/nextjs-api\//i;

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
    if (!d || d.__lmStealth !== true) return;
    if (d.from === 'page') return; // our own echo
    if (d.type === 'cfg') {
      cfg = readCfg();
    }
  });

  /* ------------------------------------------------------------------ *
   * 1. Catalog unlocking (escape-aware rewrites of the Flight payload)
   * ------------------------------------------------------------------ */

  function flipAllUserSelectable(text) {
    // matches  "userSelectable":false  and  \"userSelectable\":false
    return text.replace(/(\\?)"userSelectable(\\?)"(\s*:\s*)false/g, function (all, a, b, sep) {
      return a + '"userSelectable' + b + '"' + sep + 'true';
    });
  }

  function killDisableOpus(text) {
    // the kill-switch is a flag entry whose name AND value are "disable-opus";
    // RSC's own convention for "no value" is the $undefined marker.
    return text.replace(
      /(\\?)"disable-opus(\\?)"(\s*:\s*)(\\?)"disable-opus(\\?)"/g,
      function (all, a, b, sep, c, d) {
        return a + '"disable-opus' + b + '"' + sep + c + '"$undefined' + d + '"';
      }
    );
  }

  function flipOpusScoped(text) {
    // only entries whose name mentions opus, and only within a 600-char window
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
    } catch (e) {}
    return out;
  }

  /* ------------------------------------------------------------------ *
   * __next_f: the inline Flight chunks React uses to hydrate
   * ------------------------------------------------------------------ */
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

    function patchedPush() {
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
      // defineProperty refused: fall back to a poller
      var t = setInterval(function () {
        if (window.__next_f && window.__next_f.push !== patchedPush) {
          prime(window.__next_f);
          clearInterval(t);
        }
      }, 2);
      setTimeout(function () { clearInterval(t); }, 15000);
    }
    if (real) prime(real);
  }

  installNextF();

  /* ------------------------------------------------------------------ *
   * 2. Stealth select: rewrite the outgoing evaluation request
   * ------------------------------------------------------------------ */

  function pickModelId() {
    return cfg.forceOn && cfg.forceId ? String(cfg.forceId) : '';
  }

  function rewriteEvalBody(json, modelId) {
    var body;
    try { body = JSON.parse(json); } catch (e) { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    var touched = false;
    // Arena's verified field for the chosen model on both stream endpoints.
    if (typeof body.modelAId === 'string' || !('modelAId' in body)) { body.modelAId = modelId; touched = true; }
    if ('model_a' in body) { body.model_a = modelId; touched = true; }
    if ('modelId' in body) { body.modelId = modelId; touched = true; }
    return touched ? JSON.stringify(body) : null;
  }

  // Next's "single fetch" framing: 1 type byte + 4-byte big-endian length + JSON + rest
  function unframe(body) {
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return null;
    var bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (bytes.length < 5) return null;
    var len = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
    if (len === 0 || 5 + len > bytes.length) return null;
    return {
      type: bytes[0],
      json: new TextDecoder().decode(bytes.subarray(5, 5 + len)),
      rest: bytes.subarray(5 + len)
    };
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
    } catch (e) {}
    return body;
  }

  /* ------------------------------------------------------------------ *
   * 3. Response taps: which model actually answered?
   * ------------------------------------------------------------------ */

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

  function tapResponse(res, url) {
    try {
      if (!res || !res.body || cfg.e === false) return res;
      if (!EVAL_RE.test(url)) return res;
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
    } catch (e) {
      return res;
    }
  }

  /* ------------------------------------------------------------------ *
   * fetch / XHR hooks
   * ------------------------------------------------------------------ */
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && (input.url || String(input))) || '';
        if (url && url.charAt(0) === '/') url = window.location.origin + url;
      } catch (e) {}
      try {
        var modelId = pickModelId();
        if (init && init.body !== undefined && init.body !== null) {
          if (modelId && EVAL_RE.test(url)) {
            // must pass the rewritten init on, not the original arguments
            var newBody = rewriteBody(init.body, modelId);
            return nativeFetch.call(this, input, Object.assign({}, init, { body: newBody }))
              .then(function (res) { return tapResponse(res, url); });
          }
        } else if (input && typeof Request !== 'undefined' && input instanceof Request && modelId && EVAL_RE.test(url)) {
          // body lives inside the Request; re-read it once and hand fetch a fresh Request
          var req = input;
          return req.clone().text().then(function (text) {
            return nativeFetch.call(this, new Request(req, { body: rewriteEvalBody(text, modelId) || text }), init);
          }.bind(this)).then(function (res) { return tapResponse(res, url); });
        }
      } catch (e) {}
      var out = nativeFetch.apply(this, arguments);
      return out.then(function (res) {
        try { return tapResponse(res, url); } catch (e) { return res; }
      });
    };
    try { window.fetch.toString = nativeFetch.toString.bind(nativeFetch); } catch (e) {}
  }

  // RSC prefetch and some uploads still use XHR — cover the body rewrite there too.
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
      try {
        var modelId = pickModelId();
        if (modelId && url && EVAL_RE.test(url) && body) body = rewriteBody(body, modelId);
      } catch (e) {}
      return XS.call(this, body);
    };
  }

  try { send('ready', { url: window.location.href }); } catch (e) {}
})();