# AEC 楼层平面图与等轴测三维视图

2026 年 11 月 7 日。新增 `revit_create_floor_plan_view` 和 `revit_create_3d_view`。原 50 项未接入能力由 41 减至 39。候选工作区共 73 项，其中 43 项只读。

两项操作均要求项目文档、明确的视图名称和当前文档内的视图类型 ID。楼层平面图另需标高 ID。宿主核对视图族后调用 Revit 创建接口，读回名称、类型与视图种类。平面图核对关联标高，三维视图核对为等轴测。内层事务提交后再检查一次，异常返回给外层事务组处理。默认回滚，应用时使用现有权限和原回执链。创建不切换视图，也不保存模型。[Autodesk 楼层平面视图](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/View_Types/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Types_ViewPlan_html.html) · [Autodesk 三维视图](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/View_Types/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Types_View3D_html.html)

Code Mode 通过 `views` 分页发现，再按准确工具名取参数契约。聊天 `@` 支持英文全名、词段、`cfpv`、`c3v` 和中文标签。命令栏接收精确 ID，保留手动确认。能力缺失和参数不合法在入队前拒绝。回执与请求的文档、事务或视图事实不匹配时保留未知状态，沿用原回执核查。

- 生产 C# 提取夹具 5/5，核对两种视图的事实、错误视图族拒绝，以及内层提交后名称或透视状态漂移。
- 受控宿主 105/105。Node 合组 96/96，覆盖 Code Mode、旧宿主拒绝、精确 ID、默认回滚、异常回执、`@` 和命令栏确认。证据位于隔离工作树的 `artifacts/host-final`、`artifacts/view-fixture-evidence` 和 `artifacts/views-node-final.log`。
- 36 份 C# 使用真实 Revit 2024 API 引用编译通过。证据位于 `artifacts/compiled-final/build-record.json`。真实 Revit 事务与内嵌 WebView 仍待使用获准的测试副本验收。
