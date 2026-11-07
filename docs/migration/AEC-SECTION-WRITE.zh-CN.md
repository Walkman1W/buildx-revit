# AEC 竖直剖面视图验收

2026 年 11 月 7 日。新增 `revit_create_section_view`，AEC 原 50 项未接入能力还剩 31 项。工作区候选共 81 项，其中 43 项只读。

每次在当前项目中创建一张具名竖直剖面。BuildX 契约要求显式剖面视图类型 ID、切面底边中心 `origin_mm`、朝模型内部的水平角度和矩形宽、高、深。原点采用 Revit 内部坐标和毫米。角度从内部 +X 朝 +Y 计算，范围为 [0°, 360°)。宽、高、深各为 100 至 1,000,000 毫米。宽度以原点居中，高度沿 +Z 增加，深度从切面沿指定方向计算。[Autodesk Revit 2024 剖面 API](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/View_Types/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Types_ViewSection_html.html)

宿主校验剖面类型和八个角点，创建后在再生和内层事务提交两个阶段读取实际视图。回读要求矩形裁剪启用，远裁剪有效，并核对名称、类型、裁剪框换算的底边中心、方向和三项尺寸。长度容差为 0.001 毫米，方向向量容差为 1e-8。每次返回一条有界结果。[Autodesk Revit 2024 远裁剪参数](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Views_View_Templates_html.html)

Code Mode 在 `views` 域分页发现，再按名称获取完整契约。聊天 `@` 支持英文全名、`create_section_view`、首字母 `csv` 和「创建剖面视图」。命令栏支持分轴坐标和逐次确认。执行沿用文档绑定、具名宿主能力和写权限，默认预览回滚，应用保留模型内存修改。回执不符时按原请求核对，保持未知状态。

- Node 串行回归 125/125，无跳过。覆盖能力缺失、角度和尺寸边界、精确 ID、原回执不符且只入队一次、Code Mode 分页以及完整目录搜索和命令栏点击。
- C# 受控夹具 55/55，其中剖面 10 项。覆盖非零角度、三维原点、不同坐标系的裁剪框、类型和尺寸，以及提交后原点、裁剪、深度、裁剪形状或状态漂移。受控宿主 105/105。
- 36 份 C# 使用本机 Revit 2024 API 引用编译通过，复核编译输入和 DLL 摘要。证据位于 `artifacts/section-node.log`、`artifacts/section-peer-final/result.txt`、`artifacts/host-verified` 和 `artifacts/compiled-verified/build-record.json`。

真实 Revit 2024 中裁剪框换算、默认样板的影响、事务和内嵌 WebView 待用获准测试模型验收。下一批可推进按类别创建空明细表。
