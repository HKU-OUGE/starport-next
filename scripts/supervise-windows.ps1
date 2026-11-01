param([Parameter(Mandatory=$true)][string]$Manifest,[switch]$Once)
$ErrorActionPreference='Stop'
$m=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$repo=Split-Path $PSScriptRoot -Parent
if ($m.format -ne 'starport-user-services' -or $m.version -ne 1 -or $m.repo -ne $repo -or $m.id -notmatch '^[a-f0-9]{16}$' -or [IO.Path]::GetFullPath($Manifest) -ne (Join-Path $m.state 'services-manifest.json')) { throw 'invalid_service_manifest' }
$mutex=[Threading.Mutex]::new($false,('Local\StarportNext-'+$m.id))
try { $acquired=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
if (-not $acquired) { $mutex.Dispose(); exit 0 }
$settings=Get-Content -LiteralPath $m.config -Raw | ConvertFrom-Json
$base=Split-Path $m.config -Parent
$record=Join-Path $m.state 'services.json'
$startedAt=[datetime]::UtcNow.ToString('o')
$logDir=Join-Path $m.state 'service-logs'
$null=New-Item -ItemType Directory -Path $logDir -Force
$services=@()
if ($settings.workerComputeFile) {
    $workerConfig=[IO.Path]::GetFullPath((Join-Path $base $settings.workerComputeFile))
    if (-not $workerConfig.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'relative_worker_configuration_required' }
    $w=Get-Content -LiteralPath $workerConfig -Raw | ConvertFrom-Json
    $workerBase=Split-Path $workerConfig -Parent
    $services+=@{id='compute';entry=(Join-Path $repo 'scripts\start-worker-compute.mjs');config=$workerConfig;state=[IO.Path]::GetFullPath((Join-Path $workerBase $w.state));port=[int]$w.port;proxy=[IO.Path]::GetFullPath((Join-Path $workerBase $w.proxyBinary))}
}
$services+=@{id='control';entry=(Join-Path $repo 'bin\starport.mjs');config=$m.config;state=$m.state;port=$(if($settings.port){[int]$settings.port}else{18884});proxy=$(if($settings.proxyBinary){[IO.Path]::GetFullPath((Join-Path $base $settings.proxyBinary))}else{$null})}
$nextAttempt=@{}
function Has-Argument($line,$value) {
    $escaped=[regex]::Escape($value)
    return $line -and [regex]::IsMatch($line,('(?:^|\s)(?:"'+$escaped+'"|'+$escaped+')(?=\s|$)'),[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Test-Owned($p,$s) {
    return $p -and $p.ExecutablePath -eq $m.node -and (Has-Argument $p.CommandLine $s.entry) -and (Has-Argument $p.CommandLine $s.config) -and ($s.id -ne 'control' -or (Has-Argument $p.CommandLine $s.state))
}
function Ensure-Service($s,$processes,$listeners) {
    $listeners=@($listeners | Where-Object { $_.LocalPort -eq $s.port })
    if ($listeners.Count) {
        foreach ($listener in $listeners) { if ($listener.LocalAddress -ne '127.0.0.1' -or -not (Test-Owned ($processes | Where-Object ProcessId -eq $listener.OwningProcess | Select-Object -First 1) $s)) { return @{id=$s.id;phase='conflict';error='port_owned_by_another_process'} } }
        return @{id=$s.id;phase='running';pid=$listeners[0].OwningProcess;port=$s.port}
    }
    $existing=@($processes | Where-Object { Test-Owned $_ $s })
    if ($existing.Count) { return @{id=$s.id;phase='starting';pid=$existing[0].ProcessId;port=$s.port} }
    if ($nextAttempt[$s.id] -and [datetime]::UtcNow -lt $nextAttempt[$s.id]) { return @{id=$s.id;phase='retrying';port=$s.port} }
    $nextAttempt[$s.id]=[datetime]::UtcNow.AddSeconds(30)
    $lock=Join-Path $s.state 'control.lock'
    if ($s.id -eq 'control' -and (Test-Path -LiteralPath $lock)) {
        $old=Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
        if ($old.pid -isnot [int] -and $old.pid -isnot [long]) { throw 'invalid_control_lock' }
        if ($processes | Where-Object ProcessId -eq $old.pid) { throw 'control_lock_requires_reconciliation' }
        Remove-Item -LiteralPath $lock
    }
    # A crashed Node parent can leave its own proxy behind. Never stop live parents
    # or proxies outside this exact installation directory and executable.
    $proxyDir=Join-Path $s.state 'egress-private'
    foreach ($p in $processes) {
        if ($s.proxy -and $p.ExecutablePath -eq $s.proxy -and (Has-Argument $p.CommandLine $proxyDir) -and -not ($processes | Where-Object ProcessId -eq $p.ParentProcessId)) {
            $fresh=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ProcessId)
            if ($fresh -and $fresh.CreationDate -eq $p.CreationDate -and $fresh.ExecutablePath -eq $s.proxy) { Stop-Process -Id $p.ProcessId }
        }
    }
    if ($s.id -eq 'control') {
        $client=if($settings.apiKeyFile){'api'}else{'native'}
        $argv=@(('"'+$s.entry+'"'),'control','serve','--state',('"'+$s.state+'"'),'--config',('"'+$s.config+'"'),'--client',$client)
    } else { $argv=@(('"'+$s.entry+'"'),'--config',('"'+$s.config+'"')) }
    $stamp=[datetime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $child=Start-Process -FilePath $m.node -ArgumentList $argv -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir ($s.id+'-'+$stamp+'.out.log')) -RedirectStandardError (Join-Path $logDir ($s.id+'-'+$stamp+'.err.log'))
    return @{id=$s.id;phase='starting';pid=$child.Id;port=$s.port}
}
try {
    do {
        $rows=@()
        try {
            $processes=@(Get-CimInstance Win32_Process)
            $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
            foreach ($s in $services) {
                try { $rows+=Ensure-Service $s $processes $listeners }
                catch { $code=if($_.Exception.Message -match '^[a-z][a-z0-9_]{1,79}$'){$_.Exception.Message}else{'service_start_failed'}; $rows+=@{id=$s.id;phase='failed';error=$code} }
            }
            $receipt=@{format='starport-user-services-status';version=1;pid=$PID;startedAt=$startedAt;checkedAt=[datetime]::UtcNow.ToString('o');services=$rows}
            $temp=$record+'.tmp'
            [IO.File]::WriteAllText($temp,($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temp -Destination $record -Force
        } catch { # Transient Windows queries must not create replacement processes.
            [IO.File]::WriteAllText((Join-Path $logDir 'supervisor-error.txt'),'service_inspection_failed',[Text.UTF8Encoding]::new($false))
        }
        if (-not $Once) { Start-Sleep -Seconds 10 }
    } while (-not $Once)
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
