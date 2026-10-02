# FWW B2B Admin — Desktop

A thin Electron desktop shell around **https://b2badmin.fuzzywumpets.com/** — the
internal Fuzzywumpets B2B admin dashboard. Built to mirror `fww-shipping-desktop`.

> **This shell renders nothing of its own.** It loads the live admin URL, so the
> dashboard's *content* is always current the moment the VPS is updated — there is
> no "sync" step and no cached copy. A shell release is only ever needed to change
> shell behavior (window/OAuth/PDF/tray/updater), which is why its version number
> moves far more slowly than the server's. An old shell version does **not** mean
> you are looking at old admin data.

## What it does

- Opens the B2B Admin dashboard in its own window with a green **B2B** app icon
  (desktop + Start-menu shortcut, system-tray icon).
- **Authentication:** same as FWW Shipping — the window uses a persistent session
  partition (`persist:b2badmin`), so the **Sign in with Google** flow runs once and
  the session survives restarts. Google OAuth popups (`accounts.google.com`) open
  in-app; all other links open in your default browser.
- **Auto-update on open:** on every launch it checks GitHub Releases, downloads any
  new version in the background, and offers to restart (and installs on quit
  regardless). Powered by `electron-updater`.

## Develop

```bash
npm install
npm start          # runs the app pointed at the live admin (dev: no auto-update)
```

## Icons

The icon is generated, not hand-drawn:

```bash
npm run icons      # regenerates assets/icon*.png + assets/icon.ico (green B2B square)
```

## Release (triggers auto-update for everyone)

CI builds the Windows NSIS installer and publishes a GitHub Release whenever a
**`v*`** tag is pushed.

**The tag must be exactly `v<version>` from `desktop/package.json`.** Two publishers
write to the release: electron-builder's own GitHub publisher (which uploads the
hyphen-named `.exe`, its `.blockmap`, and the `latest.yml` that electron-updater
actually reads) and the `softprops` step. electron-builder derives its release tag
from `v${version}` and ignores the git tag name — so a mismatched tag scatters the
assets across two releases and leaves `latest.yml` pointing at an `.exe` that isn't
on the same release, i.e. a broken update feed.

```bash
# bump "version" in desktop/package.json first, then:
git tag v1.0.2
git push origin v1.0.2
```

GitHub Actions (`.github/workflows/desktop-build.yml`, at the **repo root** — GitHub
only runs workflows from there) builds on `windows-latest` and attaches `*.exe` +
`latest.yml` to the release. Installed apps pick the update up on their next launch.

### One-time cutover: installs older than the repo merge need a manual reinstall

The shell used to live in its own repo (`fww-b2b-admin-desktop`) and shipped with
`resources/app-update.yml` pointing at **that** repo. That pointer is baked into the
installer at build time, so a client installed before this merge keeps polling the
old repo forever and will never see a release published here.

Anyone still on **v1.0.1 or earlier must reinstall once** from this repo's Releases
page. After that single reinstall, auto-update follows this repo normally. (As of the
merge the only known install was Alex's PC.)

## Install

- **Shared PC (several Windows accounts, e.g. the shipping PC):** run `tools/provision-all-users.ps1`
  once, elevated (see *Install for every Windows user* below); every account then gets the app at its
  next sign-in.
- **Single account:** download the latest `FWW-B2B-Admin-Setup-x.y.z.exe` from the
  [Releases page](https://github.com/Fuzzywumpets/fww-b2b-admin/releases) and run it (no admin needed).

### Install for every Windows user (per-user app, admin-free updates)

The installer is **per-user only** (`nsis.oneClick: true`, `nsis.perMachine: false`): each Windows account
gets its own copy in `%LOCALAPPDATA%\Programs\fww-b2b-admin-desktop`, and `electron-updater` updates it
silently with **no admin prompt**. (Up to 1.0.5 the installer was an assisted wizard that offered "all
users"; picking it installed to `C:\Program Files\FWW B2B Admin`, whose updates need administrator rights,
so non-admin accounts such as the shipping staff got a UAC prompt they could not approve and never updated.)

A per-user installer only installs for whoever runs it, so each shared PC needs a **one-time admin setup**
that makes Windows install the app for every account automatically:

```powershell
# Elevated PowerShell in desktop/, once per PC (after a >= 1.0.6 release is published):
powershell -ExecutionPolicy Bypass -File .\tools\provision-all-users.ps1     # add -WhatIf to preview
```

It downloads the latest release installer (SHA-512-verified against `latest.yml`; refuses anything older
than the first per-user-only build), stages it read-only in `%ProgramData%\FWW B2B Admin`, removes the old
machine-wide install, and registers **Windows Active Setup** so every account — existing and future — gets
the app silently at its next sign-in (accounts that already have it are skipped). Each account's Google
sign-in session lives in its own `%APPDATA%` and is not touched.

**Do not flip `nsis.oneClick` back to `false` or `nsis.perMachine` to `true`**: either one makes a
machine-wide (admin-only-updates) install possible again. Because `package.json` cannot carry a `DEPENDS:`
comment, this section plus `test/install-model.test.js` (`npm test`) are the dependency marker
(SYNC: install-model, with `tools/provision-all-users.ps1`).
