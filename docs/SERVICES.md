# Windows 登录启动与服务管理

Windows 版本提供当前用户的后台守护程序，同时管理控制面板和独立计算连接。
它在当前用户登录后运行，使用该用户已经安装的 WSL2 发行版；不是登录前运行的
Windows SCM 系统服务。不保存 Windows 密码，不要求管理员权限。

## 注册已有安装

先完成安装、配置和边界验证。取得用户的登录启动选择；当前对话中已经授权时直接执行。
状态、配置及 Node 路径都必须使用本次部署的实际路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Action enable -State private/control -Config private/host-control.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Action start -State private/control -Config private/host-control.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Action status -State private/control -Config private/host-control.json
```

可用 `-Node <node.exe 的路径>` 指定安装器准备的 Node 22+。注册脚本在当前用户 Startup
目录创建带部署摘要的专属快捷方式，并在控制状态目录保存 `services-manifest.json`。
重做相同注册不会产生多个入口；目标同名但内容不同则拒绝覆盖。注册不复制凭据，
不会改动 Pi、其他部署或其他用户的启动项。

独立计算连接需要在 `host-control.json` 中声明相对路径：

```json
{ "workerComputeFile": "worker-compute.json" }
```

多服务器在 `computeNodes` 每个条目内填写 `workerComputeFile`，见
[MULTI-SERVER.md](MULTI-SERVER.md)。每个 worker 使用不同端口和状态目录；守护独立
检查、接管和恢复各节点。旧配置保留 `compute` 服务 ID，多节点使用 `compute-ID`。
修改节点列表后需重启守护以重新读取配置；原有匹配的 worker 会被接管。

守护程序每十秒检查进程和本机监听端口。只接管与本部署 Node、入口、配置和状态路径
匹配的进程；端口属于其他进程时报告冲突，不终止占用者。启动失败后按三十秒退避重试，
只有已确认父进程退出的本部署残留代理才允许清理。互斥锁避免重复守护程序。
计算连接与控制面板分别恢复；不会自动重新提交、取消或复制远端任务。

## 面板入口

“服务注册”显示守护、控制面板、计算连接及 WSL2 状态，提供启用／禁用登录启动、
启动守护和刷新。注册操作只允许本机访问码会话，仍检查 Origin 和 CSRF；远程 Access
入口不提供 Windows 启动项操作。状态记录超过四十五秒即标为未知，不沿用旧的运行中状态。

禁用登录启动不停止当前服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-startup.ps1 -Action disable -State private/control -Config private/host-control.json
```

维护时先等工作区和计算任务结束，关闭 WSLg 会话，再停止收据对应的守护进程，最后停止
本部署服务。否则守护程序会重新启动退出的进程。升级完成后 `-Action start` 恢复守护。
移动仓库或 Node 前应先禁用旧入口，完成路径核对再重新注册。

控制端重启会失效旧的工作区验收和网页会话；重新登录面板并点击“验证边界”，才可运行
SDK、终端或原生客户端。不会在登录时自动调用模型、弹出客户端或恢复用户的账号会话。

## 验收和排查

分别检查注册返回值、实际快捷方式、`services.json` 的新鲜时间、进程身份、监听端口和
控制端健康。重复启动守护应保持单实例；在空闲时退出控制进程，应自动恢复且计算连接
保持原进程。运行日志位于控制状态目录的 `service-logs`，只在本机保留。

注册成功、手动调用同一入口和进程故障恢复均不等于已完成注销重登或整机冷启动验收。
实际注销／重启由用户另行决定。Windows 设置或任务管理器可禁用 Startup 应用；面板会
读取本部署的禁用标记，用户明确点击启用后才恢复它。

Windows Startup 文件夹机制见 [Microsoft 官方说明](https://support.microsoft.com/en-gb/windows/experience/startup-boot/configure-startup-applications-in-windows)。
