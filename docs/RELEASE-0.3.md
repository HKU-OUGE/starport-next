Starport Next **v0.3.0-beta.2**：图片剪贴板与项目文件窗口。

- Linux Xpra 新增可选的双向文字与图片剪贴板（PNG/JPEG），保留仅文字与关闭模式。
- 客户端页新增独立文件管理器，使用 Thunar 打开项目 `/workspace`，支持 Xpra、WSLg 和网页桌面入口。
- 项目文件区支持批量选择／拖入文件；上传锁定目标项目与目录，同名覆盖需确认，并保留 SHA-256 校验。
- Windows `.exe` 和 Linux `.run` 内置 Node.js；可更新／修复已有安装，保留私有配置与工作区。

**更新方式：**关闭本安装中正在运行的工作及图形应用，运行新版安装器并选择更新／修复。需要文件管理器时保留“Claude 客户端工具包”；Linux 需要图片复制粘贴时勾选“无缝窗口”和“文字与图片剪贴板”，更新后重新打开项目窗口。

文件拖放边界：项目文件管理器与同一项目应用之间使用原生拖放；主机通过“打开项目文件夹”或网页传文件。**Windows Explorer 直接拖进任意 WSLg 窗口尚未实现。** 不挂载整个主机磁盘，也不开放 Xpra 任意文件传输。

[图片与文件说明](https://github.com/HKU-OUGE/starport-next/blob/main/docs/CLIPBOARD-FILES.md) · [安装指南](https://github.com/HKU-OUGE/starport-next/blob/main/docs/INSTALLER.md)

这是预发布版本。CI 验证源码测试和两种安装包的校验／安装／修复／保留数据卸载／重装；这些检查不等于实际 WSLg/Xpra 图片往返和跨应用拖放验收。Windows 的交互式 UAC、全新 WSL2 与 WSLg 仍需目标机器验证。macOS 没有本次安装包。

附 `SHA256SUMS.txt`。安装包尚未商业代码签名；Windows 使用 `/S /VERIFY`、Linux 使用 `--check` 可校验安装载荷。
