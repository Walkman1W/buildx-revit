# BuildX 账号适配器：Supabase Free 验证准备

日期：2026-10-25。范围：生产账号适配模块和离线验证；尚无 BuildX 专用云项目的真实注册、邮件送达或客户验收结果。未创建/修改云项目，未读取既有登录凭据，无新增 npm 依赖。

## 登录响应断开后的会话交付（2026-10-25）

生产HTTP配合受控Auth已复现：POST上传完成后客户端断开，迟到登录曾保留1个本机会话，匿名状态仍未登录，而下一次明确登录被409拒绝。现由原PanelAccounts消费可信ServerResponse的close/finish：断开后的迟到结果只release本次本地session；已发行但未finish时断开只清本次登录，正常finish保留登录，旧响应不能清除新账号。不自动重试、远端注销或改变客户Codex登录。

本轮HTTP及必要账号UI/确认兼容57项、独立owner7项，共64项独特检查通过、0跳过；实际产物的同1场景输入变体另通过，不重复计数。新候选`artifacts/customer-chat/20261025-account-delivery-candidate`为24文件251750B，BUILD SHA `d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，`releaseReady:false`。仅更新3项raw，实际12个应用模块从产物加载，原有候选保留。[证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。

本地finish仅表示交给底层发送，不证明浏览器收到Cookie。注册的云端创建或邮件可能已发生，本机release不能撤销这些副作用；超时后先核对状态或邮件，再明确操作。没有真实Supabase/Codex/AI/云/GUI或常驻服务控制，未重跑旧真实AI或全根774/1；外部dataRoot已接入口，真实云及客户端验收仍待，族功能继续后置、原版Argus不动。

## 配置与凭据边界

`lib/buildx-auth.mjs` 导出 `createBuildxAuth({url,publishableKey})`。配置由本机服务的可信启动配置提供，不能从 HTTP 请求接收或覆盖。

实际启动入口 `server.mjs` 通过 `lib/buildx-runtime-config.mjs` 仅消费以下三个环境变量：

| 变量 | 用途与默认行为 |
| --- | --- |
| `BUILDX_MODE` | 仅接受 `research` 或 `customer`；未设置时为 `research` |
| `BUILDX_SUPABASE_URL` | 用户确认的 BuildX 专用 Supabase 项目 HTTPS 根地址 |
| `BUILDX_SUPABASE_PUBLISHABLE_KEY` | 同一专用项目的 publishable key，与 URL 成对配置 |

两项 Supabase 配置只要出现任意一项，就必须完整、非空且格式有效，并启用账号门禁；不能把错误或空配置静默降级为无认证模式。`customer` 缺少认证配置时拒绝启动。`research` 且完全没有认证配置才保留原本机研究入口；配置认证后即使 mode 仍为 research，也必须登录。

这些值由启动进程的环境提供，不写入示例真实 key、token、对话记录或模型上下文；本说明也不自动修改当前用户环境或启动服务。独立源码开发服务继续与客户身份入口隔离。

**`customer` 只表示启用了认证门禁，不能解释为研究 DLL 已可对外分发、产品许可已实现或已通过客户验收。** 原 Argus 资源/研究入口的发布依赖隔离仍需单独完成。

- `url` 仅接受 `https://<20位小写项目ref>.supabase.co` 根地址，不接受自定义域、其他主机、HTTP、路径、账号密码、查询或端口覆盖。本轮不支持自托管域名。
- `publishableKey` 仅接受 `sb_publishable_` 类型；不接受 secret、service_role 或旧版 anon JWT。公开 key 不是用户登录证明。
- 生产实现只调用固定 `/auth/v1` 路径；禁止 HTTP redirect，防止凭据随重定向发往其他地址。
- 密码只用于本次认证请求；Supabase access/refresh token 只在本地 Node 进程内存中。适配器仅返回随机本地 sessionId、公开用户 DTO、毫秒时间戳；不把 token、密码或 provider 原始错误写入文件、日志、工具回执或模型上下文。
- 本地服务应把 sessionId 放在 HttpOnly、SameSite=Strict 的本机 cookie 中，任何业务授权均需先实时核验；不能让浏览器自报用户 ID 或角色。
- 进程退出会丢失本地账号会话，需要重新登录。本轮没有持久化 token，也不影响客户独立的 Codex 登录。

## 公共契约

所有异步认证方法返回 `Result`：成功为 `{ok:true,value:...}`，失败为 `{ok:false,error:{code,message}}`。配置无效时 factory 抛出固定 `AUTH_CONFIG_INVALID`，不回显配置。

