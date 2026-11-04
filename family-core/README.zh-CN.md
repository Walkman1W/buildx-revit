# BuildX 独立族文档核心与 Revit 适配

最新安装：0.6.1诊断候选已备份更新独立下次启动入口，Revit尚未加载；用户选择稍后启动，当前几何失败尚未修复。安装及服务恢复证据见[实机记录](../workbench/validation/20261024-family-runtime/README.zh-CN.md)。

本目录包含自研 C# 5 / .NET Framework 核心和 Revit 适配器。2026-10-24 已将独立族流程、参数化双接口示范阀体接到 WorkbenchHost 0.6.0/ExternalEvent 和六项 MCP 工具，完整宿主编译并更新下次启动入口。核心不引用 Revit API；宿主统一编译生产适配器，不混装早期测试 DLL。BuildX 已实际加载37项工具，Revit 建族、保存/重开、加载/回滚仍待实机验证。假资源测试不能证明真实文档或几何已成功。

最新入口及操作见[本轮证据](../workbench/validation/20261024-family-workflow/README.zh-CN.md)。`revit/ParametricValveBuilder.cs` 只做族事务内几何/参数/连接器；`revit/RevitFamilyWorkflow.cs` 管理可信项目身份、临时族、保存及加载；`FamilyTerminalOutcome.cs` 只解释已观察的原生终态，清理成功不能充当回滚证据。通用 ScriptRunner 的跨文档/保存/关闭限制没有放宽。

## 已实现的边界

`FamilyJobRegistry` 固定持有可信 factory；`Prepare` 发行不可猜测的作业访问句柄，`Create` 只调用一次创建，`Get` 返回已记录的 DTO，`RequestClose` 请求关闭，`CleanupAll` 汇总逐项清理。句柄绑定宿主会话、宿主 PID、项目打开实例句柄、项目持久指纹及模板 SHA256。句柄不是 Revit Document 对象或 Document 句柄；该注册表单体只验证这些元数据的格式及精确相等；模板与项目观察由已接入的规划/适配组合负责，真实Revit运行尚待验收。

factory 通过该次调用专有的 `FamilyCreationContext` 发布新临时资源或声明既有用户资源。只有内部发行的 temporary receipt 可证明这一调用记录了新临时资源；从其他作业带回的 receipt 拒绝。同一资源引用不能被不同作业重复接管。trusted factory 必须在可能失败的后续工作之前发布新资源；这不是对任意插件代码的安全沙盒，也不能识别不同 wrapper 背后是否是同一个实际 Document。

引用登记与已知冲突由注册表单一入口处理：另一作业把当前已持有的同一引用声明为用户资源时，原 holder 立即撤销就绪并禁止自动关闭；新作业只保留 `ResourceOwnerJobId` 关联，不重复持有该引用。关联冲突即使没有本地引用也不能被清理伪装成 Closed。这里没有永久的所有用户文档身份集合；未登记的实际文档身份与后续真实对象去重仍是可信 Revit adapter 的职责。

`Owned` 表示当前仍保留资源且这个作业曾发行 temporary proof；`ResourceRetained` 表示当前保留资源引用，`OwnershipConflict` 表示同一引用出现用户资源与临时资源的矛盾事实。先声明用户资源再申请 temporary proof 时不发行 proof；反向顺序保留已发 proof。两者均保留矛盾及引用，不自动关闭或回收容量。正常成功关闭后释放当前引用，Owned 变为 false；历史创建、检查结果保留在 `CreationCode` / `InspectionCode`，当前 `LastCode` 描述最后一个阶段。关闭开始就撤销当前 readiness；失败或未知不能继续展示 Ready。

无资源引用且创建结果未知时，不能据此宣称无副作用、关闭成功或重新执行创建。已知清理失败保留准确引用，只有明确 `ConfirmedClosed` 才释放；未知关闭、返回未关闭或异常可以后续再次清理。用户文档不会自动关闭。默认最多保留 8 个作业，可配置 1–64；容量耗尽只淘汰已明确 Closed 且没有资源的旧记录，不淘汰未知或冲突作业。

factory、Inspect、Close 在内部锁外执行。创建中关闭请求记录意图，在创建结果已知后处理；最终处理阶段与关闭阶段保持明确归属。同步调用不提供强制终止卡住的 factory 或 Revit UI 线程的能力。`Get` 只读现有注册表事实，不重新调用 Revit，不授权写入。

## 离线编译和检查

使用本机已有 .NET Framework 编译器，不安装依赖：

```powershell
Set-Location D:\code\REA\local-codex-panel
.\family-core\tests\run-offline.ps1
```

脚本先核对固定输入及已有编译器，以 C# 5 编译纯库和测试程序，在独立新证据目录运行。精确参数、输入/产物哈希、退出码、TAP 和耗时见每次生成的 `summary.json`。输出 DLL 仅供这个离线程序引用，不复制到 addin 入口或替换已安装 DLL。编译和测试会执行本目录代码，不能称为纯只读操作。

本次汇总及保留的早期/最终检查见 [生命周期证据](../workbench/validation/20261023-family-lifecycle/README.zh-CN.md)。

## 后续增量与尚待

早期离线模板/规划证据（2026-10-23至24，历史）：新增FamilyTemplateFacts、固定ID只读FamilyTemplateCatalog及FamilyJobPlanner。真实owner进行fresh项目检查、模板观察、再次fresh检查，再预留未执行作业；没有Create。最终Planner26/Catalog25检查分别通过，两个真实安装RFT字节与绑定SHA一致，项目来源仍为模拟。统一Core+Revit适配器编译快照避免混用早期测试程序集，详见[规划增量证据](../workbench/validation/20261023-family-planning/README.zh-CN.md)。字节SHA不是Revit格式/类别证明，Prepared不是写授权，后续执行仍须fresh校验；该次离线证据当时未接入Host或面板；后续0.6.0集成见本文开头，仍未实机验收。

10月23日项目身份离线增量已提供`ProjectDocumentRegistry.cs`、`ProjectDocumentFactsReader.cs`及`revit/RevitProjectDocuments.cs`。最终28项假来源检查和真实Revit2024.3 API编译通过，详见[身份增量证据](../workbench/validation/20261023-project-identity/README.zh-CN.md)。它用固定source的原生Equals比较当前打开文档，不凭同指纹、哈希或托管引用相同推断同一文档；ReleaseInvalid仅释放已确认失效的元数据。身份handle不是秘密写入令牌，身份Ready不是写授权；Get仍为捕获快照。该次证据未构造或执行实际API；后续组合已接入族作业与Host0.6.0，但不代表真实Document去重已实机通过。

Revit factory、规划/身份 owner、执行前模板复核及族内事务现已联通；参数/几何/连接器、保存 RFA 和精确项目加载已有生产实现及 API 编译证据。它们尚未实际运行验收，失联资源恢复、跨进程持久恢复和真实管道接管仍有缺口；不承诺跨文档与文件的全局回滚。保存是独立文件副作用，项目回滚不会删除 RFA。

宿主代码已实现登记项目打开实例与自有临时族，保留失败清理资源和未知结果；这些边界仍须真实 Revit 验收。FAM-01/02/03 均进行中，先核对指定样例的宿主/文档与只读链路，再做创建、保存和加载验证。形体是教学圆柱阀体，尚无内孔/手轮、管道连接或厂家认证。
