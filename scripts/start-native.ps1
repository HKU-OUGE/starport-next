param(
  [string]$State = 'private/native-workspace',
  [string]$Profile = 'profiles/imported',
  [string]$PasswordFile,
  [switch]$InstallClients,
  [switch]$Login
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'node-path.ps1')
$Node = Get-StarportNode -Repo $Repo
if (-not $Node) { throw 'Run scripts/setup-local.ps1 first.' }
$Cli = Join-Path $Repo 'bin/starport.mjs'
Push-Location $Repo
try {
  if (-not (Test-Path (Join-Path $State 'machine.json'))) {
    & $Node $Cli local prepare --state $State --memory-mib 4096
    if ($LASTEXITCODE -ne 0) { throw 'Workspace preparation failed.' }
  }
  $StartArgs = @($Cli,'local','start','--state',$State,'--profile',$Profile,'--client','native')
  if ($PasswordFile) { $StartArgs += @('--password-file',$PasswordFile) }
  $Started = & $Node @StartArgs
  if ($LASTEXITCODE -ne 0) { throw 'Workspace start failed; an existing workspace was not stopped.' }
  $Started | Write-Output
  if (-not (($Started | ConvertFrom-Json).reused)) {
    & $Node $Cli local verify --state $State
    if ($LASTEXITCODE -ne 0) { throw 'Isolation check failed.' }
  }
  if ($InstallClients) {
    & $Node $Cli local native-install --state $State
    if ($LASTEXITCODE -ne 0) { throw 'Native client installation failed.' }
  }
  $View = & $Node $Cli local native-ui --state $State
  if ($LASTEXITCODE -ne 0) { throw 'Workspace display failed.' }
  $Url = ($View | ConvertFrom-Json).url
  $Parsed = [Uri]$Url
  if ($Parsed.Scheme -ne 'http' -or $Parsed.Host -ne '127.0.0.1') { throw 'Refusing a non-loopback display URL.' }
  Start-Process $Url
  & $Node $Cli local native-desktop --state $State
  if ($LASTEXITCODE -ne 0) { throw 'Desktop launch failed.' }
  if ($Login) {
    & $Node $Cli local native-login --state $State
    if ($LASTEXITCODE -ne 0) { throw 'Account login launch failed.' }
  }
} finally { Pop-Location }
