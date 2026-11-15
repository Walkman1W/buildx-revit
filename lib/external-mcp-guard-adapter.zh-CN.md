# 本机 MCP 守护适配器（隔离候选）

此模块尚未接入 BuildX 面板，也不提供或证明 Windows 安全沙箱。它将未来由可信宿主提供的启动 owner 与 MCP SDK 的公开 Transport 接口衔接；用户输入不得提供启动 owner。没有可信 owner 时不会构造实例。

## 所有权约定

- `prepare(spec)` 必须同步且无资源分配、无启动，并返回冻结的 session。spec 是固定的可执行文件、SHA-256、身份、工作目录身份、参数和环境快照；它还提供 SDK `StdioClientTransport` 构造函数。此约定当前依赖宿主实现，模块本身无法证明宿主遵守。
- `startAtomic()` 必须由可信原生 owner 在同一受保护阶段实际启动并拥有进程、管道及 Windows Job；既不能先检查后用未受保护路径启动 helper，也不能只验证 Node 或脚本解释器的二进制而忽略脚本参数及其依赖。参数、目录、环境需与获批快照完全一致。配置在审批或启动阶段撤销如何与实际原子创建同步，仍未实现。
- `disposeUnstarted()` 仅处理从未启动的资源；失败时保留相同 session 并允许重试，启动与释放不能同时开始。
- `confirmClosed()` 必须证明原 helper、整个 Job 中进程及所有管道已结束，并确认相关资源释放；进程 PID、SDK `onclose` 和 `close()` 返回值单独均不足以证明。失败或结果未知时不能转发关闭通知，适配器强持有同一 session；`close()` 可重试核对且拒绝新启动。已有关闭或启动 promise 未结束时不能重复发起。启动或关闭期间的发送会立即阻断。

## 现有 native helper 的缺口

现有 `external-mcp-execution-guard.cs` 测试候选能持有目标文件和目录句柄、建立 kill-on-close Job，在正常退出路径打印关闭标记。当前缺少可信 owner 持有并验证 **helper 自身**二进制、目录和所有脚本依赖直到真实启动；经 SDK 按路径 spawn helper 仍存在替换竞态。辅助进程强杀、早期失败或没有关闭标记时，实际后代与管道清理不能因 SDK `onclose` 自动确认为完成。没有实现或核验的 native 证明不能用模拟的 `true` 替代。

## 验证范围

`node --test tests/lib/external-mcp-guard-adapter.test.mjs` 使用模拟启动 owner 检查生命周期、竞态、失败重试和关闭通知，并使用自建本地 stdio 夹具验证 SDK 握手及工具列表；该夹具直接通过 SDK 生成进程且假定清理证明，不代表真实守护或第三方 MCP 验收。未修改 ACL、现有服务或 Revit。实际 guard、私有账本和生产接线完成前，不开放该入口。
