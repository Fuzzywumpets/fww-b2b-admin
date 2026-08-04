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

### Releases are published to a different repo, on purpose

Source lives here (private `fww-b2b-admin`), but every release is published to the
**public** [`Fuzzywumpets/fww-b2b-admin-desktop`](https://github.com/Fuzzywumpets/fww-b2b-admin-desktop).

That split is load-bearing. `electron-updater` fetches `releases.atom` **unauthenticated**;
against a private repo GitHub answers **404**, and every installed client dies with
"Could not check for updates." Version 1.0.2 shipped pointing at this private repo and
did exactly that. Do not "tidy up" by pointing releases back here.

Because the public repo is also where the shell *originally* published, clients on
**v1.0.1 keep auto-updating with no reinstall**. Only **v1.0.2** is orphaned — its
baked-in `app-update.yml` names the private repo — so a 1.0.2 install needs one manual
update to 1.0.3, after which it is back on the working feed.

## Install

**First time on a machine — install the signing certificate once**, or Windows will
show SmartScreen / "unknown publisher" warnings and may refuse the download outright:

```powershell
# elevated PowerShell, from this directory
powershell -ExecutionPolicy Bypass -File .\install-codesign-cert.ps1
```

Then download the latest `FWW-B2B-Admin-Setup-x.y.z.exe` from the
[Releases page](https://github.com/Fuzzywumpets/fww-b2b-admin-desktop/releases) and run it.
(The release also carries a dot-separated `FWW.B2B.Admin.Setup.x.y.z.exe` — identical
bytes, an artifact of the two publishers. Either works; the hyphenated one is what
`latest.yml` and the auto-updater reference.)

## Code signing

Builds are signed with a **self-signed** certificate (`CN=Fuzzywumpets`, valid to
2036). That is deliberate: these are internal tools installed on machines we control,
so a self-signed cert removes the warnings for free, where a public CA cert would cost
$300-600/yr for trust we don't need.

The tradeoff is real and worth stating: the certificate only suppresses warnings on
machines where `install-codesign-cert.ps1` has been run, and running it means Windows
trusts **anything** signed with the matching private key. That key lives only in
Doppler (`fww-shared`/`prd`: `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`,
`WINDOWS_CSC_THUMBPRINT`) and in this repo's Actions secrets. If it leaks, rotate the
cert and re-run the install script on every machine.

**SYNC:** the certificate's CN and `build.win.publisherName` in `package.json` must
match. `electron-updater` compares the downloaded installer's certificate subject
against `publisherName` and refuses an update that doesn't match — so changing one
without the other silently breaks auto-update for everyone already installed. CI fails
the build if the installer comes out unsigned or signed by an unexpected certificate.
