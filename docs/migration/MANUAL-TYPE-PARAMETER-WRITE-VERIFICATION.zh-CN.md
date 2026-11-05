# 手动类型参数写入验证

日期：2026 年 11 月 5 日。手动 `revit_set_type_parameter` 已接入与对话相同的原生准备、逐次确认和原回执 owner。只完成源码、受控 HTTP/DOM/队列与 API 引用编译；未替换插件、重启用户服务、操作真实模型或完成真实 Revit/WebView/Codex 验收。宿主协议及程序集保持 **0.8.8 / 0.8.8.0**。

## 实际变化

常用命令中的类型参数表单只提供稳定 type/parameter ID、读取影响、拟议值与执行方式。先实际读取完整 `revit_get_type_parameter_impact`，按参数存储类型提供文本或数值控件；Double 明确使用 Revit 内部单位，不另造单位转换。原态四字段和完整排序实例清单直接取自读回事实，隐藏于表单 owner，不显示可编辑 JSON、ack 或凭证字段。空字符串、null、HasValue、Int32 范围及精确 ID 沿用共享事实/契约解释。

读取结果必须属于本次目标、执行 ID、文档及当前面板身份，覆盖完整且没有 partial；目标、权限、账号、上下文或文档变化后清除旧事实。提交即锁定本次草稿；unknown 不解除锁定，直到匹配的原操作核对终结。再次修改必须重新读取影响，不用旧结果生成第二次写入。

`POST /api/command` 只接受操作意图，返回的 202/executionId 不表示已经批准或写入。后端绑定当前授权文档，拒绝客户端提供 `expected_document`，重新调用既有 `prepareTypeParameterWrite`，再交同一个 `modelPermission.propose/decide`。手动运行保持 `kind:'command'`，不伪造聊天轮次，也不创建 AI thread/turn。

手动和对话共用 `dynamicApproval` 类型审阅卡以及原五字段 `POST /api/dynamic-approval`。Origin/CSRF、客户端、对话、权限、连接、摘要、当前 entry 和期限核对后，才发放一次用户决定凭证。automatic、rollback、commit 均不能跳过逐次决定；当前权限只允许回滚时，手动 commit 仍被拒绝。初始 `confirmed:true` 不充当用户决定。

目录以 `manualExecution:true`、`requiresTypeParameterReview:true` 声明这个受审阅的手动入口。原始 `dispatcher.command` 仍拒绝类型写，不因目录开放而接收外部伪造批准；真正写入由权限 owner 经既有 `.tool` 路径执行。只读/legacy MCP 继续排除此工具，具名实例写继续拒绝类型。

取消、过期、退役、关闭及连接变化都会结算等待中的手动提案，不留下永久 busy 或 reset 等待。准备读取迟到/未知时保留原 grant 下的 direct read owner，核对后不恢复提案或写入；写入已发出时沿同一 permission ticket 保留原回执，先登记再检查界面归属，不重复 close、不重发。原回执核对终结后，只更新匹配的原 conversation/executionId；迟到 received 仅显示回执已确认，不伪造完整业务 DTO。

本轮同时修正两项界面衔接遗漏：原类型审阅 helper 和新手动表单 helper 补入模型工作区 HTTP 资源表；source/customer 工作区仍不可读取它们。另将 session accessPolicy fallback 与顶层策略一起置于审阅前，保留顶层优先级，避免移动代码后 else 错绑到动态审批结果分支。

原生 token book、120 秒期限、真实文档身份、原态/直接实例守卫、四阶段回读及未知结果语义不变。任意 C#/脚本仍按其较宽权限处理，本功能不是通用沙盒。

## 验证及边界

本轮目标组、运行命令、日志摘要、源码/候选与 ZIP 哈希详见 [manual-type-parameter-write-verification.json](manual-type-parameter-write-verification.json)。本地日志位于 `artifacts/manual-type-parameter-write-validation-20261105-01`，不入仓或产品包。

