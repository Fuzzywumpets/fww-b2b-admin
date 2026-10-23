// WHAT: runs the confirmed Gauntlet scope (b2badmin-test.app-scope.json) HEADED against the isolated TEST copy of
// b2badmin, reached through an SSH tunnel (default http://localhost:18796 -> fww-vps-1 127.0.0.1:8796).
//   GAUNTLET_DIR=C:/Users/AlexLass/Documents/Codex/Gauntlet node docs/gauntlet/run-b2badmin-test.mjs [baseUrl]
// Reset the store first: scripts/seed-test-store.mjs (customers keep their ids; seeded order NAMES are stable).
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
const manifest = JSON.parse(readFileSync(new URL('./b2badmin-test.app-scope.json', import.meta.url), 'utf8'));
const outputDir = join(gauntletDir, '.gauntlet', 'b2badmin-test', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outputDir, { recursive: true });

const { report, reportPath } = await runAppAssessment({
  config: {
    url: `${base}/__test__/session?email=alex@fuzzywumpets.com`,
    mode: 'headed',
    viewports: [{ name: 'desktop', width: 1366, height: 900 }],
  },
  manifest,
  outputDir,
});
console.log(JSON.stringify({
  status: report.status, reportPath,
  routes: report.routes.map(r => `${r.id}: ${r.status}${r.error ? ' ' + r.error : ''}`),
  workflows: report.workflows.map(w => `${w.id}: ${w.status}${w.error ? ' ' + w.error : ''}${w.executions?.[0]?.steps?.find(s => s.status === 'failed') ? ' @step ' + w.executions[0].steps.find(s => s.status === 'failed').index : ''}`),
  coverage: report.coverage?.counts,
}, null, 2));
