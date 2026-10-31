# Windows 控制端与 WSL2 工作区

Windows 主系统运行 Starport，管理网络出口、服务器连接、文件面板与远程访问。WSL2 内的项目程序通过受限进程管道使用这些能力。Windows 可以管理项目文件，项目程序不能挂载或浏览 Windows 文件系统。

![Windows host and WSL2 workspace](assets/windows-host.svg)

## 当前实现

| Windows 控制端 | WSL2 项目环境 |
| --- | --- |
| Node.js 管理服务与网页面板 | Python／Shell 与项目文件 |
| 独立 Mihomo 出口及主备节点 | 仅有本地代理入口，没有外网路由 |
| 模型 API Key、计算服务凭据 | 可撤销的模型与项目计算令牌 |
| Access JWT 验证、cloudflared 进程 | 不接触 Access 邮箱、Tunnel Token |
| 上传、下载、改名、文件夹和删除 | `/workspace`、独立 HOME 与 `/tmp` |
| 计算服务状态与任务登记 | 提交、状态、日志、取消、产物下载 |

这版实现的是控制平面、项目执行边界和既有训练服务适配。它还不是完整的 Claude 会话网页；WSLg 的 Desktop／浏览器窗口、剪贴板桥及账号登录仍需独立接入和验收。

## 安装

在 Windows PowerShell 中进入仓库：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-control.ps1 -InstallPrerequisites
powershell -ExecutionPolicy Bypass -File scripts/setup-wsl.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-control.ps1
```

没有 WSL2 时，第二步加 `-InstallWsl`。系统功能安装会调用 Windows 授权窗口；需要重启时由用户决定。安装器不安装 QEMU，不替换系统 PATH，不改变默认发行版，也不执行 `wsl --shutdown`。

Ubuntu 镜像来自官方 WSL 下载目录，按同目录 SHA-256 核验后导入一个新名称 `StarportWork-…`。也可以使用 `-Rootfs` 与 `-Sha256` 指定已下载镜像。安装完成后只重新启动这个新发行版。它会安装安全更新后的基础依赖、bubblewrap、libseccomp、Python、Git、curl、locale 和 Noto CJK 字体。

默认面板：`http://127.0.0.1:18884/`。本机访问码在 `private/control/panel-key.json`，通过面板登录。初始出口关闭；先导入并选择受控节点，再点击“验证边界”。验证通过后才允许在面板终端执行命令。控制进程退出后必须重新验收。

当前启动方式为前台进程，关闭网页不会停止服务。没有自动注册开机或登录启动项。

## 复用导入配置

已有 Starport 或 Pi 配置包可以先按[配置导入](CONFIGURATION.md)导入，再启动：

```powershell
node bin/starport.mjs config import --file backup.spx --out profiles/imported
powershell -ExecutionPolicy Bypass -File scripts/start-control.ps1 -Profile profiles/imported -Client native
```

`native` 模式不注入 API Key；未来在工作区运行官方账号客户端时使用其独立登录。`-Client api` 使用配置包的官方 API 提供商与模型，真实 Key 留在 Windows。配置包的口令只在本机终端隐藏输入。

受控出口复用配置包中已选择的主备节点。Windows 需要可用的 Mihomo 可执行文件；也可以在控制端配置中通过相对路径指定 `proxyBinary`。实际节点及订阅缓存保留在私有配置中。

## 控制端配置

`private/host-control.json` 的最小内容：

```json
{
  "format": "starport-host-control",
  "version": 1,
  "port": 18884,
  "wslState": "wsl"
}
```

路径相对这份配置文件。可选 `nodesFile` 指向包含 `nodes` 与 `hosts` 的已解析节点 JSON；不把任意订阅规则直接当作出口规则。私有目录使用当前用户 ACL。请在启动前配置；暂未提供运行中切换配置的管理表单。

连接既有隔离训练 API：

```json
{
  "compute": {
    "url": "http://127.0.0.1:19090/",
    "tokenFile": "secrets/compute-token.txt"
  }
}
```

这是增补字段，不是完整配置。此端点应由 Windows 上的受信 SSH／DSW 连接器转发到**已配置隔离的训练 API**。不接受远端管理 Shell 作为替代。第一版不自动创建 DSW 或初始化远端训练服务；已有服务的只读依赖、数据挂载和断线保护继续由该服务负责。

如果服务器已有可直达的 SSH 端点，也可用 `compute.ssh` 代替 `compute.url`，由控制端建立仅转发训练 API 的专用连接：

