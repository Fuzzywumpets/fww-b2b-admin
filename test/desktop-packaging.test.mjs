// Guards the packaging allowlist for the Electron shell.
//
// WHY THIS EXISTS: electron-builder's `build.files` is an explicit ALLOWLIST. v1.0.3 shipped with
// main.js requiring './lib/pdf-headers' while `files` still listed only main.js, preload.js and
// assets/** — so the module was never copied into app.asar and the released app died on launch with
// "Cannot find module './lib/pdf-headers'". Nothing failed at build time; the installer built,
// published and auto-updated cleanly. The break was only visible by running the packaged app.
//
// So: every relative require in the shell's main process must be matched by `build.files`, and that
// is checked here rather than trusted. This runs in the normal suite, no Electron or build needed.
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..', 'desktop');
const pkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// Minimal glob matcher covering the shapes electron-builder configs actually use here:
// exact names, `dir/**`, `dir/**/*`, and `*.ext`.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {           // ** — any depth, optionally followed by /
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
      } else {
        re += '[^/]*';                      // * — within one segment
      }
    } else if (c === '.') re += '\\.';
    else if ('+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

const patterns = (pkg.build?.files || []).filter((f) => typeof f === 'string' && !f.startsWith('!'));
const matchers = patterns.map(globToRegExp);
const isPackaged = (rel) => matchers.some((m) => m.test(rel.split(path.sep).join('/')));

console.log('\n── Unit: desktop packaging allowlist ──\n');

test('build.files is a non-empty allowlist', () => {
  assert.ok(patterns.length > 0, 'build.files must list what gets packaged');
});

// The regression itself: walk main.js's relative requires and prove each one ships.
test('every relative require in main.js is inside the packaged file set', () => {
  const src = readFileSync(path.join(desktop, 'main.js'), 'utf8');
  const specs = [...src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, 'expected at least one relative require in main.js');

  for (const spec of specs) {
    // Resolve the way Node does: exact path, then .js, then /index.js.
    const base = path.resolve(desktop, spec);
    const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
    const resolved = candidates.find((c) => existsSync(c));
    assert.ok(resolved, `main.js requires '${spec}' but no such file exists on disk`);

    const rel = path.relative(desktop, resolved);
    assert.ok(
      isPackaged(rel),
      `main.js requires '${spec}' -> ${rel.split(path.sep).join('/')}, which NO build.files pattern matches ` +
      `(${patterns.join(', ')}). The packaged app would throw "Cannot find module '${spec}'" on launch — ` +
      `this is exactly how v1.0.3 shipped broken. Add it to build.files.`
    );
  }
});

test('the entry point and preload themselves are packaged', () => {
  for (const f of [pkg.main || 'main.js', 'preload.js']) {
    assert.ok(isPackaged(f), `${f} must be packaged`);
  }
});

// The tag must equal v<version> or electron-builder scatters assets across two releases; the
// workflow enforces it, but a mismatch is cheaper to find here than in CI.
test('version is a plain semver (the release tag is derived from it)', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `unexpected version: ${pkg.version}`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
