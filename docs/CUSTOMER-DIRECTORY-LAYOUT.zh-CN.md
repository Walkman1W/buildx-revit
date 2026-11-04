# 客户聊天的目录角色与工厂工作目录

## 当前入口接线（2026-10-25）

`customer-server.mjs`现已消费显式`BUILDX_DATA_ROOT`，复用纯`customerChatLayout`的词法角色，以及原audit模块的只读`inspectExistingPanelDirectory`来解释完整现存目录链。数据根及其workspace须由操作者事先准备；入口不替用户选路径、创建workspace、搬迁或删除旧数据。资源根与数据根的实际身份链不能相互包含，workspace须属于数据根；已知链接、别名、缺失或非普通目录拒绝。

| 角色 | 当前入口使用 | 验收边界 |
| --- | --- | --- |
| resourceRoot | 组件目录ROOT；Panel读取public，prompt按profile模块URL读取 | 不作为日志或Codex工作目录 |
| dataRoot | 显式BUILDX_DATA_ROOT，必须已存在 | 只观察当前普通目录链；不证明整个root/其它进程归本次调用所有 |
| runtime | dataRoot/runtime/customer-chat/run-UUID | 原audit以requireNewDirectory:true严格新建末级run，既有或创建未知不换名重试 |
| codexCwd | dataRoot/workspace，必须已存在 | 默认Core的native spawn和thread/start均使用该外部workspace |

在具备专用Auth、已有运行时和操作者明确目录授权的环境中，启动示意为：

```powershell
# 示例目录及其workspace须预先存在；此处不创建或配置任何目录。
$env:BUILDX_DATA_ROOT = 'C:\BuildXData'
node customer-server.mjs
```

示意不是实际启用记录。入口不另建或覆盖server.json、不读取旧内容推断进程存活；旧记录保留。启动地址和本次runtimeDirectory由stdout JSON返回。常驻服务归属仍需独立的新鲜证明。

## 原快照与原日志owner

应用先取得资源/数据/workspace三条目录事实。原数据根快照作为`expectedAncestor`传给原audit；该约束只收窄、不能选写路径或授予写权。writer独立捕获已经选定的run路径，核对原祖先path/identity与当前前缀；快照A被普通目录B替换时，在目标日志lstat或mkdir之前拒绝，不接管B。应用构造前，以及监听完成后、连接Codex前，入口还会复核原三条身份链。

`inspectExistingPanelDirectory`只返回冻结的path/requested/observedAt/chain元数据，不持有资源、不是租约或秘密令牌。`expectedAncestor`消费严格own-data事实，继承属性/访问器或形状未知不会变成可信约束。不接受浏览器DTO来决定写路径，没有第二套日志、配置或清理owner。

内部`requireNewDirectory`默认false，保持旧model/source与程序式调用兼容；本客户入口明确使用true。捕获时末级已存在以`audit_directory_exists`拒绝，且不检查其中的目标日志；原本缺失路径发生EEXIST或创建结果未知时沿原sticky失败，不换名、不重试、不接管。自己已明确创建后允许同owner重复ready。原FileHandle保留、cleanupId和显式只重试关闭的规则不变。

缺Auth、缺dataRoot、缺workspace、词法/实际重叠、链接或无效CODEX_HOME等未准入时，不mkdir、监听、启动native或发送认证请求；失败只输出固定stderr，不回退组件目录落日志。构造通过后的监听失败仍可由原日志owner记录并清理；初始化可能留下本次新目录，关闭资源不等于自动删除数据或全局回滚。

## 纯契约与适用性限制

`customerChatLayout`本身仍只是Result：成功value冻结并保留requested，`entryIntegrated:false`、`writeAuthorized:false`、`filesystemInspectionPerformed:false`说明这个纯函数没有执行接线或授写权，不再代表customer-server全局未接入。入口另行消费其角色并做上述物理观察。拒相对/根相对、UNC/device、ADS、点分段、保留名与末尾分隔符等不支持的拼写；词法解释不能替代物理链复核。

工厂省略codexCwd时仍保留原root默认；本客户入口显式传外部workspace。CODEX_HOME在构造时只读一次，要求完整本机绝对目录，不读登录缓存或改全局环境。Python helper与native相对解释风险曾为源码推断，没有声称实际CLI切错账号。省略home时`existing_core_default_unobserved`仍不是已观察的登录位置。

各次观察与后续I/O非原子，同权限进程仍可竞态；不承诺OS沙盒、长期workspace适用性、整个dataRoot或外部进程所有权。日志移出组件不证明实际安装、激活、权限、签名信任或历史回退已验收。安装计划因此将旧“runtime仍耦合”阻塞改为实际数据目录/启动用户`not_checked`，仍无Apply。

## 本轮与历史证据

实际14模块隔离入口＋生产Auth的受控上游/default Core fake-native，使用自有随机loopback HTTP/SSE完成登录→明确确认→一条模拟消息→completed→stop/准确close。native/thread cwd在外部workspace，新日志仅在外部run；组件完整树和旧父server.json的字节/身份保持。实跑data-root-candidate的5项入口场景包括A→B快照替换拒绝；最终producer32＋必要兼容6＋产物入口5共43项，开发侧plan/CLI8项，总51项独特检查通过，0跳过。中间来源运行与早期失败不累计。

最新候选`artifacts/customer-chat/20261025-data-root-final`为24文件249763B，BUILD SHA`7b9c5f6fda10e9ebd924f58fa4fd7fec8934b6ef4907ff44c016c911417c5866`，releaseReady=false；八个旧候选（含本轮中间candidate）保留。final仅改独立README后构建/verify，其21项运行输入与实跑candidate逐字节等价，不为文档收尾重跑5场景。本轮真实Auth/Codex/AI/云/Revit/GUI、常驻或系统探测均未执行。全根774/1及真实Codex一轮是历史，不为本次日志接线重跑。真实Supabase/WebView、安装/历史信任和产品授权仍待。[本轮证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。

历史C只完成纯角色/工厂cwd，后续目录原型揭示排队写问题，随后原audit身份/清理、入口失败日志和内部严格新目录契约逐步修复；这些阶段的“entry未接入/ROOT写日志”仅是当时状态，不用于描述当前入口。保留[纯目录契约证据](../workbench/validation/20261025-customer-layout/README.zh-CN.md)、[目录原型](../workbench/validation/20261025-customer-directory-ownership/README.zh-CN.md)、[原日志修复与真实Codex](../workbench/validation/20261025-account-dialogue-stability/README.zh-CN.md)、[入口准入日志](../workbench/validation/20261025-customer-entry-admission/README.zh-CN.md)、[内部新目录契约](../workbench/validation/20261025-audit-exclusive-run/README.zh-CN.md)。
