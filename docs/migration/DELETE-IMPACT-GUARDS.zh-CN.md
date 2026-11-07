# 删除影响比较：未注册的基础切片

本切片保留原有图纸回滚预览，并为预览核心增加普通实例目标类型；类型元素明确拒绝。通过有界 `Document.Delete` 回滚预览获得的级联仍须完成原身份恢复检查。新增 `DeleteImpactGuard` 比较函数可在未来受信任的宿主删除流程中核查文档/宿主/请求及期限、每个预览 ID 与 UniqueId、`Document.Delete` 返回的无重复集合是否精确一致，以及删除后这些 ID 是否消失。它不调用删除、不提交事务，也不构成授权；UTC 过期检查不能替代未来原生单调时钟和一次性许可。

原生结果对象、宿主请求和 session 当前仍可由内部调用方构造，不是可信回执。现有原生准入只支持图纸，Node 审批 owner 也未绑定目标种类；二者尚未与此比较器、生产队列及真实用户决定联通。共享队列令牌被同用户读到后可抢用的边界仍未解决，外部服务和事务外副作用未评估。因此 `revit_delete_element`、`revit_delete_sheet` 和删除预览仍不注册，也不能据此声称删除可用。真实 Revit、Codex 和 WebView 均未测试。

## 未注册的宿主原生双次决定候选

`DeleteNativeReviewWorkflow.Execute` 在宿主调用时通过 Revit `TaskDialog` 请求两次原生决定：第一次只允许临时删除后回滚预览；若调用目标为 commit，完整预览核验后还须第二次明确 Yes 才在同一调用中进行删除。回滚模式只进行第一次决定和预览。第二个对话框包含每个受影响 ID、UniqueId、类别与名称；为降低显示风险，仅支持最多 20 个级联元素和 12,000 字符，超限拒绝。预览开始前、决定后及提交前依赖宿主提供的 current 回调重新核实文档、授权和取消；实际删除集合必须与预览完全一致，内层提交后再次核对元素消失，只有最后身份仍有效才合并事务组。异常时尝试回滚，回滚或恢复身份不可确认归为未知。事务外和扩展服务副作用无法保证回滚。

测试注入决定的入口仅在 `BUILDX_TESTS` 下编译；生产版本只能走原生 TaskDialog 方法。但此类没有接入 `WorkbenchHost`、生产队列、访问策略、取消标记或原回执 owner，也没有登记删除/预览命令。Revit 2024 API 编译只能证明接口可编译，不能证明 ExternalEvent 中模态对话的行为、Revit 活动文档/互斥和取消语义，或 20 项在实际屏幕上的完整可读性。TaskDialog 显示事实与用户实际审核尚未设备验证。上述宿主绑定及原回执、异常/迟到回执与访问撤销的端到端验证完成前不得开放操作。

## 默认关闭的宿主 claimed 请求适配

`DeleteReviewHostAdapter` 将由宿主 claimed 文件名提供的请求 ID、宿主内部 session、当前活动文档及请求到期时间绑定到原生双次对话流程。每次 current 检查调用原生文档同一性、`RequireProjectEdit` 对绑定的 access policy 重新检查，并检查针对该请求和 session 的取消标记；错误或格式不明标记均保守取消。模型提交的 `confirmed` 等额外字段不被接受。若提交后身份不再可核实或回滚状态未知，返回未知而不重放。

`WorkbenchHost` 中的内部候选路由与未知结果的原 outbox 映射仅在编译符号 `BUILDX_DELETE_REVIEW_CANDIDATE` 启用时存在；标准构建未定义该符号，菜单、MCP 与默认队列入口均未注册。候选路由调用现有 `ProcessOne` 单次 claimed 请求与原 outbox，不发第二次请求；异常的 `RollbackUnknownException` 映射为 `DELETE_REVIEW_OUTCOME_UNKNOWN`。测试中的队列文件和 TaskDialog 均为受控 peers，不等于生产队列端到端验收。

仍缺真实 Revit ExternalEvent 模态对话和 20 项清单完整可读性验证；Node 生产原回执 owner 尚无这个内部候选的专用解释器、审批会话和取消发布接线。工作共享、真实访问撤销、对话框期间取消、宿主关闭和迟到回执均未在实际设备上验证。启用编译符号的 DLL 只能作为隔离候选，不能安装或声称此功能可用。
