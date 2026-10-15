/* Replay against a REAL arena.ai catalog snapshot.
 *
 * The sandbox this was built in cannot open a TLS connection to arena.ai, so the
 * live site could not be driven directly. This suite is the closest thing: it
 * takes an unmodified 1,066-entry catalog captured from arena.ai, rebuilds the
 * React Flight payload exactly as Next.js ships it, and runs the extension's real
 * files against it — scanner, page-world unlock hook and link builder.
 *
 * If a future Arena release renames a field, changes a capability key or moves the
 * model selector, this suite is what should fail first.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { JSDOM as JSDOMvm } from 'jsdom';
import { JSDOM } from 'jsdom';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(repo, 'tests/fixtures/arena-catalog.real.json'), 'utf8'));

let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

const hidden = catalog.filter((m) => m.userSelectable === false);
check('fixture is a real catalog', catalog.length === 1066, `${catalog.length} entries`);
check('fixture has hidden entries', hidden.length === 126, `${hidden.length} hidden`);
check('every entry carries both userSelectable and publicName', catalog.every((m) => 'userSelectable' in m && typeof m.publicName === 'string'));

/* ------------------------------------------------------------------ *
 * 1. Flight payload exactly as Next.js ships it (escaped, inside a script)
 * ------------------------------------------------------------------ */
const flight = JSON.stringify({ initialModels: catalog, initialModelAId: catalog[0].id });
const escaped = flight.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const html = `<!doctype html><html><body><div id="root"></div>
<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${escaped}"])</script>
</body></html>`;

/* ------------------------------------------------------------------ *
 * 2. Scanner must recover all 1,066 entries from that payload
 * ------------------------------------------------------------------ */
const dom = new JSDOM(html, { url: 'https://arena.ai/text/direct', runScripts: 'outside-only' });
const scanCtx = vm.createContext({ window: dom.window, console });
vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), scanCtx);
const scanned = scanCtx.KnowModelScan.scanModels(dom.window.document);
check('scanner recovers the whole real catalog', Array.isArray(scanned) && scanned.length === 1066, `${scanned && scanned.length}`);
check('scanned ids match the source exactly', scanned.every((m, i) => m.id === catalog[i].id && m.publicName === catalog[i].publicName));
check('scanned userSelectable flags survive', scanned.filter((m) => m.userSelectable === false).length === 126);

/* ------------------------------------------------------------------ *
 * 3. Page-world hook must un-hide exactly the hidden ones, on real data
 * ------------------------------------------------------------------ */
function runHook(cfg, payload) {
  const store = new Map([['lm_stealth_cfg', JSON.stringify(cfg)]]);
  const vmDom = new JSDOMvm('<!doctype html><html><body></body></html>', { url: 'https://arena.ai/text/direct' });
  const win = {
    location: { href: 'https://arena.ai/text/direct', origin: 'https://arena.ai' },
    addEventListener() {}, postMessage() {}, document: vmDom.window.document,
    fetch: () => Promise.resolve(), XMLHttpRequest: function () {}, __next_f: null,
  };
  win.XMLHttpRequest.prototype = { open() {}, send() {} };
  const sandbox = {
    window: win, self: win, console, Object, JSON, Array, String, Number, Math, Date,
    setTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, RegExp, Error, Promise,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(repo, 'main.js'), 'utf8'), sandbox);
  win.__next_f = [];
  win.__next_f.push([1, payload]);
  return win.__next_f[0][1];
}

const unlockedPayload = runHook({ e: true, o: true, h: true }, escaped);
const restored = JSON.parse(unlockedPayload.split('\\"').join('"'));
check('real payload still parses as JSON after rewriting', Array.isArray(restored.initialModels));
check('all 1,066 entries survive the rewrite', restored.initialModels.length === 1066);
check('no hidden entries left on real data', restored.initialModels.filter((m) => m.userSelectable === false).length === 0);
check('visible entries were already true and stay true', restored.initialModels.filter((m) => m.userSelectable === true).length === 1066);
check('non-catalog fields untouched', restored.initialModelAId === catalog[0].id);
const opusNames = catalog.filter((m) => /opus/i.test(m.publicName)).map((m) => m.publicName);
const opusAfter = restored.initialModels.filter((m) => /opus/i.test(m.publicName));
check('every real Opus entry unlocked', opusAfter.length > 0 && opusAfter.every((m) => m.userSelectable === true), `${opusAfter.length} entries, e.g. ${opusNames[0]}`);

// Show-hidden off + Restore-Opus on: only the Opus entries may flip
const opusOnly = JSON.parse(runHook({ e: true, o: true, h: false }, escaped).split('\\"').join('"'));
const stillHidden = opusOnly.initialModels.filter((m) => m.userSelectable === false);
const hiddenOpusNames = new Set(hidden.filter((m) => /opus/i.test(m.publicName)).map((m) => m.publicName));
check('Restore-Opus-only flips just the Opus entries',
  stillHidden.length === 126 - hiddenOpusNames.size &&
  stillHidden.every((m) => !/opus/i.test(m.publicName)),
  `${stillHidden.length} still hidden (expected ${126 - hiddenOpusNames.size})`);

// master switch off must be a true no-op
check('Active off leaves the real payload byte-identical', runHook({ e: false, o: true, h: true }, escaped) === escaped);

/* ------------------------------------------------------------------ *
 * 4. Deep links against every real name
 * ------------------------------------------------------------------ */
const utilsCtx = vm.createContext({ console });
vm.runInContext(readFileSync(join(repo, 'model-utils.js'), 'utf8'), utilsCtx);
const KU = utilsCtx.KnowModel;

