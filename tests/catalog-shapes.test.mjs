/* Regression: the catalog arrives in shapes the first version could not read.
 *
 * Reported symptom: the panel said "0 models" on a real logged-in arena.ai page.
 * The first scanner only accepted the inline form
 *    self.__next_f.push([1,"…\"initialModels\":[…],\"initialModelAId…"])
 * i.e. an escaped array immediately followed by an initialModelXId key. These
 * cases cover what actually happens in the wild.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { JSDOM } from 'jsdom';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(repo, 'tests/fixtures/arena-catalog.real.json'), 'utf8'));

let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/* ---------- shape A: plain JSON, no escaping, other key after the array ---------- */
{
  const payload = JSON.stringify({ initialModels: catalog, somethingElse: true });
  const html = `<!doctype html><html><body><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.ai/', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('A: unescaped payload with a different following key', got && got.length === catalog.length, `${got && got.length}`);
}

/* ---------- shape B: escaped, but NOT followed by initialModelAId ---------- */
{
  const payload = esc(JSON.stringify({ initialModels: catalog, someOtherField: 1 }));
  const html = `<!doctype html><html><body><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${payload}"])</script></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.ai/', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('B: escaped payload with no initialModelAId', got && got.length === catalog.length, `${got && got.length}`);
}

/* ---------- shape C: array nested under a different key ---------- */
{
  const payload = esc(JSON.stringify({ data: { models: catalog } }));
  const html = `<!doctype html><html><body><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${payload}"])</script></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.ai/', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('C: catalog under a "models" key', got && got.length === catalog.length, `${got && got.length}`);
}

/* ---------- shape D: catalog only delivered by an RSC fetch (nothing inline) ---------- */
{
  const html = '<!doctype html><html><body><div id="root"></div></body></html>';
  const dom = new JSDOM(html, { url: 'https://arena.ai/text/direct', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('D: nothing inline yields null (page hook must supply it)', got === null, JSON.stringify(got));
}

/* ---------- shape E: split across two pushes, mid-array ---------- */
{
  const payload = esc(JSON.stringify({ initialModels: catalog }));
  const cut = Math.floor(payload.length / 2);
  const html = `<!doctype html><html><body>
<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"${payload.slice(0, cut)}"])</script>
<script>self.__next_f.push([1,"${payload.slice(cut)}"])</script></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.ai/', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('E: payload split across two script tags', got && got.length === catalog.length, `${got && got.length}`);
}

/* ---------- shape F: JSON string literal inside the push (not escaped) ---------- */
{
  const payload = JSON.stringify({ initialModels: catalog });
  const literal = JSON.stringify(payload);
  const html = `<!doctype html><html><body><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,${literal}])</script></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.ai/', runScripts: 'outside-only' });
  const ctx = vm.createContext({ window: dom.window, console });
  vm.runInContext(readFileSync(join(repo, 'models-scan.js'), 'utf8'), ctx);
  const got = ctx.KnowModelScan.scanModels(dom.window.document);
  check('F: JSON-string-literal payload', got && got.length === catalog.length, `${got && got.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SHAPE TESTS PASSED');
process.exit(failures ? 1 : 0);
