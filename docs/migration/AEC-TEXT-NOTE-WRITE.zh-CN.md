# AEC 文字注释创建验收

2026 年 11 月 7 日。新增 `revit_create_text_note`，AEC 原 50 项未接入能力还剩 33 项。候选工作区共 79 项，其中 43 项只读。

一次在当前项目的显式视图中创建一条不自动换行的纯文本注释。提交目标视图和文字类型的精确 ID、Revit 内部模型坐标系下的左上锚点（XYZ，毫米）和最多 2,000 个 UTF-16 代码单元的非空文本。支持多行，输入的 CRLF 和 CR 统一为 LF；宿主按 Revit API 需要传入 CR。宿主校验非样板视图与 `TextNoteType`，由 Revit 判断目标视图能否放置注释。定位使用明确给出的坐标，不以视图原点估算平面。再生后和内层事务提交后均回读构件、视图和类型 ID、文本及锚点，锚点差异不得超过 0.001 毫米。[Autodesk TextNote.Create 参考](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/465d02a9-8bc8-8e9f-cc57-642c2626e4d6.htm)

Code Mode 在 `views` 域分页发现，按工具名获取完整契约。聊天 `@` 支持英文全名、`create_text_note`、首字母 `ctn` 和「创建文字注释」。命令栏提供精确 ID、分轴坐标和多行输入，并沿用逐次确认。执行必须通过具名宿主能力、权限和文档绑定；默认预览并回滚，应用后不保存模型。回执不符保留原请求及未知状态，不自动重发。每次只有一条有界结果。

- Node 串行回归 120/120，无跳过。覆盖旧宿主和无效参数在入队前拒绝、精确 ID、多行规范化、回执不符不重发、Code Mode 发现与契约、完整目录搜索和命令栏点击确认。
- 生产 C# 受控夹具 45/45，新增七项覆盖多语言多行、XYZ 换算、错误类型、空白和过长文字、超出坐标范围，以及内层提交后文本或位置变化。坐标解析和回执形状取自生产方法，替代夹具原先的数组模拟。通用受控宿主 105/105。
- 36 份 C# 使用实际 Revit 2024 API 引用编译通过，逐一复核编译输入和 DLL 摘要。隔离证据为 `artifacts/text-note-node-final.log`、`artifacts/text-note-fixture-final/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

真实 Revit 的视图放置资格、坐标和多行呈现、事务回滚及内嵌 WebView 待用获准测试模型验收。本轮仅编译隔离候选。下一批可定义指定剖面类型和明确坐标系的有界剖面视图创建。
