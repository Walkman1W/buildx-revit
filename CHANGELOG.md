# BuildX 版本记录 / Changelog

[中文 README](README.md) · [English README](README.en.md)

## `buildx-source-20261115` · 2026-11-15

这是 BuildX 主线的内部源码基线。Git 标签固定源码，安装候选继续使用各自的包版本和源码提交。

- **Revit 对话与命令**：合入命令分页、收藏和版本选择改进，更新白底对话、资料库和 Skills 界面。
- **执行与回执**：改进队列等待、超时与迟到回调的结算。结果未知时，通过原请求 ID 核对回执。
- **原生水泵族候选**：由对话确认规格后，使用 Revit 构建带进出水连接件的端吸泵族；端面筛选和失败回执可诊断。早期 `.3` 安装候选已验证 Revit 2024 加载，实际 RFA 生成、保存和重开仍待验收。
- **对话工具预览**：内部候选支持扫描 PDF 识别、生成 Excel、搜索和生成图片。不同能力的依赖、启用方式和验证记录见[联调说明](docs/migration/CHAT-LOCAL-TOOLS-20261115.zh-CN.md)。

### English

This tag marks an internal source baseline on `main`. Installer candidates retain their own package versions and source revisions.

- **Revit chat and commands:** improved command paging, favorites, and version selection; updated the chat composer, knowledge library, and Skills UI.
- **Execution and receipts:** improved queue handling, timeout settlement, and late callbacks. If an outcome is unknown, look up the original request ID.
- **Native pump family candidate:** after the user approves the specification in chat, Revit can attempt to build an end suction pump family with inlet and outlet connectors. Receipts include diagnostics for port face selection and failures. The earlier `.3` installer candidate was verified to load in Revit 2024; generating, saving, and reopening the RFA in Revit remain to be verified.
- **Chat tool preview:** the internal candidate supports scanned PDF recognition, Excel generation, web search, and image generation. See the [integration notes (Chinese)](docs/migration/CHAT-LOCAL-TOOLS-20261115.zh-CN.md) for dependencies, feature flags, and evidence.

[实施状态 / Implementation status](docs/migration/STATUS.md) · [任务台账 / Task ledger](docs/migration/TASKS.json)
