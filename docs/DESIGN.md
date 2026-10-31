# Starport Next 设计

目标：一台个人电脑，最多加一台 Linux／DSW 计算服务器，获得完整智能体工具、手机控制、共享依赖和受控网络。沿用成熟的网络及服务器管理原则，把安装和日常配置压缩为四步。

## 组件与责任

| 组件 | 责任 | 不承担 |
| --- | --- | --- |
| Starport Control | 私有配置、密钥、操作授权、订阅、服务器和 Access 管理 | 模型生成的任意命令 |
| Session Broker | 会话所有权、事件、审批、附件、重连、幂等发送 | 通过浏览器连接寿命决定任务寿命 |
| Engine Adapter | 官方 Claude Agent SDK／Claude Code 的会话与工具事件 | 重新实现官方 agent loop |
| Workspace Provider | 持久项目、整个 Agent 的隔离、SSH/SFTP、工具进程 | 直接暴露宿主 Shell |
| Starship | 节点探测、环境准备、版本化启动和任务资源回收 | 向模型公开云身份与管理权限 |
| Egress Manager | 受控出站、订阅转换、主备出口及失败关闭 | 用 Cloudflare 入口代替出站策略 |
| Dependency Registry | 只读依赖／模型／数据版本及使用租约 | 把整个共享盘挂给项目 |
| Ingress Adapter | Cloudflare Tunnel + Access 或本地登录 | 模型账号认证、逐项目 ACL 的自动替代品 |

## 三种部署预设

| 预设 | 控制端与网页 | 项目与训练 | 持续运行条件 |
| --- | --- | --- | --- |
| `desktop-dsw`（首选） | Windows／macOS／Linux 电脑 | 一台 DSW 的项目环境和任务执行器 | 电脑与 DSW 均在线；出口默认在电脑控制侧 |
| `single-machine` | 同一台电脑 | 独立本地 microVM 工作区 | 电脑在线；运行时须实际验收 |
| `server-hosted` | DSW 的可信控制侧 | 同一 DSW 内分离的项目与任务环境 | DSW 在线；个人电脑可关闭 |

`server-hosted` 的控制文件、Access、云管理凭据及代理进程不在项目环境内。DSW 的空闲停止策略仍影响其可用性；恢复策略需明确授权，不以虚假负载规避停机策略。

Windows 原生控制端不要求 WSL2。若本地执行使用 WSL2，它只是兼容层，必须叠加经实际验证的工作负载边界；优先评估独立 microVM。macOS 和 Linux 的本地运行时也分别验收。远端管理和本地执行能力不能用同一个“支持该系统”标签混写。

## 四步配置向导

默认简体中文，技术说明放入统一指引。每一步只有必填输入、当前状态和一个主要操作；错误包含具体阶段、已保留进度和下一步，不用通用 `operation_failed` 掩盖已知原因。

1. **出口**：导入订阅或配置包 → 选择主节点／备用节点 → 测试并应用。高级设置容纳地域偏好、健康阈值和网络适配器，不要求手写路由。
2. **服务器**：粘贴 SSH 信息，或选 DSW 并读取真实实例 → 选择资源预算 → 核对指纹 → 初始化／验证。平台恢复后自动重新探测，不自动信任更换的主机密钥。
3. **项目**：选择执行节点、依赖版本和模型；高级区设置 effort、工具和新增依赖。配置值持久化，运行认证按设备重新验证。
4. **访问**：填 Cloudflare 管理 Token、域名、允许邮箱；检测冲突后分配独立前缀，验证本地源站，再发布 Access 与 Tunnel。关闭网页不影响会话与训练。

导入配置可填好四步的意图；仍逐项显示缺少的凭据和待验证状态。服务注册询问“是否在当前用户登录后启动”，拒绝不阻塞手动使用。开机前运行是另一项可选能力，不把登录后启动写成开机必然可用。

## 两种界面，共用受控项目

首个实现优先采用自建网页 + Claude Agent SDK，复用 CloudCLI 的成熟交互方式，接入现有 Access/Tunnel。原生 Claude Desktop 使用 Workspace Provider 的受限 SSH/SFTP 入口，属于后续兼容性阶段。

