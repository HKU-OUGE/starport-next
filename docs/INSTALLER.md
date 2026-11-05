# 安装中心

从 [GitHub Releases](https://github.com/HKU-OUGE/starport-next/releases) 下载对应安装包。安装包自带 Node.js，不要求先安装 Node 或 Python。

| 平台 | 安装入口 | 项目运行环境 |
| --- | --- | --- |
| Windows 10 Build 19044+／Windows 11，x64 | 双击 `Starport-Next-…-Windows-x64.exe` | 专用 WSL2；可选 WSLg |
| Ubuntu 24.04／兼容的 Debian 系桌面，x64 | `sh Starport-Next-…-Linux-x64.run` | QEMU／KVM；可选 Xpra |

```text
打开安装程序 → 勾选功能 → 填写配置 → 系统授权 → 安装与边界验证 → 打开控制面板
                    再次打开同一安装程序 → 更新／修复，或卸载
```

1. **选择功能。** 本地项目、Claude 客户端、中文输入法、无缝窗口、文字剪贴板、API、已有计算服务器和远程入口均可按需选择。登录启动默认关闭。
2. **配置出口。** 输入 Clash／Mihomo 订阅，或粘贴 YAML／JSON，选择主节点和备用节点。支持 SS、VMess、VLESS、Trojan。项目安装和运行始终使用受控出口；不接受跳过证书验证的节点。
3. **填写可选连接。** API Key 留在控制端。计算入口连接已部署的 Starship 服务，需要专用 SSH 私钥、经核对的主机公钥和服务令牌。远程入口复用已有 Cloudflare Access／Tunnel，需要域名、团队地址、Audience、允许邮箱和 Tunnel 连接令牌。安装器不创建或重启云实例。
4. **完成系统授权。** Windows 使用 UAC，Linux 使用 PolicyKit 密码框；网页不索取管理员密码。取消后保留配置，可重试。首次启用 WSL 可能要求重启；KVM 用户组变更可能要求重新登录，之后重新打开安装器继续。安装器不会执行全局 `wsl --shutdown`。
5. **打开面板。** 完成时显示本机访问码和入口。官方账号登录在项目内完成；安装不会自动发送模型请求。

## 密钥环选项

默认使用项目内 Linux 密钥环。可以明确勾选“关闭新项目的密钥环提示”，让 Chrome／Electron 使用 `basic` 密码存储。**这会降低静态凭据保护：能读取项目文件的人可能读取凭据。** 它不关闭宿主 Windows、Linux 的密钥保护，也不自动迁移已有登录资料；已有项目保留首次确定的设置。

此选项不会关闭 Chromium 自身沙箱或改变受控网络出口。[Electron 存储语义](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 更新与卸载

默认位置：Windows 为当前用户 LocalAppData 下的 `StarportNext`；Linux 为 XDG 数据目录下的 `starport-next`。Windows 安装器可选择其他目录；Linux 用 `--target` 指定。

程序位于 `app/`，私有配置和工作区位于 `private/`，两者分开。再次启动会识别安装收据，提供更新／修复和卸载。活动任务或图形应用存在时拒绝切换；先关闭本安装的工作，再重试。更新会保留上一份程序副本，项目不进入程序备份。

- **默认卸载：**移除本安装程序、菜单和登录启动入口，保留项目、凭据和工作区磁盘。
- **永久删除：**额外勾选删除数据后，才移除本安装的 `private/`；Windows 仅注销收据对应的专用 WSL 发行版。
- 共享系统依赖、其他发行版、云资源不属于本安装的卸载范围。
- 检测到非托管目录、被修改的入口、符号链接或仍挂载的项目目录，会停止并说明原因。

Windows 的“已安装的应用”和开始菜单均有管理入口；Linux 应用菜单中的 Starport Next 提供“安装与卸载”。卸载默认保留数据时，可用同一路径重新安装后继续使用。

## 验证范围

此版是预发布安装器。Linux 和 Windows 的真实安装包已通过安装、修复、保留数据卸载、重装和永久删除测试，包括中文与空格路径；详见[安装器验收](verification/installer-0.3.json)。Windows 的 UAC／WSLg、实际注销重登和全新机器上的完整系统安装仍需要目标机验收。完整工作区与输入法的已有运行证据见 [验收记录](ACCEPTANCE.md)。

安装包附 SHA-256 校验文件，尚未进行商业代码签名。来源和校验值应与本仓库 Release 一致。离线校验：Linux 安装器支持 `--check`；Windows 安装器支持 `/S /VERIFY`。运行 `--check` 不安装工作区或修改系统。
