/* Panel UI test: content.js inside a jsdom page with a realistic Flight payload. */
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const models = [
  { id: 'uuid-hidden-1', publicName: 'claude-opus-4-6', organization: 'Anthropic', userSelectable: false, capabilities: { outputCapabilities: { text: true } } },
  { id: 'uuid-hidden-2', publicName: 'pteronura', organization: 'Anonymous', userSelectable: false, capabilities: { outputCapabilities: { text: true, search: true } } },
  { id: 'uuid-hidden-3', publicName: 'nano-banana-2', organization: 'Google', userSelectable: false, capabilities: { outputCapabilities: { image: true } } },
  { id: 'uuid-visible-4', publicName: 'gpt-6-sol', organization: 'OpenAI', userSelectable: true, capabilities: { outputCapabilities: { text: true } } },
];
const inner = JSON.stringify({ initialModels: models, initialModelAId: models[0].id });
const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const html = `<!doctype html><html><body><div id="root"></div>
<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${escaped}"])</script>
</body></html>`;

const dom = new JSDOM(html, { url: 'https://arena.ai/text/direct?model_a=max', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

// ---- chrome API stub ----
const syncStore = { e: true, o: true, h: true, forceOn: false, forceId: '', forceName: '' };
const localStore = {};
const messages = [];
window.chrome = {
  storage: {
    sync: { get: (d, cb) => cb(syncStore), set: (p, cb) => { Object.assign(syncStore, p); cb && cb(); } },
    local: { get: (_k, cb) => cb(localStore), set: (p) => Object.assign(localStore, p), remove: () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { sendMessage: (m) => messages.push(m) },
};

// web-platform bits jsdom lacks
window.navigator.clipboard = { writeText: (t) => { window.__copied = t; return Promise.resolve(); } };
window.open = (u, t) => { window.__opened = u; return null; };

// ---- load the three content scripts ----
for (const f of ['model-utils.js', 'models-scan.js', 'content.js']) {
  window.eval(readFileSync(`${repo}/${f}`, 'utf8'));
}
// jsdom fires DOMContentLoaded itself once the parser is done
await new Promise((r) => setTimeout(r, 80));

const doc = window.document;
const panel = doc.getElementById('lm-stealth-panel');
const btn = doc.getElementById('lm-stealth-btn');
check('panel built', !!panel && !!btn);
check('panel closed initially', !panel.classList.contains('lm-open'));
btn.click();
check('panel opens on click', panel.classList.contains('lm-open'));

const rows = [...doc.querySelectorAll('.lm-row')];
check('hidden-only filter applied by default', rows.length === 3, `${rows.length} rows`);
check('hidden rows tagged', doc.querySelectorAll('.lm-tag').length === 3);
check('hidden badge count', doc.getElementById('lm-count').textContent === '3', doc.getElementById('lm-count').textContent);
check('status shows catalog size', /4 models/.test(doc.getElementById('lm-status').innerHTML), doc.getElementById('lm-status').textContent);

// selection + detail links
rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('click copies id', window.__copied === 'uuid-hidden-1', String(window.__copied));
check('row marked selected', !!doc.querySelector('.lm-row.lm-sel'));
const links = [...doc.querySelectorAll('#lm-detail .lm-link')].map((a) => a.href);
check('detail links built', links.length >= 8, `${links.length}`);
check('slug used in deep link', links.some((h) => h === 'https://arena.ai/text/direct?model_a=claude-opus-4-6'), links[0]);
check('side-by-side link present', links.some((h) => h.includes('/text/side-by-side?model_a=claude-opus-4-6')));
check('image search link present', links.some((h) => h.includes('/search/side-by-side?model_a=')));
check('raw-id fallback link', links.some((h) => h.includes('uuid-hidden-1')));

// search filter
const q = doc.getElementById('lm-q');
q.value = 'pteronura';
q.dispatchEvent(new window.Event('input'));
check('search filters rows', doc.querySelectorAll('.lm-row').length === 1, `${doc.querySelectorAll('.lm-row').length}`);
q.value = '';
q.dispatchEvent(new window.Event('input'));

// "all" chip shows visible models too
const chips = [...doc.querySelectorAll('.lm-chip')];
const allChip = chips.find((c) => c.getAttribute('data-f') === 'all');
allChip.click();
check('all chip shows 4 models', doc.querySelectorAll('.lm-row').length === 4, `${doc.querySelectorAll('.lm-row').length}`);
chips.find((c) => c.getAttribute('data-f') === 'hidden').click();
check('back to hidden-only = 3', doc.querySelectorAll('.lm-row').length === 3);

// force-on-send writes config to localStorage + sync storage
doc.getElementById('lm-force').checked = true;
doc.getElementById('lm-force').dispatchEvent(new window.Event('change'));
const cfg = JSON.parse(window.localStorage.getItem('lm_stealth_cfg'));
check('force cfg persisted', cfg.forceOn === true && cfg.forceId === 'uuid-hidden-1', JSON.stringify(cfg));
check('force id written to sync storage', syncStore.forceId === 'uuid-hidden-1', JSON.stringify(syncStore));

// open button uses the mode dropdown
doc.getElementById('lm-mode').value = 'code-direct';
doc.getElementById('lm-go').click();
check('open uses selected mode', window.__opened === 'https://arena.ai/code/direct?model_a=claude-opus-4-6', String(window.__opened));

// power-user path: force an arbitrary id that is not in the catalog
const custom = doc.getElementById('lm-custom');
custom.value = ' 019b24bb-5caf-71c3-b854-37d0c7086f21 ';
doc.getElementById('lm-custom-go').click();
const cfg2 = JSON.parse(window.localStorage.getItem('lm_stealth_cfg'));
check('custom id forced', cfg2.forceId === '019b24bb-5caf-71c3-b854-37d0c7086f21' && cfg2.forceOn === true, JSON.stringify(cfg2));
check('custom id trimmed', !cfg2.forceId.startsWith(' '));
check('custom id copied', window.__copied === '019b24bb-5caf-71c3-b854-37d0c7086f21', String(window.__copied));
check('custom selection shown in detail', /019b24bb/.test(doc.getElementById('lm-detail').textContent));
custom.value = '';
doc.getElementById('lm-custom-go').click();
check('empty custom id does not clobber force', JSON.parse(window.localStorage.getItem('lm_stealth_cfg')).forceId === '019b24bb-5caf-71c3-b854-37d0c7086f21');

// message bridge from the page world
window.postMessage({ __lmStealth: true, from: 'page', type: 'unlocked', total: 3 }, '*');
window.postMessage({ __lmStealth: true, from: 'page', type: 'routed', org: 'google', name: '' }, '*');
window.postMessage({ __lmStealth: true, from: 'page', type: 'sent', modelId: 'uuid-hidden-1' }, '*');
await new Promise((r) => setTimeout(r, 30));
const status = doc.getElementById('lm-status').textContent;
check('status reflects unlocked', /unlocked 3/.test(status), status);
check('status reflects routed org', /ran: \(google\)/.test(status), status);
check('status reflects forced id', /sent: uuid-hidden-1/.test(status), status);
check('page-world messages stored, not echoed', messages.filter((m) => m.t === 'models').length === 1, JSON.stringify(messages));

// message bridge ignores foreign senders
window.postMessage({ __lmStealth: true, from: 'evil', type: 'unlocked', total: 999 }, '*');
await new Promise((r) => setTimeout(r, 10));
check('foreign message ignored', !/999/.test(doc.getElementById('lm-status').textContent));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UI TESTS PASSED');
process.exit(failures ? 1 : 0);
