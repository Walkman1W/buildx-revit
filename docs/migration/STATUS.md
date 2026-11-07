# BuildX 实施状态

更新日期：2026 年 11 月 7 日。

主要实施聊天：`01a1a752-4305-77f1-8b04-e8a1b338c1d0`，项目目录 `D:\code\BuildX`。

## 当前阶段

已从 `D:\code\REA\local-codex-panel` 白名单提取 507 份源码和必要测试，共 5,602,302 字节。复制前后来源摘要一致，目标逐文件摘要核对通过；清单见 `source-baseline.json`。源目录和已运行的插件保持原状。每小时检查继续本项目聊天，读取本状态和任务台账后推进。

六项原生查询已完成源码闭环及本轮授权的隔离验证：自有输入/输出契约、C# 生产者、宿主 0.8.1 和具名能力、统一原子队列、sourceDocument、取消和原回执核对全部接通。旧宿主在入队前拒绝，六项不回落 AEC/Python provider；本工程内专属 adapter、relay 和刷新器已退出。详见 `NATIVE-SIX-VERIFICATION.zh-CN.md` 和 `native-six-verification.json`。

`npm run test:native-queries` 最终合并运行 **181/181 通过、0 跳过**；真实 MCP 客户端逐一调用六项并验证完整 structuredContent/outputSchema。实际 C# 服务及参数方法在受控 API peers 中测试，再跨 Node 临时队列校验。宿主检查 **80/80**；最终源码真实 Revit 2024 API 引用编译成功。上述结果均不等于已加载插件或真实模型验收。

## 已核对与待验

- AEC 高频批次：原 31 个无入口名称中，**22 个已形成具名候选、9 个仍无具名入口**；另有原 9 个高权限工具暂缓。候选范围不等于完整 AEC 行为或真实 Revit 验收。工作区源码目录现为 103 项，其中 44 项只读查询。详见 [范围与验证](AEC-HIGH-FREQUENCY-BATCH-20261107.zh-CN.md) 和 [103 项台账](AEC-103-CROSSWALK.zh-CN.md)。
- 真实 Codex app-server 在隔离文档及合成权限/回执夹具内分三轮覆盖 21 个新入口，每项先获取精确契约，再提交一次合成操作；事务使用 rollback，选择操作使用夹具模拟逐次确认，无自动重试。真实 Edge 用独立 HTTP 夹具验证屋顶及 UniqueId 选择的 @ 搜索、表单和模拟提交（选择确认前零提交）；均未连接 Revit。
- 增量 UI 与目录检查 88/88，受控 C# 查询/写入 peer 152 项、选择 peer 14 项、放窗 peer 9 项通过；Revit 2024 API 和 WebView2 SDK 引用的隔离编译通过，未安装或加载。权限 owner 23/23；旧测试的“原回执不可用必须抛错”已改为验证 nonterminal/unconfirmed 且不能解除阻塞。参数生产路径合组 217/217；跨目录、权限和回执合组原为 244/245，修正唯一性测试样本后契约专项 8/8。快照事件桥和删除基础组件的隔离验证见本批验证文档。
- 快照增量已形成有界的只读候选：原子请求绑定宿主、文档、基线和版本；身份或事件连续性失效时拒绝。真实 Revit 事件生命周期及多文档行为待验。删除、按筛选批量改参数与文件导出仍需可信逐次审批、完整影响和文件副作用 owner，不因已有回滚或路径检查登记为完成。

- AEC 候选新增竖直剖面视图，未接入项由 32 减至 31。C# 受控夹具 55/55、宿主 105/105、Node 串行 125/125，含 Code Mode、完整目录 `@` 和命令栏逐次确认。36 份 C# 使用 Revit 2024 API 引用编译通过。真实 Revit 裁剪坐标、事务和 WebView 待验。[剖面验收](AEC-SECTION-WRITE.zh-CN.md)

- AEC 候选新增墙上放窗，并合入文字注释。未接入能力余 32 项。放窗支持精确类型、墙、标高与内部坐标，默认回滚；已确认创建的安全整数 ID 可作为视觉检查来源。真实 Codex 在合成会话按需读取契约后调用一次模拟预览。Revit 2024 API 引用编译通过；真实 Revit 窗族、事务和 WebView 待验。[放窗验收](AEC-WINDOW-WRITE.zh-CN.md)

- AEC 候选新增文字注释，原 50 项未接入能力还剩 33 项。生产 C# 受控夹具 45/45、宿主 105/105、Node 串行 120/120，含 Code Mode、全目录 `@` 和命令栏多行确认。36 份 C# 使用 Revit 2024 API 引用编译通过。真实 Revit 定位、多行呈现、事务和 WebView 待验。[文字注释验收](AEC-TEXT-NOTE-WRITE.zh-CN.md)