| 已执行检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run test:manual-type-writes` | **30/30，0 跳过** | 手动 HTTP 14、实际 HTTP→队列→C# 6、手动 UI 10 |
| 手动 HTTP 与原 AI HTTP owner | **25/25** | 含结果卡终态、迟到更新、换连接不应用原结果、实际静态资源请求 |
| 最终相关审批 UI | **37/37** | 手动 10、旧类型审阅 14、动态审批 13；此前更广 UI 组 101 项也通过，存在重叠 |
| 共享权限 / 命令与回执 / 原类型写 | **70/70、80/80、180/180** | 最终源码复验，保持普通命令与对话入口行为 |
| 布局与打包 | **105/105** | 路径、安装身份、源文件闭包与依赖 |
| API 引用编译 | **34 C# 输入，exit 0** | 原生 C# 源码未改；从本轮快照独立编译，未加载 DLL |
| 语法与归档 | **通过** | 三个入口语法、ZIP 条目/解压、MCP 目录、编译器及新增字段模块 |

上述最终组均无跳过；各组不能累加为互不重复的测试总数。

- 手动 HTTP 覆盖所有允许权限/执行方式、逐次决定、拒绝、过期、取消、连接变化、关闭、准备/写入未知与迟到核对；实际 GET 核对两份真实模块的 JS MIME、内容与 SHA，并核对 source/customer 的 404。
- 实际生产 C# book/Host、影响查询与 setter 经持久受控 API peers，与真实临时 Node 文件队列及 loopback HTTP 相连。覆盖 rollback/commit、HTTP 决定前零 Set、重复决定、原态/成员变化和原回执迟到；Codex、状态元数据和 API 对象受控，没有 Autodesk 进程或真实模型执行。
- UI 使用实际 app/workspace/field 与隔离 DOM；覆盖普通控件、原始事实、目标/身份变化、迟到拒绝、提交锁定、原审阅卡和策略快照顺序。不能替代 Revit WebView 的实际设备验收。
- 既有类型写、权限、命令/回执及布局回归分别记录，组间有重叠，不累加成独立验收总数。此前已知的 17 项扩展 UI 夹具失败和固定 35ms 查询测试脆弱性未在本轮修复，不宣称全仓所有测试通过。

保留的失败：HTTP 资源测试初稿缺少 fixture 必需的禁模型 invoker，补齐受控依赖后通过，未放宽生产校验。跨 C# 联测首轮两个 drift 子例的业务断言全部通过，但 fixture 在 finally 要求正常关闭未知回执的 core，正确的 close 拒绝导致两个子例及父例失败；只修改测试资源收尾，保留原合成请求/响应及 unknown 事实，明确关闭自己的测试 listener 不等于生产 close 或回滚成功。首次运行期间源码曾变化，已标记为非冻结证据；最终结果从冻结源码复验。

## 内部候选及下一步

最终源码快照 `artifacts/buildx-source-20261105-15`：**298 文件、222 JS 模块、718 引用**；内部候选 `artifacts/buildx-revit2024-manual-type-parameter-write-20261105-01`：**149 产品文件、19,527,740 字节、103 JS 模块、337 引用**，版本 `0.8.8-internal-manual-type-parameter-write`。新增表单和审阅 helper 的运行导入、HTTP 路由及打包闭包均有对应检查；当前源码、编译输入、清单及逐文件摘要一致，缺失相对导入、裸 NPM、构建机绝对路径和 DLL 调试目录均为零。旧候选及证据保留。

独立运行 ZIP **7,436,398 字节 / 150 条目**，源码 ZIP **1,240,000 字节 / 300 条目**，位于 artifacts 的本版本文件。逐条目、临时解压、编译器 17 文件、源码闭包与 34 项 API 输入已核验；只读 MCP 23 项及 default 45 项目录都不暴露类型写，没有调用模型业务工具或创建队列。SHA 与完整核对记录见机器文件。

仍为 **releaseReady:false，不可安装**。Argus 分发/运行、外部 Node bootstrap、私有 Node/Python 与 WebView2 Runtime 四项缺口保持；许可、pypdf、数据升级恢复、许可后端、真实 Revit/WebView/Codex 及干净客户机验收未完成。不捆绑或改动用户 Codex。

手动类型写切片完成后，BX-006 继续按清单推进其余常用命令，再做原生系统图、标注和已替代依赖移除；仍有消费者的 Argus/ScriptRunner 保留。当前工具目录默认 31,583 字节、含族能力 32,756 字节，上限仍为 32,768；新增命令前需在同一契约 owner 内处理目录预算。每小时自检继续，整套计划未完成。
