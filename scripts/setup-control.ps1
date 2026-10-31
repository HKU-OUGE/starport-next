param([switch]$InstallPrerequisites)
$ErrorActionPreference='Stop'
$Repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'node-path.ps1')
$Node=Get-StarportNode -Repo $Repo
if (-not $Node -and $InstallPrerequisites) {
  $Arch=if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }
  $Version='22.23.1'
  $Name="node-v$Version-win-$Arch.zip"
  $Runtime=Join-Path $Repo 'private/runtime'
  New-Item -ItemType Directory -Force $Runtime | Out-Null
  $Sums=(Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$Version/SHASUMS256.txt").Content
  $Line=@($Sums -split "`n" | Where-Object { $_.TrimEnd().EndsWith("  $Name") })
  if ($Line.Count -ne 1) { throw 'Official Node checksum missing.' }
  $Hash=($Line[0] -split '\s+')[0].ToLowerInvariant()
  $Zip=Join-Path $Runtime $Name
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$Version/$Name" -OutFile $Zip
  if ((Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'Node checksum mismatch.' }
  Expand-Archive -Path $Zip -DestinationPath $Runtime -Force
  Remove-Item -LiteralPath $Zip
  $Node=Get-StarportNode -Repo $Repo
}
if (-not $Node) { throw 'Node.js 22+ required. Rerun with -InstallPrerequisites.' }
$Npm=Join-Path (Split-Path $Node -Parent) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path $Npm)) { throw 'npm-cli.js is missing from this Node installation.' }
Push-Location $Repo
try {
  & $Node $Npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  if (-not (Test-Path 'private/host-control.json')) {
    & $Node 'bin/starport.mjs' control init --out 'private/host-control.json'
    if ($LASTEXITCODE -ne 0) { throw 'Control configuration initialization failed.' }
  }
} finally { Pop-Location }
Write-Output 'Control ready. Next: scripts/setup-wsl.ps1; then scripts/start-control.ps1.'
Write-Output 'No QEMU, global PATH change, cloud resource, or login-startup task was created.'
