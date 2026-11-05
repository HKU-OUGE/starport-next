param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][string]$Nonce)
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
$dir=[IO.Path]::GetFullPath($Directory)
if(-not $dir.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $dir -Leaf) -notmatch '^starport-manager-[a-f0-9]{32}$'){exit 2}
$marker=Join-Path $dir 'manager-owner.json'
$m=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json
if($m.nonce -cne $Nonce -or $m.pid -ne $OwnerPid){exit 3}
for($i=0;$i -lt 120;$i++){
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$OwnerPid)
 if(-not $p -or $p.ExecutablePath -ne (Join-Path $dir 'runtime/node.exe')){Start-Sleep -Milliseconds 300;Remove-Item -LiteralPath $dir -Recurse -Force;exit 0}
 Start-Sleep -Seconds 1
}
