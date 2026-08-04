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

Download the latest `FWW B2B Admin Setup x.y.z.exe` from the
[Releases page](https://github.com/Fuzzywumpets/fww-b2b-admin/releases) and run it.
