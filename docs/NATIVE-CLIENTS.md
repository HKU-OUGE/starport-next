# 官方账号客户端

API 模式运行官方 Agent SDK；账号模式运行官方 Claude Code CLI 和 Claude Desktop，使用官方账号授权。两者不共用凭据入口；本实现不把原生客户端的订阅令牌复制到自建 SDK 网关。

QEMU 账号模式将浏览器、CLI、Desktop 和项目放在同一独立 Linux 虚拟机里。宿主浏览器只显示虚拟机画面，不访问授权网站。浏览器资料、Cookie、宿主目录与剪贴板不自动共享。通过画面侧栏的剪贴板面板，可以手动双向传递文字。已有登录保存在虚拟机自己的磁盘里；新安装需要一次官方登录。

Windows 另提供 [WSL2 客户端入口](WINDOWS-HOST.md#安装-claude-客户端与-wslg)。它使用项目命名空间和独立 WSLg 窗口，明确启用后与 Windows **共享显示和剪贴板**，不适用上面的手动剪贴板承诺。官方账号资料仍保存在项目 HOME；SDK 的 API Key 留在 Windows 控制侧。

## 准备

需要先完成[本地运行环境](LOCAL-RUNTIME.md)安装。图形客户端至少分配 4 GiB 内存。安装器为 x64 guest 使用官方 Chrome，为 arm64 guest 使用 Mozilla 签名仓库的 Firefox。Apple Silicon 的整机运行尚未验证；不会回退到宿主浏览器。

```sh
node bin/starport.mjs local prepare --state private/native-workspace --memory-mib 4096
node bin/starport.mjs local start --state private/native-workspace --profile profiles/imported --client native
node bin/starport.mjs local verify --state private/native-workspace
node bin/starport.mjs local native-install --state private/native-workspace
node bin/starport.mjs local native-ui --state private/native-workspace
```

在本机打开最后一条命令给出的地址。它只监听回环地址，含仅用于画面连接的临时访问口令，请勿公开。剪贴板支持手动文字传递，传入 guest 的文字单次最多 1 MiB，不主动读取本机剪贴板，也不同步鼠标选中的 PRIMARY 内容；文件使用文件传输入口。Ubuntu 图形组件、浏览器和官方客户端都安装到 guest；不向宿主安装 Claude，不修改现有会话。

`--client native` 忽略导入配置里的模型 API Key，并拒绝同时传入 `--api-key-file`。账号模式仍使用导入的受控出口。官方登录域名、应用静态资源和安装仓库按域名放行，均经过同一个代理；未放行的站点返回失败，不走直连。

## 跨平台快捷启动

Windows 的独立虚拟机路线：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-local.ps1 -InstallPrerequisites -EnableHypervisor -InstallOpenSSH
powershell -ExecutionPolicy Bypass -File scripts/start-native.ps1 -Profile profiles/imported -InstallClients
```

Ubuntu／macOS：

```sh
sh scripts/setup-local.sh --install-prerequisites
bash scripts/start-native.sh --profile profiles/imported --install-clients
```

第二次启动可省略安装参数。首次配置导入按 [配置指南](CONFIGURATION.md) 进行；Mac 需要已有 Homebrew。缺少 Node 时安装私有运行时，不覆盖系统 PATH。Windows 特性授权通过 UAC，不自动重启。快捷启动只打开本机回环地址的画面，官方登录由 guest 内程序完成；需要时显式添加 `-Login` 或 `--login`。已有运行工作区会复用，启动脚本不自动停止它，也不重复执行断线测试。

上述脚本使用 QEMU。Windows 的 [WSL2＋WSLg 路线](WINDOWS-HOST.md) 使用 `setup-wsl-clients.ps1` 安装，再由控制台打开客户端，不混用两种运行时的收据或启动命令。

## 登录与使用

```sh
node bin/starport.mjs local native-login --state private/native-workspace
node bin/starport.mjs local native-status --state private/native-workspace
node bin/starport.mjs local native-desktop --state private/native-workspace
node bin/starport.mjs local native-terminal --state private/native-workspace
```

`native-login` 在虚拟机终端执行 `claude auth login --claudeai`，浏览器也在虚拟机内打开。Desktop 使用自身官方登录界面，不能仅凭 CLI 已登录就认定 Desktop 验证完成。控制端的状态只显示登录方式和成功与否，不返回邮箱或组织信息。

项目示例目录为 `/workspace/account-smoke`。账号 CLI 的配置目录与 API 测试记录分开。终端内可直接运行 `claude`，也可以在 Desktop 的 Code 页选择项目目录。要让普通输入自动转换，仍使用 Starport 工作台的转换入口；原生客户端直接键入的内容不会被额外拦截或偷偷改写。

停止时运行：

```sh
node bin/starport.mjs local stop --state private/native-workspace
```

虚拟机磁盘保留项目和登录状态；再次启动后需重新执行网络边界验证。删除工作区磁盘会一并删除这些内容，应先导出需要的文件。

## 验证范围

- API 路径已在 Ubuntu 完成实际会话、工具执行、续接、文件校验与断线测试。
- 账号路径分别验收：官方包签名、客户端启动、浏览器出口、登录、CLI 工具调用、Desktop 工具调用和重启后的续接。安装成功不代表账号会话已通过。
- Windows 已完成 WSL2 安装和 SDK 真实任务；WSLg 的密钥环、账号授权及 Desktop 工具调用仍单独记账，不由安装结果推断通过。macOS 实机图形客户端待验收。
- 原生账号令牌可能被同一 guest 用户下的工具读取。它不会得到控制端 API Key、订阅或云管理凭据，但不能声称原生客户端对自己的登录令牌完全不可见。

参考：[官方认证方式](https://code.claude.com/docs/en/authentication)、[Linux Desktop](https://code.claude.com/docs/en/desktop-linux)、[网络要求](https://code.claude.com/docs/en/network-config)。
