# 独立计算资源与 Claude 调用

Next 的 Windows 控制端保存服务器连接和凭据；WSL2 内的 Claude Code／SDK 只获得
项目计算 URL 与可撤销令牌。模型生成的命令只在远端 gVisor 任务中执行。

现有隔离训练 HTTP API 和独立 Next SSH／DSW worker 均可接入。独立 worker 的连接器、
协议适配、代理和服务器源码都由本仓库维护，不加载 Pi 包、进程、配置或远端 worker。
可以一次性迁移已授权凭据、已核对主机公钥和已校验依赖缓存；迁移后的运行副本独立。
源码来源与许可证见 [THIRD_PARTY.md](../THIRD_PARTY.md)。

## 安装与资源

服务器目录为 `~/.local/share/starport-next-worker`。`packages/worker/provision.py`
仅接收可信安装方的 JSON：`dependencyRoot` 指向已校验的本地运行时缓存，`cpuIndices`、
`memoryGiB`、`gpuIndices`、`maxParallel` 为已授权预算，`owner` 是安装收据标识，
`sources` 是本仓库 worker、guest_entry、configure_gpu、probe、gpu_probe 的 base64 源码。
它校验 runsc／sidecar 摘要、独立复制 rootfs 并逐文件验证，拒绝共享硬链接和覆盖已有安装。
这不是模型可调用的 API；部署结果未知时先检查 `installation.json`，不可直接重放。

不要根据空闲显存推断 GPU 获准使用。共享 GPU 需要用户授权；当前调度器仅协调本 Next
worker，不与其他服务建立统一资源预留。CPU affinity 和内存监控也不是多租户硬配额。
需要独占资源时先由管理方分配。旧服务、任务和项目目录均应保留。

私有 SSH 连接配置使用 `mode: "ssh"`、`host`、`user`、`port`、`identityFile`、
`knownHostsFile`；文件路径相对该配置。DSW 使用 `mode: "dsw"`，另提供 `instanceId`、
`region`、`hostKeyAlias`、`python`、`proxyClient`、`credentialsFile`。真实值留在私有
目录；SSH 指纹必须核对，禁止关闭主机校验。管理 RPC 命令固定，不接受模型给出的 SSH 命令。

计算桥接配置示例，路径相对这份配置：

```json
{
  "format": "starport-worker-compute",
  "version": 1,
  "port": 19091,
  "state": "worker-compute",
  "connectionFile": "worker-connection/connection.json",
  "nodesFile": "nodes.json",
  "proxyBinary": "tools/mihomo.exe",
  "tokenFile": "secrets/compute-token.txt",
  "limits": { "cpus": 255, "memory_gib": 1600, "gpus": 0, "timeout": 3600, "parallel": null }
}
```

示例不授权 GPU；确认分配后设置 `gpus` 并运行真实 GPU 验收。令牌文件至少保存 32 字符
随机秘密，当前用户可读。启动命令：

```powershell
node scripts/start-worker-compute.mjs --config private/worker-compute.json
```

服务管理独立代理与远端出口隧道。把主控制配置的 `compute.url` 设为
`http://127.0.0.1:19091/`，`compute.tokenFile` 指向同一个私有令牌文件，结束活动会话后
重启本项目控制进程并重新验证。连接材料变化时需要核对原任务，不能静默切换服务器。
关闭网页不会取消任务；关闭计算桥接会切断网络，远端任务仍自行运行、超时及释放。

## Claude 使用方式

将 [compute-client.py](../scripts/compute-client.py) 通过项目文件 API 放到
`/workspace/starport_compute.py`，并在项目 `CLAUDE.md` 中写明以下用法。SDK 使用明确
提示读取说明，再通过现有 Bash 工具调用；当前不是自动注册的 MCP。Desktop 普通聊天
不会自动获得计算工具。

```sh
python3 starport_compute.py health
python3 starport_compute.py submit train.py --file config.json --cpus 2 --memory-gib 4 --gpus 1 --timeout 600
python3 starport_compute.py status JOB_ID
python3 starport_compute.py logs JOB_ID --cursor 0
python3 starport_compute.py download JOB_ID result.json result.json
python3 starport_compute.py cancel JOB_ID
```

任务输入位于远端 `/workspace`，要下载的结果写入 `/output`。每次提交创建新远端工作区，
不共享前次任务的可写文件；显式上传最多 16 个文件、合计 16 MiB，支持 Python／Bash
入口和参数。分布式训练、依赖层选择和数据挂载尚未接入，相关字段会被拒绝。

先查容量，提交一次并保存 ID，轮询最终状态及 `resources_released`。下载检查块摘要和
版本，跨项目查询／取消／下载拒绝。提交响应丢失会保留结果未知记录，不自动重试；远端
工作区及产物也不自动删除。当前桥接同时只接收一个上传提交，已提交任务按并发预算运行。

可给 Claude 的提示：

> 阅读 STARPORT_COMPUTE.md，使用 starport_compute.py 调用远端资源。先检查容量，
> 在指定预算内提交一次任务，保存 ID，查看日志并下载 /output 中的结果。不要输出令牌；
> 提交结果未知时先核对，不能重复提交。

`parallel: null` 表示不设置固定并发任务数上限，CPU／内存／GPU 的实际容量与已预留资源检查仍生效。`configuredLimits` 是配置上限，`limits` 是当前节点可提供的上限，两者不能混淆。内存单位为 GiB。桥接上传提交串行防止重复提交，并不限制已运行任务数量。
