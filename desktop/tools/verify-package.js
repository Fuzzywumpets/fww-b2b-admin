#!/usr/bin/env node
'use strict';

// WHAT: verifies the BUILT app.asar — not the source tree, not the config — by resolving every
//   relative require in the packaged main.js against the files actually inside the archive.
//
// WHY: v1.0.3 was built, published and auto-updated to staff while being unlaunchable. main.js
//   required './lib/pdf-headers', electron-builder's `files` allowlist did not include lib/, so the
//   module was never copied in and the app died on launch with "Cannot find module". Nothing in the
//   pipeline noticed: the build succeeded, the unit tests passed (they import from the REPO, which
//   still had the file), and the release published cleanly. The only thing that would have caught it
//   was looking inside the artifact — so that is now a build step rather than a habit.
//
// This checks the artifact rather than launching it on purpose: a GUI launch on a CI runner is
// flaky, and a flaky gate that blocks releases is worse than no gate. Launching the packaged app
// stays the manual pre-release check.
//
// Usage: node tools/verify-package.js <path-to-app.asar>

const path = require('path');
const asar = require('@electron/asar');

const archive = process.argv[2];
if (!archive) {
  console.error('usage: node tools/verify-package.js <path-to-app.asar>');
  process.exit(2);
}

// listPackage returns platform-separated, leading-separator paths ("\lib\pdf-headers.js");
// normalise to forward slashes with no leading slash so lookups are platform-independent.
const entries = new Set(
  asar.listPackage(archive).map((e) => e.replace(/\\/g, '/').replace(/^\//, ''))
);

function fail(msg) {
  console.error(`\n  PACKAGE VERIFICATION FAILED\n  ${msg}\n`);
  process.exit(1);
}

const main = asar.extractFile(archive, 'main.js').toString('utf8');
const specs = [...main.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
if (!specs.length) fail('no relative requires found in the packaged main.js — is this the right archive?');

let checked = 0;
for (const spec of specs) {
  const base = spec.replace(/^\.\//, '');
  const candidates = [base, `${base}.js`, `${base}/index.js`];
  const hit = candidates.find((c) => entries.has(c));
  if (!hit) {
    fail(
      `packaged main.js requires '${spec}', but no such file is inside app.asar.\n` +
      `  Tried: ${candidates.join(', ')}\n` +
      `  The installed app would throw "Cannot find module '${spec}'" on launch.\n` +
      `  Add it to build.files in desktop/package.json (this is exactly how v1.0.3 shipped broken).`
    );
  }
  console.log(`  ok  ${spec} -> ${hit}`);
  checked++;
}

console.log(`\n  package verified: ${checked} relative require(s) present inside app.asar\n`);
