# Starport 远端计算

本项目可通过 `starport-compute` MCP 使用远端 CPU/GPU。计算不是本机 Bash 的默认执行位置。
Claude Code 和 Desktop 的 Code 页应打开 `/workspace`；Desktop Chat 使用 MCP 工具。

1. 先调用 `compute_health`，区分 `configuredLimits` 和当前节点实际 `limits`。遵守用户要求的资源范围；不要把配置上限当作现有硬件。
2. 将 Python/Bash 入口与依赖文件一起交给 `compute_submit`。`files` 可直接传 UTF-8 文件内容；`local_files` 可读取本项目相对路径。入口必须包含在输入中。
3. 每次任务得到新的远端 `/workspace`，不会继承前一个任务的文件。产物写入 `/output`。
4. 提交一次并立即保存返回的任务 ID。用 `compute_status`、`compute_logs` 跟进；结束后检查 `exit_code` 和 `resources_released`。
5. 用 `compute_download` 下载产物到项目相对路径；它拒绝覆盖已有文件。需要在聊天中验证文本结果时设置 `include_text: true`。
6. 取消用 `compute_cancel`，之后查询状态直到资源释放。关闭聊天不等于取消计算任务。
7. 返回 `outcome_unknown` 时先调用 `compute_jobs` 核对并报告，不重复提交。连接失败不表示任务已停止。

输入最多 16 个文件、合计 16 MiB。内存单位 GiB；`parallel: null` 表示不设固定任务数上限，实际资源检查仍生效。共享 GPU 必须已有授权；本 worker 不提供跨服务统一调度或显存硬配额。

工具只连接项目计算 API。不要使用管理 SSH，不读取或输出环境令牌、客户端登录凭据、云凭据。MCP 不需要这些秘密作为参数。不要把项目 HOME 当作任务输入。

Claude Code 也可通过 Bash 使用 `python3 /opt/starport/compute-client.py`，命令为 `health`、`jobs`、`submit`、`status`、`logs`、`cancel`、`download`。运行 `--help` 查看参数。模型 API 计费与远端资源配额是不同约束。

示例：先检查容量，再提交一个 1 CPU、2 GiB、0 GPU、60 秒任务，内容为 `print('hello'); open('/output/result.txt','w').write('ok')`。保存 ID，确认完成并释放，然后下载并读取 `result.txt`。GPU 任务需要在 submit 中明确指定 `gpus`。