官方 Desktop 的 SSH 要求不能由现有固定 RPC Worker 直接满足。必须验证隔离环境中的安装、可写 HOME、SFTP、长连接、终端、插件和所有文件工具。控制端管理 SSH 与项目 SSH 是不同权限；桌面只拿项目能力。

同一会话只有一个执行者。网页断线后按事件游标追赶；发送使用 `operationId` 去重。原生 Desktop 和网页的双入口先共享项目和产物，不宣称自动共享同一正在运行的会话。接管必须原执行者释放所有权，并验证历史兼容，才能继续。

API／网关模式不依赖官方 Remote Control。模型供应商配置可适配 CC Switch，但网络防护由 Egress Manager 独立实施，不能因供应商工具退出而放行直连。

## 入口与额度

连接方式与额度资格分别管理。按 2026-11-01 核对的官方规则，订阅附送、领取至 Console 的 API 额度适用于以下用途：

| 入口 | 订阅附送 API 额度 |
| --- | --- |
| 自建 Starport 界面 + Claude Agent SDK，使用领取额度的 Console 组织 API Key | 支持 |
| 自建应用直接调用 Claude Messages API | 支持 |
| 自行运行 `claude -p`，使用上述 API Key | 支持，官方按 Agent SDK 用量处理 |
| 官方 Claude Code 交互式终端、IDE、Desktop、网页会话 | 不支持 |
| 从官方 Desktop、IDE 扩展或 GitHub Action 发起的运行，即使使用 `-p` | 不支持 |

原生 Desktop 的第三方推理模式可以连接 Claude API，但这不赋予赠额资格；CC Switch 的供应商、密钥及地址切换也不改变该限制。原生入口独立选择其适用的订阅或付费 API 计费，不把获赠额度显示成可供该入口消费的余额。

默认实现采用自建界面 + 官方 Agent SDK。工具、文件和计算功能复用项目环境；计费保持真实的 SDK 来源，不通过改写产品身份让 Desktop 用量冒充 SDK。当前只完成设计，尚未发起真实模型请求或验证账号扣费。

