# 适配器合同

此目录定义跨后端接口；本地 QEMU 的初始实现位于 `packages/runtime`，使用方式见 [LOCAL-RUNTIME.md](../../docs/LOCAL-RUNTIME.md)。远端 DSW、计算调度与远程入口尚未在新仓库实现。适配器只能实现声明的能力，探测失败不得回退到宿主执行。

| 适配器 | 主要操作 | 验收输出 |
| --- | --- | --- |
| Egress | inspect、plan、validate、apply、rollback、health | 配置摘要、独立守卫、实际出口、断线关闭证据 |
| Node | discover、inspect、connect、initialize、reconcile | 私有实例身份、资源、运行时版本和公开能力 |
| Workspace | create、start、stop、sshEndpoint、verify | 项目范围、SSH/SFTP、文件和环境边界 |
| Engine | start、send、approve、interrupt、resume、events | 唯一会话所有者、可恢复游标和幂等请求 |
| Compute | reserve、submit、status、logs、cancel、collect、release | 每任务分配、退出码、收集状态和释放确认 |
| Dependency | inspect、publish、mount、lease、retire | 版本摘要、兼容性、只读挂载和引用计数 |
| Ingress | inspect、plan、enroll、verify、reconcile、removeOwned | Access JWT、域名所有权、Tunnel 和撤销收据 |

每个变更操作接收 `operationId` 与预期配置版本；未知结果先 inspect/reconcile。控制端只传固定协议，真实连接参数不由模型工具提供。私有观测与模型可见视图分别序列化，不能通过“删除几个字段”的方式直接透传云 API。

SSH 项目入口允许可审核的 Shell/SFTP 语义，但服务器端强制落入对应项目环境。管理 RPC 不提供任意宿主命令。公开错误使用稳定错误码和可操作说明，完整云／SSH 诊断只存在私有运维记录。
