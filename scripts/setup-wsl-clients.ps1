param([string]$State='private\wsl',[string]$Config='private\host-control.json',[switch]$EnableWslg)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'node-path.ps1')
$node=Get-StarportNode -Repo (Split-Path $PSScriptRoot -Parent)
if (-not $node) { throw 'Node.js 22 or newer is required.' }
$cli=Join-Path $PSScriptRoot '..\bin\starport.mjs'
& $node $cli wsl clients-install --state $State --config $Config
if ($LASTEXITCODE -ne 0) { throw 'Client installation failed. Inspect the private installation log before retrying.' }
& $node $cli wsl update-runtime --state $State
if ($LASTEXITCODE -ne 0) { throw 'Runtime update failed. Stop workspace operations and reconcile the recorded update phase.' }
if ($EnableWslg) {
    $file=[IO.Path]::GetFullPath($Config)
    $configuration=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $configuration | Add-Member -NotePropertyName wslg -NotePropertyValue $true -Force
    [IO.File]::WriteAllText($file,($configuration|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))
    Write-Output 'WSLg enabled: graphical apps share Windows display and clipboard. Restart the control process and verify the boundary.'
}
Write-Output 'Clients installed. Verify the workspace, then use the control panel to open the browser, Claude Desktop and Claude Code.'
Write-Output 'Official account login and a real SDK API task are separate acceptance steps.'
