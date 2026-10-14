'use strict';

// SYNC: install-model — enforces the coupling between desktop/package.json (which cannot carry comments),
// tools/provision-all-users.ps1 and the README. Per-machine installs put the app in Program Files, so
// electron-updater needs admin and non-admin accounts can never update; per-user builds + the one-time
// Active Setup provisioning give every account the app AND silent, admin-free updates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = fs.readFileSync(path.join(root, 'tools', 'provision-all-users.ps1'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('installer is per-user only so updates never need admin', () => {
  // oneClick + perMachine=false = always per-user. An assisted (oneClick=false) installer with
  // perMachine=false shows an "all users / just me" page, which is how the shipping PC ended up machine-wide.
  assert.equal(pkg.build.nsis.oneClick, true);
  assert.equal(pkg.build.nsis.perMachine, false);
});

test('provisioning script matches the package it installs', () => {
  // Per-user install dir is %LOCALAPPDATA%\Programs\<package name>; the Active Setup stub skips accounts
  // that already have it, so the name must match exactly.
  assert.ok(script.includes(`\\Programs\\${pkg.name}\\${pkg.build.productName}.exe`), 'per-user exe path');
  // No artifactName: electron-builder's GitHub publisher names the asset <productName with dashes>-Setup-<ver>.exe,
  // and that is the file latest.yml (the SHA-512 source) describes.
  assert.equal(pkg.build.win.artifactName, undefined);
  const asset = `${pkg.build.productName.replace(/ /g, '-')}-Setup-*.exe`;
  assert.ok(script.includes(`'${asset}'`), `release asset pattern ${asset}`);
  assert.ok(script.includes(`'${pkg.build.publish.owner}/${pkg.build.publish.repo}'`), 'release repo');
});

test('provisioning refuses pre-per-user builds and this build qualifies', () => {
  const m = script.match(/\$MinVersion\s*=\s*\[version\]'([\d.]+)'/);
  assert.ok(m, 'MinVersion declared');
  const [a, b, c] = m[1].split('.').map(Number);
  const [x, y, z] = pkg.version.split('.').map(Number);
  assert.ok(x > a || (x === a && (y > b || (y === b && z >= c))), `package ${pkg.version} >= MinVersion ${m[1]}`);
});

test('README documents the per-user model', () => {
  assert.match(readme, /Install for every Windows user/);
  assert.match(readme, /provision-all-users\.ps1/);
});
