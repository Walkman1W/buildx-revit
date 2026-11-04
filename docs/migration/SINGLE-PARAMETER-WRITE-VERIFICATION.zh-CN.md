# 实例单参数写入验证

日期：2026 年 11 月 5 日。P1 `revit_set_parameter_value` 已完成源码实现、受控执行验证及 Revit 2024 API 引用编译。宿主与程序集为 **0.8.5**。只修改新工程；未重启服务、替换已安装插件、加载 DLL 或执行真实模型操作。

## 当前实现与边界

新具名操作 `set_parameter_value` 复用现有 `WorkbenchActions.SetParameters`、内层事务和宿主外层事务组。输入为 `expected_document`、默认 rollback 的 `mode` 和恰好一项 `changes`：稳定元素/参数 ID、目标值、Double 的显式 `value_unit=internal`，以及实际读取的 `expected_state`。该状态保留 `storage_type`、`has_value`、`value_internal`、`data_type`，不使用显示值或未知值的推测替代。

执行器在 Set 前核对四项事实、元素不是 ElementType，且 Parameter.Element 属于所选实例和同一 Document。拒绝名称查找、隐式转读/转写类型及 ElementId 存储写入。Double、Int32、String 沿用唯一 setter 的解释；YesNo 的目标值仍限 0/1，原有异常整数前值作为原始观测保留。设置后、Regenerate 后、内层 Commit 后均按 ID 复验目标值、存储、参数归属和 data_type；最后仍由原外层事务组决定 rollback/commit。commit 仅保留内存修改，不保存模型。

成功 DTO 明确 `schema_version:1`、`target_kind:instance`、实际 `before` 状态和共享单行 `result`。新操作的回执 ID 均为精确十进制字符串。Node 对照已发布请求核对完整身份、前态、值、类型、单位、行数及 changed；原 `set_parameters` 默认仍接受安全整数 ID，保持旧结果兼容。返回的前后值发生于外组决定之前，rollback 预览不能描述成模型最终保留目标值。

宿主同时在 host.json 和状态中声明 `nativeParameterWritesVersion:1`、`nativeParameterWriteOperations:[set_parameter_value]`。版本、能力或操作缺失时零入队；新写不进入原子只读分支。新入口要求已绑定文档、持续权限检查和原回执 owner，由现有审批 owner 冻结并哈希绑定完整输入。旧 MCP 与工作区只读 MCP 都不暴露新写；legacy MCP、会话目录与提示词计数由同一个目录投影保持一致。

界面复用既有元素/参数下拉和类型控件，限制一项，使用原单位转换；expected_state 只从新读取的原始描述符快照产生，不要求用户编辑 JSON。大 ID 使用已发布精确 ID 规则。复核发现选择描述器的关联类型/标高 ID 仍可能先经 JSON 数字舍入再被 Node 拒绝，已将同一描述器的元素、类别、类型、标高 ID 统一为安全范围保数字、超范围保字符串；负数及类别空值保留。实际 C# 序列化与 Node selection 投影已串联检查。

通用错误、取消后的在途执行、超时、回执不匹配及回滚异常继续保留 unknown/unconfirmed 和原请求核对能力；没有新增“已停止/已回滚”推断，也不自动重发。

## 已执行检查

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| `npm run test:single-parameter-write` | **124/124，0 跳过** | 新契约、实际 C# setter/事务组 peers、临时队列/原回执、真实权限 owner、MCP 拒绝入口及轻 DOM 控件 |
| `npm run test:parameter-writes` | **117/117，0 跳过** | 原批量写、三阶段回读、失败及发布生命周期 |
| `npm run test:native-queries` | **182/182，0 跳过** | 六查询、原子读取、目录及文档/访问权限回归 |
| `npm run test:native-parameters` | **24/24，0 跳过** | 原类型查询 |
| `npm run test:single-parameter` | **79/79，0 跳过** | 单参数读取、精确 ID 和表单 |
| `npm run test:layout` | **105/105，0 跳过** | 路径、安装身份、运行时与源码闭包 |
| legacy 会话/目录专项 | **23/23，0 跳过** | 实际 MCP 目录、协议夹具、会话配置与提示词 |
| 原宿主检查 | **80/80** | 实际调度、请求认领、访问及文档校验代码，业务/API 为受控 peers |
| 最终描述器独立检查 | **7/7** | 实际生产方法序列化，包含 Int64 上界，无事务启动 |
| 真实 API 引用编译 | **33 项 C# 输入，exit 0** | Revit 2024 / 官方 WebView2 SDK；未加载新 DLL |

证据目录：`artifacts/native-single-parameter-write-validation-20261105-01`。机器记录为 [single-parameter-write-verification.json](single-parameter-write-verification.json)，记录日志、源码与产物摘要。

首轮失败记录保留：legacy 两项测试仍把新增审批专用写工具期待在 raw MCP 中，已改为核对独立 legacy 目录；一项旧写 peers 及一项源码闭包检查在协作文件尚未落齐时执行，最终文件冻结后复验通过；四项审批夹具以 JSON 属性插入顺序比较同一文档，改为逐字段身份比较后通过。源码快照 08/候选 01 的审计也正确拒绝了随后发生的一个测试文件变化，未将其中间结果冒充最终验证；最终使用快照 09/候选 02。没有放宽生产回执或审批校验来使测试通过。

## 内部候选与未验证层面

最终源码快照 `artifacts/buildx-source-20261105-09`：**266 文件、193 JS 模块、589 引用**，当前源码逐文件一致。最终 `artifacts/buildx-revit2024-single-parameter-write-20261105-02` 为 **0.8.5-internal-single-parameter-write**：**145 产品文件、19,421,009 字节、99 JS 模块、315 引用**，裸 NPM 导入、缺失相对导入、构建机绝对路径和 DLL 调试目录均为零。官方私有编译器继续为 17 文件、16,200,956 字节；不捆绑 Codex。

运行 ZIP 为 `artifacts/BuildX-Revit2024-0.8.5-internal-single-parameter-write-20261105.zip`（7,402,873 字节、146 项）；源码 ZIP 为 `artifacts/BuildX-Source-0.8.5-internal-single-parameter-write-20261105.zip`（1,114,774 字节、268 项，不含 build）。两包逐项摘要、解压后源码闭包、编译器 17 文件与只读 MCP 22 项目录均通过；新写工具未暴露、调用被拒且没有生成队列。ZIP 哈希见机器记录。临时目录按 owner、目录身份和绝对路径核验后清理。

仍为 **`releaseReady:false`、不可安装**。产品清单保留四项缺口：Argus 分发/运行未核实、安装 bootstrap 需要外部 Node、私有 Node/Python 分发未核实、WebView2 Runtime 存在性未核实。插件及第三方许可、pypdf、数据升级恢复、许可后端和客户首装/升级/卸载仍需对应验收；SDK 编译不等于客户运行时可用。

真实 Revit/WebView/Codex、插件加载、模型效果及干净客户机均未验收。旧工程、研究材料、既有候选和失败证据保留；本轮没有真实模型写入或正式发布。

下一切片为类型参数写入的影响范围与可信确认契约。类型整体修改不能只增加 `ack:true` 或沿用自动应用权限；需明确 type ID、原始状态和跨实例影响，完成独立验收后再接入。其余常用命令、原生系统图、规则标注和后续依赖移除仍在计划中。
