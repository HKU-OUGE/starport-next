# 本地项目环境

控制端在 Ubuntu、Windows、macOS 上运行 Node.js；整个 Agent 在独立 Ubuntu 虚拟机中运行。项目文件通过受控文件接口传输，不挂载宿主 HOME、磁盘或容器 socket。

| 控制端 | 运行时 | 状态 |
| --- | --- | --- |
| Ubuntu x86-64 | QEMU + KVM | 本机验收记录见 [ACCEPTANCE.md](ACCEPTANCE.md) |
| Windows x86-64 | QEMU + Windows Hypervisor Platform | 接口与引导脚本已实现，待 Windows 实机验收 |
| macOS Apple Silicon | QEMU arm64 + HVF | 接口与引导脚本已实现，待 Mac 实机验收 |
| macOS Intel／Linux arm64 | QEMU + 对应原生加速 | 参数路径已实现，待实机验收 |

Windows 无需 WSL2。没有硬件加速时明确失败，不自动切换成宿主命令或放宽网络。此阶段提供 CLI、持久项目、文件操作与 Agent SDK；完整网页工作台仍在后续阶段。

## 安装与准备

需要 Node.js 22+、QEMU 8.2+、OpenSSH 客户端，以及至少 10 GiB 可用磁盘。默认分配 2 核、2 GiB 内存、8 GiB 虚拟磁盘；磁盘按需增长，但安装前保留整个预算和宿主余量。

Ubuntu／macOS：

```sh
sh scripts/setup-local.sh --install-prerequisites
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-local.ps1 -InstallPrerequisites -EnableHypervisor
```

Windows 启用 Hypervisor Platform 会出现系统管理员授权窗口，可能需要重启；脚本不会自动重启。Ubuntu 需要当前用户有 `/dev/kvm` 读写权限。安装器不会改写整个 PATH。

```sh
node bin/starport.mjs local doctor
node bin/starport.mjs local prepare --state private/local-workspace
```

准备过程下载官方 Ubuntu Minimal 镜像并核对官方 SHA-256，生成工作区专用 SSH 密钥、固定主机信任、只读初始化盘及独立可写系统盘。下载支持从已有分块接续，最后必须验证完整摘要。可用 `--installer-proxy http://127.0.0.1:端口` 给可信安装下载配置代理；这个安装参数不会替代工作区出口。

`--ephemeral` 只用于明确选择临时存储的验收，降低初始磁盘预留；目录是否会在重启后消失由使用者所选存储决定。日常使用应选择持久目录。

## 从配置包启动

先按 [CONFIGURATION.md](CONFIGURATION.md) 导入 Pi 或 Starport 配置包。导入包需要已有缓存节点及选中节点；运行 Mihomo 前会重新构造禁止 DIRECT 的专用配置。先安装 Mihomo，并加入 PATH，或通过 `--proxy-binary` 指定其程序。

```sh
node bin/starport.mjs local start --state private/local-workspace --profile profiles/imported --model 选择的模型ID
node bin/starport.mjs local verify --state private/local-workspace
node bin/starport.mjs local bootstrap --state private/local-workspace
```

真实 API Key 仅在控制端守护进程的内存中解密，项目只获得当前工作区网关凭据。停止后重新启动需要再次解锁。当前本地适配器使用官方 Claude API，其他兼容网关暂不作为已验证路径。

默认允许 API、Node.js、npm、GitHub 与验收站点的 HTTPS。需要其他站点时，在启动命令追加 `--allow-hosts docs.python.org,需要的域名`；只接受明确域名，不接受私网 IP 或通配符。修改配置需停止并重新启动该工作区，再重新验证。

也可接入已有的受控 HTTP 代理：

```sh
node bin/starport.mjs local start --state private/local-workspace --upstream http://127.0.0.1:端口 --api-key-file private/api-key.txt --model 选择的模型ID
```

已有代理必须由操作者保证只走指定出口。该入口不会修改它的路由规则；需要 Starport 自己保证不出现 DIRECT 时，使用上面的配置包／专用 Mihomo 入口。原有 Mac 软路由可通过 `--upstream-socket` 接入其受控代理 socket。

没有 API Key 也可以启动并验证文件、命令和网络；只有真实会话需要 API 认证。API Key 文件不会上传到虚拟机。SDK 每轮默认最多 12 个 Agent turn、1 美元 SDK 预算，真实扣费由供应商返回，不能把本地估算当作账单余额。

## 开发与文件

把要执行的命令放在脚本文件中；执行发生在虚拟机 `/workspace` 内：

```sh
node bin/starport.mjs local exec --state private/local-workspace --script examples/local-smoke.sh
node bin/starport.mjs local files --state private/local-workspace --operation list
node bin/starport.mjs local files --state private/local-workspace --operation mkdir --path src
node bin/starport.mjs local files --state private/local-workspace --operation upload --source example.py --path src/example.py
node bin/starport.mjs local files --state private/local-workspace --operation download --path result.json --out result.json
```

文件接口还支持 `rename`（`--destination`）与 `delete`。删除目录仅允许空目录。拒绝跳出项目的路径和符号链接；上传、下载核对 SHA-256，默认不覆盖。覆盖上传需要显式 `--replace`。当前单文件上限 64 MiB，目录每页最多 500 项，后续页用 `--offset`；大文件分块接口尚未接入此新适配器。

启动会话：

```sh
node bin/starport.mjs local chat --state private/local-workspace --prompt-file prompt.txt
```

输出 JSONL 事件，包含 SDK 的会话 ID、工具输入输出和结果；后续使用 `--resume 会话ID` 继续。普通消息转繁、显示文本转简，代码围栏与行内代码保留；原始事件保存在项目内。流式显示是增量文本，完整结果用于准确的最终显示。

安装的 Node.js 和 Agent SDK 位于 guest 的只读权限目录，项目用户没有 sudo。当前包含 Bash、Python、文件编辑与搜索；不承诺宿主全部依赖都自动可用。GPU 直通、已有宿主依赖的只读发布以及远端 DSW 适配仍按路线单独验证。

## 网络与生命周期

```text
整个 Agent → guest 回环代理 → SSH 反向转发 → 控制端白名单代理
                                               ↓
                                      专用 Mihomo／既有受控出口
                                               ↓
                                      API 与获准外部服务
```

QEMU `restrict=on` 阻断 guest 向宿主与外部的正常路由；guest 的 Agent 用户 slice 另限制为回环访问。管理 SSH 仅监听宿主回环地址，主机密钥在创建时固定，关闭转发代理、继承 SSH 配置及环境。代理断开不会获得直连路径。

`local verify` 在该新实例中执行直连、DNS、IPv6、元数据和出口故障探测，不停止外部已有代理。验证通过后才允许 Agent SDK 会话；每次重启都应重新验收。

```sh
node bin/starport.mjs local status --state private/local-workspace
node bin/starport.mjs local stop --state private/local-workspace
```

停止只影响该目录登记的实例和它自己启动的代理。项目仍在虚拟磁盘中。此阶段不自动注册登录启动；卸载先停止实例、导出需要的文件，再按 [卸载指引](../skills/starport-uninstall/SKILL.md) 选择确切目录。

依据：[QEMU 受限用户网络](https://www.qemu.org/docs/master/system/invocation.html)、[WHPX](https://www.qemu.org/docs/master/system/whpx.html)、[QEMU 加速器支持](https://www.qemu.org/docs/master/system/introduction.html)、[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)。
