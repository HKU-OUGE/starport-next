# 接口与状态合同

`readiness.mjs` 是已实现的纯判定逻辑；以下 API 是后续 Session Broker／Control 的设计，不是已监听的 HTTP 服务。

| 入口 | 授权方 | 语义 |
| --- | --- | --- |
| `POST /control/imports/preview` | 操作用户 | 解密并返回不含秘密的预览 |
| `POST /control/imports` | 操作用户 | 新配置导入，不能自动激活 |
| `POST /control/egress/plans` | 操作用户 | 生成有摘要和有效期的出口计划 |
| `POST /control/operations` | 操作用户 | 执行已授权计划，operationId 去重 |
| `GET /control/nodes` | 操作用户 | 云状态、SSH、运行时、资源和出口分别展示 |
| `POST /workspaces` | 已授权项目用户 | 使用公开节点／依赖版本 ID 创建环境 |
| `POST /sessions` | 已授权项目用户 | 绑定工作区和单一 Engine 所有者 |
| `POST /sessions/:id/turns` | 会话用户 | operationId、ownerGeneration、消息与附件引用 |
| `GET /sessions/:id/events?after=cursor` | 会话用户 | 单调游标、断线追赶和过期游标重置 |
| `POST /jobs` | 项目用户／受限模型工具 | 计算资源、入口、超时及数据 ID |
| `GET /jobs/:id/logs?after=cursor` | 项目用户／受限模型工具 | 增量日志，不以日志活跃度判定存活 |
| `POST /uploads/:id/chunks` | 项目用户 | offset、chunk hash；重复分块幂等 |
| `GET /artifacts/:id` | 项目用户 | 授权、Range、摘要；与会话网络连接独立 |

控制接口不能注册成模型工具。模型只得到公开别名、预算、项目内路径和受限任务状态，不能得到 SSH／云原始响应、Access 邮箱或请求来源 IP。

Node 状态：`unverified → provisioning → verifying → ready`；异常为 `degraded/stale/offline/stopped/unknown`。`paused` 是接收开关，与节点本身是否在线分别记录。配置 generation 改变使旧收据立即失效。

Job 状态拆为 `computeStatus`、`collectionStatus`、`releaseStatus`。训练成功但只收回部分文件不能被写成计算失败。Session 状态为 `idle/thinking/tool/approval/reconnecting/error`，与 Job 存活独立。
