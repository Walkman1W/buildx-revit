# IFC 导出条件核查

2026 年 11 月 7 日。BuildX 新增只读 `revit_preview_ifc_export`。工作区候选共 108 项，其中 49 项只读。AEC 的 9 个无具名入口仍包括 `revit_export_ifc`。

按精确视图 ID 查询当前项目的一条结果。结果报告 IFC 功能是否可用、文档是否只读，以及指定 ID 指向非样板视图、样板还是缺失或非视图。族文档和链接文档拒绝查询。非样板状态表示找到视图，实际可导出性仍取决于事务、选项和导出器执行。IFC 的可见性筛选可指定视图 ID。实际导出要求打开事务。[Autodesk IFC 功能检查](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/c1c011d3-b6e9-2a64-8c58-c7c386100aae.htm) · [IFC 筛选视图](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/927884ac-60b2-fe93-faac-8212d26ebd6a.htm) · [IFC 导出事务](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/7efa4eb3-8d94-b8e7-f608-3dbae751331d.htm)

Code Mode 在 `views` 域分页发现，再按名称读取完整契约。聊天 `@` 支持英文全名、操作名、首字母 `pie` 和「核查 IFC 导出条件」。命令栏沿用文档身份校验及原子读队列。缺少具名宿主能力时在入队前拒绝，原回执中的视图 ID 必须与请求一致。

- Node 合组 136/136，无跳过。覆盖生产 MCP 与合成队列、旧宿主和无效参数拒绝、错误视图回执保留原请求、Code Mode 和命令栏点击。完整目录 108 项逐项核对英文全名、操作名、首字母与命令栏映射。
- C# 图纸夹具通过，新增用例覆盖视图、项目只读状态、导出器缺失或异常、无效 ID 和不适用文档。受控宿主 109/109。57 份 C# 使用本机 Revit 2024 API 引用编译通过，复核编译输入与 DLL 摘要。
- 本地证据在 `artifacts/ifc-preview-node.log`、`artifacts/ifc-peer-20261107-unique/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

真实 Revit 和内嵌 WebView 待验。实际 IFC 导出仍依赖事务、可信暂存、完整文件清单、原回执和发布流程。
