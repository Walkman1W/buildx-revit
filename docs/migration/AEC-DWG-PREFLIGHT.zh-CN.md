# DWG 导出条件核查

2026 年 11 月 7 日。BuildX 新增只读 `revit_preview_dwg_export`。工作区候选共 106 项，其中 47 项只读。AEC 尚无具名入口的 9 项中仍包括 `revit_export_dwg`。

一次核查当前项目的一个精确视图 ID，区分可打印、不可打印、样板、缺失或非视图。占位图纸标为不可打印。返回已安装 DWG 导出器的可用性。可选输入一个大小写精确的已命名导出设置，返回该名称是否列在当前项目的设置中。省略时设置相关两个字段均为 `null`。这次操作读取单条有界结果，不提供输出路径、选项装载或导出授权。[Autodesk Revit 2024 导出 API](https://help.autodesk.com/cloudhelp/2024/ESP/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Export_html.html)

Code Mode 可在 `views` 域分页发现，再按名称获取完整输入与输出契约。聊天 `@` 支持英文全名、操作名、首字母 `pde` 及「核查 DWG 导出条件」。命令栏接受精确 ID 和可选设置名称，沿用文档范围校验与原子读队列。缺少具名宿主能力时在入队前拒绝。回执中的视图和设置名称必须与请求一致。

- Node 合组 132/132，无跳过。覆盖生产 MCP 入口及合成队列、旧宿主拒绝、无效参数拒绝、回执不符时保留原请求、Code Mode 和命令栏点击。完整目录 106 项逐项复核英文全名、操作名、首字母和命令栏条目。
- C# 图纸夹具通过，新增用例覆盖命名设置的大小写、样板与占位图纸、导出器缺失和无效参数。受控宿主 109/109。57 份 C# 使用本机 Revit 2024 API 引用编译成功，复核输入和 DLL 摘要。
- 本地证据在 `artifacts/dwg-preview-node.log`、`artifacts/dwg-peer-final/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-verified/build-record.json`。

真实 Revit 和内嵌 WebView 待验。实际 DWG 导出仍需独立文件发布、完整输出清单和原回执闭环。
