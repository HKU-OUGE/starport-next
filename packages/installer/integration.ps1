param([Parameter(Mandatory=$true)][string]$Root,[ValidateSet('register','remove')][string]$Action='register')
$ErrorActionPreference='Stop'
trap { Write-Output ('integration_failed: '+$_.Exception.Message); Write-Output $_.InvocationInfo.PositionMessage; exit 1 }
$r=Get-Content -LiteralPath (Join-Path $Root 'installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($r.format -ne 'starport-installation' -or $r.root -ne $Root -or $r.id -notmatch '^[a-f0-9]{32}$'){throw 'installation_ownership_mismatch'}
$reg='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StarportNext-'+$r.id
Add-Type -Path (Join-Path $PSScriptRoot 'ShellLink.cs')
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Starport Next'
$node=[IO.Path]::GetFullPath((Join-Path $Root 'runtime/node.exe'))
$entry=[IO.Path]::GetFullPath((Join-Path $Root 'app/packages/installer/cli.mjs'))
$managerArgs='"'+$entry+'" --source "'+$Root+'" --target "'+$Root+'"'
$links=@(@{Name='Starport Next';Args=($managerArgs+' --start')},@{Name='Starport Next - 安装与卸载';Args=$managerArgs})
foreach($item in $links){
 $file=Join-Path $menu ($item.Name+' - '+$r.id.Substring(0,8)+'.lnk')
 if(Test-Path -LiteralPath $file){$old=[StarportLink]::Read($file);if($old[0] -ne $node -or $old[1] -cne $item.Args){throw 'shortcut_ownership_mismatch'}}
 if($Action -eq 'remove'){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file};continue}
 New-Item -ItemType Directory -Force $menu|Out-Null
 [StarportLink]::Save($file,$node,$item.Args,$Root)
}
if($Action -eq 'register'){
 New-Item -Path $reg -Force|Out-Null
 New-ItemProperty -Path $reg -Name DisplayName -Value 'Starport Next' -Force|Out-Null
 New-ItemProperty -Path $reg -Name DisplayVersion -Value '0.3.0-beta.1' -Force|Out-Null
 New-ItemProperty -Path $reg -Name InstallLocation -Value $Root -Force|Out-Null
 New-ItemProperty -Path $reg -Name UninstallString -Value ('"'+$node+'" '+$managerArgs+' --uninstall') -Force|Out-Null
 New-ItemProperty -Path $reg -Name NoModify -Value 1 -PropertyType DWord -Force|Out-Null
 New-ItemProperty -Path $reg -Name NoRepair -Value 1 -PropertyType DWord -Force|Out-Null
}else{if(Test-Path -LiteralPath $reg){$v=Get-ItemProperty -LiteralPath $reg;if($v.InstallLocation -ne $Root){throw 'uninstall_registration_changed'};Remove-Item -LiteralPath $reg -Recurse}}
