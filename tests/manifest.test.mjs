/* Static checks: manifest validity + every referenced file parses and exists. */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); if (!ok) failures++; };

let m;
try {
  m = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8'));
} catch (e) {
  console.log('FAIL  manifest.json parses  ' + e.message);
  process.exit(1);
}
check('manifest.json parses', true);
check('manifest v3', m.manifest_version === 3);
check('name + version present', !!m.name && /^\d+\.\d+\.\d+$/.test(m.version || ''), `${m.name} ${m.version}`);
check('host permissions cover arena.ai + canary', (m.host_permissions || []).some((h) => h.includes('arena.ai')) && (m.host_permissions || []).some((h) => h.includes('canaryarena.ai')));
check('required permissions', ['storage', 'tabs'].every((p) => (m.permissions || []).includes(p)), JSON.stringify(m.permissions));

const scripts = (m.content_scripts || []).flatMap((cs) => cs.js || []);
const css = (m.content_scripts || []).flatMap((cs) => cs.css || []);
const icons = Object.values(m.icons || {}).concat(Object.values((m.action && m.action.default_icon) || {}));
const files = [...scripts, ...css, ...icons, m.background && m.background.service_worker, m.action && m.action.default_popup].filter(Boolean);

for (const f of [...new Set(files)]) {
  check(`file exists: ${f}`, existsSync(join(repo, f)));
}

const jsFiles = [...new Set([...scripts, m.background && m.background.service_worker, m.action && m.action.default_popup && 'popup.js', 'tests-not-applicable'].filter(Boolean))].filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const src = readFileSync(join(repo, f), 'utf8');
  try {
    new vm.Script(src, { filename: f });
    check(`parses: ${f}`, true);
  } catch (e) {
    check(`parses: ${f}`, false, e.message);
  }
}

// the page-world hook must be declared with world: MAIN, otherwise the fetch hook
// would land in the isolated world and never see Arena's requests
const mainWorld = (m.content_scripts || []).filter((cs) => cs.world === 'MAIN');
check('page hook runs in MAIN world at document_start', mainWorld.length === 1 && mainWorld[0].run_at === 'document_start', JSON.stringify(mainWorld.map((c) => c.js)));
check('bridge runs before the page hook can matter', (m.content_scripts || []).some((cs) => cs.run_at === 'document_start' && !cs.world));

// no remote code, no eval, no inline injection
const offenders = [];
for (const f of jsFiles.concat(['boot.js', 'content.js', 'main.js'])) {
  const src = readFileSync(join(repo, f), 'utf8');
  if (/\beval\s*\(/.test(src)) offenders.push(f + ':eval');
  if (/createElement\(['"]script['"]\)/.test(src)) offenders.push(f + ':injected-script-tag');
  if (/https?:\/\/(?!arena\.ai|canaryarena\.ai|www\.w3\.org)/.test(src.replace(/^\s*\*.*$/gm, ''))) offenders.push(f + ':remote-url');
}
check('no eval / injected script tags / remote fetch targets', offenders.length === 0, offenders.join(', '));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL MANIFEST TESTS PASSED');
process.exit(failures ? 1 : 0);
