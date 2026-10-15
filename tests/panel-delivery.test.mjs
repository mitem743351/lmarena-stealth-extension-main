/* ============================================================================
 * Regression for the "0 models" report.
 * ----------------------------------------------------------------------------
 * This runs the real main.js (page world) and the real content.js (panel) in one
 * jsdom page where NOTHING is inlined, exactly like a live arena.ai tab that
 * hydrates client-side. The catalog only ever arrives over the network, and the
 * panel must still fill up.
 * ========================================================================== */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(repo, 'tests/fixtures/arena-catalog.real.json'), 'utf8'));
const hiddenCount = catalog.filter((m) => m.userSelectable === false).length;

let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

const flightText = () => JSON.stringify({ initialModels: catalog, initialModelAId: catalog[0].id });

function makeResponse(bodyText, ct = 'text/x-component') {
  const res = {
    status: 200, statusText: 'OK', body: {},
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    clone: () => ({ text: () => Promise.resolve(bodyText) }),
    text: () => Promise.resolve(bodyText),
  };
  return res;
}

/* Build a page whose world contains main.js + content.js, with a controllable network. */
async function bootPage({ inlineHtml = '', routeFetch = true, xhrCatalog = false, cfg = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root"></div>${inlineHtml}</body></html>`,
    { url: 'https://arena.ai/text/direct', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const w = dom.window;

  const requests = [];
  const store = new Map([['lm_stealth_cfg', JSON.stringify({ e: true, o: true, h: true, forceOn: false, forceId: '', forceName: '', ...cfg })]]);

  // page world needs a Response constructor
  w.Response = class { constructor(b, i) { this._b = b; this.body = {}; Object.assign(this, i); } };
  w.localStorage; // jsdom provides it
  w.localStorage.setItem('lm_stealth_cfg', store.get('lm_stealth_cfg'));

  w.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isRoute = init && init.headers && (init.headers.RSC || init.headers['Next-Router-Prefetch']);
    requests.push({ url, isRoute: !!isRoute });
    if (isRoute) {
      if (!routeFetch) return Promise.resolve(makeResponse('', 'text/plain'));
      return Promise.resolve(makeResponse(flightText()));
    }
    // a normal RSC navigation response — this is where a live tab gets models
    return Promise.resolve(makeResponse(flightText()));
  };

  // XHR stub that carries the catalog, to exercise that path too
  if (xhrCatalog) {
    w.XMLHttpRequest = class {
      constructor() { this._l = {}; this.responseType = ''; this.responseText = ''; }
      open(m, u) { this._u = u; }
      addEventListener(t, fn) { this._l[t] = fn; }
      send() {
        this.responseText = flightText();
        this.status = 200;
        setTimeout(() => this._l.load && this._l.load.call(this), 0);
      }
    };
  }

  // chrome API stub for the panel
  w.chrome = {
    storage: {
      sync: { get: (d, cb) => cb({ e: true, o: true, h: true, forceOn: false, forceId: '', forceName: '' }), set: () => {} },
      local: { get: (_k, cb) => cb({}), set: () => {}, remove: () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: { sendMessage: () => {} },
  };
  w.navigator.clipboard = { writeText: () => Promise.resolve() };
  w.open = () => null;

  // page hook first (as at document_start), then the panel
  w.eval(readFileSync(join(repo, 'main.js'), 'utf8'));
  for (const f of ['model-utils.js', 'models-scan.js', 'content.js']) w.eval(readFileSync(join(repo, f), 'utf8'));

  await new Promise((r) => setTimeout(r, 120));
  return { w, requests, doc: w.document };
}

const statusOf = (doc) => doc.getElementById('lm-status').textContent;
const rowsOf = (doc) => doc.querySelectorAll('.lm-row').length;

/* ---------- 1. nothing inline: catalog only over fetch, as on a real tab ---------- */
{
  const { w, doc } = await bootPage();
  // a hydration fetch for models, the way the app itself would do it
  await w.fetch('/text/direct?_rsc=abc', { headers: { RSC: '1' } });
  await new Promise((r) => setTimeout(r, 250));
  check('fetch-only page: panel fills up', /1066 models/.test(statusOf(doc)), statusOf(doc));
  check('fetch-only page: hidden flags preserved', /126 hidden/.test(statusOf(doc)), statusOf(doc));
  check('fetch-only page: hidden rows listed', rowsOf(doc) === hiddenCount, `${rowsOf(doc)} rows`);
}

/* ---------- 2. the page itself asks for its route payload ---------- */
{
  const { w, doc } = await bootPage();
  // press "Get catalog" in the empty state
  const getBtn = [...doc.querySelectorAll('#lm-list button')].find((b) => /Get catalog/.test(b.textContent));
  check('empty state offers a recovery button', !!getBtn);
  if (getBtn) getBtn.click();
  await new Promise((r) => setTimeout(r, 300));
  check('recovery button pulls the catalog', /1066 models/.test(statusOf(doc)), statusOf(doc));
  const rsc = (await Promise.resolve(w.__lmRequests), 0);
  void rsc;
}

/* ---------- 3. catalog arriving over XHR ---------- */
{
  const { doc } = await bootPage({ xhrCatalog: true });
  const xhr = new doc.defaultView.XMLHttpRequest();
  xhr.open('GET', '/nextjs-api/models');
  xhr.send();
  await new Promise((r) => setTimeout(r, 250));
  check('xhr path delivers the catalog', /1066 models/.test(statusOf(doc)), statusOf(doc));
}

/* ---------- 4. hidden flags survive an already-patched wire copy ---------- */
{
  const patched = JSON.stringify({ initialModels: catalog.map((m) => ({ ...m, userSelectable: true })) });
  const { w, doc } = await bootPage();
  // first the honest copy (126 hidden), then a copy where everything reads true
  w.postMessage; // no-op, keeps lint quiet
  await new Promise((r) => setTimeout(r, 50));
  const w2 = w;
  w2.fetch = undefined;
  const res = makeResponse(JSON.stringify({ initialModels: catalog }));
  void res;
  // simulate the hook seeing the honest payload, then the patched one later
  w2.postMessage({ __lmStealth: true, from: 'page', type: 'catalog', models: catalog, count: catalog.length, source: 'test' }, '*');
  await new Promise((r) => setTimeout(r, 120));
  w2.postMessage({ __lmStealth: true, from: 'page', type: 'catalog', models: JSON.parse(patched).initialModels, count: catalog.length, source: 'test-patched' }, '*');
  await new Promise((r) => setTimeout(r, 120));
  check('merge keeps 1066 models after a patched copy', /1066 models/.test(statusOf(doc)), statusOf(doc));
  check('merge does not lose the hidden flags', /126 hidden/.test(statusOf(doc)), statusOf(doc));
}

/* ---------- 5. diagnostic surface exists for the "still 0" case ---------- */
{
  const { doc } = await bootPage({ routeFetch: false });
  const empty = doc.querySelector('.lm-empty');
  check('empty state explains itself', !!empty && /No catalog yet/.test(empty.textContent), empty && empty.textContent.slice(0, 60));
  const copyBtn = [...doc.querySelectorAll('#lm-list button')].find((b) => /Copy report/.test(b.textContent));
  check('empty state offers a report copy', !!copyBtn);
  copyBtn && copyBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  const diag = doc.getElementById('lm-diag');
  check('diag line is present', !!diag, diag && diag.className);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DELIVERY TESTS PASSED');
process.exit(failures ? 1 : 0);
