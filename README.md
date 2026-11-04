# BuildX

BuildX 是面向 Revit 的本地 AI 助手，正在从原实验工程提取为独立项目，并将需要的 AEC 查询和 Argus 业务能力迁为自有 Revit C# 命令。

当前阶段：提取源码基线、建立完整命令清单、实施首批六项原生查询。现有路径与依赖尚在迁移，当前源码不是可交付安装包。

## 开发与进度

- [实施状态](docs/migration/STATUS.md)
- [任务台账](docs/migration/TASKS.json)
- [总规划](docs/migration/PLAN.zh-CN.md)
- [原生替代规划](docs/migration/NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md)
- [每小时检查与推进](docs/migration/SUPERVISION.md)

首次基线使用 `node scripts/import-legacy-baseline.mjs` 按源码白名单提取，拒绝覆盖已有文件，并核对来源与复制摘要。该操作不复制用户数据、运行组件或历史候选，不启动服务。

保留原有目录布局以便先验证行为。实际开发命令以本项目 package.json 和各阶段记录为准；正式构建入口及测试集合随迁移补齐。Revit API 与客户机验收单独记录。
