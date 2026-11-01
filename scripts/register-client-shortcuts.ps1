param(
    [Parameter(Mandatory=$true)][string]$State,
    [Parameter(Mandatory=$true)][string]$Config,
    [ValidatePattern('^[a-z][a-z0-9-]{0,47}$')][string]$Workspace='main',
    [string]$Node,
    [switch]$RepairWslShortcuts,
    [ValidateSet('original','next')][string]$Appearance='original'
)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$State=[IO.Path]::GetFullPath($State);$Config=[IO.Path]::GetFullPath($Config)
$settings=Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.format -ne 'starport-host-control' -or $settings.version -ne 1 -or $settings.wslg -ne $true) { throw 'configured_wslg_installation_required' }
if (Test-Path -LiteralPath $State -PathType Leaf) { throw 'control_state_directory_required' }
if (-not $Node) { . (Join-Path $PSScriptRoot 'node-path.ps1'); $Node=Get-StarportNode -Repo $repo }
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'node_required' }
$Node=[IO.Path]::GetFullPath($Node)
$launcher=Join-Path $PSScriptRoot 'launch-client.ps1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($p in @($State,$Config,$Node,$launcher)) { if ($p -match '["\r\n\x00]') { throw 'invalid_shortcut_path' } }
$hash=[Security.Cryptography.SHA256]::Create()
try { $id=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($State.ToLowerInvariant())))).Replace('-','').Substring(0,8).ToLowerInvariant() } finally { $hash.Dispose() }
$folder=Join-Path ([Environment]::GetFolderPath('Programs')) ('Starport Next '+$id)
$backup=Join-Path $State 'client-shortcut-backups'
$shell=New-Object -ComObject WScript.Shell
$items=@(@{app='browser';label='浏览器'},@{app='desktop';label='Claude Desktop'},@{app='terminal';label='Claude Code'})
$wslState=if($settings.wslState){$settings.wslState}else{'wsl'}
if ([IO.Path]::IsPathRooted($wslState) -or ($wslState -split '[/\\]') -contains '..') { throw 'relative_wsl_state_required' }
$wslDirectory=Join-Path (Split-Path $Config -Parent) $wslState
$receipt=Get-Content -LiteralPath (Join-Path $wslDirectory 'wsl.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$distribution=$receipt.distribution
if ($receipt.phase -ne 'installed' -or $distribution -cnotmatch '^StarportWork-[a-f0-9]{16}$') { throw 'owned_wsl_distribution_required' }
$oldFolder=Join-Path ([Environment]::GetFolderPath('Programs')) $distribution
$iconRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('Temp\WSLDVCPlugin\'+$distribution)))
$icons=Join-Path $State 'client-icons'
$originalNames=@{browser='Google Chrome';desktop='Claude';terminal='Claude Code'}
$originalIcons=@{browser='google-chrome.ico';desktop='Claude.ico';terminal='debian-xterm.ico'}
$clientsFile=Join-Path $wslDirectory 'clients.json'
$clients=if(Test-Path -LiteralPath $clientsFile -PathType Leaf){Get-Content -LiteralPath $clientsFile -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
if ($clients.browser -eq 'firefox') {
    $originalNames.browser='Workspace Browser';$originalIcons.browser='starport-browser.ico'
}
$written=@();$repaired=@()
$receiptFile=Join-Path $State ('client-shortcuts-'+$Workspace+'.json')
$previous=if(Test-Path -LiteralPath $receiptFile){Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
if ($previous -and ($previous.id -ne $id -or $previous.state -ne $State -or $previous.launcher -ne $launcher)) { throw 'client_shortcut_receipt_mismatch' }
function Get-LaunchArguments([string]$app) {
    return '-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launcher+'" -State "'+$State+'" -Workspace "'+$Workspace+'" -App '+$app+' -Node "'+$Node+'"'
}
function Save-LaunchLink($link,[string]$app,[string]$icon='') {
    $link.TargetPath=$powershell;$link.Arguments=Get-LaunchArguments $app
    $link.WorkingDirectory=$repo;$link.WindowStyle=7
    $link.Description='Starport Next project '+$Workspace+' via authenticated control ('+$id+')'
    if ($icon) { $link.IconLocation=$icon+',0' }
    elseif (-not $link.IconLocation) { $link.IconLocation=$powershell+',0' }
    $link.Save()
}
# Separate, persistent entries: WSL may regenerate its own menu directory.
$null=New-Item -ItemType Directory -Path $folder -Force
foreach ($item in $items) {
    $iconFile=Join-Path $icons ($item.app+'.ico')
    $sourceIcon=Join-Path $iconRoot $originalIcons[$item.app]
    if (Test-Path -LiteralPath $sourceIcon -PathType Leaf) {
        if ((Get-Item -LiteralPath $sourceIcon).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'shortcut_icon_symlink_rejected' }
        $null=New-Item -ItemType Directory -Path $icons -Force
        Copy-Item -LiteralPath $sourceIcon -Destination $iconFile -Force
    }
    $icon=if(Test-Path -LiteralPath $iconFile -PathType Leaf){$iconFile}else{''}
    foreach ($destination in @($folder,[Environment]::GetFolderPath('Desktop'))) {
        $name=if($Appearance -eq 'original'){$originalNames[$item.app]+' ('+$distribution+')'+$(if($Workspace -ne 'main'){' - '+$Workspace})+'.lnk'}else{'Starport Next - '+$item.label+' ('+$Workspace+'-'+$id+').lnk'}
        $file=Join-Path $destination $name
        $link=$shell.CreateShortcut($file)
        if ((Test-Path -LiteralPath $file) -and ($link.TargetPath -ne $powershell -or $link.Arguments -cne (Get-LaunchArguments $item.app))) { throw 'client_shortcut_owned_by_another_installation' }
        Save-LaunchLink $link $item.app $icon;$written+=$file
    }
}
if ($RepairWslShortcuts) {
    $commands=@{'/usr/bin/google-chrome-stable'='browser';'/usr/local/bin/starport-browser'='browser';'claude-desktop'='desktop'}
    foreach ($file in @(Get-ChildItem -LiteralPath $oldFolder -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
        $link=$shell.CreateShortcut($file.FullName)
        if ($link.TargetPath -ne (Join-Path $env:ProgramFiles 'WSL\wslg.exe')) { continue }
        foreach ($command in $commands.Keys) {
            if ($link.Arguments.TrimEnd() -cne ('-d '+$distribution+' --cd "~" -- '+$command)) { continue }
            $null=New-Item -ItemType Directory -Path $backup -Force
            $saved=Join-Path $backup $file.Name
            if (-not (Test-Path -LiteralPath $saved)) { Copy-Item -LiteralPath $file.FullName -Destination $saved }
            Save-LaunchLink $link $commands[$command];$repaired+=$file.FullName
        }
    }
}
# Retire only this receipt's old names, after checking exact path and command.
# Keep a copy so changing appearance is reversible; never remove a whole menu.
$retired=@($previous.retired|Where-Object{$_})
foreach ($old in @($previous.shortcuts|Where-Object{$_ -and $_ -notin $written})) {
    $full=[IO.Path]::GetFullPath($old)
    $parent=Split-Path $full -Parent
    if ($parent -notin @($folder,[Environment]::GetFolderPath('Desktop')) -or [IO.Path]::GetExtension($full) -ne '.lnk') { throw 'shortcut_retirement_path_mismatch' }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $link=$shell.CreateShortcut($full)
    if ($link.TargetPath -ne $powershell -or $link.Arguments -cnotin @($items|ForEach-Object{Get-LaunchArguments $_.app})) { throw 'shortcut_changed_preserve_user_version' }
    $archive=Join-Path $backup ('retired-'+[Guid]::NewGuid().ToString('N')+'.lnk')
    if (-not ([IO.Path]::GetFullPath($archive)).StartsWith([IO.Path]::GetFullPath($backup)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'shortcut_backup_path_mismatch' }
    $null=New-Item -ItemType Directory -Path $backup -Force
    Move-Item -LiteralPath $full -Destination $archive
    $retired+=@{original=$full;backup=$archive}
}
$record=@{format='starport-client-shortcuts';version=1;state=$State;workspace=$Workspace;id=$id;launcher=$launcher;node=$Node;appearance=$Appearance;shortcuts=$written;repaired=@(@($previous.repaired)+$repaired|Where-Object{$_}|Select-Object -Unique);backup=$backup;retired=$retired;icons=$icons}
$null=New-Item -ItemType Directory -Path $State -Force
[IO.File]::WriteAllText($receiptFile,($record|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
@{created=$written.Count;repaired=$repaired.Count;workspace=$Workspace;id=$id}|ConvertTo-Json -Compress
