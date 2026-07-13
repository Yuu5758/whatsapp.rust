# Whatsapp.rust one-line installer — Windows.
#
#   irm https://raw.githubusercontent.com/Yuu5758/whatsapp-rust/master/install.ps1 | iex
#
# Downloads the latest published GitHub release installer (NSIS .exe, falling back
# to the .msi) and runs it.
$ErrorActionPreference = 'Stop'
$repo = 'Yuu5758/whatsapp-rust'
$app  = 'Whatsapp.rust'

Write-Host "Installing $app (latest)..." -ForegroundColor Green

try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'whatsapp-rust-installer' }
} catch {
  throw "Couldn't reach the GitHub release. Is $repo public with a published release? ($_)"
}

$asset = $rel.assets | Where-Object { $_.name -match '-setup\.exe$' } | Select-Object -First 1
if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match '\.msi$' } | Select-Object -First 1 }
if (-not $asset) { throw "No .exe/.msi installer in the latest release (the build may still be running)." }

$out = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing

Write-Host "Launching installer..."
if ($asset.name -match '\.msi$') {
  Start-Process msiexec.exe -ArgumentList "/i `"$out`"" -Wait
} else {
  Start-Process -FilePath $out -Wait
}
Write-Host "Done. Launch '$app' from the Start menu." -ForegroundColor Green
