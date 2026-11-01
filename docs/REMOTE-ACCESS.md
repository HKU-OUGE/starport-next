# 域名与邮箱设置

本机控制面板左侧的“远程访问”可设置域名、允许登录的完整邮箱、Cloudflare 团队地址、应用 Audience，以及可选的本机 Tunnel 连接器。该页仅对本机访问码会话开放；远程 Access 用户不能修改此设置。

## 一个入口使用三种客户端

邮箱登录后，打开左侧“Claude 工具”，选择项目并完成边界验证。

| 入口 | 使用方式 | 独立认证 |
| --- | --- | --- |
| Claude Code CLI | 选择“网页项目桌面”，点击 Claude Code CLI，在终端内操作 | Claude 官方账号 |
| Claude Desktop | 同一项目桌面内点击 Claude Desktop | Claude 官方账号 |
| Agent SDK | 在下方输入任务并运行 | Windows 控制端保存的 API 配置 |

网页项目桌面包含项目内的终端、Linux Desktop 和浏览器。它使用项目自己的虚拟显示，
通过鉴权后的 WebSocket 传递画面和键鼠；不公开 Windows 桌面或 VNC 端口。
三者共用该项目的文件和计算 MCP，CLI／Desktop 与 SDK 的认证、会话和计费仍各自独立。
这是 Next 的网页操作入口；不是 Claude 官方的 `remote-control` 会话。

安装客户端时会安装 TigerVNC 与 Openbox。已有 WSL2 安装可在没有活动项目操作时补装：

```sh
node bin/starport.mjs wsl remote-display-install --state private/wsl --config private/host-control.json
node bin/starport.mjs wsl update-runtime --state private/wsl
```

随后重启本安装的控制端、重新验证项目。下载通过受控代理和 stdio 通道完成，无需开放
Windows 入站端口。`npm ci --ignore-scripts` 安装锁定版本的 noVNC 和 WebSocket 库。

本机仍可选择 WSLg 窗口；切换显示方式前先关闭工作区应用。一个项目同一时间连接一个
网页查看器；“断开画面”保留应用，“关闭工作区应用”结束项目图形会话。连接最长 30 分钟，
到期重新连接，应用仍保留。登录过期或允许策略变化会断开连接。移动端可缩放查看画面，
完整终端输入建议使用实体键盘。传递文字为手动操作，不自动同步访问设备剪贴板。

公网验收应分别记录邮箱登录、画面与键鼠、重连、SDK 调用，以及 CLI／Desktop 账号登录。
安装成功、MCP 就绪、出现登录页面均不代表已经完成 Claude 真实对话验证。

## 连接已有 Cloudflare 配置

1. 在 Cloudflare 创建自托管 Access 应用，使用计划公开的域名，例如 `console.example.com`。建立 Allow 策略，逐个填写允许的邮箱；需要邮箱验证码时启用相应身份提供方式。见 [自托管应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) 与 [Access 策略](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)。
2. 为该域名配置 Tunnel 和 DNS。连接器运行在本机时，HTTP 服务地址使用 `http://127.0.0.1:18884`（以实际面板端口为准），保留公网域名作为 Host，不将它改写为 localhost。
3. 在 Next 填写域名（不含协议与路径）、相同的邮箱名单、`https://团队名称.cloudflareaccess.com` 和该应用的 AUD。邮箱名单同时受云端策略和 Next JWT 校验约束。
4. 若由 Next 启动连接器，安装 `cloudflared` 2025.4.0 或更高版本，勾选“由本机运行 Tunnel”并填写该 Tunnel 的 Token。它不是 Cloudflare 管理 API Token。已由外部连接器负责时取消勾选。见 [Tunnel Token](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/) 和 [token-file 参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。
5. 点击“保存并应用”，再检查源站鉴权，最后用实际公网浏览器分别验证允许邮箱和拒绝访问。

本页应用已有云端资源的本机设置，不自动创建、更新或删除 DNS、Access 应用、云端邮箱策略或 Tunnel。保存成功不代表公网路由与登录成功；“检查源站鉴权”仅检查带公网 Host 的无凭据请求在本机被拒绝。实际公网验收前 `publicAccessVerified` 始终为 false。

## 保存、关闭与恢复

配置立即应用，不需要重启控制端或中断计算任务。本机入口和原访问码继续有效。关闭远程访问会移除本机 Access 配置并停止本安装的 Tunnel；外部连接器与云端资源不会被删除，源站仍拒绝公网 Host。

设置先验证格式，再使用读取版本摘要防止覆盖其他修改。更改前的完整配置和新 Token 位于主配置旁的私有 `.starport-remote` 目录；立即应用失败会恢复原配置。Tunnel 进程之后退出则显示“连接器需检查”，不能据此声称路由可用。

Token 使用独立私有文件，通过 `--token-file` 启动，不出现在进程参数、网页响应、项目工作区或配置导出。留空保留当前 Token；禁用后再次启用本机连接器需要重新提供 Token。旧备份和 Token 由操作员管理，不能公开上传。

错误 `remote_settings_changed_reload` 表示文件已被其他操作修改，应点击“重新读取”后再编辑。`cloudflared_binary_required` 表示本机缺少连接器；可通过 PATH 安装，或在私有配置 `tunnel.binary` 指定相对路径。源站拒绝本机 Cookie 作为公网身份，要求有效 JWT、正确 issuer／audience、允许邮箱以及请求 Origin／CSRF。
