# 登录启动与服务管理

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

## Linux 当前用户服务

Linux 使用 systemd 用户单元。虚拟机、面板、每个计算连接分别管理；重启面板不停止虚拟机，也不重新提交远端任务。本机项目的控制管道关闭时，其本机操作仍会结束。

```sh
node bin/starport.mjs linux services plan --state private/control --config private/host-control.json
node bin/starport.mjs linux services enable --state private/control --config private/host-control.json
node bin/starport.mjs linux services status --state private/control --config private/host-control.json
```

`enable` 注册并安排下次用户登录启动，不停止现有手动进程。若需要立即切换，先关闭本安装的项目应用和手动控制端，再执行：

```sh
node bin/starport.mjs linux services start --state private/control --config private/host-control.json
```

每个单元带安装摘要，收据位于 `private/control/linux-services.json`。只管理当前用户的本安装单元；不保存系统密码，不开启 linger，不要求系统 root 服务。若没有桌面登录，网页功能可工作，但无缝窗口需要 X11/XWayland 会话。桌面管理器通常会导入显示变量；必要时在登录会话执行 `systemctl --user import-environment DISPLAY XAUTHORITY XDG_RUNTIME_DIR`，再启动本安装服务。

`disable` 只禁用下次启动。卸载先用 `plan` 核对单元名，按控制端、计算连接、虚拟机的顺序停止本安装单元，再执行 `unregister`；存在活动单元或文件内容被修改时拒绝删除。所有这些命令都需要同一组 `--state` 和 `--config`。整机重启验收需单独进行，不能用单元注册成功替代。
