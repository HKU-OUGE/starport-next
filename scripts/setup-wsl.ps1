param(
  [string]$State = 'private\wsl',
  [string]$Rootfs,
  [string]$Sha256,
  [switch]$InstallWsl
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'node-path.ps1')
$node = Get-StarportNode -Repo (Split-Path $PSScriptRoot -Parent)
if (-not $node) { throw 'Run scripts/setup-control.ps1 -InstallPrerequisites first to install Node.js.' }
if ($InstallWsl) {
  # Only enable WSL. Never replace the default distribution or stop existing ones.
  $p = Start-Process wsl.exe -Verb RunAs -ArgumentList '--install','--no-distribution' -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw 'WSL installation requires attention. Restart Windows if requested, then rerun.' }
}
& wsl.exe --status
if ($LASTEXITCODE -ne 0) { throw 'WSL2 is required. Run this script with -InstallWsl.' }
if (-not $Rootfs) {
  $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'amd64' }
  $name = "ubuntu-noble-wsl-$arch-24.04lts.rootfs.tar.gz"
  $url = 'https://cloud-images.ubuntu.com/wsl/releases/noble/current/'
  $cache = Join-Path ([System.IO.Path]::GetFullPath($State)) 'downloads'
  New-Item -ItemType Directory -Force $cache | Out-Null
  $Rootfs = Join-Path $cache $name
  $sums = (Invoke-WebRequest -Uri ($url + 'SHA256SUMS') -UseBasicParsing).Content
  $line = ($sums -split "`n" | Where-Object { $_ -match ([regex]::Escape($name) + '$') } | Select-Object -First 1)
  if (-not $line -or $line -notmatch '^([a-f0-9]{64})\s+') { throw 'Official rootfs digest not found.' }
  $Sha256 = $Matches[1]
  if (-not (Test-Path $Rootfs) -or (Get-FileHash -Algorithm SHA256 $Rootfs).Hash.ToLower() -ne $Sha256) {
    Invoke-WebRequest -Uri ($url + $name) -OutFile ($Rootfs + '.partial') -UseBasicParsing
    if ((Get-FileHash -Algorithm SHA256 ($Rootfs + '.partial')).Hash.ToLower() -ne $Sha256) { throw 'Rootfs checksum mismatch.' }
    Move-Item ($Rootfs + '.partial') $Rootfs -Force
  }
}
if (-not $Sha256) { throw 'Provide -Sha256 with an explicit rootfs.' }
& $node (Join-Path $PSScriptRoot '..\bin\starport.mjs') wsl install --state $State --rootfs $Rootfs --sha256 $Sha256
if ($LASTEXITCODE -ne 0) { throw 'WSL setup failed; inspect the reported phase before rerunning.' }
