// WHAT: runs the confirmed Gauntlet scope (b2badmin-test.app-scope.json) HEADED against the isolated TEST copy of
// b2badmin, reached through an SSH tunnel (default http://localhost:18796 -> fww-vps-1 127.0.0.1:8796).
//   GAUNTLET_DIR=C:/Users/AlexLass/Documents/Codex/Gauntlet node docs/gauntlet/run-b2badmin-test.mjs [baseUrl]
// Off Windows (e.g. fww-brain under xvfb-run) Gauntlet finds no Chrome/Edge, so pass GAUNTLET_BROWSER_PATH=<chromium>.
// Reset the store first: scripts/seed-test-store.mjs (customers and products keep their ids; seeded order NAMES are
// stable but order ids are new on every reset).
// CHANGE-GUARD: one desktop viewport on purpose. Gauntlet repeats every workflow per viewport, and Reset / Cancel
// can only succeed once per seed, so a second viewport would fail on state the first one already changed.
// INVARIANT(S): the entry URL is /__test__/session (exists only with B2B_ADMIN_ALLOW_TEST_SESSION=1); the scope's
// destructive allowlist only activates while #test-env-banner is visibly painted, so this cannot drive production.
import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const gauntletDir = process.env.GAUNTLET_DIR || 'C:/Users/AlexLass/Documents/Codex/Gauntlet';
const { runAppAssessment } = await import(pathToFileURL(join(gauntletDir, 'src/application/run-app-assessment.js')).href);
const base = (process.argv[2] || 'http://localhost:18796').replace(/\/$/, '');
const SESSION_PATH = '/__test__/session?email=alex@fuzzywumpets.com';

// WHAT: maps each seeded order NAME (#S-REFUND, …) to its current numeric id by reading the TEST copy's /orders list.
// CHANGE-GUARD: read-only (two GETs); it only fills ids into paths the scope already declares, so it can never
// add, drop or rename a route or workflow. A name the list does not show fails the run instead of being skipped.
// DEPENDS: server.mjs renderOrders() emits <a href="/orders/<id>" … data-order-name="<name>"> for every row, and
// scripts/seed-test-store.mjs creates exactly the names the scope's {{order:S-…}} placeholders use.
async function resolveSeedOrderIds() {
  const login = await fetch(base + SESSION_PATH);
  const sid = /b2b_admin_sid=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
  if (!sid) throw new Error(`no test session from ${base}${SESSION_PATH} (HTTP ${login.status})`);
  const html = await (await fetch(`${base}/orders`, { headers: { Cookie: `b2b_admin_sid=${sid}` } })).text();
  const ids = new Map();
  for (const [tag] of html.matchAll(/<a\b[^>]*data-order-name="[^"]*"[^>]*>/g)) {
    const id = /href="\/orders\/(\d+)"/.exec(tag)?.[1];
    const name = /data-order-name="#?([^"]*)"/.exec(tag)?.[1];
    if (id && name) ids.set(name, id);
  }
  return ids;
}

const ids = await resolveSeedOrderIds();
const scopeText = readFileSync(new URL('./b2badmin-test.app-scope.json', import.meta.url), 'utf8')
  .replace(/\{\{order:([^}]+)\}\}/g, (_, name) => {
    if (!ids.has(name)) throw new Error(`seeded order #${name} is not on ${base}/orders; reseed the TEST store`);
    return ids.get(name);
  });
const manifest = JSON.parse(scopeText);
const outputDir = join(gauntletDir, '.gauntlet', 'b2badmin-test', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outputDir, { recursive: true });

const { report, reportPath } = await runAppAssessment({
  config: {
    url: `${base}${SESSION_PATH}`,
    mode: 'headed',
    ...(process.env.GAUNTLET_BROWSER_PATH ? { browserPath: process.env.GAUNTLET_BROWSER_PATH } : {}),
    viewports: [{ name: 'desktop', width: 1366, height: 900 }],
  },
  manifest,
  outputDir,
});
console.log(JSON.stringify({
  status: report.status, reportPath,
  orderIds: Object.fromEntries(ids),
  routes: report.routes.filter((r) => r.status !== 'completed').map((r) => `${r.id}: ${r.status}`),
  workflows: report.workflows.map(w => `${w.id}: ${w.status}${w.error ? ' ' + w.error : ''}${w.executions?.[0]?.steps?.find(s => s.status === 'failed') ? ' @step ' + w.executions[0].steps.find(s => s.status === 'failed').index : ''}`),
  coverage: report.coverage?.counts,
  blockers: report.coverage?.blockers?.map((b) => `${b.code} ${b.subject ?? ''}`.trim()),
  findings: report.summary?.byCode,
}, null, 2));
