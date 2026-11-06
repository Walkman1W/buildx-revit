# AEC 电气导管创建验收

2026 年 11 月 7 日。新增 `revit_create_conduit`，AEC 台账的未接入项由 39 减至 38。候选工作区共 74 项，其中 43 项只读。

每次创建一段直导管。输入为当前项目的导管类型 ID、标高 ID、Revit 内部坐标系中的两端点及公称直径。长度与坐标均以毫米表示。执行器核对精确 ID、真实元素类型和 Revit 最短长度，拒绝自动选型或替换规格。创建后与内层事务提交后分别回读导管类型、参照标高、中心线端点和公称直径。读取不一致则失败，由现有外层事务组处理。[Autodesk Conduit.Create](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/d54ff31b-353b-eb13-337c-cee8abb021f7.htm)

沿用宿主 0.8.9 的具名能力、文档绑定、执行权限、默认回滚和原回执。应用保留在内存中的修改，模型仍需用户自行保存。Code Mode 在 `mep` 域发现并按准确工具名读取完整输入契约。完整工作区目录可通过英文名称、词段和首字母查到「创建电气导管」。命令栏保留精确 ID 输入和确认。

- Node 串行回归 100/100，覆盖旧宿主和非法参数在入队前拒绝、默认回滚、回执不符与不重放、`@` 搜索、命令确认。
- 生产 C# 方法受控夹具 10/10，其中五项导管用例覆盖反向中心线按调用顺序返回、提交后直径变化、参数设置失败、错误类型和过短几何。通用受控宿主 105/105。
- 36 份 C# 使用真实 Revit 2024 API 引用编译通过。首次并行验证触及 Windows 页文件提交限制，串行编译与回归通过。证据为工作树的 `artifacts/conduit-node-serial.log`、`artifacts/conduit-peers-final/result.txt`、`artifacts/host-final` 和 `artifacts/compiled-serial/build-record.json`。

真实 Revit 的规格表行为、事务和内嵌 WebView 待在获准测试模型中验收。下一批按台账继续推进风管或常用图纸操作。
