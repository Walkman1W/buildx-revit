# BuildX

BuildX 是面向 Revit 的本地 AI 助手，正在从原实验工程提取为独立项目，并将需要的 AEC 查询和 Argus 业务能力迁为自有 Revit C# 命令。

当前阶段：六项原生查询、独立运行布局和可重建内部候选已完成源码及隔离验证（181 项查询回归、105 项布局/安装检查、80 项宿主检查，以及从完整快照的 Revit 2024 API 引用编译）。已生成运行包与源码 ZIP，`releaseReady:false`，实际安装仍受阻塞。真实 Revit 加载/执行尚未验收。

## 开发与进度

- [实施状态](docs/migration/STATUS.md)
- [任务台账](docs/migration/TASKS.json)
- [六查询实施与验证](docs/migration/NATIVE-SIX-VERIFICATION.zh-CN.md)
- [独立运行布局](docs/migration/RUNTIME-LAYOUT.zh-CN.md)
- [内部候选与阻塞](docs/migration/INTERNAL-CANDIDATE-20261105.zh-CN.md)
- [总规划](docs/migration/PLAN.zh-CN.md)
- [原生替代规划](docs/migration/NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md)
- [每小时检查与推进](docs/migration/SUPERVISION.md)

首次基线使用 `node scripts/import-legacy-baseline.mjs` 按源码白名单提取，拒绝覆盖已有文件，并核对来源与复制摘要。该操作不复制用户数据、运行组件或历史候选，不启动服务。

`npm ci --ignore-scripts` 安装源码验证依赖；`npm run check` 检查入口语法；`npm run test:native-queries` 与 `npm run test:layout` 运行目标回归（C# 测试使用 Windows 既有 .NET Framework 编译器）。运行候选只带已经交付的 start/check 脚本和零 npm 运行依赖；源码测试与原锁文件留在源码快照。真实 Revit 与客户机验收单独记录。
