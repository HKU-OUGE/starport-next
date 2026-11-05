param([Parameter(Mandatory=$true)][string]$State,[Parameter(Mandatory=$true)][string]$Repo)
$ErrorActionPreference='Stop'
$file=Join-Path $State 'services.json'
if(-not(Test-Path -LiteralPath $file)){exit 0}
$r=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json
if($r.format -ne 'starport-user-services-status'){throw 'invalid_supervisor_receipt'}
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$r.pid)
if(-not $p){exit 0}
$entry=Join-Path $Repo 'scripts/supervise-windows.ps1'
$manifest=Join-Path $State 'services-manifest.json'
if($p.Name -notin @('powershell.exe','pwsh.exe') -or -not $p.CommandLine.Contains($entry) -or -not $p.CommandLine.Contains($manifest)){throw 'supervisor_ownership_unconfirmed'}
$creation=[datetime]$p.CreationDate
$recorded=[datetime]$r.startedAt
if([math]::Abs(($creation.ToUniversalTime()-$recorded.ToUniversalTime()).TotalSeconds) -gt 60){throw 'supervisor_generation_changed'}
$fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$r.pid)
if($fresh.CreationDate -ne $p.CreationDate){throw 'supervisor_generation_changed'}
Stop-Process -Id $p.ProcessId
