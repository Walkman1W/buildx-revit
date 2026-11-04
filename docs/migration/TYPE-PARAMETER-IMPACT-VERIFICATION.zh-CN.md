# 类型参数影响核查验证

日期：2026 年 11 月 5 日。已完成原生只读 `revit_get_type_parameter_impact` 的源码、隔离执行、界面展示、Revit 2024 API 引用编译及内部归档。宿主 **0.8.6**，参数查询族仍为 v1；本轮没有启用具名类型写入，没有运行真实 Revit、重启服务或替换已安装插件。

## 实际能力与范围

输入仅有明确的 `type_id`、`parameter_id` 和可选 `expected_document`。ID 沿用唯一精确 Int64 owner；参数 ID 不能为 0/-1。要求目标实际为当前文档中的 ElementType，参数属于该类型和同一 Document；不从实例隐式跳转类型，不按名称寻找，也不接受 value、ack 或 mode。

在同一次原子回调中，复用既有参数选择器和 `DescribeParameter` 返回完整原始事实。完整遍历当前文档的非类型元素，仅按 `GetTypeId()` 精确匹配，返回按 Int64 数值排序、唯一的十进制字符串 `instance_ids`、计数及覆盖范围。没有按活动视图、类别或楼层过滤；链接文档内容和间接联动未评估。`GetDependentElements` 的逻辑子元素与这项直接引用范围不同，本轮不调用它。

参数扫描上限 2,000，参数与候选元素合计扫描上限 20,000，直接实例最多 500；共享 owner 保留 5 秒检查和 180,000 字符估算预算，旧查询默认扫描上限 100,000 不变。超限、空或异常类型引用、重复/失效/异文档候选或参数归属不明时明确失败，不发布部分清单。预算检查不能中断正在进行的同步 Revit API 调用，也不等于取消了已经发布的请求。

结果固定 `coverage.complete:true`，范围仅为 `current_document_direct_type_references`，并保留 `indirect_effects:not_assessed`、`write_authorization:not_granted`。这是一份观察结果，不是后续写入的新鲜度凭证或用户确认。Node 核对类型/参数身份、完整覆盖声明、计数、扫描数、排序、唯一性和未授予权限；不会将快照中的字段当作执行授权。

新操作独立要求 0.8.6、`nativeParameterQueriesVersion:1` 和具名操作声明，入队及原子结果两侧都检查。原类型参数读取最低 0.8.2、单参数读取最低 0.8.4 保持；旧宿主不因新目录存在而接受未声明的操作。新查询进入实际只读 MCP 目录，工作区只读工具由 22 增至 23，仍保留源文档、取消、未知结果和原请求回执核对，不自动重放。

界面使用精确 ID 文本控件，只展示类型及参数身份、HasValue、原始内部值、显示值、单位/数据类型、直接实例数和核查范围。null、空串、0 与未知分别呈现；实例 ID 最多显示 50 项，并明确显示项数/总数。没有新增值、commit、应用按钮或 JSON 编辑器。

## 已执行检查

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| `npm run test:type-impact` | **65/65，0 跳过** | 38 实际 C# 生产者 peers、9 契约、10 原子队列/MCP、8 界面检查 |
| C# 新旧读取合组 | **71/71，0 跳过** | 新 38 项和旧 33 项；实际生产方法与共享事实 owner，受控 API |
| 原查询/目录 | **182/182** | 原子绑定、能力门禁与访问/文档回归 |
| 类型读取 / 单参数读取与界面 | **24/24、79/79** | 旧具名操作及字段兼容 |
| 原批量写 / 实例单参数写 | **117/117、124/124** | 原 setter、事务与原回执生命周期 |
| 布局 / legacy 目录会话 | **105/105、23/23** | 源码闭包、路径、安装身份、MCP 与会话 |
| 宿主检查 | **80/80** | 实际调度、认领、权限和文档校验，业务/API 使用 peers |
| 真实 Revit API 引用编译 | **33 C# 输入，exit 0** | 官方 WebView2 SDK；未加载生成 DLL |

上述测试均无跳过，不能据此声称真实模型或客户安装已验收。特别覆盖 500/501 实例、2,000 参数加 18,000 元素恰好 20,000、超扫描预算、两种实际 5,100ms 延迟、响应预算、类型自列实例、重复/失效/异文档来源以及 GetTypeId 异常；失败均不发布部分成功结果。参数事实与原始值 owner 未变，peers 不提供 Set 或 Transaction API。

复核时发现两处一致性问题并在冻结前修正：新实例 ID 列表的初稿 schema 接受数字而 C#/UI 使用字符串，已仅对新字段统一为 canonical 字符串，保留旧 ID 输入/描述符语义；UI 对扫描数少于实例数的矛盾结果新增待核对处理。最终合组全部通过，没有放宽覆盖或授权校验。

机器记录见 [type-parameter-impact-verification.json](type-parameter-impact-verification.json)，本地证据目录为 `artifacts/native-type-parameter-impact-validation-20261105-01`，包含实际 DTO、源码摘要、官方本地 API XML member 依据、日志及归档回读。

## 内部候选和未验项

最终源码快照 `artifacts/buildx-source-20261105-10`：**273 文件、199 JS 模块、613 引用**；当前源码逐文件一致。`artifacts/buildx-revit2024-type-parameter-impact-20261105-01`：**145 产品文件、19,437,404 字节、99 JS 模块、315 引用**，无裸 NPM 导入、缺失相对导入、构建机绝对路径或 DLL 调试目录。官方私有编译器仍为 17 文件；不捆绑 Codex。

运行 ZIP `artifacts/BuildX-Revit2024-0.8.6-internal-type-parameter-impact-20261105.zip`：7,407,247 字节、146 项。源码 ZIP `artifacts/BuildX-Source-0.8.6-internal-type-parameter-impact-20261105.zip`：1,140,383 字节、275 项，不含 build。逐项哈希、解压后源码闭包、编译器 17 文件和只读 MCP 23 项目录均通过；没有生成模型队列，临时目录核验归属与身份后清理。哈希详见机器记录，既有候选保留。

仍为 **releaseReady:false，不可安装**。四项产品清单缺口仍为 Argus 分发/运行、外部 Node bootstrap、私有 Node/Python 分发及 WebView2 Runtime。插件/第三方许可、pypdf、数据升级恢复、许可后端、真实 Revit/WebView/Codex 和干净客户机验收仍未完成。

下一切片是类型写入的可信强制确认和写前影响集复核。当前普通 automatic 策略会跳过一般确认，manual 入口也没有动态审批的一次性 ticket；旧 `set_parameters` 和任意 C# 仍有原有较宽写路径。本次查询不新增授权，也没有封堵这些旧入口，不能宣称所有类型修改已强制确认。后续需统一手动/AI 决策、冻结准确输入与影响事实，并处理旧批量类型目标和脚本边界；不能只接受模型提供的 ack。原生系统图、标注与依赖移除仍待后续验证。
