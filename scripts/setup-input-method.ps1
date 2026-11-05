param(
  [string]$State="private/wsl",
  [string]$Config="private/host-control.json",
  [string]$ControlState="private/control",
  [string]$Workspace="main",
  [switch]$VerifyOnly
)
$ErrorActionPreference='Stop'
$Repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'node-path.ps1')
$Node=Get-StarportNode -Repo $Repo
if (-not $Node) { throw 'Node.js 22+ required.' }
Push-Location $Repo
try {
  if (-not $VerifyOnly) {
    # The update holds the owned runtime lease and refuses active projects.
    & $Node 'bin/starport.mjs' wsl update-runtime --state $State
    if ($LASTEXITCODE -ne 0) { throw 'Close this installation project apps/operations first. No global WSL shutdown is used.' }
    & $Node 'bin/starport.mjs' wsl ime-install --state $State --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Input method installation failed. Check the private installer log; rerun after the cause is resolved.' }
    Write-Output 'Input method packages and runtime updated.'
    Write-Output 'Restart only this installation control process when idle, verify the boundary, then open the three clients.'
    Write-Output 'Chinese defaults to Traditional. Ctrl+Space switches English; Simplified is an explicit option.'
    Write-Output 'Run this script again with -VerifyOnly; then complete docs/INPUT-METHODS.md manual checks.'
  } else {
    & $Node 'scripts/verify-ime.mjs' --state $ControlState --workspace $Workspace
    if ($LASTEXITCODE -ne 0) { throw 'Input method preflight needs attention.' }
  }
} finally { Pop-Location }
