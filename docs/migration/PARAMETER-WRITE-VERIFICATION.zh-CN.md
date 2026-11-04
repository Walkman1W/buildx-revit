# 参数写入回读与回滚验证

日期：2026 年 11 月 5 日。已用实际生产 setter、内层事务和 Host 外层事务组代码，在受控 API peers 复现并修复 Double、Integer、String 三类错误成功：`Set` 返回 true，但参数仍为旧值时，原实现仍返回 `committed:true`。相同三份输入在修复后均拒绝成功。宿主和程序集升至 **0.8.3**。

本文与 `parameter-write-verification.json` 保留 0.8.3 切片的历史证据。后续单参数查询、精确 ID 控件及 Double 解析修正见 [0.8.4 单参数验证](SINGLE-PARAMETER-VERIFICATION.zh-CN.md)；原写入验证和产物保留。

本轮只改新工程；没有加载新插件、替换用户 DLL/Addins、重启既有服务、执行真实 Revit/模型操作或公开发布。新内部候选 **`releaseReady:false`，仍不能安装**。原 0.8.2 查询候选及修复前失败证据保留。

## 实际变化

`WorkbenchActions.SetParameters` 沿用原 ID、存储类型、可写性和单位规则。三种存储类型不再把 Set 的 Boolean 当作目标值已满足的证明；设置后必须有值、存储类型一致且实际回读等于请求。相同值跳过 Set；Set 返回 false 但实际值已满足时允许成功。`changed` 按观测前后差异计算，`updated_count` 仍是结果行数，包含未变化行。

该操作在内层事务中完成全部设置后调用一次 Regenerate，再按元素/参数 ID 重新获取并复验；内层 Commit 确认为 Committed 后再做一次只读重新获取/复验。两阶段都不信任旧 Parameter 引用。缺元素、失效元素、缺参数、替换后的新参数值错误、存储类型变化、HasValue 消失、回读异常或值漂移均抛错，既有外层事务组尚未 Assimilate，可以进入原失败处理。显式 Regenerate 仅在开放事务内调用；成功 Commit 本身会再生成，因此提交后只读复验。[Autodesk 2024 事务与再生成说明](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Transactions/Revit_API_Revit_API_Developers_Guide_Basic_Interaction_with_Revit_Elements_Transactions_Getting_Element_Geometry_and_AnalyticalModel_html.html)。

内层提交返回非 Committed 时只报告实际状态，去掉原“已回滚”的无依据文案。通用 Host 失败分支及权限、文档绑定、外层提交前权限复验均未改。外层 RollBack 调用成功与否没有新的协议证明，Node 继续保留 `unconfirmed`，不因为错误文本、调用过回滚或受控 peers 已恢复就标为实机已回滚。

新 `lib/parameter-write-result.mjs` 核对成功回执与原请求：1–50 个精确且唯一的元素/参数 ID 对、结果行数、Double/Int32/String 类型、before/after、实际 changed 标志、请求值相等及 Double 的 internal 声明；不进行显示单位转换。保留回执和直接 invokeWorkbench 两条入口都拒绝错误成功。原 receipt owner 可继续核对同一个请求，不自动重发或补写。原工具字段、显式 ID 写入、ElementId 不支持写入、默认 rollback 和不保存工程等边界保持。

`after_internal` 是内层验证后的值，发生于外层事务组 rollback/commit 决定之前；rollback 模式不能据此声称模型最终保留目标值。宿主 0.8.3 的设置后/再生成后/提交后验证也不表示当前用户已装 DLL 获得更新。

## 复现与检查

