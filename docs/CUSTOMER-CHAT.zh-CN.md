# 独立客户聊天入口（候选）

客户聊天以“BuildX 登录 → 读取本机 Codex → 明确确认此连接 → 对话”为入口。账号、确认、续期和会话实现均复用现有核心；没有第二套令牌存储或聊天实现。

前轮已用受控BuildX Auth与真实本机Codex跑通确认和一轮对话。没有专用Supabase项目，真实云认证与WebView仍待；没有启动常驻客户服务或接管Revit面板。候选仍未满足商业安装与许可验收。[当时证据](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)。

## 当前增量：登录响应断开恢复（2026-10-25）

生产HTTP＋受控Auth已复现POST上传完成后断开、迟到登录保留1个本机会话，匿名状态未登录而下一明确登录409。现原PanelAccounts监听可信ServerResponse的close/finish：迟到结果只release本次本地session，已发行未finish时断开只清本次登录，正常finish保留、旧close不清新账号。不会按网页client标识认领会话、自动重试、远端注销或改变Codex登录；本地finish也不证明浏览器收到Cookie，signup云端结果或邮件须另行核对。

HTTP及必要账号UI/确认兼容57项＋独立owner7项，共64项独特检查通过、0跳过；同1场景实际产物变体另过，不累计。候选`artifacts/customer-chat/20261025-account-delivery-candidate`共24文件251750B，BUILD SHA `d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，`releaseReady:false`；3项raw更新，12应用模块实际来自产物，旧候选保留。没有真实Supabase/Codex/AI/云/GUI或常驻服务控制，也未重跑旧真实AI及774/1；外部dataRoot已接事实不变，真实云及客户端验收仍待，族功能后置、原版Argus不动。[本轮证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。

## 固定范围

- 新命名组合是 `customer-chat`，服务标识 `buildx-customer-chat`。声明的模型/源码工具为0，不读取模型或选择上下文；当前只处理对话。
- 子进程配置禁用既有MCP服务、代码模式、终端、应用/插件、浏览器等能力。准备新线程须回读完整终页，`nextCursor`为null或省略；可返回disabled配置元数据，但每项必须明确disabled且tools/resources/resourceTemplates为空、名称不重复。活跃、未知、分页或暴露能力均撤就绪，不自动重发消息。前轮真实CLI回读10项disabled、各能力为空并完成零工具对话；这不证明全部原生工具权限已穷尽验收。
- 客户模式必须配置专用Supabase Auth，不能降级为research。不接受浏览器自报profile、账号身份、工具配置或写权限。
- 客户Cookie固定为 `buildx_customer_chat_session`，模型面板仍用旧Cookie。Cookie不按端口隔离，不能靠不同端口冒充隔离。
- 本机确认键包含workspace scope、BuildX session/user/代次及Codex连接/账号代次。客户与模型的挑战和确认不能互用。稳定OpenAI账号与workspace ID仍未知，不以邮箱或套餐造主键。
- 配置或目录运行中不匹配会拒绝继续对话并撤销确认；同身份续期仍保留确认。令牌仍只在服务端内存，账号界面与聊天输入分开。

## 文件和入口

`lib/customer-chat-profile.mjs` 单独拥有Codex与Panel的冻结组合，应用指令唯一来源为 `prompts/buildx-customer-chat.zh-CN.md`。`lib/customer-chat.mjs` 只组合纯核心与账号适配器，不导入旧model/source研究配置。

`customer-server.mjs` 是未来已配置环境中的显式启动入口：

```powershell
# 示例目录及其workspace须预先存在；本示例不创建、配置或启动任何环境。
$env:BUILDX_DATA_ROOT = 'C:\BuildXData'
npm run start:customer-chat
```

它固定customer模式，读取 `BUILDX_SUPABASE_URL`、`BUILDX_SUPABASE_PUBLISHABLE_KEY`与显式`BUILDX_DATA_ROOT`；若显式提供 `BUILDX_MODE`，只能是 `customer`。不配置、部分或空配置、secret/service_role、research降级都拒绝。当前没有专用项目，因此本轮没有运行这个有配置的常驻命令，也不需要重复提供密码或密钥。

候选默认只绑定 `127.0.0.1:41875`；必须显式设置`BUILDX_DATA_ROOT`并事先准备数据根和workspace，日志写入其`runtime/customer-chat/run-UUID`。原日志owner在监听前核验目录/文件身份并严格新建run。独立`server.json`覆盖写已移除，启动事实通过同一日志owner和stdout返回；旧记录不删除。缺Auth、缺/重叠/链接数据目录、缺workspace或坏CODEX_HOME等未准入时只输出固定stderr，不mkdir/listen/native/fetch、不回退资源目录写日志；通过后listen失败才由原owner记录并清理。先成功绑定才连接Codex，不停止或替换已有服务。现有41873模型、41874源码入口和Revit addin均保留。任何真实启用仍须核对进程归属/空闲及具体配置；旧runtime文件不能证明在线。

## 初版组合验证边界（历史）

隔离副本仅允许声明的12个生产模块、专用prompt和6项前端资源；真实解析器记录实际import。使用生产Codex核心＋fake-native、生产认证适配器＋fake-fetch，完成登录、两步确认、一轮HTTP/SSE回复及准确关闭。另一个14模块副本运行真实入口的缺配置分支，确认退出1、没有runtime目录、没有启动Codex子进程。

上述初版均为测试自有进程/端口与模拟native/Auth；历史真实Codex一轮的证据另见顶部。真实云账号、Revit及浏览器验收仍待。前端3项脚本因新增客户分支而经人工核对刷新白名单；旧前端组件保留，未覆盖。独立24文件组件现已构建并回查，详见[CUSTOMER-COMPONENT.zh-CN.md](CUSTOMER-COMPONENT.zh-CN.md)。后续仍需许可/公告、真实外部前置与账号、长时网络及WebView、安装升级/回退和产品权限验收。完整研究宿主不随此候选分发。

证据：[20261025-customer-chat](../workbench/validation/20261025-customer-chat/README.zh-CN.md)。

## 早期产物断线恢复检查（2026-10-25，后续已修复）

既有候选从实际产物加载12个生产模块，以fake-native/Auth验证轮次中EOF、失效、准确旧close后显式重连、重新确认、新thread与不重放；新增case1/1及必要共享harness回归1/1通过，产物完整树不变。观察到旧SSE没有unknown终态、退役快照为空，结果待核对提示和浏览器恢复尚待修复/验收。静态UI的旧busy可能在新快照前阻塞重连，尚未做组合UI复现。没有真实账号/CLI/云、模型、GUI或常驻启用；不是发布验收。详见[证据](../workbench/validation/20261025-customer-recovery/README.zh-CN.md)。

## 断线提示修复与新候选（2026-10-25）

此前提示缺口已在生产单一owner修复；固定无正文notice按BuildX登录身份投影，临时核验隐藏但保留，退出/到期/换号清除。页面失连先暂停发送，有界核对状态并正确释放失效GET，旧回执不覆盖新状态；不自动重发。最终源码/HTTP/VM受影响116项通过，新产物组合1项通过，均非真实云/浏览器验收。新候选为`artifacts/customer-chat/20261025-recovery-notice-candidate`，24文件共223121B，旧候选未覆盖、无安装启用发布，`releaseReady:false`。原真实环境及产品许可/安装/用户验收门槛仍待。[当时证据](../workbench/validation/20261025-customer-interruption/README.zh-CN.md)。

## 目录角色与工厂cwd（2026-10-25）

已完成纯role Result和程序式工厂显式cwd接线，实际C默认工厂＋fake native证明两个cwd一致且Panel/prompt资源源不变；5/24/2项分范围通过，另同2项默认fixture变体和缺Auth entry回查，不累计为更多业务。该历史轮次入口尚未接dataRoot；本次已接显式外部数据根和独立run，但不证明immutable安装、权限或客户环境已验收。新C为`artifacts/customer-chat/20261025-layout-contract-candidate`（24文件228017B），无服务启用或真实账号/CLI/Revit/UI验收。[契约](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)、[证据](../workbench/validation/20261025-customer-layout/README.zh-CN.md)。

## 前轮外部数据根验收（2026-10-25）

此前已把客户入口接到显式外部`BUILDX_DATA_ROOT`：数据根与workspace须预存；资源/数据/workspace复用原目录事实解释，原数据根快照作为仅拒绝性约束交给原audit。日志在外部`runtime/customer-chat/run-UUID`严格新建，Codex的native及thread cwd使用外部workspace，public/prompt仍来自组件。实际14模块隔离入口＋受控Auth/default Core fake-native，以随机loopback HTTP/SSE跑通登录、明确确认、一条模拟回复和准确关闭；旧server.json身份/字节及组件树保持。最终producer32＋必要兼容6＋实跑中间candidate入口5共43项，开发侧plan/CLI8项，共51项独特检查通过、0跳过；早中间版本不累计。final仅收尾独立README后构建/verify，与已实跑candidate的21项运行输入（14模块＋prompt＋6前端）逐字节等价，未为文档重跑5场景。该轮候选`artifacts/customer-chat/20261025-data-root-final`共24文件249763B，BUILD SHA为`7b9c5f6fda10e9ebd924f58fa4fd7fec8934b6ef4907ff44c016c911417c5866`，`releaseReady:false`；八个旧候选（含本轮中间candidate）保留。[本轮证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。

前轮已修日志身份/关闭边界，并以受控BuildX A/B认证上游和真实本机Codex完成一轮对话；59个根测试文件774通过、1项可选Revit编译跳过、0失败属于前轮，本轮未重跑或新增AI。真实Supabase/WebView仍待；外部dataRoot和独立run已在本轮入口接线，实际安装/激活与历史信任仍未验收。原版Argus不动、族功能后置。[前轮证据](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)。
