param([string]$State='private\control')
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This access-code window requires Windows.' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run this script with powershell -STA.' }
$statePath=[IO.Path]::GetFullPath($State)
$record=Get-Content -LiteralPath (Join-Path $statePath 'control.json') -Raw | ConvertFrom-Json
if ($record.phase -ne 'running' -or ($record.port -isnot [int] -and $record.port -isnot [long]) -or $record.port -lt 1024 -or $record.port -gt 65535) {
    throw 'Start the control service before opening its access-code window.'
}
$address='http://127.0.0.1:'+$record.port
$key=(Get-Content -LiteralPath (Join-Path $statePath 'panel-key.json') -Raw | ConvertFrom-Json).key
if ($key -isnot [string] -or $key -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid panel-key file.' }
# Validate the saved code against the loopback control service, without logging it.
$null=Invoke-WebRequest -Uri ($address+'/api/login') -Method Post -UseBasicParsing -TimeoutSec 5 `
    -Headers @{Origin=$address} -ContentType 'application/json' -Body (@{key=$key}|ConvertTo-Json -Compress)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StarportAccessWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text='Starport Next - 访问码'
$form.ClientSize=New-Object Drawing.Size(620,270)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.MinimizeBox=$false
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$form.AutoScaleMode='Dpi'
$heading=New-Object Windows.Forms.Label
$heading.Text='Starport Next 控制台已就绪'
$heading.Font=New-Object Drawing.Font('Microsoft YaHei UI',14,[Drawing.FontStyle]::Bold)
$heading.SetBounds(20,18,580,32)
$location=New-Object Windows.Forms.Label
$location.Text='面板地址：'+$address+'/'
$location.SetBounds(20,58,580,26)
$codeBox=New-Object Windows.Forms.TextBox
$codeBox.Text=$key
$codeBox.ReadOnly=$true
$codeBox.UseSystemPasswordChar=$true
$codeBox.AccessibleName='本机控制台访问码'
$codeBox.SetBounds(20,94,580,30)
$show=New-Object Windows.Forms.CheckBox
$show.Text='显示访问码'
$show.SetBounds(20,132,180,28)
$show.Add_CheckedChanged({$codeBox.UseSystemPasswordChar=-not $show.Checked})
$status=New-Object Windows.Forms.Label
$status.Text='点击“复制访问码”，然后粘贴到面板登录框。'
$status.SetBounds(20,166,580,26)
$copy=New-Object Windows.Forms.Button
$copy.Text='复制访问码'
$copy.SetBounds(20,207,150,38)
$copy.Add_Click({
    try {
        [Windows.Forms.Clipboard]::SetText($codeBox.Text)
        $status.Text='访问码已复制，可以粘贴到面板登录框。'
    } catch {
        $status.Text='剪贴板暂不可用，请显示访问码后手动复制。'
    }
})
$open=New-Object Windows.Forms.Button
$open.Text='打开面板'
$open.SetBounds(184,207,150,38)
$open.Add_Click({Start-Process ($address+'/')})
$close=New-Object Windows.Forms.Button
$close.Text='关闭'
$close.SetBounds(450,207,150,38)
$close.DialogResult=[Windows.Forms.DialogResult]::OK
$form.CancelButton=$close
$form.Controls.AddRange(@($heading,$location,$codeBox,$show,$status,$copy,$open,$close))
$form.Add_Shown({
    # The parent may hide its console through STARTUPINFO. Explicitly show only
    # our own requested dialog after its first ShowWindow consumes that flag.
    $null=[StarportAccessWindow]::ShowWindow($form.Handle,5)
    $form.Activate()
    $null=$copy.Focus()
})
try { $null=$form.ShowDialog() }
finally { $codeBox.Clear();$key=$null;$form.Dispose() }
