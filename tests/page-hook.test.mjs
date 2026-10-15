/* Full harness: exercising main.js exactly as it runs in the page world. */
import { readFileSync } from 'fs';
import vm from 'vm';
import { JSDOM } from 'jsdom';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeDoc() {
  const d = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://arena.ai/text/direct' });
  return d.window.document;
}

function makeSandbox(cfg, fetchImpl) {
  const store = new Map();
  const listeners = {};
  const win = {
    location: { href: 'https://arena.ai/text/direct', origin: 'https://arena.ai' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage(msg) { posts.push(msg); (listeners.message || []).forEach((f) => f({ data: msg, source: win })); },
    fetch: fetchImpl,
    XMLHttpRequest: function () {},
  };
  win.XMLHttpRequest.prototype = { open() {}, send() {} };
  const posts = [];
  win.document = makeDoc();
  const sandbox = {
    window: win, self: win, console, URL, URLSearchParams, TextDecoder, TextEncoder,
    Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
    Request: class { constructor(i, o) { this.url = typeof i === 'string' ? i : i.url; this._body = o && o.body; } clone() { return this; } text() { return Promise.resolve(this._body || ''); } },
    ArrayBuffer, DataView, Uint8Array, Object, JSON, Array, String, Number, Math, Date,
    setTimeout, clearInterval, setInterval, Promise, RegExp, Error,
  };
  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  if (cfg) store.set('lm_stealth_cfg', JSON.stringify(cfg));
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(repo + '/main.js', 'utf8'), sandbox);
  return { sandbox, win: sandbox.window, posts, store };
}

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

