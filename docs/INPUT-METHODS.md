# 项目输入法

Windows／WSL2 与 Linux／QEMU 的项目图形会话内运行 Fcitx5＋Rime。基础包和离线词库只安装一次，各项目的配置、词库缓存、D-Bus 和 XIM 名称独立。

| 模式 | 默认行为 |
| --- | --- |
| 繁体拼音 | 新项目默认中文，台湾繁体字形；使用普通汉语拼音 |
| English | Ctrl + Space 切换；终端默认 ASCII |
| 简体拼音 | 通过输入法菜单或面板手动选择，不作为初始默认 |
| 标点 | 默认半角和 ASCII 标点 |

中文输入只作用于当前编辑框，不转换代码、路径、文件或粘贴内容。窗口状态默认独立，中文模式选择不会同时改变其他已有窗口。手动选过的中文方案会在本项目中保留。原生 Desktop／CLI 不经过面板的聊天发送转换。

## 安装或升级

新安装的完整客户端包含输入法。已有 Windows 安装先关闭本安装的项目图形应用和本机操作，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-input-method.ps1 -State private/wsl -Config private/host-control.json -ControlState private/control
```

脚本检查运行时租约，拒绝覆盖活动项目。只更新本安装；不执行 `wsl --shutdown`，不停止远端训练。
完成后在空闲时重启本安装控制端，重新验证边界并打开应用。

Linux 的对应操作：

```sh
node bin/starport.mjs linux ime-install --config private/host-control.json
```

使用原有受控安装出口；安装失败不切换直连。已安装后，输入法和词库离线工作。

## 使用

从 Starport 的项目入口打开应用。Chrome／Electron 显式使用 X11／XWayland 兼容路径；Linux Xpra 转发项目的应用和候选窗，Windows WSLg 显示它们。

Windows 选择「本机 WSLg 窗口」后，可在「输入法」中点击「对比 X11 / Wayland」。
它同时打开两个标明协议的 Chrome 离线测试窗口，各用独立测试配置，不复用日常浏览器的
账号或配置目录。两个窗口仍处于当前项目边界内，关闭工作区应用时一起结束；普通浏览器
和 Desktop 的默认 X11 启动方式不变。Wayland 的输入法与候选窗兼容性需要单独观察，
不能由 X11 的输入结果推断通过。网页桌面和 Linux Xpra 不提供此 WSLg 对比入口。

2026-11-05 Windows 实机已同时显示两个标记窗口，并核对两个独立 Chrome 主进程的
`--ozone-platform=x11`／`--ozone-platform=wayland` 与独立测试目录。此记录只确认
双协议并行启动，不代表 Wayland 中文候选、剪贴板或所有缩放比例均已验收。

- `Ctrl + Space`：当前窗口的中英切换。
- 输入拼音后，用空格或数字选词；`Esc` 取消未提交的拼音。
- 输入法菜单可选择繁体或简体拼音。
- 面板「Claude 工具 → 输入法」显示状态，提供最近应用输入框的模式切换、快捷键设置和独立恢复。
- 先在应用中点选输入框，再使用面板切换；没有输入上下文时明确提示，不假报成功。
- 快捷键若被宿主或应用占用，可改为 `Ctrl + Shift + Space` 或 `Ctrl + Alt + Space`。宿主使用英文键盘输入（Windows 可用 Win + Space 选择 English），避免两层输入法同时组合文字。

输入法恢复保留应用进程和已提交文本；当前未确认的拼音可能被取消。不会记录按键或组合文字到状态接口。云候选、剪贴板插件和词库同步关闭；初版默认关闭用户词条学习。

## 主机与项目双向复制粘贴

- **Windows WSLg**：开启 WSLg 后使用原生剪贴板，应用内 Ctrl+C／Ctrl+V；终端内 Ctrl+Shift+C／Ctrl+Shift+V。
- **Linux Xpra**：启用 `seamless: true` 和 `seamlessClipboard: "text"`，使用同样快捷键；只同步文字。
- 繁体、简体、英文、多行代码均按原文传递；Fcitx 的剪贴板历史插件仍然关闭。
- Windows 使用 WSLg 自身的格式支持，本项目没有为 WSLg 增加图片功能或强制纯文本过滤。
- 开启同步意味着项目应用可以读取当前主机剪贴板中的文字；关闭无缝查看器即断开该同步通道。多个启用同步的项目会共用主机剪贴板。

## 验证

Windows 先读取安装与会话状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-input-method.ps1 -VerifyOnly -ControlState private/control -Workspace main
```

Linux 使用同一只读诊断：

```sh
node scripts/verify-ime.mjs --state private/control --workspace main
```

诊断不发送 Claude 消息，不读取输入内容。`preflightReady: true` 只表示安装、边界验证和输入法进程就绪；未就绪时退出码为 2。它不能代替实际键盘验收：

1. 先从面板「输入法 → 测试输入」打开项目内的离线测试页，核对候选词和上屏文本，用“测试终端输入”检查终端（只回显文本，不执行命令）。再分别打开 Chrome、Claude Desktop 和 Claude Code 终端；在可编辑输入框中输入 `ceshi`，确认候选窗出现并能上屏“測試”。登录页的字段也可用于临时输入测试，测试后清空，不提交。
2. `Ctrl + Space` 切换后输入 `Hello_123 ./file.py`，核对英文、下划线、数字、路径和标点未变化。
3. 手动选择简体，输入 `ceshi` 并选“测试”；回到另一个已打开的窗口，确认其模式没有被一起改变。
4. 测试退格、Esc、空格、数字选词；在候选窗打开时移动窗口、最大化、改变缩放。
5. 同时打开两个项目，确认候选词、状态与恢复操作互不干扰。
6. 双向复制一段包含中文、英文、换行和代码的测试文字，确认内容完整且没有简繁转换。Linux 同时检查复制图片／文件不会传入项目。
7. 创建一个新项目，检查中文以繁体作为初始默认；关闭并重开已有项目，检查手动选择可保留。断开代理后，已打开窗口中的离线输入仍工作。

Windows 实机结果与 Linux 验证分别记录。进程存在、包已安装、模板检查通过，均不等于中文键盘输入通过。

实际验证范围见 [验收记录](ACCEPTANCE.md#2026-11-05项目输入法)。

## 边界

输入法与应用使用项目私有 D-Bus，不连接宿主输入法服务或读取个人词库。WSLg 的共享 X11 显示限制仍然存在；独立 XIM 名称用于防止实例冲突，不能将共享显示称为强项目图形隔离。不会替换 Windows 的 WSLg 系统镜像或插件 DLL。

上游依据：[Fcitx5 配置](https://fcitx-im.org/wiki/Setup_Fcitx_5)、[Chromium／Electron 接入](https://fcitx-im.org/wiki/Using_Fcitx_5_on_Wayland)、[Rime](https://github.com/fcitx/fcitx5-rime)。
