# AEC 图纸创建验收

2026 年 11 月 7 日。新增 `revit_create_sheet`，AEC 未接入项由 37 减至 36。候选工作区共 76 项，其中 43 项只读。

每次创建一张图纸。填写名称与编号，指定当前项目的精确图框类型 ID 可创建普通图纸，留空创建占位图纸。可通过 `revit_list_titleblocks` 分页查询可用图框。执行器确认 ID 对应图框族类型，Revit 校验图纸编号是否合法且唯一。再生和内层事务提交后按新图纸 ID 回读名称、编号、占位状态与实际图框类型。结果仅返回这五项，图框类型在占位图纸中显式为 `null`。[Autodesk Revit 2024 图纸 API](https://help.autodesk.com/cloudhelp/2024/CHS/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/View_Types/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Types_ViewSheet_html.html)

使用宿主具名能力、文档绑定和写权限。命令栏先确认再提交，默认预览回滚，应用只保留内存修改。Node 校验原回执，不符时记录未知并保留原请求。Code Mode 在 `views` 域分页发现，按工具名获取完整契约。聊天 `@` 可用英文全名、`create_sheet`、首字母 `cs` 和「创建图纸」搜索。

- Node 串行回归 108/108，覆盖旧宿主拒绝、入队前校验、精确 ID、占位分支、原回执不符不重发，以及 Code Mode、`@` 搜索与命令栏确认。
- 生产 C# 受控夹具 22/22，其中八项图纸用例覆盖两类图纸、无效图框 ID 和内层提交后的编号与图框漂移。通用受控宿主 105/105。
- 36 份 C# 使用 Revit 2024 API 引用编译通过，逐一复核编译输入摘要。独立证据为 `artifacts/sheet-node-final.log`、`artifacts/fixture-sheet-03/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

实际 Revit 图纸与图框的创建、事务回滚和内嵌 WebView 待在获准测试模型验收。下一批可接入按图纸和视图 ID 放置视口。
