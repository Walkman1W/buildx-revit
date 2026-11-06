# AEC 图纸视口放置验收

2026 年 11 月 7 日。新增 `revit_place_viewport_on_sheet`，AEC 未接入项由 36 减至 35。候选工作区共 77 项，其中 43 项只读。

每次在当前项目的普通图纸上放置一个视口。使用精确的图纸和视图 ID，`x_mm` 与 `y_mm` 表示图纸纸面坐标中的视口框中心，单位为毫米。执行器验证图纸和视图并使用 Revit 的放置资格检查。内层事务再生与提交后按新视口 ID 核对图纸、视图和实际中心，平面距离容差为 0.001 mm。结果只返回视口 ID、图纸 ID、视图 ID 及中心坐标。中心按视口框计算，不含视口标题。[Autodesk 视口创建](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/0f951f28-eb6b-2a37-668a-b248bfb7de97.htm) · [视口中心回读](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/10a5ede6-0c97-79e0-a31a-2ffd90c7fc97.htm)

沿用具名宿主能力、文档绑定与写权限。命令栏逐次确认，默认预览回滚，应用只保留内存修改。原回执不符时保留未知状态与原请求，不自动重发。Code Mode 在 `views` 域分页发现，按工具名获取完整契约。聊天 `@` 支持英文全名、词段、首字母 `pvos` 和「放置视口」。

- Node 串行回归 112/112，覆盖入队校验、精确 ID、原回执核对、二维容差、Code Mode、全目录检索及命令栏确认。生产注册尚未接入时试跑 42/46，四项新增用例因缺注册失败，合入后全组通过。
- 生产 C# 受控夹具 30/30，其中八项视口用例覆盖有符号纸面坐标、无效输入、占位图纸、不可放置的视图和内层提交后的身份及中心漂移。首轮夹具编译缺 `ViewSchedule` 替身，补齐后通过。通用受控宿主 105/105。
- 36 份 C# 使用 Revit 2024 API 引用编译通过，逐一复核编译输入摘要。独立证据为 `artifacts/viewport-node-final.log`、`artifacts/viewport-peer-20261107-2/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-final/build-record.json`。

真实 Revit 的放置资格、纸面定位、事务回滚及内嵌 WebView 待在获准测试模型验收。下一批可推进按精确 ID 应用视图样板。
