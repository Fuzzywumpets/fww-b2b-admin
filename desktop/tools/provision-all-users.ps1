<#
.SYNOPSIS
  One-time, per-PC setup so EVERY Windows account gets FWW B2B Admin and can update it WITHOUT admin.

.DESCRIPTION
  FWW B2B Admin installs per-user (desktop/package.json nsis.oneClick = true, perMachine = false): each account
  gets its own copy in %LOCALAPPDATA%\Programs\fww-b2b-admin-desktop and electron-updater updates it silently,
  no UAC. A per-user installer only installs for whoever runs it, so this script (run ONCE, elevated) makes
  Windows install it for every account automatically:

    1. Gets the per-user installer (latest GitHub release by default, or -Installer <path>) and verifies its
       SHA-512 against the release's latest.yml. Refuses versions < MinVersion (those builds could be, and on
       the shipping PC were, installed machine-wide).
    2. Stages it read-only at %ProgramData%\FWW B2B Admin\FWW-B2B-Admin-Setup.exe (users can read/run, not
       replace it, because it runs inside every account's sign-in).
    3. Removes the old machine-wide install (C:\Program Files\FWW B2B Admin), whose updates needed admin.
    4. Registers Windows Active Setup: at each account's next sign-in, Windows runs the staged installer
       silently for that account, once. Accounts that already have the app are skipped.

  Per-account data (%APPDATA%: Google sign-in session, window state) is not touched.

  Adapted from fww-shipping-desktop/tools/provision-all-users.ps1 (same model, same Active Setup mechanics).

.PARAMETER Installer
  Use a local per-user installer instead of downloading the latest release.
.PARAMETER WhatIf
  Print what would happen; change nothing.

.EXAMPLE
  # Elevated PowerShell, from desktop/:
  powershell -ExecutionPolicy Bypass -File .\tools\provision-all-users.ps1
#>
param(
  [string]$Installer,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIf) { throw 'Run this from an elevated (Run as administrator) PowerShell. Use -WhatIf to preview without admin.' }

# SYNC: install-model — desktop/package.json build.nsis (oneClick=true, perMachine=false), build.publish
# owner/repo, build.productName (default electron-builder asset name "FWW-B2B-Admin-Setup-<ver>.exe", exe name
# "FWW B2B Admin.exe"), package name "fww-b2b-admin-desktop" (= per-user dir
# %LOCALAPPDATA%\Programs\fww-b2b-admin-desktop) and the desktop/README.md section "Install for every Windows
# user". desktop/test/install-model.test.js checks these stay aligned.
$Repo               = 'Fuzzywumpets/fww-b2b-admin'
$AssetPattern       = 'FWW-B2B-Admin-Setup-*.exe'
$MinVersion         = [version]'1.0.6'           # first per-user-only build; older releases could install per-machine
$StageDir           = Join-Path $env:ProgramData 'FWW B2B Admin'
$StagedInstaller    = Join-Path $StageDir 'FWW-B2B-Admin-Setup.exe'
$PerUserExe         = '%LOCALAPPDATA%\Programs\fww-b2b-admin-desktop\FWW B2B Admin.exe'
$ActiveSetupKey     = 'HKLM:\SOFTWARE\Microsoft\Active Setup\Installed Components\FWWB2BAdmin'
# Bump ONLY to force a re-run of the per-account install at every account's next sign-in.
$ActiveSetupVersion = '1,0,6,0'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Do-It([scriptblock]$b, $what) { if ($WhatIf) { Write-Host "    [WhatIf] $what" } else { & $b } }

function Get-Sha512Base64($path) {
  $sha = [Security.Cryptography.SHA512]::Create()
  $fs = [IO.File]::OpenRead($path)
  try { [Convert]::ToBase64String($sha.ComputeHash($fs)) } finally { $fs.Dispose(); $sha.Dispose() }
}

# ── 1. Installer ─────────────────────────────────────────────────────────────────────────────────────────
$tmp = Join-Path $env:TEMP ('fww-b2b-admin-provision-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($Installer) {
    Step "Using local installer $Installer"
    if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer" }
    $src = (Resolve-Path $Installer).Path
    $verText = (Get-Item $src).VersionInfo.ProductVersion
  } else {
    Step "Fetching latest release of $Repo"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'fww-provision' }
    # The release also carries a dotted "FWW.B2B.Admin.Setup.<ver>.exe" from the softprops step; the hyphenated
    # one is what latest.yml (and therefore the SHA-512 below) describes.
    $exe = $rel.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
    $yml = $rel.assets | Where-Object { $_.name -eq 'latest.yml' } | Select-Object -First 1
    if (-not $exe -or -not $yml) { throw "Release $($rel.tag_name) is missing the installer or latest.yml." }
    $src = Join-Path $tmp $exe.name
    Invoke-WebRequest $exe.browser_download_url -OutFile $src -UseBasicParsing
    $ymlPath = Join-Path $tmp 'latest.yml'
    Invoke-WebRequest $yml.browser_download_url -OutFile $ymlPath -UseBasicParsing
    $expected = (Select-String -Path $ymlPath -Pattern '^sha512:\s*(\S+)' | Select-Object -First 1).Matches[0].Groups[1].Value
    $actual = Get-Sha512Base64 $src
    if (-not $expected -or $expected -ne $actual) { throw "SHA-512 mismatch for $($exe.name) (expected $expected, got $actual). Not installing." }
    Write-Host "    SHA-512 verified against latest.yml"
    $verText = $rel.tag_name.TrimStart('v')
  }
  $ver = [version]($verText -replace '[^0-9.].*$', '')
  if ($ver -lt $MinVersion) {
    throw "Installer version $ver is older than $MinVersion. Builds before $MinVersion can install machine-wide (admin-only updates); publish $MinVersion+ first."
  }
  Write-Host "    Installer version $ver"

  # ── 2. Stage read-only in ProgramData ──────────────────────────────────────────────────────────────────
  Step "Staging installer at $StagedInstaller (users: read/run only)"
  Do-It {
    New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
    Copy-Item $src $StagedInstaller -Force
    # Break inheritance: ProgramData lets ordinary users create/modify files, and this exe runs inside
    # every account's sign-in, so no non-admin may be able to replace it.
    & icacls $StageDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE)" }
  } "copy installer + lock ACL (SYSTEM/Administrators full, Users read+execute)"

  # ── 3. Remove the old machine-wide install ─────────────────────────────────────────────────────────────
  $machine = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' -EA SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like 'FWW B2B Admin*' -and $_.QuietUninstallString -match '/allusers' }
  if ($machine) {
    Step "Removing machine-wide install $($machine.DisplayName) (admin-only updates)"
    $running = Get-Process -Name 'FWW B2B Admin' -EA SilentlyContinue | Where-Object { $_.Path -like "$env:ProgramFiles*" }
    if ($running) { Write-Host "    Closing $($running.Count) running machine-wide FWW B2B Admin process(es)" }
    Do-It {
      $running | Stop-Process -Force -EA SilentlyContinue
      Start-Sleep -Seconds 2
      if ($machine.QuietUninstallString -notmatch '^"([^"]+)"\s*(.*)$') { throw "Unexpected QuietUninstallString: $($machine.QuietUninstallString)" }
      $uninst = $Matches[1]; $uargs = $Matches[2]
      Start-Process -FilePath $uninst -ArgumentList $uargs -Wait -WindowStyle Hidden
      # NSIS uninstallers re-launch from %TEMP% and return early: wait until the uninstaller itself is gone.
      for ($i = 0; $i -lt 60 -and (Test-Path $uninst); $i++) { Start-Sleep -Seconds 1 }
      if (Test-Path $uninst) { throw "Machine-wide uninstall did not finish within 60s ($uninst still present)." }
    } "run: $($machine.QuietUninstallString)"
  } else {
    Step "No machine-wide FWW B2B Admin install found (nothing to remove)"
  }

  # ── 4. Active Setup: install for each account at its next sign-in ──────────────────────────────────────
  # Runs once per account (Windows records the Version under that account's HKCU). Skipped when the
  # account already has the per-user app, so a newer self-updated copy is never downgraded.
  $stub = "cmd.exe /d /c if not exist `"$PerUserExe`" `"$StagedInstaller`" /S"
  Step "Registering Active Setup (version $ActiveSetupVersion)"
  Do-It {
    New-Item -Path $ActiveSetupKey -Force | Out-Null
    Set-ItemProperty -Path $ActiveSetupKey -Name '(default)'   -Value 'FWW B2B Admin (per-user install)'
    Set-ItemProperty -Path $ActiveSetupKey -Name 'StubPath'    -Value $stub
    Set-ItemProperty -Path $ActiveSetupKey -Name 'Version'     -Value $ActiveSetupVersion
    New-ItemProperty -Path $ActiveSetupKey -Name 'IsInstalled' -Value 1 -PropertyType DWord -Force | Out-Null
  } "HKLM Active Setup StubPath = $stub"

  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
  Write-Host "  * Every account (including new ones) gets FWW B2B Admin at its NEXT sign-in, then updates itself with no admin prompt."
  Write-Host "  * For the account you are signed into now, either sign out and back in, or run this from a NORMAL (not admin) prompt:"
  Write-Host "      & `"$StagedInstaller`" /S"
  Write-Host "  * Per-account sign-in sessions were not touched."
} finally {
  Remove-Item $tmp -Recurse -Force -EA SilentlyContinue
}
