param([ValidateSet('desktop-dsw','single-machine','server-hosted')][string]$Preset = 'desktop-dsw')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$StarportNode = (Get-Command node -ErrorAction Stop).Source
& $StarportNode -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or newer is required.' }
New-Item -ItemType Directory -Force profiles | Out-Null
& $StarportNode bin/starport.mjs init --preset $Preset --out profiles/default
if ($LASTEXITCODE -ne 0) { throw 'Profile initialization failed; existing profiles were preserved.' }
& $StarportNode bin/starport.mjs plan --profile profiles/default
if ($LASTEXITCODE -ne 0) { throw 'Configuration planning failed.' }