修复前记录：`artifacts/native-parameter-write-validation-20261105-01/baseline-failures.json`，三项期望拒绝的回归断言实际失败；原 C# 提取源码另存 `baseline-production-peers.cs`。修复后同输入及代表场景见 `fixed-peer-evidence.json`，原三组输入逐项相同，均由错误成功变为失败并进入受控回滚。不是将断言改成接受旧行为。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run test:parameter-writes` | **117/117，0 跳过** | 91 实际生产 C# peers、9 结果契约/旧回执、7 跨 C#→临时队列→原 owner、10 既有写入生命周期 |
| 独立 C# peers | **91/91**，110 次受控夹具执行 | 原 Set/Write/Hostgroup 方法；错误 Set、falseApplied、no-op、批次失败、两阶段漂移/删除/替换/类型变化、提交与回滚异常/Pending |
| 典型提交后漂移 | 验证通过 | 内层已 Commit 1 次、内层 RollBack 0、外组 Commit 0、外组 RollBack 1；验证发生在外组 Assimilate 前 |
| 原六查询/目录 | **182/182，0 跳过** | 原生查询、参数事实和 legacy 目录兼容 |
| 类型查询 | **24/24，0 跳过** | 0.8.2 参数能力 v1 保留 |
| 布局/安装/源闭包 | **105/105，0 跳过** | 独立配置、数据归属、安装阻塞和源码完整性 |
| 受控宿主 | **80/80** | 原调度、权限、身份和请求验证；原查询能力未变，通用失败不产已核实回滚证明 |
| 完整源码/API 编译 | 249 文件、33 项 C# 输入，exit 0 | 从新快照独立引用真实 Revit 2024 API/UI 编译，未加载插件 |
| `npm run check` / diff 检查 | 通过 | 入口语法、补丁格式 |

新增跨层测试的首轮 fixture 漏建 processing 目录，被原 receipt owner 在发布前拒绝，6 子项未执行；补齐独立测试队列布局后 7/7 通过，再纳入完整 117 项合组。没有放宽生产 owner 的目录核查。结果契约首次还发现独立验证函数漏拒绝 change 行额外字段，已补齐并复验 9/9。

权限检查和 API/事务状态由 peers 模拟，Node 队列封套和 timing 是受控值；实际生产 setter、参数解析/值 owner、Write 和 Host 事务组片段按原文提取并校验摘要。C# 受控恢复与客户端实机回滚证明分开记录；未知/Pending/回滚异常均未升级为确定终态。

## 可审阅产物

| 产物 | 内容 |
| --- | --- |
| `artifacts/buildx-source-20261105-06` | source 为 249 文件；177 JS 模块、518 条依赖/资源引用无缺项；build 为同快照隔离构建 |
| `artifacts/buildx-revit2024-parameter-write-20261105-01` | `0.8.3-internal-parameter-write`，144 产品文件共 19,387,669 字节；98 JS/MJS、308 条导入，无 bare npm、缺项、摘要错误或本机开发根字节；产品 DLL 调试目录为 0 |
| `artifacts/BuildX-Revit2024-0.8.3-internal-parameter-write-20261105.zip` | 7,393,411 字节，145 条目 |
| `artifacts/BuildX-Source-0.8.3-internal-parameter-write-20261105.zip` | 1,047,295 字节，251 条目，不含 build |
| `docs/migration/parameter-write-verification.json` | 测试、前后对照、源码/构建/ZIP 摘要和未验范围 |

运行 ZIP SHA-256：`c45b42eff753f9d204883aa5f2a3ca26514720b427a5d528bd045634fc51266f`。

源码 ZIP SHA-256：`e40f3d97a3169d571139ee228ec420b200f37e046ce81e2cb48d7cde09394307`。

DLL SHA-256：`4ba6a4f7c63d47cfa5ac383a7ceda12b03050e30b90086103c9a3ac12d766d02`。

全部 ZIP 条目与清单逐项回读/解压匹配；官方 compiler 固定 17 文件、源码 249 文件及闭包通过。无 node_modules 的解压运行包完成 21 项生产 workspace MCP 目录握手；回执模块可独立导入，对匹配成功通过、错误 after 拒绝。只发送 initialize/initialized/tools/list，没有模型调用、队列或其他运行态创建，临时目录核实归属后清理。

## 未验与下一步

真实 Revit 的 setter/updater/失败处理、模型回滚、WebView/Codex 联动、干净客户机、实际安装升级恢复卸载，以及新增 Regenerate 的实机成本尚未验证。Argus 业务/分发、外置 Node 引导、Node/Python 私有运行时、WebView2 Runtime 等四项包缺项及安装器的插件许可、pypdf、数据恢复/许可后端条件保持阻塞。

本轮修复的是已有参数写路径，不表示 BX-006 全部完成。下一项按 P1 台账补具名单参数读取的稳定 ID 选择与歧义处理，再推进剩余参数/常用建模命令；继续保留权限、文档身份、取消、未知结果和原回执核对，不执行真实模型写入。
