# AEC 模型组成员查询验收

2026 年 11 月 7 日。新增 `revit_get_group_members`，AEC 台账原 50 项未接入能力还剩 47 项。候选源码目录有 65 项工具，其中 41 项只读。

以当前文档的模型组实例 ElementId 为输入，保留 Revit 返回的直接成员顺序。默认只返回精确十进制成员 ID。可以显式附加名称、类别和类型 ID，只读取本页所需字段。单页默认 100 项，最多 200 项。嵌套组作为直接成员返回。输出保留页偏移、总数和完整扫描证明，超过预算或身份无效时明确失败。[Autodesk Group API](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/ca54af3c-52d8-0aed-cd22-440ec2584b89.htm)

宿主声明具名能力后，执行器才可发布原子只读请求。宿主同一回调绑定并核验文档，执行端按请求检查精确 ID、分页、字段和原回执。Code Mode 通过 `elements` 分页发现，再按准确名称读取完整输入和输出契约。聊天 `@` 可用英文全名、`ggm` 和「模型组成员」查找。工作区从同一目录生成「模型组 ID」输入并走既有命令读取流程。

## 已执行检查

- 受控生产 C# 重复读取 700/700，14 份查询 DTO 通过 Node 契约核验。组成员夹具覆盖顺序、分页、按需字段、类型与类别身份及超预算拒绝。
- 受控宿主 103/103，新增路径验证仅准入原子读取、绑定当前文档并单次分派。
- 九份 Node 测试文件 101/101，包含独立 MCP 客户端和模拟宿主队列、旧宿主入队前拒绝、错包保持未确认，以及 `@` 和命令栏单次提交。
- 36 份 C# 使用实际 Revit 2024 API 引用编译通过。证据位于该工作树的 `artifacts/compiled-group-final`、`artifacts/host-group-final`、`artifacts/pilot-group-verified` 与 `artifacts/node-final.log`。

真实 Revit 模型组、内嵌 WebView 和实际点击回执待验。候选没有加载到已安装宿主。下一步在获准使用的测试副本中验证普通组、嵌套组和分两页回读，再通过同一回执核对命令栏。余项继续按台账分批推进。