```json
{
  "compute": {
    "tokenFile": "secrets/compute-token.txt",
    "ssh": {
      "host": "compute.example.com",
      "user": "operator",
      "port": 22,
      "serverPort": 19090,
      "identityFile": "secrets/compute-key",
      "knownHostsFile": "secrets/known-hosts"
    }
  }
}
```

必须预先核对主机指纹。此连接使用 `-NT`、严格主机校验、禁用 Agent 和环境转发，模型无法指定 SSH 命令。DSW ProxyClient 专用通道目前仍由外部受信连接器提供，不把它简化成公网 SSH。

工作区只看到固定的 `http://127.0.0.1:18081` 和项目令牌。可以使用：

```python
import os, json, urllib.request
url = os.environ["STARPORT_COMPUTE_URL"]
token = os.environ["STARPORT_COMPUTE_TOKEN"]
request = urllib.request.Request(url + "/health", headers={"Authorization": "Bearer " + token})
print(json.load(urllib.request.urlopen(request)))
```

支持既有 API 的 `/jobs` 提交、`/jobs/ID`、`/jobs/ID/logs`、`/jobs/ID/config`、`/jobs/ID/cancel` 与 `/jobs/ID/artifact/路径`。控制端登记创建项目，只允许该项目访问自己提交的任务；不转发管理 API、云实例标识或服务器地址。日志、源代码和产物字节不经过语义过滤。上传使用既有 `files` 字典协议；大型分块上传与共享数据发布接口尚未迁入这一适配层。

如果提交响应丢失，会登记“结果待核对”，不会自动再次创建任务。网页断线或控制端退出不调用远端取消接口。

## Access 与 Tunnel

远程入口仍在 Windows 上运行。为已有独立 Tunnel 增加：

```json
{
  "access": {
    "issuer": "https://team.cloudflareaccess.com",
    "hostname": "console.example.com",
    "audience": "YOUR_ACCESS_AUDIENCE",
    "allowedEmails": ["operator@example.com"]
  },
  "tunnel": { "tokenFile": "secrets/tunnel-token.txt" }
}
```

Windows 安装 `cloudflared`，把这条 Tunnel 的应用路由配置为本机 `http://127.0.0.1:18884`，保留公开应用域名的 Host。控制端用 Token 文件启动独立连接器；不把 Token 放入命令参数或 WSL。没有 Access 配置时拒绝启动 Tunnel。

源站核验 JWT 的签名、issuer、audience、有效期和允许邮箱，再校验 Origin／CSRF。只有邮箱头不构成授权。本机登录入口拒绝伪造的转发头。连接器进程运行不等于公网访问验收通过；本次没有修改真实域名、Tunnel 或访问策略。

## 文件与区域设置

Windows 面板能管理项目文件，单文件当前上限 64 MiB，读写校验 SHA-256；不开放整个发行版的管理目录。Windows 管理员也可以通过 Windows 自身的 WSL 文件入口访问发行版，这不改变工作区权限。

| 设置 | 固定值 |
| --- | --- |
| 主机名／用户 | `starship`／`agent` |
| 时区 | `Asia/Taipei` |
| LANG／LC_ALL | `zh_TW.UTF-8` |
| LANGUAGE | `zh_TW:en_US` |
| 编码 | UTF-8 |
| 字体 | Noto CJK，提供繁体中文字形 |

locale 数据及 `/etc/localtime` 同时配置，不只设置环境变量。不继承 Windows 时区、账户目录、PATH、SSH Agent 或云凭据。界面继续使用简体中文。

## 边界与验收

WSL2 本身不是抵御 Windows 管理员或发行版 root 的安全边界。本方案把两者视为可信管理方，模型只能进入另外的用户、文件、进程与网络命名空间。它没有挂载 Windows 盘、interop、D-Bus、宿主显示 socket 或管理进程；seccomp 限制 vsock、其他非 IP socket、用户命名空间与宿主检查接口。更强的独立内核边界仍可选原有 QEMU 路径。

当前 Linux 实测：项目文件往返、摘要、路径／软链接拒绝、繁体台湾 locale、无直连路由、IPv4／IPv6／DNS／元数据／vsock 阻断、真实代理 HTTPS、暂停后断网、恢复重连。计算项目授权与 Access 签名验证通过接口测试。桌面与手机尺寸的面板已检查。

**Windows 实机的导入、冷启动、完整官方客户端、WSLg、远端 DSW 小任务以及真实 Access 外网入口仍未验收。** 不自动注册登录启动，也不把 Linux 验证收据导入为 Windows 的已验证状态。详见[验收矩阵](ACCEPTANCE.md)。

官方依据：[WSL 安全模型](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)、[WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[WSLg](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)、[Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Tunnel Token 文件](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)。
