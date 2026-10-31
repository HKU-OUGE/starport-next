---
status: accepted
---
# 将整个 Agent 放入项目边界

采用官方 Claude Code／Agent SDK 保留完整工具能力，同时把 Agent、文件工具、插件、MCP 和子进程放入同一项目环境。按单条 Bash 远程执行不能覆盖原生文件工具及扩展，因此现有 Worker 是计算适配器，而不是可直接冒充 Desktop SSH 环境的服务。代价是需要单独验证持久运行时、SSH/SFTP 和原生引擎兼容性。
