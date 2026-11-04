# BuildX 商用交付门槛

## 当前验收范围（2026-10-25）

本轮修复登录响应交付边界：生产HTTP＋受控Auth曾复现POST上传完毕后断开、迟到会话保留1个，匿名仍未登录且下一明确登录409。现原PanelAccounts消费可信ServerResponse的close/finish，断开后的迟到结果仅release本次本地session；已发行未finish时断开精确清本次登录，正常finish保留，旧close不能清新账号。不自动重试、远端注销或代Codex登录。

最终HTTP及必要账号UI/确认兼容57项＋独立owner7项，共64项独特检查通过、0跳过；同1场景实际产物变体另通过，不累加。新候选`artifacts/customer-chat/20261025-account-delivery-candidate`共24文件251750B，BUILD SHA `d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，`releaseReady:false`；3项raw更新、12应用模块实际从产物加载，原有候选保留。[本轮证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。

finish只表示交给本地底层发送，不证明浏览器收到Cookie；signup的云端创建或邮件不因本机release撤销。本轮没有真实Supabase/Codex/AI/云/GUI或常驻服务控制，未重跑旧真实AI和全根774/1。外部dataRoot已接入口，真实云及客户端、安装与许可验收仍待；族功能继续后置、原版Argus不动。

## 前轮外部数据根验收（2026-10-25）

此前已把客户入口接到显式外部`BUILDX_DATA_ROOT`：数据根与workspace须预存；资源/数据/workspace复用原目录事实解释，原数据根快照作为仅拒绝性约束交给原audit。日志在外部`runtime/customer-chat/run-UUID`严格新建，Codex的native及thread cwd使用外部workspace，public/prompt仍来自组件。实际14模块隔离入口＋受控Auth/default Core fake-native，以随机loopback HTTP/SSE跑通登录、明确确认、一条模拟回复和准确关闭；旧server.json身份/字节及组件树保持。最终producer32＋必要兼容6＋实跑中间candidate入口5共43项，开发侧plan/CLI8项，共51项独特检查通过、0跳过；早中间版本不累计。final仅收尾独立README后构建/verify，与已实跑candidate的21项运行输入（14模块＋prompt＋6前端）逐字节等价，未为文档重跑5场景。该轮候选`artifacts/customer-chat/20261025-data-root-final`共24文件249763B，BUILD SHA为`7b9c5f6fda10e9ebd924f58fa4fd7fec8934b6ef4907ff44c016c911417c5866`，`releaseReady:false`；八个旧候选（含本轮中间candidate）保留。[本轮证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。

前轮已修日志身份/关闭边界，并以受控BuildX A/B认证上游和真实本机Codex完成一轮对话；59个根测试文件774通过、1项可选Revit编译跳过、0失败属于前轮，本轮未重跑或新增AI。真实Supabase/WebView仍待；外部dataRoot和独立run已在本轮入口接线，实际安装/激活与历史信任仍未验收。原版Argus不动、族功能后置。[前轮证据](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)。

更新：2026-10-25。当前为研究原型的商用准备阶段，尚未满足对外分发验收。旧 `server.mjs` 的 `BUILDX_MODE=customer` 仍只启用账号门禁；新的 `customer-server.mjs` 是独立零模型工具聊天候选。二者都不是发布许可或付费授权。

| 阶段 | 本轮结果 | 仍需验收 |
| --- | --- | --- |
| 连接与恢复 | 传输/背压与精确关闭、断线结果未知提示已实现；日志目录/文件身份和hardlink复核、失败句柄保留、Panel聚合清理及迟到ready护栏已修复；历史全根774通过/1可选跳过，此前实际入口/原owner及必要兼容43项、plan/CLI8项通过 | 内部诊断监督25项/纯命令身份34项通过；实际有界查询超时且helper确认关闭。生产启动器未接入，常驻身份unknown；长时/网络波动及退出原因仍待 |
| BuildX账号 | Supabase Auth适配器、账号界面、HttpOnly/HTTP/SSE门禁、切账号隔离及显式续期已实现；同身份续期保留历史，晚到期/失败拒恢复；已修复登录响应明确断开后的本机会话遗留，相关64项通过（HTTP＋受控Auth/owner/必要UI兼容） | BuildX专用Free项目、真实注册/验证邮件/退出/过期及两用户隔离；本轮没有云端写入 |
| 客户自有Codex | 真实本机Codex读取、两步HTTP确认、一轮AI及SSE completed已通过；受控BuildX A退出/B登录后历史为空，未确认B拒绝发送；准确关闭通过 | 真实Supabase、长时网络、客户端/WebView及常驻加载仍待；稳定账号/工作区ID保持unknown，不是跨客户稳定身份绑定 |
| 产品权限 | 认证状态与产品许可明确区分 | 设备/组织/权限和到期数据表、RLS/GRANT、后台管理、撤销及离线行为规则；用户不能自授付费权限 |
| 安装与分发 | 独立24文件客户聊天组件已按白名单构建，两包字节一致、产物副本模拟闭环/只读回查通过；最终相关37项通过；原件保持 | 研究入口/原厂资源依赖隔离、自研发布构建、支持的Revit版本、可重复安装/升级/回退；当前完整宿主不能直接交给客户 |
| 业务与验收 | 既有样例只读对话/标高/上下文历史证据保留 | 至少一个约定业务端到端、真实项目副本、用户验收、故障恢复；族失败调查按用户要求后移 |

## 本地账号模式

默认 `research` 且未提供任何 Supabase 配置时，保留本地研究入口并明确显示“未配置”。成对配置专用项目 URL 与 publishable key 后启用登录门禁；`customer` 缺配置直接拒绝启动。空配置、部分配置、service_role 或 secret key 不会静默降级。

账号令牌仅在服务端内存；本机HttpOnly cookie只携带随机本地会话标识。服务停止后需重新登录。当前是每个本地安装实例同时一位BuildX用户，多标签共享该登录；不是远程多租户SaaS服务器。源代码工作台是独立研究入口，不属于客户发布能力。会话过期后停止新调用，在途模型结果仍需回查，不能声称取消已执行的Revit操作。

Supabase `GET /user` 是用户核验，不保证JWT即时撤销，也不证明购买、订阅或工程操作授权。设备和产品权限的业务后端尚待实现。云端会话/令牌同步、收费、模型上传均不在本轮。

## 停机和证据

手动 `POST /api/stop-service` 只在无活跃对话/上下文任务时接受，返回 `cleanupId`。若清理尚未确认，原client可携同一 `cleanupId`、Origin和CSRF重试同一路径；该凭据只允许原停机清理，不能恢复业务授权。已确认关闭前保留原资源，不启动重叠Codex进程。研究模式旧启动器的同client停机重试保持兼容；客户模式必须提供原清理回执。

停机现在同时等待Codex、Auth和原日志owner明确关闭；日志关闭失败时保持原HTTP清理回执可用，显式重试仅关闭原句柄，不重放写入。生命周期日志只保存固定原因码、代次、PID和退出终态；不记录密码、令牌、stderr或对话正文。队列和文件有上限，满额时保留旧证据并记录丢弃/失败计数；不能因没有日志就推断正常退出。启动脚本在此机的系统进程/监听查询曾阻塞，历史诊断已停止自有只读查询，没有绕过未知进程身份去启动常驻服务。

早期传输加固证据：`workbench/validation/20261025-commercial-hardening/README.zh-CN.md`、`summary.json`。该轮仅临时连接/目录验证、零AI；历史真实Codex一轮对话见20261025-account-dialogue-stability证据。两个常驻面板状态仍unknown，真实Supabase未验收。

本轮内部诊断及撤回证据：`workbench/validation/20261025-bounded-startup/README.zh-CN.md`。内部owner期限不能当成同步启动器的完整期限；未知关闭必须保留准确资源，不能通过强退外层丢弃。未启动或重启常驻服务，未新增账号/模型权限。

显式续期证据：`workbench/validation/20261025-account-renewal/README.zh-CN.md`。没有自动续期；客户端超时先只读核对、不自动重发POST。新常驻后端加载未确认，专用项目和WebView验收仍待；不把本地通过当作上线。

本机连接确认本地证据：`workbench/validation/20261025-codex-confirmation/README.zh-CN.md`。不能把schema导出、Fake child/fetch、HTTP/VM或工具目录当真实账号和客户验收；已收到的通知用于失效，不保证无通知的外部变化都能发现。

前端组件证据：`workbench/validation/20261025-customer-assets/README.zh-CN.md`；它仍依赖同源API/SSE，不能作为完整客户包发放。后端/Host闭包、许可与安装验收仍待，详见[CUSTOMER-ASSETS.zh-CN.md](CUSTOMER-ASSETS.zh-CN.md)。

聊天核心抽离证据：`workbench/validation/20261025-chat-core/README.zh-CN.md`。两个共用核心在缺研究组合文件的隔离副本中验证通过（受影响156项，模拟Codex），原入口兼容；该历史轮次尚无独立客户组合，之后的客户候选与最终证据见上文。常驻加载与真实云/UI仍待，见[CHAT-CORE.zh-CN.md](CHAT-CORE.zh-CN.md)。

独立客户聊天候选：`workbench/validation/20261025-customer-chat/README.zh-CN.md`。固定customer组合、独立Cookie和scope、两步确认、纯聊天/上下文拒绝已接，最终受影响293通过；仅模拟native/Auth与隔离HTTP/VM。真实CLI工具范围、专用云账号、常驻加载和WebView仍待，未构建完整客户安装包，见[CUSTOMER-CHAT.zh-CN.md](CUSTOMER-CHAT.zh-CN.md)。

客户聊天组件：`workbench/validation/20261025-customer-component/README.zh-CN.md`。22项来源＋生成package/BUILD共24文件，独立产物候选不含Revit宿主、研究工具或外部运行时；产物级真实云/原生Codex权限、WebView、许可证/公告和安装回退仍待，`releaseReady:false`，见[CUSTOMER-COMPONENT.zh-CN.md](CUSTOMER-COMPONENT.zh-CN.md)。

## 早期产物断线恢复检查（2026-10-25，后续已修复）

既有候选从实际产物加载12个生产模块，以fake-native/Auth验证轮次中EOF、失效、准确旧close后显式重连、重新确认、新thread与不重放；新增case1/1及必要共享harness回归1/1通过，产物完整树不变。观察到旧SSE没有unknown终态、退役快照为空，结果待核对提示和浏览器恢复尚待修复/验收。静态UI的旧busy可能在新快照前阻塞重连，尚未做组合UI复现。没有真实账号/CLI/云、模型、GUI或常驻启用；不是发布验收。详见[证据](../workbench/validation/20261025-customer-recovery/README.zh-CN.md)。

## 断线提示修复与新候选（2026-10-25）

此前提示缺口已在生产单一owner修复；固定无正文notice按BuildX登录身份投影，临时核验隐藏但保留，退出/到期/换号清除。页面失连先暂停发送，有界核对状态并正确释放失效GET，旧回执不覆盖新状态；不自动重发。最终源码/HTTP/VM受影响116项通过，新产物组合1项通过，均非真实云/浏览器验收。新候选为`artifacts/customer-chat/20261025-recovery-notice-candidate`，24文件共223121B，旧候选未覆盖、无安装启用发布，`releaseReady:false`。原真实环境及产品许可/安装/用户验收门槛仍待。[当时证据](../workbench/validation/20261025-customer-interruption/README.zh-CN.md)。

## 安装就绪计划（2026-10-25）

开发侧`customer:install-plan`已实现，只读核对当前候选并输出安装/升级/回退意图；所有计划均不可Apply。原verify/cleanup owner复用，同次BUILD摘要提供版本键；最终45项通过，真实B计划阻塞、旧A历史回退预期拒绝，未实际安装或启用。该历史轮次runtime仍写release；本次入口已外置日志与cwd，实际数据目录/启动用户和历史信任仍待验收。目标/active/进程unknown不能当空闲；代码回退不恢复登录、日志、云端或在途操作。[使用边界](CUSTOMER-INSTALL-PLAN.zh-CN.md)、[当时证据](../workbench/validation/20261025-customer-install-plan/README.zh-CN.md)。

## 目录角色与工厂cwd（2026-10-25）

已完成纯role Result和程序式工厂显式cwd接线，实际C默认工厂＋fake native证明两个cwd一致且Panel/prompt资源源不变；5/24/2项分范围通过，另同2项默认fixture变体和缺Auth entry回查，不累计为更多业务。该历史轮次入口尚未接dataRoot；本次已接显式外部数据根和独立run，但不证明immutable安装、权限或客户环境已验收。新C为`artifacts/customer-chat/20261025-layout-contract-candidate`（24文件228017B），无服务启用或真实账号/CLI/Revit/UI验收。[契约](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)、[证据](../workbench/validation/20261025-customer-layout/README.zh-CN.md)。

## 目录归属原型核查（2026-10-25）

仅workbench自建temp的原型，6项约束验收和2项实际排队写反例；不是8项产品或客户业务通过。该原型当时实测原audit跟随入队后被替换的junction/hardlink，生产与旧产物当时未改。此缺口现已在原生产者修复；本次已接显式外部数据根与独立run；实际安装、激活、长期目录适用性及历史信任仍待。安装计划继续readyToApply=false；[证据](../workbench/validation/20261025-customer-directory-ownership/README.zh-CN.md)与[目录规则](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)。

## 开发侧登记字节版本（2026-10-26）

仅已修复的account-delivery候选已固定原始定义/manifest/BUILD预期；同一builder支持独立只读核对，当前源码缺失也不信产物自报。最终新6＋受影响打包34共40项通过，中间版本不累计；没有新包、22raw/14模块变化或安装激活，原11候选完整树保持。它不是签名、撤销/安装选择或商用许可，真实账号与客户端验收仍待。[登记边界](CUSTOMER-KNOWN-RELEASES.zh-CN.md) · [证据](../workbench/validation/20261026-known-release/README.zh-CN.md)。
