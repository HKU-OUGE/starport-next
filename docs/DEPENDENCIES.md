# 外部依赖复用与挂载

当前可复用安装包和已校验的运行时缓存，为每台服务器建立独立 Next 运行副本；不必
重新下载 rootfs、gVisor 或逐包重新安装基础环境。每个任务仍获得独立工作目录。
项目依赖／数据的任意外部目录挂载尚未启用，不能把下述设计视为已经可用。

## 拟采用的边界

由操作员在控制端登记服务器、依赖 ID、版本摘要和具体来源目录。模型只选择已登记 ID，
不传宿主路径；执行器只读挂载到固定 guest 路径，例如 `/dependencies/python` 或
`/datasets/training`。缓存、日志与临时输出写入当前任务目录，不回写共享依赖。
跨机器需要各节点缓存副本或已授权网络存储，软链接本身不能跨服务器共享文件。

软链接可通过 `readlink` 读取目标，不能作为隐藏路径或权限隔离。挂载命名空间提供独立
目录视图，但仍需检查 guest 的 `/proc/self/mountinfo`、`/proc/mounts` 和工具输出，不能
假定 bind mount 自动隐藏所有来源。见 [Linux mount namespaces](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html)。

Python／Conda 环境还可能在 shebang、`.pth`、`pyvenv.cfg`、包元数据、编译路径和调试信息
中保存绝对路径。Python venv 本身也不保证可迁移，见 [Python venv 文档](https://docs.python.org/3/library/venv.html)。
可优先复用 wheel／包缓存，在中性前缀构建只读版本，再登记挂载；数据集和权重通常更适合
直接只读使用。实际实施前需确定目录范围，并验证链接不能越界、依赖不可写、相邻宿主目录
不可见以及路径信息是否残留。不能承诺第三方包内容完全匿名。
