# 聊天核心与工具组合

`lib/codex-client-core.mjs` 与 `lib/panel-server-core.mjs` 保存共用的生产传输、账号观察、HTTP/SSE、会话与准确关闭实现。它们不导入研究工具目录或命名 profile，也不自行决定开放哪些工具。

现有 `CodexClient(root, options, dependencies)` 和 `createPanelServer(options)` 保留为应用组合入口：原命名 profile、默认模型模式、模型/源码模式匹配和源码账号限制继续生效。两个既有服务入口没有换成新客户配置，也没有启动或重载。

核心只接收可信应用代码产生的冻结配置；可变嵌套对象、访问器、未知工作区或不一致的上下文能力拒绝。当前 Panel 核心支持固定 `model`、`source-development` 与 `customer-chat` 组合；客户聊天必须登录及明确确认、无模型上下文，确认键包含各自scope。这里没有开放浏览器自报 profile、任意 MCP、文件、终端或权限请求，也没有新增可用模型工具。

核心隔离副本的闭包为八个生产模块：

| 模块 | 职责 |
| --- | --- |
| `codex-client-core.mjs` | 既有 Codex 协议、连接/账号代次、背压及准确关闭 |
| `local-runtimes.mjs` | 定位客户已安装的运行时；不安装软件 |
| `panel-server-core.mjs` | 既有本机 HTTP/SSE 与会话编排 |
| `chat-session.mjs` | 有界历史、工具回执与 thread/turn/item 归属 |
| `chat-context.mjs` | 既有显式模型/选择上下文契约 |
| `cad-document-path.mjs` | 普通路径比较，不读取模型 |
| `panel-accounts.mjs` | 既有本机 BuildX 会话与认证适配契约 |
| `codex-confirmation.mjs` | 既有本机连接的两步确认与失效 |

隔离测试删除了研究 wrapper/profile/工具实现的可见性，使用真实 Node 解析器记录并限制实际 import；随后运行生产 HTTP/SSE 核心的一轮模拟 Codex 对话、上下文拒绝、停止与关闭。另一个两文件隔离检查让生产 Codex 核心经 fake child 完成初始化、模拟账号/目录握手并确认关闭。它们不代表真实云账号、Codex 推理、Revit、浏览器或客户验收。

现有 `server.mjs` 的 customer 开关仍只启用账号门禁；完整模型 wrapper 仍引用研究组合。另已实现独立 `customer-server.mjs` 候选及纯聊天组合，见[CUSTOMER-CHAT.zh-CN.md](CUSTOMER-CHAT.zh-CN.md)。它复用核心并经模拟协议/账号与隔离HTTP验证，但尚未启用为常驻服务，也没有后端安装包；下一步按精确白名单完成独立组件构建，不能把内部测试配置放到客户机。

客户自己的 Node/Codex/Python 前置、运行时定位行为、许可与公告、Supabase 项目、长时/网络波动、WebView和完整宿主依赖隔离仍须分别验收。原版 Argus、已安装宿主及启动器不变。证据：[20261025-chat-core](../workbench/validation/20261025-chat-core/README.zh-CN.md)。
