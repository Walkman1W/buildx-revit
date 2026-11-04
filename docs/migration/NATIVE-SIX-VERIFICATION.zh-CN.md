# 六项原生查询实施与验证

日期：2026 年 11 月 5 日。范围为六查询源码、受控生产者、Node/MCP 边界及 Revit 2024 API 引用编译。原工程和已装插件未修改，未启动或重启既有服务，未操作真实模型。本记录不能作为真实 Revit 加载、模型效果或客户机验收证明。

## 实际实现

`lib/native-model-queries.mjs` 是六项工具的输入、业务结果、完整公开输出 schema、操作映射和能力门槛 owner。保留公开名称：

| 工具 | 原生操作 | 结果重点 |
| --- | --- | --- |
| `revit_health` | `health` | 本次宿主响应与是否打开文档；无文档可读，超时仍未知 |
| `revit_get_document_info` | `get_document_info` | 项目/族、只读/修改状态及活动视图；与原子文档事实一致 |
| `revit_list_views` | `list_views` | 视图类型、模板事实、稳定 ID 排序与分页覆盖 |
| `revit_get_element_parameters` | `get_element_parameters` | 复用参数 owner，身份、存储类型、原始值、显示值、单位、可写性 |
| `revit_get_elements_by_type` | `get_elements_by_type` | 实例按真实类型、OST/显式类别别名、准确楼层过滤，按所选 fields 返回 |
| `revit_get_element_geometry` | `get_element_geometry` | 毫米位置和包围盒、楼层、mm/m2/m3量测及未知原因；不返回 mesh |

`NativeModelQueries.cs` 在现有 ExternalEvent 回调内生产 DTO。宿主源码版本为 **0.8.1**，`host.json` 与状态都声明 `nativeModelQueriesVersion:1` 和六个 `nativeModelQueryOperations`。Node 在任何查询入队前核对版本、原子能力、契约版本与具名操作；版本号或旧 `atomicReadSnapshot` 标记本身不能放行。原子回执再次核对能力、会话、操作和文档。

统一 `workbench-client`、模型派发器、手工目录和 MCP 入口；显式 `sourceDocument` 不能被当前文档替代。公开 `outputSchema` 描述完整结构化回执，MCP 同时返回文本及完整 `structuredContent`。目录和提示词已退出外部双桥工作流；六查询不会回落 Python provider。

长 ID 使用精确十进制字符串；不安全的 JSON 数字在入队前拒绝。类别身份与显示名称分开，楼层重名要求 ID 去歧义，`fields:[]` 只返回 ID。列表默认 200、最多 500 项；实际扫描后稳定分页，超过 100,000 个扫描对象或时间/响应预算明确失败，不用第一页声称全量覆盖。几何包围盒对全部八个角做变换再取轴向范围，缺项返回 null 和原因。

取消前未发布请求归为未开始；发布后或回执到达时取消保留原请求和未知结果。超时、身份变化、异常回执均不自动重放；迟到回执通过原 owner 核对。明确未执行过期与已开始失败保持独立结果。

## 验证入口和证据

- `npm ci --ignore-scripts --no-audit --no-fund`：按现有 lock 安装 19 包，不升级、不执行安装脚本。第三方原始许可证见根目录 `THIRD-PARTY-NOTICES.md`。
- `npm run check`：三个既有入口语法检查。
- `npm run test:native-queries`：最终合并运行 **181/181 通过，0 失败、0 跳过**。具名 schema、实际 C# 查询及参数方法、临时文件队列、来源身份、权限、原子读取、目录、MCP 公开边界、取消、失败与原回执核对。
- `native-six-mcp-client.test.mjs`：使用锁定的 MCP 客户端 2.3.1，复制未改写的生产 stdio 入口及纯源码到独立临时目录；逐一校验六项真实调用、公开 outputSchema、完整 structuredContent、文本一致、畸形结果不重放和旧宿主拒绝，**10/10**（包含于上述 181 项）。队列/Revit DTO 仍为受控 peer。
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\check-workspace-host.ps1 -EvidenceDirectory D:\code\BuildX\artifacts\native-six-managed-20261105-02`：**80/80**。提取实际调度、验证、原子读取与文档身份方法，使用受控 Revit/业务 peers。
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\revit-addin\build.ps1 -OutputDirectory D:\code\BuildX\artifacts\native-six-api-20261105-02 -IsolatedBuild`：**真实 Revit 2024 API 引用编译通过**。只在不存在的新目录重跑；不要覆盖该证据目录。

最终编译 DLL SHA-256：`6671b96b445b1e434b21d332029efbacd987abd9df90fb146ef8b385a47a9f09`。构建记录和宿主 source proof 保留实际引用、源码摘要与检查范围；机器可读汇总见同目录的 `native-six-verification.json`。

功能测试执行实际 `NativeModelQueries.cs` 和提取的参数生产方法，覆盖 650 个实例上 offset=500 的真实分页、字段选择、楼层重名、Int64 参数引用、单位换算、旋转包围盒和超预算。六项实际 C# DTO 均经过真实临时队列进入 Node 校验并通过其公开输出 schema；peers 不等于 Autodesk 运行时行为。

原六查询专属 adapter、relay、快照刷新器及其专属测试已退出本工程；取消、宿主更换、未知回执、明确失败/过期等有效语义迁入原生回归。原件仍保留在只读旧工程，历史 507 文件复制证据未改写。仅修正候选入口中的六查询依赖引用；未制作安装包或展开其他瘦身。

## 未验收及下一步边界

尚未在真实 Revit 进程加载新 DLL，也未在真实项目/族文档调用六项查询；WebView/Codex、客户机、安装升级和性能对比均未验收。当前已安装宿主及在线 AEC 的状态不能作为新查询的执行证明。

API 编译仍只读引用现有目录中的 WebView2 组件。`LocalCodexRevit.DevelopmentRoot`、研究组件适配、ScriptRunner 编译器路径、资料解析 Python 与数据布局仍有独立任务；六查询原生化不证明产品全部去外部依赖。

按用户最新顺序，先完成本批查询验证和记录，再推进后续瘦身与安装候选。真实加载或已装插件替换需要覆盖该具体操作的授权；本轮只交付可审阅源码与隔离产物。