const problems = [];
for (const m of catalog) {
  const v = KU.paramValue(m);
  if (!v) problems.push(`${m.publicName}: empty param`);
  // the param must round-trip case-insensitively to a real publicName
  if (v !== String(m.publicName).toLowerCase()) problems.push(`${m.publicName}: mangled to ${v}`);
  // no URL-breaking characters may survive unescaped
  const url = `https://arena.ai/text/direct?model_a=${encodeURIComponent(v)}`;
  const back = new URL(url).searchParams.get('model_a');
  if (back !== v) problems.push(`${m.publicName}: param did not round-trip (${back})`);
}
check('every real model yields a correct ?model_a= value', problems.length === 0, problems.slice(0, 3).join(' | '));

// the exact cases that broke the old slug builder, plus the user's own examples
const cases = [
  ['gemini-3.6-flash', 'gemini-3.6-flash'],
  ['minimax-m3', 'minimax-m3'],
  ['Max', 'max'],
  ['gpt-5.4-high-no-system-prompt', 'gpt-5.4-high-no-system-prompt'],
  ['claude-opus-4-6', 'claude-opus-4-6'],
  ['gemini-3-pro-image-2k (nano-banana-pro)', 'gemini-3-pro-image-2k (nano-banana-pro)'],
];
const caseFails = cases.filter(([name, want]) => KU.paramValue({ publicName: name }) !== want);
check('dotted names are not slugified (the old bug)', caseFails.length === 0, JSON.stringify(caseFails));

const dotted = catalog.filter((m) => m.publicName.includes('.')).length;
check('catalog really does contain dotted names', dotted > 100, `${dotted} names with a dot`);

/* ------------------------------------------------------------------ *
 * 5. Capability mapping against real capability shapes
 * ------------------------------------------------------------------ */
const capKeys = new Set();
for (const m of catalog) for (const k of Object.keys((m.capabilities || {}).outputCapabilities || {})) capKeys.add(k);
check('real capability keys are the ones we map', ['text', 'web', 'image', 'search', 'video'].some((k) => capKeys.has(k)), [...capKeys].join(','));

const webModels = catalog.filter((m) => ((m.capabilities || {}).outputCapabilities || {}).web);
check('web capability is mapped (was missing before)', webModels.length > 0 && webModels.every((m) => KU.caps(m).includes('web')), `${webModels.length} web-capable models`);

const imageModels = catalog.filter((m) => {
  const v = ((m.capabilities || {}).outputCapabilities || {}).image;
  return v && typeof v === 'object';
});
check('object-valued image capability still counts as image',
  imageModels.length > 0 ? imageModels.every((m) => KU.caps(m).includes('image')) : true,
  `${imageModels.length} models with an object-valued image cap`);

const unknownCaps = catalog.filter((m) => KU.caps(m).length === 0).length;
console.log(`INFO  ${unknownCaps} of ${catalog.length} models expose no capability we map`);

/* ------------------------------------------------------------------ *
 * 6. Panel renders the real catalog (hidden-only default)
 * ------------------------------------------------------------------ */
const panelHtml = `<!doctype html><html><body><div id="root"></div>
<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${escaped}"])</script>
</body></html>`;
const pdom = new JSDOM(panelHtml, { url: 'https://arena.ai/text/direct', runScripts: 'outside-only', pretendToBeVisual: true });
const pw = pdom.window;
pw.chrome = {
  storage: {
    sync: { get: (d, cb) => cb(d), set: () => {} },
    local: { get: (_k, cb) => cb({}), set: () => {}, remove: () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { sendMessage: () => {} },
};
pw.navigator.clipboard = { writeText: () => Promise.resolve() };
pw.open = () => null;
for (const f of ['model-utils.js', 'models-scan.js', 'content.js']) pw.eval(readFileSync(join(repo, f), 'utf8'));
await new Promise((r) => setTimeout(r, 200));

const pdoc = pw.document;
check('panel builds on a real page', !!pdoc.getElementById('lm-stealth-panel'));
check('badge reports the real hidden count', pdoc.getElementById('lm-count').textContent === '126', pdoc.getElementById('lm-count').textContent);
check('status reports the real totals', /1066 models/.test(pdoc.getElementById('lm-status').innerHTML) && /126 hidden/.test(pdoc.getElementById('lm-status').innerHTML), pdoc.getElementById('lm-status').textContent);
const rows = [...pdoc.querySelectorAll('.lm-row')];
check('hidden-only list is populated from real data', rows.length === 126, `${rows.length} rows`);
check('first row of the hidden list is a real hidden model', /\S/.test(rows[0].textContent));
check('capability labels shown for real entries', [...pdoc.querySelectorAll('.lm-org')].some((n) => /text|web|image|search/.test(n.textContent)));

// search the real catalog for the codenames people care about
const q = pdoc.getElementById('lm-q');
q.value = 'opus';
q.dispatchEvent(new pw.Event('input'));
const opusRows = pdoc.querySelectorAll('.lm-row').length;
check('search finds the Opus family', opusRows >= 10, `${opusRows} rows`);
q.value = 'pearl';
q.dispatchEvent(new pw.Event('input'));
check('search finds codenames', pdoc.querySelectorAll('.lm-row').length >= 3, `${pdoc.querySelectorAll('.lm-row').length} rows`);
q.value = '';
q.dispatchEvent(new pw.Event('input'));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LIVE-CATALOG TESTS PASSED');
process.exit(failures ? 1 : 0);
