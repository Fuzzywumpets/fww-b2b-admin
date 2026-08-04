# FWW B2B Admin — Desktop

A thin Electron desktop shell around **https://b2badmin.fuzzywumpets.com/** — the
internal Fuzzywumpets B2B admin dashboard. Built to mirror `fww-shipping-desktop`.

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
`v*` tag is pushed:

```bash
# bump "version" in package.json first, then:
git tag v1.0.1
git push origin v1.0.1
```

GitHub Actions (`.github/workflows/build.yml`) builds on `windows-latest` and
attaches `*.exe` + `latest.yml` to the release. Installed apps pick the update up
on their next launch.

## Install

Download the latest `FWW B2B Admin Setup x.y.z.exe` from the
[Releases page](https://github.com/fuzzyalex84/fww-b2b-admin-desktop/releases) and run it.
