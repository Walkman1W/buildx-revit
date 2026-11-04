# BuildX 邀请激活与许可：本地实现和迁移草案

本轮仅完成本地代码、数据库迁移草案与隔离 PostgreSQL 验证。没有连接、读取或修改远端项目，也没有执行真实 Supabase/PostgREST、邮件或客户环境验收。正式迁移前必须核对目标项目既有对象、暴露 schema、权限、回退与数据保留，再生成 Supabase CLI 版本化迁移并单独授权应用。`sql/buildx-license-migration-draft.sql` 是可审查 SQL 源，不能冒充已应用的版本化迁移。本机未找到 Supabase CLI，尝试临时运行 CLI 未完成；没有修改远端配置。

## 行为

邮箱/密码登录、产品许可和 Codex 连接是不同状态。邀请码只能激活一次账号，绑定账号而非设备；试用或有效许可从**数据库收到并提交兑换的时间**开始，期限由受限管理侧创建邀请码时指定，不设默认天数或价格。账号第一次激活后重复兑换不会增加次数或延长期限。到期和停用实时计算；禁用邀请码只阻止后续兑换，禁用既有许可需要由受限管理侧更新许可。续费、更换邀请码、退款、支付和多设备策略未实现。

管理者通过受控数据库管理渠道执行 `buildx_private.create_invite(kind,duration_seconds,expires_at,max_uses)`，参数分别为 `trial` 或 `active`、秒数、过期时间和总次数。返回的一次性随机码需通过已授权渠道安全交付；数据库只保存散列。匿名和普通认证用户不能创建、读取邀请码或直接写入许可。兑换事务对账号和邀请码分别加锁，处理同一账号多码并发和不同账号争抢最后一次机会；失效码统一返回当前许可状态，避免泄露代码是否存在。

本地 `POST /api/account/license-status` 接受 `{client}`，`POST /api/account/redeem` 接受 `{client,code}`，兑换码为 64 位小写十六进制；均使用现有 HttpOnly cookie 和 CSRF 边界。成功返回 `{ok:true,license:{status,startsAt,endsAt}}`，状态为 `unactivated`、`trial`、`active`、`expired` 或 `disabled`，时间为 ISO 时间字符串或 null。网络中断或超时后兑换结果可能已提交，不自动重试：返回 `outcome:unknown`，先以原账号刷新许可状态。账号变化时迟到结果不会作为当前用户许可应用。每次服务端许可核验访问实时后端，不缓存离线授权；网络不可达时需要许可的新操作拒绝，保留本地资料及历史读取。严格的会话即时撤销仍取决于 Supabase session 和 JWT 的实际部署策略。

`BUILDX_REQUIRE_LICENSE` 只接受 `true` 或 `false`。研究模式默认关闭，可显式启用；`BUILDX_MODE=customer` 默认启用并拒绝显式关闭，启用时必须配置 BuildX 专用 Supabase URL 和 publishable key，配置错误拒绝启动。研究模式关闭不表示已有有效许可。模型服务在启用许可时对新对话、补充指令、模型命令、上下文采集、资料绑定/刷新和快照生成等操作做后端核验；历史读取、停止和回执核对仍可用。许可变化不会证明在途操作已取消。独立聊天组件有自己的配置入口，不能据此声称其已启用同一门禁。在生产启用前应先部署、验证迁移及许可证管理流程；本轮没有将开关写入机器环境或重启服务。

## 验证范围

隔离 PostgreSQL 17 用本地假 Auth schema 验证 SQL 可执行、普通用户不能读邀请码或创建代码、匿名用户拒绝、有限次数并发、重复兑换、停用和到期。Node 测试覆盖固定 RPC、仅内存 token、输入、超时不自动重试和账号边界。它们不替代真实 Supabase Data API、JWT、RLS 策略、权限 advisor、客户 WebView、跨设备和网络异常验收；正式环境启用前必须在隔离 Supabase 项目补测上述流程，确认用户删除或远端撤销对现有 JWT 的影响。

参考：[Supabase 行级安全](https://supabase.com/docs/guides/database/postgres/row-level-security)、[数据库函数](https://supabase.com/docs/guides/database/functions)、[API 权限](https://supabase.com/docs/guides/api/securing-your-api)。
