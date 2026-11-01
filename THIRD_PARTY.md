# 第三方来源

网页项目桌面通过 npm 锁定版本依赖 [noVNC](https://github.com/novnc/noVNC)
（MPL-2.0，完整许可证随包提供）和 [ws](https://github.com/websockets/ws)（MIT）。
noVNC 源码模块按原样提供给浏览器，未修改或复制入本仓库。Linux 显示由发行版软件包
TigerVNC、Openbox 提供，遵循各自软件包附带的许可证。

`packages/worker/worker.py`、`guest_entry.py`、`probe.py`、`gpu_probe.py` 和
`configure_gpu.py`、`install.py` 及 `tests/test_worker.py` 改编自 [Starport Pi](https://github.com/HKU-OUGE/starport-pi)，
Copyright (c) 2026 Starport contributors，MIT License。这些源码由 Next 独立维护，
不加载 Pi 包、配置、进程或服务器 worker。

MIT License

Copyright (c) 2026 Starport contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
