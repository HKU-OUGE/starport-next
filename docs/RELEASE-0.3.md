Starport Next 的首个统一安装器预发布版本。

- Windows `.exe`、Linux `.run`，内置 Node.js。
- 同一向导选择功能、填写订阅和连接配置、检查安装进度、更新／修复或卸载。
- 系统依赖通过 Windows UAC／Linux PolicyKit 授权；不保存管理员密码。
- 可选新项目免密钥环模式，默认保留密钥环保护。
- 默认卸载保留项目与凭据；永久删除需要单独选择。
- 包含主分支的中文输入、剪贴板、X11／Wayland 诊断与会话连接修复。

计算和远程入口连接已有 Starship／Cloudflare Access 配置，不自动创建付费云资源。安装不调用模型、不代替账号登录。

先下载对应 `.exe` 或 `.run`，按[安装指南](https://github.com/HKU-OUGE/starport-next/blob/main/docs/INSTALLER.md)操作。首次下载的运行环境和客户端仍需联网。

Linux 与 Windows 的真实安装包均通过安装、修复、保留数据卸载、重装和彻底卸载测试；包含中文路径和 Windows 中文菜单验证。

这是 **beta**：Windows 的交互式 UAC、全新 WSL2 和 WSLg 输入仍需实际机器验收。安装包提供 SHA-256 校验，尚未商业代码签名。
