# 本机 Codex 连接确认

2026-10-25：已用现有真实本机Codex登录完成只读账号核对、两步确认和一轮AI回复；BuildX Auth上游为受控A/B模拟。真实Supabase、长时网络与WebView验收仍待，常驻服务加载未确认。当前研究宿主不是客户发布包。

## 当前增量：登录响应交付（2026-10-25）

已修复BuildX登录响应断开后的迟到会话阻塞：生产HTTP＋受控Auth曾复现匿名未登录、下次明确登录409；现在原账号owner按可信ServerResponse的close/finish，只释放本次未交付的本地session，正常finish保留，旧close不清新账号。读取本机Codex→明确确认的门禁不变，没有自动重试、远端注销或代Codex登录。

HTTP及必要账号UI/确认兼容57项＋独立owner7项，共64项独特检查通过、0跳过；实际产物同1场景变体另通过，不累加。新候选`artifacts/customer-chat/20261025-account-delivery-candidate`共24文件251750B，BUILD SHA `d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，`releaseReady:false`；3项raw更新、12应用模块实际从产物加载，旧候选保留。[本轮证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。

finish不是浏览器收到Cookie的证明；signup云端副作用不因本机release撤销，结果未知须核对。本轮没有真实Supabase/Codex/AI/云/GUI或常驻服务控制，没有重跑历史真实AI与774/1；真实云及客户端验收仍待，外部dataRoot已接，族功能继续后置、原版Argus不动。

客户模式下，登录 BuildX 后还需：

1. 等待本机 Codex 及工具连接就绪；Codex 继续使用客户自己已有的登录。
2. 展开“本机 Codex 连接确认”，点击“读取本机 Codex”，核对返回的邮箱、套餐和读取时间。未返回邮箱时如实显示未返回。
3. 点击“确认使用此连接”。这一步之后开放所在工作区允许的调用；独立customer-chat只开放对话、始终拒绝模型/选择上下文。模型研究入口的操作仍遵守原样例、文档和授权边界。

这只确认当前本机连接，不证明稳定的 OpenAI 账号/工作区身份，也不授予产品付费权限。没有导入 token、代登录、注销其他客户端或切换 API 计费。

确认依赖当前 BuildX 本机会话、Codex 连接代次和账号状态修订。收到账号变更提示、连接故障、退出、到期或重新连接后，旧确认与上下文失效，需再次读取和明确确认。临时核验或同会话续期只暂停使用，成功恢复后保留同一确认，不会每5分钟要求重确认。已开始的模型操作不能据此宣称已撤销，未知结果仍需回查。

读取凭据只在当前页面内存中保留5分钟，不能跨发起面板确认，刷新页面不恢复旧凭据。请求超时表示结果待核对，先刷新状态；不会自动再次提交读取或确认。跨标签页或服务重载使旧凭据失效时，重新读取即可。

未配置账号的 research 模式和独立 source 工作区不声明客户绑定；源码工具仍与模型会话分开。没有 BuildX 专用 Supabase 项目时，真实云登录仍待；已用受控Auth与真实本机Codex验证对话链路，不误用其他项目。

## 本地实现与边界

- POST `/api/codex-account/inspect` 只收 `{client}`；成功返回一次性 challenge 和可见账号信息。
- POST `/api/codex-account/confirm` 只收 `{client,challengeId}`，再做一次新鲜只读账号核对；HTTP不接收账号 DTO、密码或 token。
- 两次操作均核对 cookie、Origin/CSRF、空闲状态和异步前后的当前身份。挑战不能复用或跨面板消费。
- `CodexClient` 唯一解释 account/read 回执；公开 status 不含 Codex 邮箱、套餐、challenge 或凭据。可见信息只在已认证的 inspect 回执展示，不进入 AI 上下文和生命周期日志。
- 邮箱与套餐不是身份主键；当前0.164.0-alpha.11.1已导出 schema 的可达账号响应未返回稳定账号/工作区 ID，因此这两个值保持 unknown/null。不能把未被响应引用的 schema 定义当作已返回字段。
- 只有已收到的通知和显式观察可用于失效处理；未承诺能发现没有通知、且可见信息完全相同的外部账号切换。

完整证据：`workbench/validation/20261025-codex-confirmation/README.zh-CN.md`。协议依据：[OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)，并以本机实际导出的当前版本契约为具体字段依据。

## 启动新鲜度与实际链路

启动阶段仅在首次账号观察尚未发布、且已知初始账号通知跨越该次读取时，最多补一次新鲜`account/read(refreshToken:false)`；旧响应丢弃。第二次变化、RPC失败或公开`failed()`均停止启动，不自动重试消息。确认之后的账号通知、故障或可见事实变化仍撤销旧确认与线程，不会被迟到启动回执恢复。

前轮真实HTTP链路：匿名401、确认前403、inspect/confirm各200；一次明确发送收到202和SSE completed，规范会话包含两条completed消息、零工具与零模型上下文。A退出、B登录后历史为空且B未确认发送403。没有代登录/注销真实Codex；所有自有App Server与HTTP/Auth/audit均确认关闭。[当时证据](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)。

## 客户入口准入失败日志（2026-10-25）

该历史轮次仅修正配置准入前的失败日志：即使Auth配置完整，工厂因CODEX_HOME等配置拒绝时，也只输出固定stderr并关闭原资源，不创建runtime。工厂通过后的模拟listen失败仍记录到原owner并准确关闭；2项新场景及6项兼容通过，产物同2项输入变体不重复计数。没有再次调用真实Codex或Supabase，前轮对话证据保留。当时24文件候选为`artifacts/customer-chat/20261025-entry-admission-candidate`、243309B、`releaseReady:false`。[本轮证据](../workbench/validation/20261025-customer-entry-admission/README.zh-CN.md)。

## 外部数据根接线（2026-10-25）

客户入口现要求操作者显式选择已准备的`BUILDX_DATA_ROOT`及其workspace；资源和数据物理链不得互相包含，日志在数据根内的新run，由原owner处理。该接线不改变登录、读取本机Codex→明确确认的门禁，也不代创建workspace、读取/覆盖旧server.json或改Codex凭据。实际隔离入口以受控认证上游和fake-native完成登录、确认、模拟对话及关闭；native/thread cwd均为外部workspace。该轮final为`artifacts/customer-chat/20261025-data-root-final`，24文件249763B，BUILD SHA`7b9c5f6fda10e9ebd924f58fa4fd7fec8934b6ef4907ff44c016c911417c5866`；21项运行输入与已实跑中间candidate等价，独立README收尾未追加AI或入口场景。真实Codex一轮属于此前轮次，该轮没有真实账号/AI/云调用，专用Supabase和WebView仍待。[当时证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。