- AEC 候选新增视图样板应用，原 50 项未接入能力还剩 34 项。生产 C# 受控夹具 38/38、宿主 105/105、Node 串行 116/116，36 份 C# 使用 Revit 2024 API 引用编译通过。Code Mode、全目录 `@` 和命令栏确认通过受控验证，真实 Revit 样板控制、事务和 WebView 待验。[视图样板验收](AEC-VIEW-TEMPLATE-WRITE.zh-CN.md)
- AEC 候选新增图纸视口放置，原 50 项未接入能力还剩 35 项。生产 C# 受控夹具 30/30、宿主 105/105、Node 串行 112/112，36 份 C# 使用 Revit 2024 API 引用编译通过。Code Mode、全目录 `@` 和命令栏确认通过受控验证，真实 Revit 纸面定位、事务和 WebView 待验。[视口验收](AEC-VIEWPORT-WRITE.zh-CN.md)
- AEC 候选新增普通与占位图纸创建，原 50 项未接入能力还剩 36 项。生产 C# 受控夹具 22/22、宿主 105/105、Node 串行 108/108，36 份 C# 使用 Revit 2024 API 引用编译通过。Code Mode、全目录 `@` 和命令栏确认通过受控验证，真实 Revit 图框创建、事务与 WebView 待验。[图纸验收](AEC-SHEET-WRITE.zh-CN.md)
- AEC 候选新增直风管，原 50 项未接入能力还剩 37 项。生产 C# 受控夹具 14/14、宿主 105/105、Node 串行 104/104，36 份 C# 使用 Revit 2024 API 引用编译通过。Code Mode、完整目录 `@` 和命令栏确认已通过受控验证，真实 Revit 事务、默认截面和 WebView 待验。[风管验收](AEC-DUCT-WRITE.zh-CN.md)
- AEC 候选新增直线电气导管，原 50 项未接入能力还剩 38 项。生产方法受控夹具 10/10、宿主 105/105、Node 串行 100/100，36 份 C# 的 Revit 2024 API 引用编译通过。Code Mode、`@` 和命令栏受控路径已验，真实 Revit 事务和 WebView 待验。[导管验收](AEC-CONDUIT-WRITE.zh-CN.md)
- AEC 候选新增楼层平面图与等轴测三维视图，原 50 项未接入能力还剩 39 项。C# 生产方法夹具 5/5、受控宿主 105/105、Node 96/96，36 份 C# 使用 Revit 2024 API 引用编译通过。工作区 `@` 和命令栏受控测试通过。真实 Revit 事务及内嵌 WebView 待验。[视图验收](AEC-VIEW-WRITES.zh-CN.md)
- AEC 候选本批新增材料用量、碰撞候选、标高、直线轴网、固定与取消固定。候选目录 71 项，原 50 项未接入能力还剩 41 项。聊天 `@` 和命令栏共用字母搜索，真实 Edge 在独立 HTTP 端口使用模拟回执验证。受控宿主 105/105、只读 C# 800/800、36 份 C# 的 Revit 2024 API 引用编译通过。真实 Revit 操作和内嵌 WebView 待验。[本批验收](AEC-WORKSPACE-WAVE.zh-CN.md)

