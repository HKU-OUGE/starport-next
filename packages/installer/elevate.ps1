param([switch]$Elevated,[switch]$NeedWsl,[switch]$NeedSsh)
$ErrorActionPreference='Stop'
if (-not $Elevated) {
  $argsList=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Elevated')
  if ($NeedWsl) { $argsList+='-NeedWsl' }
  if ($NeedSsh) { $argsList+='-NeedSsh' }
  try { $child=Start-Process powershell.exe -Verb RunAs -ArgumentList $argsList -Wait -PassThru }
  catch { Write-Output 'administrator_authorization_cancelled'; exit 1223 }
  exit $child.ExitCode
}
if ($NeedWsl) {
  & wsl.exe --install --no-distribution
  if ($LASTEXITCODE -ne 0) { exit 3010 }
}
if ($NeedSsh) {
  $feature=Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0'
  if ($feature.State -ne 'Installed') { $result=Add-WindowsCapability -Online -Name $feature.Name; if($result.RestartNeeded){exit 3010} }
}
