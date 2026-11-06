# AEC 视图样板应用验收

2026 年 11 月 7 日。新增 `revit_apply_view_template`，AEC 未接入项由 35 减至 34。候选工作区共 78 项，其中 43 项只读。

每次为当前项目中的一个视图关联一个兼容的视图样板。使用目标视图与样板的精确 ID，可通过 `revit_list_views` 分页读取两类 ID 和 `is_template`。执行端先检查视图类型与样板兼容性，再赋予持续控制关系。目标已经关联所选样板时跳过赋值。再生和内层事务提交后重新读取关系，返回目标视图 ID、前一个样板 ID、实际样板 ID 和是否发生变更。前一个样板不存在时返回 `null`。[Autodesk Revit 2024 视图样板](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Templates_html.html)

执行沿用具名宿主能力、文档绑定、写权限和原回执。命令栏逐次确认，默认预览回滚，应用只保留内存修改。原回执与请求不符时保留未知状态与原请求，不自动重发。Code Mode 在 `views` 域分页发现，按名称获取完整契约。聊天 `@` 支持英文全名、词段、首字母 `avt` 和「应用视图样板」。

- Node 串行回归 116/116，覆盖旧宿主和无效参数在入队前拒绝、精确 ID、默认回滚、相同样板回执、不一致回执不重发，以及 Code Mode、全目录搜索和命令栏确认。
- 生产 C# 受控夹具 38/38，其中八项视图样板用例覆盖首次关联、原样板 ID 回读、相同样板跳过赋值、无效视图或样板、不兼容及内层提交后的关系漂移。通用受控宿主 105/105。
- 36 份 C# 使用 Revit 2024 API 引用编译通过，逐一复核编译输入摘要。独立证据为 `artifacts/view-template-node-final.log`、`artifacts/aec-view-template-fixture-20261107/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

真实 Revit 的样板兼容性、受控属性、事务回滚及内嵌 WebView 待在获准测试模型中验收。下一批可推进给定视图、文字类型和位置的文字注释。
