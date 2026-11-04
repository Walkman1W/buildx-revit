# 客户聊天组件的独立构建

## 当前候选（2026-10-25）

`artifacts/customer-chat/20261025-account-delivery-candidate`共24文件251750B，BUILD SHA `d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，releaseReady=false。原账号owner已修复已知HTTP断开后的未交付登录；64项定向检查通过，同1场景产物输入变体另过不累加，实际12应用模块来自新包。仅PanelAccounts/Core/独立README三项raw更新，22raw/14模块闭包不变；前端manifest与旧10完整树保持。没有真实云/AI/UI或安装启用，[本轮证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。下节data-root-final是目录接线历史验收。

## 目录接线验收范围（2026-10-25）

本轮已把客户入口接到显式外部`BUILDX_DATA_ROOT`：数据根与workspace须预存；资源/数据/workspace复用原目录事实解释，原数据根快照作为仅拒绝性约束交给原audit。日志在外部`runtime/customer-chat/run-UUID`严格新建，Codex的native及thread cwd使用外部workspace，public/prompt仍来自组件。实际14模块隔离入口＋受控Auth/default Core fake-native，以随机loopback HTTP/SSE跑通登录、明确确认、一条模拟回复和准确关闭；旧server.json身份/字节及组件树保持。最终producer32＋必要兼容6＋实跑中间candidate入口5共43项，开发侧plan/CLI8项，共51项独特检查通过、0跳过；早中间版本不累计。final仅收尾独立README后构建/verify，与已实跑candidate的21项运行输入（14模块＋prompt＋6前端）逐字节等价，未为文档重跑5场景。该轮候选`artifacts/customer-chat/20261025-data-root-final`共24文件249763B，BUILD SHA为`7b9c5f6fda10e9ebd924f58fa4fd7fec8934b6ef4907ff44c016c911417c5866`，`releaseReady:false`；八个旧候选（含本轮中间candidate）保留。[本轮证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。

前轮已修日志身份/关闭边界，并以受控BuildX A/B认证上游和真实本机Codex完成一轮对话；59个根测试文件774通过、1项可选Revit编译跳过、0失败属于前轮，本轮未重跑或新增AI。真实Supabase/WebView仍待；外部dataRoot和独立run已在本轮入口接线，实际安装/激活与历史信任仍未验收。原版Argus不动、族功能后置。[前轮证据](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)。

本入口生成独立的源码/资源组件候选，不安装、启动或发布服务。它不包含Revit宿主或原版Argus，不能当作完整商用安装包。账号/CLI/WebView、许可与公告、产品授权、升级回退和干净机器验收仍待。

## 构建与回查

在工程根目录，使用已有Node：

```powershell
npm run customer:component -- --plan
npm run customer:component -- --build D:\code\REA\local-codex-panel\artifacts\customer-chat\my-candidate
npm run customer:component -- --verify D:\code\REA\local-codex-panel\artifacts\customer-chat\my-candidate
```

默认只读计划。输出只能是本工程 `artifacts/customer-chat` 下的新目录；不覆盖、清空或删除旧组件。失败时保留已生成目录，`ok:false`/非零退出码不能视为有效产物。构建/回查复核来源与字节；没有自动刷新哈希放行新输入。

## 唯一输入和生成文件

`release/customer-chat-component.json` 固定22项来源及原始SHA/长度/职责/依赖：14个服务端mjs、1个应用指令、6个前端资源、1份独立README。`lib/customer-component-definitions.mjs` 固定组件ID、入口、允许路径、输出根与生成元数据；不是HTTP可选策略。

生成的 `package.json` 仅保留 `node customer-server.mjs` 启动脚本、已测Node版本与候选标识；不会复制开发仓库package、依赖缓存或本机配置。最后生成 `BUILD-MANIFEST.json`，因此组件共24文件。两份生成文件不含机器路径、时间、环境值或凭据，`releaseReady:false` 固定保留。

旧前端和新聊天组件共用 `lib/customer-component-builder.mjs` 的读/写/精确树/清理算法，各自保留准确pending资源与清理ID。关闭失败阻止该owner新工作，只允许同owner重试原句柄关闭；成功才能释放。清理ID不能跨owner或跨进程使用。旧前端接口和metadata字节兼容，不另造打包实现。

每层目录逐项读取，至多期望数量加一条超限判据；不递归复制开发目录，不跟随符号链接、junction或多硬链接文件。核对使用工程内受信定义与manifest，不信任产物自报清单。额外/缺失/改名/篡改、未知来源与依赖、生成元数据变化都会拒绝；source hash、名称和闭包检查不能替代人工来源/分发审定，也不是同权限进程的OS沙盒或原子隔离。

## 产物运行边界与历史验证

组件内 `customer-chat.README.zh-CN.md` 是独立说明。Node、Codex、Python由客户自备，Supabase由用户具体配置；本组件不安装运行时、不复制登录缓存、不创建云项目、不读取 `.env`。本地部署仍使用云端认证与AI，并非离线AI。

产物副本验证使用真实Node和生产入口/核心，配合fake-native/Auth，在组件目录外存放测试harness、trace与证据。测试前后比较整个产物文件与目录树；它不向组件写fixture或runtime。缺配置入口按预期exit1，也不是有配置的常驻启用。实际Codex全部原生工具、真实Supabase、Revit集成和用户验收不能由这些模拟检查代替。前轮源码工厂曾以真实本机Codex完成一轮并跑过完整根套件；此前入口准入失败日志guard及独立README已更新；此前内部新目录选项已独立验收；本轮更新audit/entry/README及客户工厂注释四项raw，22来源/14模块闭包保持，无新增依赖。未重复真实AI或全根测试，中间candidate实际通过5个隔离入口场景；final仅收尾独立README再build/verify，21项运行输入字节等价，没有追加场景次数。

证据：[20261025-customer-component](../workbench/validation/20261025-customer-component/README.zh-CN.md)。

## 早期产物断线恢复检查（2026-10-25，后续已修复）

既有候选从实际产物加载12个生产模块，以fake-native/Auth验证轮次中EOF、失效、准确旧close后显式重连、重新确认、新thread与不重放；新增case1/1及必要共享harness回归1/1通过，产物完整树不变。观察到旧SSE没有unknown终态、退役快照为空，结果待核对提示和浏览器恢复尚待修复/验收。静态UI的旧busy可能在新快照前阻塞重连，尚未做组合UI复现。没有真实账号/CLI/云、模型、GUI或常驻启用；不是发布验收。详见[证据](../workbench/validation/20261025-customer-recovery/README.zh-CN.md)。

## 断线提示修复与新候选（2026-10-25）

此前提示缺口已在生产单一owner修复；固定无正文notice按BuildX登录身份投影，临时核验隐藏但保留，退出/到期/换号清除。页面失连先暂停发送，有界核对状态并正确释放失效GET，旧回执不覆盖新状态；不自动重发。最终源码/HTTP/VM受影响116项通过，新产物组合1项通过，均非真实云/浏览器验收。新候选为`artifacts/customer-chat/20261025-recovery-notice-candidate`，24文件共223121B，旧候选未覆盖、无安装启用发布，`releaseReady:false`。原真实环境及产品许可/安装/用户验收门槛仍待。[当时证据](../workbench/validation/20261025-customer-interruption/README.zh-CN.md)。

## 安装就绪计划（2026-10-25）

开发侧`customer:install-plan`已实现，只读核对当前候选并输出安装/升级/回退意图；所有计划均不可Apply。原verify/cleanup owner复用，同次BUILD摘要提供版本键；最终45项通过，真实B计划阻塞、旧A历史回退预期拒绝，未实际安装或启用。该历史轮次runtime仍写release；本次入口已外置日志与cwd，实际数据目录/启动用户和历史信任仍待验收。目标/active/进程unknown不能当空闲；代码回退不恢复登录、日志、云端或在途操作。[使用边界](CUSTOMER-INSTALL-PLAN.zh-CN.md)、[当时证据](../workbench/validation/20261025-customer-install-plan/README.zh-CN.md)。

## 目录角色与工厂cwd（2026-10-25）

已完成纯role Result和程序式工厂显式cwd接线，实际C默认工厂＋fake native证明两个cwd一致且Panel/prompt资源源不变；5/24/2项分范围通过，另同2项默认fixture变体和缺Auth entry回查，不累计为更多业务。该历史轮次入口尚未接dataRoot；本次已接显式外部数据根和独立run，但不证明immutable安装、权限或客户环境已验收。新C为`artifacts/customer-chat/20261025-layout-contract-candidate`（24文件228017B），无服务启用或真实账号/CLI/Revit/UI验收。[契约](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)、[证据](../workbench/validation/20261025-customer-layout/README.zh-CN.md)。

## 开发侧登记字节版本（2026-10-26）

仅已修复的account-delivery候选已固定原始定义/manifest/BUILD预期；同一builder支持独立只读核对，当前源码缺失也不信产物自报。最终新6＋受影响打包34共40项通过，中间版本不累计；没有新包、22raw/14模块变化或安装激活，原11候选完整树保持。它不是签名、撤销/安装选择或商用许可，真实账号与客户端验收仍待。[登记边界](CUSTOMER-KNOWN-RELEASES.zh-CN.md) · [证据](../workbench/validation/20261026-known-release/README.zh-CN.md)。
