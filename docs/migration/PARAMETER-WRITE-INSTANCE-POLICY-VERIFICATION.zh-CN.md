# 具名参数写入的实例目标策略验证

日期：2026 年 11 月 5 日。已将旧 `revit_set_parameters` 收紧为实例参数入口，关闭其显式 ElementType 目标旁路。宿主/程序集为 **0.8.7**。本轮仅完成源码、受控执行、API 引用编译和内部归档，未重启服务、替换插件或执行真实模型操作。

## 实际变化

两个具名参数 setter 共用实例目标解释：先核查整批字段、ID、重复对及目标归属，保存已解析 ID 和请求数据副本；不跨阶段缓存 Revit Element/Parameter 对象。每个目标都须是所选当前文档中的有效实例，参数 ID 唯一，Parameter.Element 也是该实例且属于同一文档。预检完成后，每项写入前再次按 ID 获取并核对；设置后立即、Regenerate 后和内层 Commit 后同样重新获取，验证归属与实际值。

静态类型、异归属、只读或不存在的参数即使位于批次末尾，也在任何 Set 前拒绝。若前一项 Set 后才出现后一项目标变化，前项可能已经 Set；后项在其 Set 前被拒绝，原事务进入失败处理。不能将这种动态失败描述为整批从未开始，也不因受控 peers 恢复成功而推断实机已经回滚。

可写性仅在整批预检及每项 Set 前要求；纯回读仍允许参数在合法设置后变为只读，只要实际归属和值保持。Double/Int32/String、单位、YesNo、原始值/显示值以及旧 safe numeric ID 解释均沿用现有 owner。旧批量仍为 1–50 项、默认 rollback、原七字段行和 numeric ID；具名单项仍保留 exact ID、原态守卫及额外 data_type 核对。commit 仅保留内存修改，不保存模型。

宿主在 host.json 和 Status.capabilities 都声明 `parameterWriteTargetPolicyVersion:1` 与 `parameterWriteTargetPolicy:instance_only`。Node 对旧批量操作在建立请求 ID、临时请求及回执 owner 前检查 **0.8.7 + 两项声明**；raw/MCP 与保留回执路径共用这条门禁。缺少声明的旧宿主不能被当作实现新策略。原 `revit_set_parameter_value` 的 0.8.5/v1 独立门禁保持，没有要求它额外声明新策略。所有读取操作及其最低版本保持。

旧、新参数控件都排除原生选择结果明确标记的类型，不按显示名称猜测；旧 50 项、安全整数、原描述接口和 Length 转换保持。没有改变现有实例操作的审批或自动应用设置。

本策略只约束这两个具名入口的显式参数目标。任意 C#、保存脚本及其他操作仍按各自权限处理，不能将其称为通用安全沙盒；具名类型写入及类型整体的可信强制确认尚未开放。

## 已执行检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run test:parameter-targets` | **87/87，0 跳过** | 7 契约、64 实际 C# 生产者、9 队列/MCP、7 UI |
| 原批量参数组 | **117/117** | 旧 DTO、值验证与原回执路径 |
| 具名单参数写组 | **125/125** | 原组新增“拒绝旧类型目标/保持实例 metadata”分开断言 |
| 原查询/目录 | **182/182** | 最终串行执行，源码及断言未变；首轮并行失败见下文 |
| 类型读取 / 单参数读取与 UI | **24/24、79/79** | 旧读取与控件兼容 |
| 类型影响核查 | **65/65** | 原生只读影响 DTO 与边界 |
| 布局 / legacy 会话目录 | **105/105、23/23** | 源码闭包、路径、安装身份和实际 MCP |
| 宿主检查 | **80/80** | 原调度/请求/权限代码，业务/API 使用受控 peers |
| 真实 API 引用编译 | **33 C# 输入，exit 0** | Revit 2024 与官方 WebView2 SDK；未加载 DLL |

以上最终测试均无跳过。独立 C# 合组 247 项（旧批量 91、单项 92、新策略 64）也在 Agent 终端执行通过；其同版生产测试随后在 root 的上述三组日志复验。覆盖 50 项批次首/中/尾静态类型或五类错误 owner 的零 Set、前项 Set 后后项 owner 漂移、API 对象替换、live before/no-op、三阶段只读状态变化、提交/回滚异常与 unknown。原失败回执不新增回滚证明，也不自动重发。

预期变化明确记录：重复对现在零 Set；后项只读/不存在时，前项也不再先 Set；后项运行时 throws/trueNoChange 仍可能已有前项 Set。旧测试曾接受 ElementType 的行为已按新契约分为类型拒绝和实例 numeric DTO/metadata 兼容，历史验证记录不改写。

保留的失败记录：两个新增测试的初稿分别误读 schema wrapper 和误禁合法的 transport_finished 诊断，已修正测试而未放宽产品校验。查询并行首轮有一个旧子例及其父例失败：发布异常后固定等待 35ms，受控 peer 尚未记录请求。源码和断言均未改，最终用 `--test-concurrency=1` 得到 182/182；固定 35ms 的旧测试在并行调度下仍有脆弱性，未宣称已经修复。实际日志和后续串行结果都保留。

机器记录：[parameter-write-instance-policy-verification.json](parameter-write-instance-policy-verification.json)。本地证据：`artifacts/parameter-write-instance-policy-validation-20261105-01`。

## 内部候选与剩余工作

源码快照 `artifacts/buildx-source-20261105-11`：**278 文件、204 JS 模块、633 引用**。内部候选 `artifacts/buildx-revit2024-instance-parameter-policy-20261105-01`：**145 产品文件、19,440,954 字节、99 JS 模块、315 引用**。当前源码、构建记录和清单摘要一致；裸 NPM 导入、缺失相对导入、构建机绝对路径和 DLL 调试目录为零。私有官方编译器仍为 17 文件，不捆绑 Codex。

两个独立 ZIP 为 `BuildX-Revit2024-0.8.7-internal-instance-parameter-policy-20261105.zip`（7,408,436 字节、146 项）及 `BuildX-Source-0.8.7-internal-instance-parameter-policy-20261105.zip`（1,156,805 字节、280 项，不含 build），位于 artifacts。逐项摘要、解压源码闭包、编译器、只读 MCP 23 项及策略纯内存检查通过，没有调用业务工具或创建队列。旧包保留，临时目录核验身份后清理；摘要见机器记录。

仍为 **releaseReady:false，不可安装**。四项产品缺口仍为 Argus 分发/运行、外部 Node bootstrap、私有 Node/Python 分发和 WebView2 Runtime；插件/第三方许可、pypdf、数据升级恢复、许可后端及真实 Revit/WebView/Codex/客户机验收未完成。

下一切片为具名类型写入的手动/AI 可信强制确认、写前原态和影响集复核，继续明确脚本的较宽权限边界。原生系统图、规则标注及依赖移除仍待后续；自检继续，不将本切片当作整套计划完成。