- AEC 模型组成员已接入候选。以模型组实例 ID 原序分页，默认只返回成员 ID，保留原子文档核验和原回执。原 50 项未接入能力还剩 47 项。受控宿主 103/103、生产者 700/700、Node 合组 101/101，36 份 C# 用 Revit 2024 API 引用编译成功。Code Mode、`@ggm` 与命令栏点击已验证受控路径，真实 Revit WebView 待验。[模型组验收](AEC-GROUP-MEMBERS.zh-CN.md)
- 私有仓库：`https://github.com/Walkman1W/buildx-revit`，默认分支 main 保留规划基线；审查后的业务源码和本轮实现保存在 `codex/native-foundation`。没有合并受保护分支或正式发布。
- 完整 AEC Revit 静态台账已完成：103 项工具、103 个映射，P0 六项；记录业务分组、schema、来源行号、语义差异和未核实项，不表示 103 项已实现。
- 锁定安装 19 个 Node 依赖、纯解析 owner 遗漏修复、第三方原始许可证公告和有限敏感扫描完成。历史来源记录仅追加更正，未改写 507 文件复制证据。见 `BASELINE-AUDIT.zh-CN.md`。
- 每小时自检任务 `buildx` 已启用，目标为本项目聊天，配置读回确认；已收到 2026-11-05 02:12（北京时间）的实际 heartbeat 并推进本轮私有编译器切片。
- 已执行 `node --check server.mjs`、`node --check source-panel.mjs`、`node --check public/app.js`，三项语法检查通过；这不证明运行依赖完整或真实 Revit 可用。
- 原提取宿主为 0.8.0；本工程新源码为 0.8.8。查询族及最低版本保持；具名单项写仍独立要求 0.8.5/v1。旧批量参数写要求 0.8.7、`parameterWriteTargetPolicyVersion:1` 和 `parameterWriteTargetPolicy:instance_only`，整批目标预检和逐阶段重新获取均限制实例归属。新类型写独立要求 0.8.8/v1/具名操作及可信逐次确认。新 DLL 只在隔离目录编译，未替换已安装插件。
- 独立运行布局源码已完成：schema 2 程序/私有执行资源/数据/队列分离，Node、MCP、命令库与 C# 使用同一配置；schema 1 保留原数据位置。旧开发根、个人 Node 例外和 Python 私有缓存兜底已退出生产启动路径。见 `RUNTIME-LAYOUT.zh-CN.md`。
- 布局修改后六查询 **181/181** 保持通过，布局/安装/归属相关组 **105/105**，受控宿主 **80/80**；227 文件完整源码快照以官方 NuGet WebView2 SDK 独立通过 Revit 2024 API 编译。首次六查询记录的摘要属于 93b324c 历史切片，该历史候选构建和包摘要见 `internal-candidate-verification.json`。
- 历史内部候选已完成：运行包 ZIP 1,086,373 字节（123 产品文件及清单），源码 ZIP 983,301 字节（227 源文件及两份清单），全部条目回读与解压验证通过。无 node_modules 的解压运行包能启动生产 MCP 目录并保留六项契约，未创建队列。详见 `INTERNAL-CANDIDATE-20261105.zh-CN.md`，旧产物保留。
- 去掉 AEC 后，资料解析和 Codex TOML 配置读取仍依赖 Python。C# 用户命令现有独立官方编译器来源、固定 16 项载荷和 17 文件私有布局；7 项生产 ScriptRunner 离线编译已通过真实 Revit 2024 API 引用，未加载生成 DLL。新增含编译器的候选与记录见 `SCRIPT-COMPILER-VERIFICATION.zh-CN.md`；原候选和摘要保留为历史证据。
- P1 `revit_get_type_parameters` 已接通自有 C#、具名原子契约、共享参数事实和双侧能力门禁，实例解析真实类型，直接类型读取自身；没有类型时明确失败，不回落实例参数。新增验证 **24/24**、六查询及目录回归 **182/182**、布局 **105/105**、宿主 **80/80**，均无跳过；242 文件源码快照、33 项 C# 输入真实 Revit 2024 API 引用编译成功。新候选为 `0.8.2-internal-parameters`，143 产品文件，仍 `releaseReady:false`。详见 `NATIVE-PARAMETER-VERIFICATION.zh-CN.md`。
- 已用实际生产 setter/事务组代码在受控 API peers 复现三种存储类型“Set 返回 true、值未满足却成功”的问题并修复。0.8.3 强制设置后、Regenerate 后及内层 Commit 后按 ID 回读；Node 对参数成功回执逐行核对原请求，不匹配保留 unknown、不重发。写入相关合组 **117/117**、六查询/目录 **182/182**、类型查询 **24/24**、布局 **105/105**、宿主 **80/80**，无跳过；249 文件源码快照和 33 项 C# 输入 API 编译通过。该切片内部候选为 `0.8.3-internal-parameter-write`，144 产品文件，仍阻止安装。详见 `PARAMETER-WRITE-VERIFICATION.zh-CN.md`。
- P1 `revit_get_parameter_value` 已实现显式 ID/完整名称二选一、完整有界扫描与歧义拒绝，仅读取所选元素参数，不暗中改读类型。精确 ID 使用普通文本控件，大 ID 保留字符串，名称不 trim；前端和执行器都校验选择器互斥。新单参数/字段/界面合组 **79/79**，其余 182/24/117/105/80 组回归均通过。另实际复现并修复旧公共 ID 解析在 boxed Double 安全上界少 1 的问题。最新 `0.8.4-internal-single-parameter` 候选：259 源文件、33 C# API 引用编译、144 产品文件，仍 `releaseReady:false`。见 `SINGLE-PARAMETER-VERIFICATION.zh-CN.md`。
- P1 `revit_set_parameter_value` 已完成实例专用具名写入：单项稳定 ID、原始前态守卫、实例/参数归属和三阶段回读，复用现有审批、事务及原回执 owner；旧宿主/raw MCP 零入队。新合组 **124/124**，其余 117/182/24/79/105/80 组与 legacy 专项 23 项均通过。选择描述器四项 ID 的真实序列化和 Node 传输已核验。最新 `0.8.5-internal-single-parameter-write`：266 源文件、33 C# API 编译、145 产品文件，仍 `releaseReady:false`。见 `SINGLE-PARAMETER-WRITE-VERIFICATION.zh-CN.md` 与 `single-parameter-write-verification.json`。
- 类型写的前置切片 `revit_get_type_parameter_impact` 已完成只读核查：显式 type/parameter ID、同回调参数原态和完整直接实例清单，合计 20,000 扫描、最多 500 实例，超限不返回 partial；明确间接影响未评估、不授予写权限。新组 **65/65**、旧 182/24/79/117/124/105/23/80 组均通过；273 文件快照、33 项 C# API 编译和 145 文件内部候选已核验。只读 MCP 为 23 项，仍未启用具名类型写，见 `TYPE-PARAMETER-IMPACT-VERIFICATION.zh-CN.md` 与 `type-parameter-impact-verification.json`。
- 旧批量参数入口的显式类型旁路已收口：整批预检静态非法目标零 Set，每项及三阶段回读重新核对实际实例/参数归属；动态变化仍可能已有前项修改，保留 unknown。新策略组 **87/87**、旧批量 **117/117**、单项写 **125/125** 及其余 182/24/79/65/105/23/80 组最终通过。273 文件历史快照保留，新快照 **278 文件**，33 项 API 引用编译、145 文件候选及 ZIP 回读通过，仍不可安装。旧查询首轮固定 35ms 测试在并行下失败，未改源码/断言的串行复验通过，详见 `PARAMETER-WRITE-INSTANCE-POLICY-VERIFICATION.zh-CN.md`。
- P1 `revit_set_type_parameter` 已完成对话入口的可信逐次确认：实际原生准备、HTTP 用户决定与单次进程内批准分开绑定；automatic/rollback 也必须决定，模型自报 ack 无效。原生文档身份/120 秒 token、写前原态/完整直接影响集及四阶段重新获取核对已实现，准备读取未知也保留原回执、迟到不自动写。新组合 **180/180**、审批回归 **92/92**，原查询 **182/182** 及既有参数/布局/宿主组通过；**292 文件**快照、**34 C#** 真实 API 引用编译及 **148 文件**候选/ZIP 核对，仍不可安装。手动命令面板明确暂不执行此工具。见 `TYPE-PARAMETER-WRITE-VERIFICATION.zh-CN.md`；旧 UI 扩展扫描 17 项与 HEAD 基线同样失败、首轮目录超限 6 字节及其他夹具/CLI 失败均已记录，未声称全套测试通过。
- 手动类型写已接入同一准备/审批/回执 owner：实际完整影响读取、原生控件、提交锁定、同五字段逐次决定；初始提交、automatic 和 rollback 都不能替代批准，raw dispatcher/MCP 仍拒绝。取消/过期结算等待，准备和写入未知保原回执，命令及确认卡按原执行 ID 接收终态/迟到核对。补齐两份模块的 HTTP 路由并实际核对内容/MIME/跨工作区 404。最终手动组 **30/30**、HTTP 兼容 **25/25**、审批 UI **37/37**、旧类型写 **180/180**、共享权限 **70/70**、命令/回执 **80/80**、布局 **105/105** 通过。**298 文件**快照、**34 C#** API 引用编译及 **149 文件**候选/ZIP 核对，仍不可安装；未替换插件或操作真实模型。见 `MANUAL-TYPE-PARAMETER-WRITE-VERIFICATION.zh-CN.md`。
- 动态工具目录容量已处理：仅从注册副本移除 schema 字段说明，按需完整契约、所有约束和权限保持；默认/族能力目录分别 **24,777/25,570 字节**，专项 **7/7**、关联注册/协议回归 **45/45**。真实 Codex 读取说明行为未验证；上一版候选未包含本轮修改，仍需重建。见 `TOOL-CATALOG-BUDGET-VERIFICATION.zh-CN.md`。
- 真实 Revit/WebView/Codex、模型效果、客户安装升级和恢复尚未验收。

## 下一步

BX-006 继续：具名类型写的对话和手动路径均已完成源码与隔离验证，下一项按清单推进其余 P1 常用命令；不改变用户已安装宿主或真实模型。任意 C#/保存脚本仍有较宽权限，不声称通用沙盒。继续复用权限/原回执 owner，不接收模型自报 ack。原生系统图、标注及其专属依赖替代尚未完成，仍有消费者的 Argus/ScriptRunner 保留。运行时、许可、数据升级恢复及真实设备/客户机验收继续单列，未安装或加载候选。旧固定 35ms 查询测试和 17 项 UI 基线失败留待测试维护；此前九个空 HTTP 夹具目录仍保留，本轮未再次清理。自检继续，不将本切片当作整套计划完成。
