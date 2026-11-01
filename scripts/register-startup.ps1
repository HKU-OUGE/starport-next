param(
    [ValidateSet('enable','disable','status','start')][string]$Action='status',
    [string]$State='private\control',
    [string]$Config='private\host-control.json',
    [string]$Node
)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$State=[IO.Path]::GetFullPath($State)
$Config=[IO.Path]::GetFullPath($Config)
$manifestFile=Join-Path $State 'services-manifest.json'
$supervisor=Join-Path $PSScriptRoot 'supervise-windows.ps1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hash=[Security.Cryptography.SHA256]::Create()
try { $id=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($State.ToLowerInvariant())))).Replace('-','').Substring(0,16).ToLowerInvariant() } finally { $hash.Dispose() }
$name='Starport Next '+$id+'.lnk'
$shortcutFile=Join-Path ([Environment]::GetFolderPath('Startup')) $name
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$supervisor+'" -Manifest "'+$manifestFile+'"'
$approvalKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
$shell=New-Object -ComObject WScript.Shell

function Read-OwnedShortcut {
    if (-not (Test-Path -LiteralPath $shortcutFile)) { return $null }
    $link=$shell.CreateShortcut($shortcutFile)
    if ($link.TargetPath -ne $powershell -or $link.Arguments -cne $arguments) { throw 'startup_entry_owned_by_another_installation' }
    return $link
}
function Get-Disabled {
    if (-not (Test-Path -LiteralPath $approvalKey)) { return $false }
    $value=(Get-Item -LiteralPath $approvalKey).GetValue($name,$null)
    return ($value -is [byte[]] -and $value.Length -ge 12 -and ($value[0] -band 1) -eq 1)
}
function Read-Manifest {
    if (-not (Test-Path -LiteralPath $manifestFile)) { throw 'startup_registration_required' }
    $m=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($m.format -ne 'starport-user-services' -or $m.version -ne 1 -or $m.state -ne $State -or $m.repo -ne $repo -or $m.config -ne $Config) { throw 'startup_manifest_mismatch' }
    return $m
}
$link=Read-OwnedShortcut
if ($Action -eq 'enable') {
    if (-not $Node) { . (Join-Path $PSScriptRoot 'node-path.ps1'); $Node=Get-StarportNode -Repo $repo }
    if (-not $Node) { throw 'node_required' }
    $Node=[IO.Path]::GetFullPath($Node)
    foreach ($p in @($State,$Config,$Node,$supervisor,$manifestFile)) { if ($p -match '["\r\n\x00]') { throw 'invalid_service_path' } }
    if (-not (Test-Path -LiteralPath $State -PathType Container) -or -not (Test-Path -LiteralPath $Config -PathType Leaf) -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'configured_installation_required' }
    $settings=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($settings.format -ne 'starport-host-control' -or $settings.version -ne 1) { throw 'invalid_control_configuration' }
    if (Test-Path -LiteralPath $manifestFile) { $m=Read-Manifest; if ($m.node -ne $Node) { throw 'startup_node_changed_reconcile_first' } }
    $manifest=@{format='starport-user-services';version=1;repo=$repo;state=$State;config=$Config;node=$Node;id=$id}
    [IO.File]::WriteAllText($manifestFile,($manifest|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    if (-not $link) { $link=$shell.CreateShortcut($shortcutFile) }
    $link.TargetPath=$powershell; $link.Arguments=$arguments; $link.WorkingDirectory=$repo
    $link.WindowStyle=7; $link.Description='Starport Next user services'; $link.Save()
    if (Get-Disabled) { Remove-ItemProperty -LiteralPath $approvalKey -Name $name }
} elseif ($Action -eq 'disable') {
    if ($link) { Remove-Item -LiteralPath $shortcutFile }
} elseif ($Action -eq 'start') {
    $null=Read-Manifest
    Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden
}
$registered=Test-Path -LiteralPath $shortcutFile
@{registered=$registered;enabled=($registered -and -not (Get-Disabled));kind='current-user-login';id=$id;manifestPresent=(Test-Path -LiteralPath $manifestFile)} | ConvertTo-Json -Compress
