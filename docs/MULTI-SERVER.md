# 多服务器管理

控制面板采用左侧导航：总览、计算服务器、服务器任务、项目工作区、Claude 工具、服务注册、远程访问和配置迁移分别显示。服务器列表展示每台机器的状态、资源申请量与可用上限；任务可按服务器、项目和状态筛选。暂停接单只阻止该节点的新任务，已有任务仍可查询、下载和取消。

## 登记连接

每台服务器使用独立的 Next worker、本机连接端口、令牌和状态目录。先按 [COMPUTE.md](COMPUTE.md) 安装并验证，随后在私有 `host-control.json` 登记：

```json
{
  "format": "starport-host-control",
  "version": 1,
  "port": 18884,
  "wslState": "wsl",
  "computeNodes": [
    { "id": "primary", "name": "GPU 服务器", "url": "http://127.0.0.1:19091/", "tokenFile": "secrets/compute-token.txt", "workerComputeFile": "worker-compute.json" },
    { "id": "cpu-1", "name": "CPU 服务器", "url": "http://127.0.0.1:19092/", "tokenFile": "secrets/cpu-1-token.txt", "workerComputeFile": "cpu-1-worker.json" }
  ],
  "defaultComputeNode": "primary"
}
```

示例中的 worker 配置必须分别存在，且端口与令牌和相应节点一致。路径相对包含它的配置文件；SSH／DSW 凭据只在控制端保存。最多 32 个节点。节点 ID 唯一且固定，显示名称可以更改。两个节点不能登记同一个 HTTP 端点。

旧的 `compute` 和顶层 `workerComputeFile` 仍可使用，会映射为 `primary`；迁移时保留其 ID、URL 和令牌，删除旧字段后改用 `computeNodes`。两种写法不能混用。多节点可指定默认节点；不指定时提交必须显式选择 `node`，不会自动猜测或故障转移。单节点默认选择唯一节点。

暂停接单与首次连接绑定保存在控制端 `compute-nodes.json`。同 ID 的 URL／SSH 材料／令牌变化会拒绝使用该连接，先核对旧任务与实际服务器。不要删除登记文件来绕过核对。确认同一服务器的合法连接更新后，备份登记文件并由安装者更新该节点的绑定；如果是另一台机器，应分配新 ID。

完成配置后，在工作区与任务空闲时重启本部署的守护与控制端，保留既有 worker 进程。守护为每个 `workerComputeFile` 分别建立 `compute-ID` 服务，见 [SERVICES.md](SERVICES.md)。没有该字段的连接由外部进程管理。

## Claude 选择服务器

先调用 `compute_health`，查看 `nodes` 中各节点的 `ready`、`acceptingNewJobs`、`limits` 与 `configuredLimits`。随后传入 `compute_submit` 的 `node`，例如 `cpu-1`。CLI 对应：

```sh
python3 /opt/starport/compute-client.py submit train.py --node cpu-1 --cpus 2 --memory-gib 4 --gpus 0
```

总览的合计资源用于观察，不能把多机总和作为一个任务申请。本实现不做跨节点分布式调度，也不协调 Pi 或其他服务的资源预留。配置上限与物理可用上限分别显示。

任务的公开 ID 由 Next 生成，远端 ID 留在控制端。日志、取消、状态和产物始终路由到提交时的节点；不同服务器返回相同远端 ID 也不会串线。旧任务固定归属 `primary`，移除节点后历史仍保留。提交响应未知时保留待核对记录，不重试或切换节点。

新增服务器须验证真实 CPU 任务、日志、下载与释放；有授权 GPU 才执行 GPU 测试。模拟双节点测试不代替第二台真实机器的验收。官方 Claude 账号登录与 Desktop 对话验收仍单独记录。
