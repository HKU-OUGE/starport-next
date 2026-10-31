param(
  [switch]$InstallPrerequisites,
  [switch]$EnableHypervisor,
  [switch]$InstallOpenSSH,
  [switch]$ConfigureFeaturesOnly,
  [string]$State = 'private/local-workspace'
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
if ($ConfigureFeaturesOnly) {
  if ($EnableHypervisor) {
    $result = Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart
    Write-Output "Hypervisor Platform enabled. Restart needed: $($result.RestartNeeded)"
  }
  if ($InstallOpenSSH) { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null }
  exit 0
}
if ($EnableHypervisor -or $InstallOpenSSH) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-ConfigureFeaturesOnly')
  if ($EnableHypervisor) { $arguments += '-EnableHypervisor' }
  if ($InstallOpenSSH) { $arguments += '-InstallOpenSSH' }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw 'Windows feature setup did not complete.' }
  Write-Output 'If Windows requests a restart, restart before launching a workspace. No restart was forced.'
}
. (Join-Path $PSScriptRoot 'node-path.ps1')
$Node = Get-StarportNode -Repo $Repo
if ($InstallPrerequisites) {
  if (-not $Node) {
    # Private portable runtime: no system PATH rewrite and no replacement of another project's Node.
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This Windows runtime currently requires x64.' }
    $Runtime = Join-Path $Repo 'private/runtime'
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    $Version = '22.23.1'
    $Archive = "node-v$Version-win-x64.zip"
    $Zip = Join-Path $Runtime $Archive
    $Sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$Version/SHASUMS256.txt").Content
    $Line = ($Sums -split "`n" | Where-Object { $_.TrimEnd().EndsWith("  $Archive") })
    if (@($Line).Count -ne 1) { throw 'Official Node checksum missing.' }
    $Digest = ($Line -split '\s+')[0].ToLowerInvariant()
    if (-not (Test-Path $Zip)) { Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$Version/$Archive" -OutFile $Zip }
    if ((Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Digest) { throw 'Node checksum mismatch; archive preserved for inspection.' }
    Expand-Archive -Path $Zip -DestinationPath $Runtime -Force
    Remove-Item -LiteralPath $Zip
    $Node = Get-StarportNode -Repo $Repo
  }
  $Qemu = Join-Path $env:ProgramFiles 'qemu/qemu-system-x86_64.exe'
  if (-not (Test-Path $Qemu) -and -not (Get-Command qemu-system-x86_64.exe -ErrorAction SilentlyContinue)) {
    $Winget = (Get-Command winget.exe -ErrorAction Stop).Source
    & $Winget install --exact --id SoftwareFreedomConservancy.QEMU --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'QEMU installation failed. Inspect the installer output.' }
  }
}
if (-not $Node) { throw 'Node.js 22+ is missing. Rerun with -InstallPrerequisites or install it from nodejs.org.' }
& $Node (Join-Path $Repo 'bin/starport.mjs') local doctor
if ($LASTEXITCODE -ne 0) { throw 'Runtime not ready. Check QEMU, OpenSSH, Hypervisor Platform and any pending restart.' }
Write-Output ('Prepare: & "' + $Node + '" "' + (Join-Path $Repo 'bin/starport.mjs') + '" local prepare --state "' + $State + '" --memory-mib 4096')
Write-Output 'Then follow docs/NATIVE-CLIENTS.md to import configuration and start. WSL2 is not required.'
