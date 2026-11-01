# 配置与迁移

公开配置保存部署意图，私密连接和凭据使用 `secret://` 引用。主机文件路径相对配置根目录；文档中的 `/workspace` 等路径是隔离环境的固定视图，不是操作电脑的路径。

## 初始化

```sh
mkdir profiles
node bin/starport.mjs init --preset desktop-dsw --out profiles/work
node bin/starport.mjs validate --profile profiles/work
node bin/starport.mjs plan --profile profiles/work
```

Windows 可用 `New-Item -ItemType Directory -Force profiles`。已有目标目录会被拒绝，不覆盖配置。`plan` 不解密 vault，因此会把所有未解析引用列为待配置；这是离线规划，不是在线健康报告。

预设：

- `desktop-dsw`：控制端在电脑，远端提供项目与计算。
- `single-machine`：同一电脑的独立本地运行时，目标平台验证后才能启用。
- `server-hosted`：控制端、出口、网页在服务器可信控制侧，项目环境独立。

## 导入／导出

```sh
# 预览不会写入文件、连接服务器或打印密钥内容。
node bin/starport.mjs config preview --file backup.spx

# 导入到全新的目标配置；随后显示缺少的引用和待验证状态。
node bin/starport.mjs config import --file backup.spx --out profiles/imported

# 默认只导出配置意图：不含连接地址、邮箱名单、订阅内容或密钥。
node bin/starport.mjs config export --profile profiles/imported --out config-only.json

# 完整包包含已有私密资料，必须加密；此版本使用同一口令解锁及重新加密。
node bin/starport.mjs config export --profile profiles/imported --out full-backup.spx --include-secrets
```

口令交互输入不回显，至少 12 个字符。自动化可增加 `--password-file private/passphrase.txt`；POSIX 口令文件权限必须为当前用户私有（例如 0600）。不支持把口令作为命令行字符串参数。配置包必须通过可信渠道取得；加密校验只证明口令和内容一致，不证明发送者身份。

导出的配置模板仍可能有用户自行选择的节点别名和模型偏好，分享前应检查。程序不会宣称任意配置是匿名数据。

## 控制面板入口

本机面板的 **配置导入／导出** 可导出“当前安装”或此前导入的配置。默认下载不含连接地址
和凭据的模板；勾选“包含连接与凭据”后输入至少 12 字符的口令，下载 scrypt＋AES-256-GCM
加密包。导出已导入的加密配置时使用原口令。口令仅在本次操作中使用，不保存在浏览器存储。

当前安装快照包含模型选择、代理节点、独立 worker 的 SSH／DSW 连接与凭据、资源上限，
以及 WSLg 使用意图。控制配置的 `workerComputeFile` 用相对路径指向独立计算配置。
新增可选字段 `workspace` 和 `computePolicy` 保留 WSL2 与无固定并发数等意图；旧版本需要
升级后才能读取含这些字段的新包。普通训练 API 和公网 Access 的重新部署仍需另行配置。

导入流程为选择文件、输入口令（加密包）、预览、填写新名称、保存。预览不显示密钥；确认
绑定同一份配置内容，不能预览一个文件后替换另一个。包保存在实际控制状态目录的
`imported-profiles/<name>`，名称冲突不会覆盖。可继续用 CLI 的 `--profile` 读取该目录。
导入不会切换当前服务，也不会自动安装新运行时、信任服务器指纹、启用 WSLg 或启动服务。
新设备仍需按 setup skill 完成激活和边界验证。

不会迁移账号 Cookie、密钥环、面板访问码、主机信任、二进制、WSL 发行版、任务、产物或
运行收据。该入口仅开放给本机已认证面板，继续执行 Origin／CSRF 校验；Access 远程面板
不开放本机配置包操作。

## Pi v1 兼容范围

接受 `starport-pi-profile-encrypted` v1（scrypt + AES-256-GCM），转换为新格式。含凭据或完整扩展内容的明文包被拒绝；建议从 Pi 导出加密完整包。

| 原内容 | 处理 |
| --- | --- |
| 模型、effort | 保留选择；模型实际可用性后续核对 |
| 订阅节点、hosts 别名和选中节点 | 放入加密 vault；激活前重新校验和探测 |
| SSH／DSW 连接、私钥、RAM／STS 凭据 | 放入加密 vault，生成新的引用 |
| Cloudflare Token、域名、邮箱名单 | 保留配置意图，重新注册远程入口 |
| Skills／MCP／插件 | 暂存且禁用；不运行任何导入脚本 |
| 工具二进制、绝对路径、known_hosts | 不迁移 |
| Access audience、Tunnel 连接令牌 | 不迁移 |
| 已初始化、ready、进程、启动项、运行收据 | 不迁移 |
| WSL 发行版 | 不迁移，需新设备重新创建和验收 |
| 会话历史、工作区文件、依赖和模型内容 | 不在配置包范围，后续独立迁移 |

`dsw-proxy` 这类命令占位符不接受为真实实例 ID。格式校验不能证明实例存在；激活前还需调用云端只读接口核实。

## 落盘结构

```text
profile/
  config.json             可移植配置，只有 secret 引用
  vault.spx               可选的加密私密资料
  import-receipt.json      导入来源与迁移警告
  verification.json       全部待验证，自动启动禁用
  profile.json            最后写入的提交标记
```

导入先完成解密、类型、引用和边界校验，再独占创建目标目录。中途失败移除本次创建的目录；读取端要求提交标记，不能把部分导入当成可用配置。现有目录、导出文件和软链接目标不会被覆盖。目标父目录应由当前操作用户拥有，避免其他本机用户并发替换路径。

完整包解密后只在进程内使用，落盘重新加密。当前 CLI 没有长期解锁服务，也没有 OS keychain 集成；这些属于后续控制端工作。

## 后续向导字段

面板与 CLI 共用同一模型，不能各自维护不同的安全默认值。普通页面只显示：订阅／节点、连接方式／资源、依赖版本／模型、域名／邮箱。秘密保存在控制端，模型接口只返回任务使用所需的公开别名和虚拟路径。

升级已有配置采用预览、版本摘要比较和迁移收据。第一版只允许新配置导入，不做静默合并；旧配置仍可保留用于回退。公共发布、云端启动和服务注册与导入分别记录，导入成功不代表已经授权执行它们。
