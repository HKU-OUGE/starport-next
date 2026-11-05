# Chrome 独立窗口消失

WSLg 同时提供 X11 和 Wayland。当前 Starport 项目入口将 Chrome 明确设为 X11/XWayland；用户改过启动代码后，不能只按仓库默认值判断。`chrome://version` 可查看 `--ozone-platform`，无需提供完整命令行或浏览网址。

重新打开后仍显示原页面，可能是窗口显示丢失，也可能是 Chrome 重启后恢复会话。用进程号和启动时间区分，避免直接重启 WSL 丢失现场。

## 记录现场

在 Windows 的 Starport 仓库目录运行；`main` 换成实际项目 ID，状态路径按该安装填写：

```powershell
node scripts/diagnose-wslg.mjs --state private/wsl --workspace main
```

提前连续记录 30 分钟，每 5 秒取一次状态：

```powershell
node scripts/diagnose-wslg.mjs --state private/wsl --workspace main --watch 1800 --output private/diagnostics/chrome-window.jsonl
```

输出文件必须是新文件。脚本只读，不关闭应用，不重启 WSL，不联网，不唤醒已停止的发行版。只返回所选项目的浏览器／图形会话进程号、启动计数、请求的 Ozone 模式、显示 socket 是否存在及日志的固定错误标记；不输出命令行、URL、环境变量或原始日志。日志标记本身不能证明故障原因。

| 消失前后对比 | 下一步 |
| --- | --- |
| Chrome PID 与 `startTicks` 都相同 | 浏览器没有退出，优先检查 WSLg 窗口映射、显示连接、最小化和多显示器行为 |
| Chrome 改了 PID／启动计数，图形会话相同 | 检查 Chrome 自身退出、崩溃或内存压力；页面保留可能来自会话恢复 |
| 浏览器和图形会话都重建 | 检查控制端退出、WSL 停止或项目通道关闭 |
| 实际 `requestedOzone` 为 `wayland` | 先保存工作；若要对照，回到当前项目入口的 X11 配置后独立复现，不并行启动两种模式争用同一浏览器配置 |

面板鉴权和网页桌面的连接时限不负责关闭 WSLg 原生窗口。没有该 Windows 机器的现场数据时，不能把显示丢失直接判断为训练被杀、Chrome 崩溃或某一网络故障。

## 本次已修复的独立缺陷

原控制桥在接近 48 条连接时，关闭事件尚未执行就来了替代连接，会把一次正常连接更替误判为全局故障；整个本机图形会话可能随之结束。现在同步释放通道名额，容量不足或单连接积压只关闭相应连接。无效协议和真正的控制端退出仍关闭受控通道，没有增加直连回退。

此缺陷有自动化复现和回归测试；它不等于已经确认某台 Windows 上窗口消失的原因，也不能修复 WSLg 自身的窗口管理错误。

微软资料：[WSLg 窗口消失记录](https://github.com/microsoft/wslg/issues/1058)、[WSL／WSLg 日志位置](https://github.com/microsoft/WSL/blob/master/doc/docs/debugging.md)。