| 方法 | 行为 |
| --- | --- |
| `signUp(email,password)` | POST `/signup`；需邮件确认时只返回 `state:confirmation_required`，不声称用户已注册或已验证登录 |
| `signIn(email,password)` | POST `/token?grant_type=password`，再 GET `/user` 核验，成功返回 `state:signed_in,sessionId,user,expiresAt,verifiedAt` |
| `verifySession(sessionId)` | 对内部持有的 access token 实时 GET `/user`；身份漂移、401/403或过期删除本地会话，网络故障拒绝本次访问并保留待核验状态 |
| `refresh(sessionId)` | POST `/token?grant_type=refresh_token`，再次 GET `/user`；只允许同一用户，失败不保留旧授权，不自动重试未知刷新结果 |
| `signOut(sessionId)` | 先撤销本地会话，再 POST `/logout?scope=local`；失败仍本地退出，明确报告远端撤销 unknown，不注销其他设备 |
| `release(sessionId)` | 仅删除本地会话，不声称远端已注销；清历史时由调用者按实际归属使用 |
| `close()` | 禁止新调用、清本地 token 并 abort 网络；底层请求未 settle 则 `closed:false,pendingRequests>0`，保留 owner供回查 |

`verify(accessToken)` 是模块内部组合入口，不应暴露成通用 HTTP token 核验代理。`diagnostics()` 只返回数量和关闭标记，无账号或凭据。

`user` 只包含固定用户 ID 与邮箱，不包含 user_metadata、app_metadata、provider角色或产品套餐。成功认证不等于 BuildX 付费权限；产品许可、组织、设备上限必须由后续可信业务数据及访问规则决定，不能用用户可编辑 metadata 授权。

## 面板续期（2026-10-25本地实现）

“刷新状态”继续使用 GET 核验，不隐式续期。新增“续期登录”显式提交 `POST /api/account/refresh-session`，JSON只含本机 `client`，cookie/CSRF由既有本机边界核对；不接收密码、token或用户覆盖。当前登录尚未到期、没有对话/上下文任务且无其他账号操作时可调用。

成功要求同一 sessionId 和用户，保留 cookie、对话和线程；前端仅通知主面板重核状态。核验进行中返回409，续期进行中的状态请求共享同一结论。到期、关闭、身份漂移以及失败/未知结果不能恢复旧身份；没有自动重试或后台定时续期，到期后须重新登录。

客户端请求超时仅表示结果未核对，应先“刷新状态”，不能重复提交续期；若服务端明确续期失败并清除本机会话，则重新登录。token始终仅在服务端内存。此入口已经离线HTTP/VM验证，专用项目云端与WebView验收仍未完成，详见 `workbench/validation/20261025-account-renewal/README.zh-CN.md`。

## 限制与真实验收

本机最多24个内部会话、4个在途请求；回执128KiB、单token16KiB、默认超时8秒。超时后若底层调用未 settle，其请求仍占容量，不能静默释放预算。没有自动重试注册、密码登录、刷新或注销。

模块输入密码登录至少1字符、注册至少6字符，最多1024 UTF-8字节，且不trim密码；实际Supabase项目可要求更强密码。邮箱格式与长度先本地检查，云端仍作最终判定。根入口和界面应与这些契约一致。

真实接入仍需：

1. 用户确认的 BuildX 专用 Supabase 项目 URL 与 publishable key；不得误接入其他项目。
2. 核对免费额度、邮件确认与 SMTP 配置。默认邮件发送限制不等于可向全部客户稳定发信；测试成功与邮件送达分别留证。
3. 完成两用户登录/退出/过期/撤销与跨用户历史隔离验证，再完成真实本机Codex绑定流程。离线 Fake HTTP 不是云端验收。
4. 本轮只使用 Supabase Auth，没有新建业务表、SQL迁移或 RLS。新增用户资料/设备/授权表时，先审查现有schema，明确GRANT与RLS，禁止匿名访问或用户自行写入付费权限，之后再单独验收查询与权限。

## 官方来源及本轮核查

- [Supabase changelog](https://supabase.com/changelog.md)：已读取当期索引；相关 breaking 项为[HTTP API停用旧CBC TLS配置](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)，最早2026-11-10实施。当前 Node 内置TLS支持现代加密套件；本轮不修改TLS验证或降低版本。
- [Supabase Auth 官方源码说明](https://github.com/supabase/auth)：核对 `/signup`、密码与refresh token grant、GET `/user`。
- [实时 getUser 核验](https://supabase.com/docs/reference/javascript/auth-getuser)：不信任客户端反序列化的 session/user 作为服务端认证证明。
- [密码认证](https://supabase.com/docs/guides/auth/passwords)：托管项目默认需邮件确认。
- [注销 scope](https://supabase.com/docs/guides/auth/signout)：显式使用 `local`；已撤销 session 的 JWT仍可能到期前有效，实时用户核验不能冒充严格 session撤销或付费许可验证。

本轮没有执行 Supabase SQL、云函数、注册或注销。生产模块配合 Fake fetch 的边界测试结果在 `workbench/validation/20261025-commercial-hardening/buildx-auth-tests.tap`。
