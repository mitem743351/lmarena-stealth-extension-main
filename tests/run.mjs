/* Test runner for the LMArena Stealth extension.
 *   node tests/run.mjs          # everything
 *   node tests/run.mjs page     # only the page-hook tests (no dependencies)
 * The DOM tests need jsdom:  npm install  (or: npm i -D jsdom)
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const want = process.argv[2] || '';

const suites = [
  { id: 'manifest', file: 'manifest.test.mjs', needsJsdom: false, what: 'manifest: files exist, scripts parse, no remote code' },
  { id: 'page', file: 'page-hook.test.mjs', needsJsdom: false, what: 'page hook: flight unlock + request rewrite + stream tap' },
  { id: 'catalog', file: 'live-catalog.test.mjs', needsJsdom: true, what: 'live catalog: 1,066 real models replayed through the real files' },
  { id: 'shapes', file: 'catalog-shapes.test.mjs', needsJsdom: true, what: 'shapes: six real payload shapes the catalog arrives in' },
  { id: 'delivery', file: 'panel-delivery.test.mjs', needsJsdom: true, what: 'delivery: nothing inline, catalog over fetch/XHR reaches the panel' },
  { id: 'panel', file: 'panel.test.mjs', needsJsdom: true, what: 'panel: catalog, hidden filter, deep links, force toggle' },
  { id: 'bridge', file: 'bridge.test.mjs', needsJsdom: true, what: 'bridge: sync storage -> localStorage -> page world' },
];

function hasJsdom() {
  try {
    const r = spawnSync(process.execPath, ['-e', 'require.resolve("jsdom")'], { stdio: 'ignore' });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

const jsdom = hasJsdom();
let failed = 0;
let skipped = 0;

for (const suite of suites) {
  if (want && suite.id !== want) continue;
  if (suite.needsJsdom && !jsdom) {
    console.log(`SKIP  ${suite.id.padEnd(7)} (jsdom not installed — run: npm install)`);
    skipped++;
    continue;
  }
  const path = join(here, suite.file);
  if (!existsSync(path)) {
    console.log(`SKIP  ${suite.id.padEnd(7)} (missing ${suite.file})`);
    skipped++;
    continue;
  }
  console.log(`\n=== ${suite.id}: ${suite.what} ===`);
  const r = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('');
if (failed) {
  console.log(`${failed} suite(s) failed`);
  process.exit(1);
}
console.log(`all suites passed${skipped ? ` (${skipped} skipped)` : ''}`);
