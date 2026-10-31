param([string]$State='private\control',[string]$Config='private\host-control.json',[string]$Profile,[ValidateSet('api','native')][string]$Client='native')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'node-path.ps1')
$node=Get-StarportNode -Repo (Split-Path $PSScriptRoot -Parent)
if (-not $node) { throw 'Node.js 22 or newer is required. Run scripts/setup-control.ps1 -InstallPrerequisites.' }
$options=@('control','serve','--state',$State,'--config',$Config,'--client',$Client)
if ($Profile) { $options += @('--profile',$Profile) }
& $node (Join-Path $PSScriptRoot '..\bin\starport.mjs') @options
if ($LASTEXITCODE -ne 0) { throw 'Starport control stopped with an error.' }
