# AEC 直风管创建验收

2026 年 11 月 7 日。新增 `revit_create_duct`，AEC 台账的未接入项由 38 减至 37。候选工作区共 75 项，其中 43 项只读。

每次创建一段直风管。调用者提供当前项目的风管类型 ID、机械系统类型 ID、标高 ID 和 Revit 内部坐标系中的两个端点（毫米）。执行器校验精确 ID、真实元素类型和 Revit 最短曲线长度。截面尺寸由 Revit 默认规则决定，本命令不连接其他构件。再生后与内层事务提交后均按新元素 ID 回读风管类型、机械系统类型、参照标高和实际中心线端点。回读不符时交由外层事务组处理。[Autodesk Duct.Create](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/86174dcb-e86e-c987-93ff-75e3d2773cf0.htm)

沿用宿主 0.8.9 的具名能力、文档绑定、写权限和默认回滚。提交不保存模型。Node 核对原回执中的精确 ID 和端点；无法确认时保留未知状态和原请求，不自动重发。Code Mode 在 `mep` 域发现该工具，按工具名读取完整契约。聊天 `@` 可用英文名称、`create_duct`、首字母 `cd` 和「创建直风管」检索。命令栏在单次确认后发送，保留精确 ID 与坐标。

- Node 串行回归 104/104。覆盖具名能力、执行端校验、默认回滚、回执不符、Code Mode、全目录检索和命令栏确认。首轮 103/104：新界面用例漏写预期的 `mode: rollback`；补齐断言后全组通过，生产行为未变。
- 生产 C# 受控夹具 14/14，其中四项风管用例覆盖反向端点、错误机械系统元素、内层提交后系统类型或端点变化。通用受控宿主 105/105。
- 36 份 C# 使用 Revit 2024 API 引用编译通过，编译输入摘要逐一回核。独立证据：`artifacts/duct-node-final.log`、`artifacts/duct-peer-fixture-20261107/result.txt`、`artifacts/host-final`、`artifacts/compiled-final/build-record.json`。

实际 Revit 的默认截面、事务回滚及内嵌 WebView 仍需在获准测试模型中验收。下一批可推进明确限定输入和回读的图纸操作。