/* ---------- 1. Flight payload unlocking ---------- */
{
  const models = [
    { id: 'aaa-1', publicName: 'claude-opus-4-6', organization: 'Anthropic', userSelectable: false, capabilities: { outputCapabilities: { text: true } } },
    { id: 'bbb-2', publicName: 'pteronura', organization: 'Anonymous', userSelectable: false },
    { id: 'ccc-3', publicName: 'gpt-6-sol', organization: 'OpenAI', userSelectable: true },
  ];
  const inner = JSON.stringify({ initialModels: models, disableOpus: 'disable-opus', flags: { 'disable-opus': 'disable-opus' } });
  const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const { win, posts } = makeSandbox({ e: true, o: true, h: true }, () => Promise.resolve(new Response(null, {})));
  win.__next_f = [];
  win.__next_f.push([1, escaped]);
  const out = win.__next_f[0][1];

  const stillHidden = (out.match(/userSelectable\\?":\s*false/g) || []).length;
  check('flight: no hidden models left', stillHidden === 0, `(${stillHidden} left)`);
  check('flight: json still parses after rewrite', (() => {
    try { JSON.parse(out.split('\\"').join('"')); return true; } catch { return false; }
  })());
  check('flight: disable-opus value neutralised', !/disable-opus\\?"\s*:\s*\\?"disable-opus/.test(out), out.match(/disable-opus[^\]]{0,60}/)?.[0] || '');
  const unlocked = posts.filter((p) => p.type === 'unlocked');
  check('flight: reported unlock count', unlocked.length > 0 && unlocked.at(-1).total >= 2, JSON.stringify(unlocked.at(-1) || {}));
}

/* ---------- 2. Toggle semantics: o=off, h=off → nothing changes ---------- */
{
  const inner = JSON.stringify({ m: [{ publicName: 'claude-opus-4-6', userSelectable: false }, { publicName: 'x', userSelectable: false }] });
  const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const { win } = makeSandbox({ e: true, o: false, h: false }, () => Promise.resolve(new Response(null, {})));
  win.__next_f = [];
  win.__next_f.push([1, escaped]);
  check('toggles off: payload untouched', win.__next_f[0][1] === escaped);
}

/* ---------- 3. Opus-scoped flip only (h off, o on) ---------- */
{
  const inner = JSON.stringify({ m: [{ publicName: 'claude-opus-4-6', userSelectable: false }, { publicName: 'gemini-3.6-flash', userSelectable: false }] });
  const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const { win } = makeSandbox({ e: true, o: true, h: false }, () => Promise.resolve(new Response(null, {})));
  win.__next_f = [];
  win.__next_f.push([1, escaped]);
  const out = win.__next_f[0][1];
  const parsed = JSON.parse(out.split('\\"').join('"'));
  check('opus only: opus flipped', parsed.m[0].userSelectable === true);
  check('opus only: others still hidden', parsed.m[1].userSelectable === false);
}

/* ---------- 4. Request body rewrite (plain JSON) ---------- */
{
  const seen = [];
  const fetchImpl = (url, init) => { seen.push({ url, body: init && init.body }); return Promise.resolve(new Response('a0:"hi"\n', { status: 200, headers: { get: () => 'text/event-stream' } })); };
  const { win, posts } = makeSandbox({ e: true, o: true, h: true, forceOn: true, forceId: 'HIDDEN-UUID' }, fetchImpl);
  const body = JSON.stringify({ modelAId: 'visible-model', messages: [{ role: 'user', content: 'x' }] });
  await win.fetch('/nextjs-api/stream/create-evaluation', { method: 'POST', body });
  check('eval json: modelAId rewritten', JSON.parse(seen[0].body).modelAId === 'HIDDEN-UUID', seen[0].body);
  check('eval json: message untouched', JSON.parse(seen[0].body).messages[0].content === 'x');
  check('eval json: reported sent', posts.some((p) => p.type === 'sent'));
}

/* ---------- 5. Request body rewrite (Next framed body) ---------- */
{
  const seen = [];
  const fetchImpl = (url, init) => { seen.push({ url, body: init && init.body }); return Promise.resolve(new Response('a0:"hi"\n')); };
  const { win } = makeSandbox({ e: true, o: true, h: true, forceOn: true, forceId: 'HIDDEN-UUID' }, fetchImpl);
  const json = JSON.stringify({ modelAId: 'visible-model' });
  const payload = new TextEncoder().encode(json);
  const framed = new Uint8Array(5 + payload.length + 3);
  framed[0] = 0x31;
  new DataView(framed.buffer).setUint32(1, payload.length);
  framed.set(payload, 5);
  framed.set([9, 9, 9], 5 + payload.length);
  await win.fetch('/nextjs-api/stream/post-to-evaluation', { method: 'POST', body: framed });
  const got = seen[0].body;
  const len = new DataView(got.buffer, got.byteOffset + 1, 4).getUint32(0);
  const inner = JSON.parse(new TextDecoder().decode(got.subarray(5, 5 + len)));
  check('eval framed: type byte preserved', got[0] === 0x31);
  check('eval framed: length reframed', 5 + len + 3 === got.length, `${got.length}`);
  check('eval framed: modelAId rewritten', inner.modelAId === 'HIDDEN-UUID');
  check('eval framed: trailing bytes preserved', got[got.length - 1] === 9);
}

/* ---------- 6. Force off → no rewrite ---------- */
{
  const seen = [];
  const fetchImpl = (url, init) => { seen.push(init && init.body); return Promise.resolve(new Response('ok')); };
  const { win } = makeSandbox({ e: true, o: true, h: true, forceOn: false, forceId: '' }, fetchImpl);
  const body = JSON.stringify({ modelAId: 'visible-model' });
  await win.fetch('/nextjs-api/stream/create-evaluation', { method: 'POST', body });
  check('force off: body untouched', seen[0] === body);
}

/* ---------- 7. Unrelated endpoints untouched ---------- */
{
  const seen = [];
  const fetchImpl = (url, init) => { seen.push(init && init.body); return Promise.resolve(new Response('{}')); };
  const { win } = makeSandbox({ e: true, o: true, h: true, forceOn: true, forceId: 'HIDDEN-UUID' }, fetchImpl);
  const body = JSON.stringify({ modelAId: 'visible-model', other: 1 });
  await win.fetch('/nextjs-api/user/settings', { method: 'POST', body });
  check('other endpoint: untouched', seen[0] === body);
}

/* ---------- 8. routed_model tap ---------- */
{
  const enc = new TextEncoder();
  const chunks = ['a2:[{"type":"routed_model","organization":"google"}]\n', 'a0:"hello"\n'];
  let i = 0;
  const stream = { getReader: () => ({ read: () => Promise.resolve(i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) };
  const response = { status: 200, statusText: 'OK', headers: { get: () => 'text/event-stream' }, body: { tee: () => [stream, stream] } };
  const fetchImpl = () => Promise.resolve(response);
  const { win, posts } = makeSandbox({ e: true, o: true, h: true, forceOn: false }, fetchImpl);
  win.fetch('/nextjs-api/stream/create-evaluation', { method: 'POST', body: '{}' });
  await new Promise((r) => setTimeout(r, 40));
  const routed = posts.filter((p) => p.type === 'routed');
  check('stream tap: routed_model captured', routed.length === 1 && routed[0].org === 'google', JSON.stringify(routed));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
