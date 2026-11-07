# NWC 导出条件核查

2026 年 11 月 7 日。BuildX 新增只读 `revit_preview_nwc_export`。工作区候选共 107 项，其中 48 项只读。AEC 的 9 个无具名入口仍包括 `revit_export_navisworks`。

按精确视图 ID 查询当前项目中的一条结果。返回 Navisworks 导出器是否可用，并区分可打印三维视图、不可打印、三维样板及缺失或非三维视图。可打印三维视图是 BuildX 为按视图导出选定的范围。查询不创建文件，不授权导出，输出不包含路径或导出内容。[Autodesk Revit 2024 导出 API](https://help.autodesk.com/cloudhelp/2024/ESP/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Export_html.html)

Code Mode 在 `views` 域分页发现，再按名称获取完整契约。聊天 `@` 支持英文全名、操作名、首字母 `pne` 和「核查 NWC 导出条件」。命令栏沿用文档校验和原子读队列。宿主没有具名能力时拒绝入队，回执的视图 ID 必须与原请求一致。

- Node 合组 134/134，无跳过。覆盖生产 MCP 与合成队列、旧宿主及无效参数拒绝、错误视图回执保留原请求、命令栏点击和 Code Mode。完整目录 107 项逐项复核英文全名、操作名、首字母和命令栏条目。
- C# 图纸夹具通过，新增用例覆盖三维视图状态、导出器缺失或异常和输入拒绝。受控宿主 109/109。57 份 C# 使用本机 Revit 2024 API 引用编译通过，复核编译输入与 DLL 摘要。
- 本地证据在 `artifacts/nwc-preview-node.log`、`artifacts/nwc-peer-20261107-csharp/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

真实 Revit 和内嵌 WebView 待验。实际 NWC 导出仍依赖可信暂存、完整输出清单、原回执及发布流程。
