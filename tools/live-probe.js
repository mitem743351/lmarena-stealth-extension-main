/* ============================================================================
 * LMArena Stealth — live probe
 * ----------------------------------------------------------------------------
 * Paste this whole file into the DevTools console on an arena.ai tab (while
 * logged in) and read the report. Read-only: it never sends a request, never
 * reads your chat text, and never touches your cookies.
 *
 * It answers the four questions a static test cannot:
 *   1. What did the server actually send — how many models, how many hidden?
 *   2. Did the page-world hook rewrite them before the app parsed them?
 *   3. Which field does the live evaluation request carry the model in?
 *   4. Did a real message actually run the model you picked?
 * ========================================================================== */
(async () => {
  const log = (...a) => console.log('%c[stealth]', 'color:#a78bfa;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[stealth]', 'color:#fbbf24;font-weight:bold', ...a);
  const ok = (...a) => console.log('%c[stealth]', 'color:#34d399;font-weight:bold', ...a);

  log('probing', location.href);

  /* ---------- 1. what the server sent (raw, pre-patch) ---------- */
  const scripts = [...document.querySelectorAll('script')];
  const flight = scripts.map((s) => {
    const m = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/.exec(s.textContent || '');
    try { return m ? String(JSON.parse(m[1])) : ''; } catch { return ''; }
  }).join('');

  let raw = null;
  const start = flight.indexOf('"initialModels":[');
  if (start >= 0) {
    const from = flight.indexOf('[', start);
    let depth = 0;
    for (let i = from; i < flight.length; i++) {
      if (flight[i] === '[') depth++;
      else if (flight[i] === ']' && --depth === 0) { raw = flight.slice(from, i + 1); break; }
    }
  }

  let models = [];
  if (raw) { try { models = JSON.parse(raw); } catch (e) { warn('catalog found but did not parse:', e.message); } }

  if (!models.length) {
    warn('no initialModels in this page. Open https://arena.ai/ (home) or a /text/direct page and reload once the extension is installed.');
  } else {
    const hidden = models.filter((m) => m.userSelectable === false);
    ok(`catalog: ${models.length} models, ${hidden.length} hidden  (this is what the SERVER sent)`);
    const sample = (list) => list.slice(0, 5).map((m) => `${m.publicName} [${m.organization || '?'}]`).join(', ');
    if (hidden.length) log('hidden sample:', sample(hidden));
    log('first entry keys:', Object.keys(models[0]).join(', '));
    log('capability keys:', [...new Set(models.flatMap((m) => Object.keys((m.capabilities || {}).outputCapabilities || {})))].join(', '));
  }

  /* ---------- 2. did the hook rewrite it before the app parsed it? ---------- */
  const cfg = (() => { try { return JSON.parse(localStorage.getItem('lm_stealth_cfg') || '{}'); } catch { return {}; } })();
  const installed = !!document.getElementById('lm-stealth-btn');
  log('extension installed:', installed ? 'yes' : 'NO — load the unpacked folder in chrome://extensions');
  log('config mirror:', JSON.stringify(cfg));

  if (installed) {
    const panelBadge = document.getElementById('lm-count');
    log('panel reports hidden count:', panelBadge ? panelBadge.textContent : '(panel not opened yet)');
    if (models.length) {
      // the panel counts what the app ended up with; the raw scan counts what arrived
      const stillHidden = models.filter((m) => m.userSelectable === false).length;
      if (cfg.h && stillHidden > 0) {
        warn(`hook did NOT flip all hidden flags on this page (${stillHidden} still false).`);
        warn('The inline payload was probably fetched after hydration, or Arena changed the shape. Run: copy(document.documentElement.outerHTML.length) and report it.');
      } else if (cfg.h) {
        ok('hook flipped every hidden flag in the inline payload');
      }
    }
  }

  /* ---------- 3. watch the NEXT evaluation request ---------- */
  const EVAL = /\/nextjs-api\/stream\/(?:create|post-to)-evaluation/;
  const orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (EVAL.test(url) && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        const keys = Object.keys(body);
        log('evaluation request body keys:', keys.join(', '));
        const idKey = keys.find((k) => /model/i.test(k) && typeof body[k] === 'string');
        if (idKey) {
          ok(`model carried in "${idKey}" = ${String(body[idKey]).slice(0, 14)}…`);
          window.__stealthLastModelKey = idKey;
          window.__stealthLastModelId = body[idKey];
        }
        const meta = models.find((m) => m.id === (idKey && body[idKey]));
        if (meta) log('resolved to:', meta.publicName, '| hidden:', meta.userSelectable === false);
      }
    } catch (e) { /* not json, or not the body we care about */ }
    const out = orig.apply(this, arguments);
    return out.then((res) => {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (EVAL.test(url) && res.body) {
          const [a, b] = res.body.tee();
          const rd = b.getReader(); const dec = new TextDecoder(); let buf = '';
          (function pump() {
            rd.read().then(({ done, value }) => {
              if (done) return;
              buf += dec.decode(value, { stream: true });
              const lines = buf.split('\n'); buf = lines.pop() || '';
              for (const line of lines) {
                if (!line.includes('routed_model')) continue;
                const at = line.lastIndexOf('{', line.indexOf('routed_model'));
                if (at < 0) continue;
                let d = 0, end = -1;
                for (let i = at; i < line.length; i++) { if (line[i] === '{') d++; else if (line[i] === '}' && --d === 0) { end = i; break; } }
                if (end < 0) continue;
                try { ok('MODEL THAT RAN:', JSON.parse(line.slice(at, end + 1))); } catch {}
              }
              pump();
            }).catch(() => {});
          })();
          return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch {}
      return res;
    });
  };
  ok('fetch watcher armed — now send any message on this page.');
  log('You will see the model field name, the id sent, and the model that actually ran.');

  /* ---------- 4. ask the extension's page hook what it has seen ---------- */
  const hookReply = new Promise((resolve) => {
    const onMsg = (ev) => {
      const d = ev.data;
      if (!d || d.__lmStealth !== true || d.from !== 'page') return;
      if (d.type === 'diag' || d.type === 'catalog') resolve(d);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ __lmStealth: true, from: 'panel', type: 'diag' }, '*');
    window.postMessage({ __lmStealth: true, from: 'panel', type: 'get-catalog' }, '*');
    setTimeout(() => resolve(null), 1500);
  });
  const reply = await hookReply;
  if (!reply) {
    warn('the extension page hook did not answer. Either it was loaded after this page');
    warn('was opened, or the extension is not installed. Reload the tab and re-run.');
  } else if (reply.type === 'diag') {
    const d = reply.diag || {};
    log('hook diagnostics:', JSON.stringify(d));
    ok(`hook captured ${reply.catalogCount || 0} models` + (reply.catalogSource ? ` (via ${reply.catalogSource})` : ''));
    if (!reply.catalogCount) {
      warn('the hook has not seen a catalog either. Report the diagnostics line above.');
    }
  } else if (reply.type === 'catalog') {
    ok(`hook delivered ${reply.count} models via ${reply.source}`);
  }

  /* ---------- 5. quick deep-link check without sending anything ---------- */
  if (models.length) {
    const hidden = models.filter((m) => m.userSelectable === false);
    const pick = hidden[0] || models[0];
    if (pick) {
      log('suggested deep link for a real hidden model:');
      console.log(`https://arena.ai${location.pathname.startsWith('/code') ? '/code' : '/text'}/direct?model_a=${encodeURIComponent(String(pick.publicName).toLowerCase())}`,
        '   <-', pick.publicName, `(hidden=${pick.userSelectable === false})`);
      log('compare with the raw-id form:');
      console.log(`https://arena.ai/text/direct?model_a=${encodeURIComponent(pick.id)}`);
    }
  }

  log('done — nothing was sent, no cookies read.');
})();
