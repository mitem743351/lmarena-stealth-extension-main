/* boot.js bridge test: chrome.storage.sync -> localStorage -> postMessage */
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://arena.ai/text/direct', runScripts: 'outside-only' });
const { window } = dom;

let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

const syncStore = { e: false, o: true, h: false, forceOn: false, forceId: '', forceName: '' };
let onChanged = null;
let onMessage = null;
window.chrome = {
  storage: {
    sync: { get: (d, cb) => cb(Object.assign({}, d, syncStore)), set: (p, cb) => { Object.assign(syncStore, p); cb && cb(); } },
    onChanged: { addListener: (fn) => { onChanged = fn; } },
  },
  runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
};

const posts = [];
window.postMessage = (m) => { posts.push(m); };

try { window.eval(readFileSync(`${repo}/boot.js`, 'utf8')); } catch (e) { console.log('BOOT THREW:', e && e.message); }

await new Promise((r) => setTimeout(r, 20));

const stored = JSON.parse(window.localStorage.getItem('lm_stealth_cfg'));
check('localStorage mirror written', !!stored, JSON.stringify(stored));
check('sync storage wins over defaults after boot', stored.e === false && stored.h === false, JSON.stringify(stored));
check('announced config to page world', posts.length >= 1 && posts[0].type === 'cfg' && posts[0].from === 'panel', JSON.stringify(posts[0]));

// popup writes a toggle -> bridge updates mirror + announces
onMessage({ t: 's', d: { h: true, forceOn: true, forceId: 'uuid-9' } }, {}, () => {});
await new Promise((r) => setTimeout(r, 10));
const after = JSON.parse(window.localStorage.getItem('lm_stealth_cfg'));
check('onMessage write lands in mirror', after.h === true && after.forceId === 'uuid-9', JSON.stringify(after));
check('announced change', posts.some((p) => p.cfg && p.cfg.forceId === 'uuid-9'));

// storage.onChanged from another tab
onChanged({ o: { newValue: false } }, 'sync');
await new Promise((r) => setTimeout(r, 10));
check('sync change propagated', JSON.parse(window.localStorage.getItem('lm_stealth_cfg')).o === false);

// get request answers with current state
let answered = null;
onMessage({ t: 'g' }, {}, (v) => { answered = v; });
check('get returns state', answered && answered.forceId === 'uuid-9', JSON.stringify(answered));

// corrupt localStorage must not break the bridge
window.localStorage.setItem('lm_stealth_cfg', '{not json');
window.eval(readFileSync(`${repo}/boot.js`, 'utf8'));
await new Promise((r) => setTimeout(r, 20));
check('recovers from corrupt mirror', !!JSON.parse(window.localStorage.getItem('lm_stealth_cfg')));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BOOT TESTS PASSED');
process.exit(failures ? 1 : 0);
