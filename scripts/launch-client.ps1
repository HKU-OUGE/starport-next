param(
    [Parameter(Mandatory=$true)][string]$State,
    [ValidateSet('browser','desktop','terminal','login')][string]$App='browser',
    [ValidatePattern('^[a-z][a-z0-9-]{0,47}$')][string]$Workspace='main',
    [string]$Node,
    [switch]$NoDialog
)
$ErrorActionPreference='Stop'
$failure='client_launch_failed'
try {
    if (-not $Node) { . (Join-Path $PSScriptRoot 'node-path.ps1'); $Node=Get-StarportNode -Repo (Split-Path $PSScriptRoot -Parent) }
    if (-not $Node) { $failure='node_required'; throw $failure }
    $output=& $Node (Join-Path $PSScriptRoot 'launch-client.mjs') --state ([IO.Path]::GetFullPath($State)) --workspace $Workspace --app $App
    $result=$output | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $result.ok) { $failure=$result.error; throw $failure }
    if ($NoDialog) { $output }
} catch {
    if ($NoDialog) { @{ok=$false;error=$failure}|ConvertTo-Json -Compress; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    $messages=@{
        close_existing_display_first='此项目正在网页桌面运行。请先在控制面板点击“关闭工作区应用”，再打开本机窗口。'
        control_not_running='控制端尚未运行。请先启动 Starport Next 服务，再打开应用。'
        control_unreachable='无法连接本机控制端。请检查 Starport Next 服务。'
        wslg_authorization_required='此安装尚未启用 WSLg，请在安装配置中先启用。'
        workspace_verification_required='请先在控制面板验证项目边界，再打开应用。'
        workspace_verification_failed='项目边界验证未通过，请在控制面板检查。'
        enable_controlled_egress_first='受控出口已暂停，请在控制面板恢复后再打开应用。'
        launch_outcome_unknown='启动结果尚未确认。请检查已有窗口和控制面板，再决定是否重试。'
        native_app_stopped='应用启动后退出，请检查项目内的应用日志。'
    }
    $message=$messages[$failure]
    if (-not $message) { $message='应用未能启动，请检查控制面板。错误：'+$failure }
    $null=[Windows.Forms.MessageBox]::Show($message,'Starport Next',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Information)
    exit 1
}
