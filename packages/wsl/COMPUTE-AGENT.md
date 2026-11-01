# Starport 远端计算

本项目可通过 `starport-compute` MCP 使用远端 CPU/GPU。计算不是本机 Bash 的默认执行位置。
Claude Code 和 Desktop 的 Code 页应打开 `/workspace`；Desktop Chat 使用 MCP 工具。

1. 先调用 `compute_health`，查看 `nodes` 中每台服务器的 ID、就绪状态、`configuredLimits` 与实际 `limits`。多服务器提交时用 `node` 明确选择；只有已配置默认服务器时才可省略。汇总资源不能作为单个任务的预算。
2. 将 Python/Bash 入口与依赖文件一起交给 `compute_submit`。`files` 可直接传 UTF-8 文件内容；`local_files` 可读取本项目相对路径。入口必须包含在输入中。
3. 每次任务得到新的远端 `/workspace`，不会继承前一个任务的文件。产物写入 `/output`。
4. 提交一次并立即保存返回的任务 ID。用 `compute_status`、`compute_logs` 跟进；结束后检查 `exit_code` 和 `resources_released`。
5. 用 `compute_download` 下载产物到项目相对路径；它拒绝覆盖已有文件。需要在聊天中验证文本结果时设置 `include_text: true`。
6. 取消用 `compute_cancel`，之后查询状态直到资源释放。关闭聊天不等于取消计算任务。
7. 返回 `outcome_unknown` 时先调用 `compute_jobs` 核对并报告，不重复提交，也不要换另一台服务器重放。连接失败不表示任务已停止。任务 ID 永久绑定原服务器，查询、取消和下载无需再次选择服务器。

输入最多 16 个文件、合计 16 MiB。内存单位 GiB；`parallel: null` 表示不设固定任务数上限，实际资源检查仍生效。共享 GPU 必须已有授权；本 worker 不提供跨服务统一调度或显存硬配额。

工具只连接项目计算 API。不要使用管理 SSH，不读取或输出环境令牌、客户端登录凭据、云凭据。MCP 不需要这些秘密作为参数。不要把项目 HOME 当作任务输入。

复用依赖／数据时先调用 `compute_resources`，指定同一个 `node`。将 `id` 和完整 `version`
放入 `compute_submit.mounts`，例如 `[{"id":"返回的ID","version":"返回的版本摘要"}]`。
每次最多 16 个版本。环境位于 `/dependencies/<ID>`，数据位于 `/datasets/<ID>`，均为只读。
这些路径只存在于该远端任务中，不是本机 WSL 路径。新增包、缓存与输出写到 `/workspace`、
`/tmp` 或 `/output`。目录内内容对本安装的所有项目可读。

可选 `python_environment: "ID"` 会用已选环境的 `bin/python` 或 `bin/python3` 运行入口；
必须同时在 mounts 中选择该 Python 版本。发布不代表兼容：先运行小型 import 检查，确认
解释器、系统动态库与二进制包可用。纯库目录可在任务脚本中设置相应的 `sys.path`／
`PYTHONPATH`；不要添加宿主路径、请求管理 SSH，或在宿主执行环境修复。只读不隐藏
包内原始路径或敏感内容；目录外软链接会在发布时拒绝。缺少依赖时报告具体失败并让操作员
准备新的中性路径版本。停用后的版本不再接受新任务，已有任务继续使用提交时的固定版本。

Claude Code 也可通过 Bash 使用 `python3 /opt/starport/compute-client.py`，命令为 `health`、`resources`、`jobs`、`submit`、`status`、`logs`、`cancel`、`download`。提交用 `--node SERVER_ID` 选择服务器、`--mount ID:VERSION` 选择复用版本，可选 `--python-environment ID`。运行 `--help` 查看参数。模型 API 计费与远端资源配额是不同约束。

示例：先检查容量，再提交一个 1 CPU、2 GiB、0 GPU、60 秒任务，内容为 `print('hello'); open('/output/result.txt','w').write('ok')`。保存 ID，确认完成并释放，然后下载并读取 `result.txt`。GPU 任务需要在 submit 中明确指定 `gpus`。
