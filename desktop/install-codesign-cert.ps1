# Installs the Fuzzywumpets internal code-signing certificate so Windows stops
# showing "unknown publisher" / SmartScreen warnings for FWW desktop apps.
#
# Run ONCE per machine, as Administrator:
#   powershell -ExecutionPolicy Bypass -File .\install-codesign-cert.ps1
#
# WHAT THIS DOES, PLAINLY: it adds a certificate you control to this machine's
# Trusted Root store. From then on, Windows trusts ANY program signed with the
# matching private key. That key lives only in Doppler (fww-shared/prd,
# WINDOWS_CSC_LINK + WINDOWS_CSC_KEY_PASSWORD) and in this repo's GitHub Actions
# secrets. If that key ever leaks, anything an attacker signs with it would be
# trusted on every machine where this script has been run — so rotate the cert
# and re-run this everywhere if you suspect exposure.
#
# Only the PUBLIC certificate is in this repo. It cannot sign anything.

$ErrorActionPreference = 'Stop'

$certPath   = Join-Path $PSScriptRoot 'fww-codesign-public.cer'
$thumbprint = '2CDFA8AEDA884BDEDC14B7B6AF91EB31B15A9928'

if (-not (Test-Path $certPath)) {
  throw "Certificate not found next to this script: $certPath"
}

# Refuse to install anything other than the cert we expect, even if the .cer file
# in the working directory has been swapped.
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $certPath
if ($cert.Thumbprint -ne $thumbprint) {
  throw "Unexpected certificate. Expected thumbprint $thumbprint but the file has $($cert.Thumbprint). Refusing to install."
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run this in an elevated PowerShell (Run as Administrator) - writing to LocalMachine Trusted Root requires it."
}

Write-Host "Installing: $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "Valid until: $($cert.NotAfter)"

# Root  -> Windows trusts the certificate chain at all.
# TrustedPublisher -> suppresses the "unknown publisher" prompt for signed installers.
foreach ($store in @('Root', 'TrustedPublisher')) {
  Import-Certificate -FilePath $certPath -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
  Write-Host "  added to LocalMachine\$store"
}

Write-Host ""
Write-Host "Done. Signed FWW installers will now show 'Fuzzywumpets' as a verified publisher on this machine." -ForegroundColor Green
Write-Host "To undo:  Get-ChildItem Cert:\LocalMachine\Root,Cert:\LocalMachine\TrustedPublisher | Where-Object Thumbprint -eq '$thumbprint' | Remove-Item"