依据：[API 额度的适用范围与 `claude -p` 说明](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)、[Desktop 的 Claude API 配置](https://claude.com/docs/third-party/claude-desktop/claude-api)、[CC Switch](https://github.com/farion1231/cc-switch)。实际赠额种类、金额及有效期以使用者 Console 为准。

## 网络设计

数据路径：`Agent → 项目代理接口 → 受控通道 → Egress Manager → 所选出口 → 外部服务`。
入口路径：`浏览器 → Access → Tunnel → Session Broker`。
管理路径：`Control → 固定管理协议／SSH／DSW ProxyClient → Starship`。

运行时必须隔离整个 Agent 的网络；仅代理环境变量不足。入口域名、Access 邮箱、客户端 IP 和管理地址只用于控制侧，不作为模型元数据。Cloudflare 不负责替代模型出站出口。

复用既有 Mac 软路由经验，但使用适配器：Linux OpenWrt 网关、已有外部网关、受控 Unix socket／代理桥接。Windows 不通过运行一段 Linux 防火墙脚本来宣称隔离已完成。

出口应用是事务：

1. 解析订阅，只提取支持的节点与地址别名，丢弃供应商的路由、脚本和 DIRECT 回退。
2. 生成短时有效计划，记录配置基线摘要和资源所有权；检查别名链和循环。
3. 验证候选配置、端点和防护规则，不先修改当前出口。
4. 获得专用锁，比较当前摘要；配置已经变化则重新规划。
5. 在防护有效的条件下应用、验证真实代理 HTTPS 与禁止直连。
6. 失败回到上一个已验证版本；回滚也失败则保持出口关闭。

端点 DNS/IP 更新和上联网卡变化由控制侧重新规划。优先按新连接切换；需要中断既有连接时明确标示，支持在长传输或任务完成后应用。保留主备策略及手动固定节点。

## 节点与任务生命周期

实例存在、云端 Running、SSH 成功、运行时完整、隔离验收有效、出口健康和资源容量是独立字段。最终可提交状态需要全部通过且观测未过期；恢复至少连续两次成功。降级／过期停止新提交，不取消原任务。

云端关机、平台自动恢复、SSH 超时、API 不可达、主机密钥变化和实例不存在分别处理。SSH／ProxyClient 的 404 不能推断删除。自动启动仅在已授权策略、明确 `Inactivity` 生命周期、配置未变化且没有已有启动操作时执行一次；结果不明先核对。

CPU、内存和 GPU 都做预算及实际容量检查；GPU 排除外部工作负载和其他任务预留。容量缩减只影响新任务，不能抢占既有任务。同一任务结束只释放自己的分配，并在确认进程／运行时清理后更新预留。

网页心跳、会话所有权租约、Worker 控制存活和训练日志输出不是同一个信号。静默任务不因没有日志失败；浏览器或 Tunnel 断开不取消训练。控制连接故障时按任务控制租约处理，只清理确认属于失效控制者的任务，不广播停止。

训练退出码与产物收集状态分开。容量超限报告部分保留及遗漏，不把成功训练伪装成计算失败。支持执行中的输出快照、任务自身临时目录快照、分块传输、摘要和断点续传。删除缓存前确认正式副本、完整性与活动租约；不删除仍被运行任务或依赖层引用的文件。

## 依赖和存储

基础依赖从节点已有共享卷发布成版本：受信管理器检查内容、链接和二进制兼容性，创建不可变 manifest；Workspace Provider 仅挂选中的 payload。挂载源路径、卷身份、云 Bucket 和挂载凭据保持私有。

| 项目视图 | 模式 | 生命周期 |
| --- | --- | --- |
| `/workspace` | 读写 | 持久项目 |
| `/output` | 读写 | 当前任务产物 |
| `/tmp` | 读写 | 当前任务私有 |
| `/opt/dependencies/<release>` | 只读 | 共享依赖版本 |
| `/data/shared/<id>` | 只读 | 不可变数据版本 |
| 项目新增依赖层 | 独立读写构建，发布后只读 | 可复用 |

不能随意改变现存 Conda 前缀。先验证 Python ABI、动态库、CUDA、绝对路径及原生扩展；必要时维护兼容挂载视图，不复制整个用户环境。纯 Python 新增包和原生编译依赖分开处理，后者在受控构建任务内生成新版本。

NAS／CPFS／本地文件系统适合作为已安装依赖来源。OSS 可保存版本包、模型和数据，经缓存校验后使用；不默认把整个 Python 环境的细粒度读取交给远程对象存储。依赖写入和资产修改创建新版本；租约保护运行中的版本。

## 数据与用户体验

普通消息发送前简体转繁体，显示时繁体转简体；保留原始记录，代码、路径、结构化参数和附件不改写。不给消息增加语义过滤或强制预览。工具事件必须保留命令、输入、输出、耗时和明确阶段，不能只显示“Bash”。

日志使用 16 MiB 近期环形缓冲、单调游标和压缩分段；上传／下载进度由后台维护。任务、会话、产物与文件各有独立状态。移动端折叠模型和工具设置，状态保留可见；断线时保留已经加载的内容。

## 外部依据

设计依据核对日期：2026-11-01。文档能力不等于此仓库已实现，验收状态以 [ACCEPTANCE.md](ACCEPTANCE.md) 为准。

- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [Desktop SSH](https://code.claude.com/docs/en/desktop#ssh-sessions)
- [Desktop 第三方 SSH 的凭据和网络规则](https://claude.com/docs/third-party/claude-desktop/ssh-remote-sessions)
- [Claude Code 沙盒范围](https://code.claude.com/docs/en/sandboxing)
- [CloudCLI](https://github.com/siteboon/claudecodeui)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [DSW 挂载存储](https://help.aliyun.com/en/pai/read-and-write-dataset-data)
- [WSL 安全模型](https://wsl.dev/technical-documentation/security/)
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started/)
