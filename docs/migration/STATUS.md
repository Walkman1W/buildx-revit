# BuildX 实施状态

更新日期：2026 年 11 月 5 日。

主要实施聊天：`01a1a752-4305-77f1-8b04-e8a1b338c1d0`，项目目录 `D:\code\BuildX`。

## 当前阶段

已从 `D:\code\REA\local-codex-panel` 白名单提取 507 份源码和必要测试，共 5,602,302 字节。复制前后来源摘要一致，目标逐文件摘要核对通过；清单见 `source-baseline.json`。源目录和已运行的插件保持原状。每小时检查继续本项目聊天，读取本状态和任务台账后推进。

六项原生查询已完成源码闭环及本轮授权的隔离验证：自有输入/输出契约、C# 生产者、宿主 0.8.1 和具名能力、统一原子队列、sourceDocument、取消和原回执核对全部接通。旧宿主在入队前拒绝，六项不回落 AEC/Python provider；本工程内专属 adapter、relay 和刷新器已退出。详见 `NATIVE-SIX-VERIFICATION.zh-CN.md` 和 `native-six-verification.json`。

`npm run test:native-queries` 最终合并运行 **181/181 通过、0 跳过**；真实 MCP 客户端逐一调用六项并验证完整 structuredContent/outputSchema。实际 C# 服务及参数方法在受控 API peers 中测试，再跨 Node 临时队列校验。宿主检查 **80/80**；最终源码真实 Revit 2024 API 引用编译成功。上述结果均不等于已加载插件或真实模型验收。

## 已核对与待验

- 私有仓库：`https://github.com/Walkman1W/buildx-revit`，默认分支 main 保留规划基线；审查后的业务源码和本轮实现保存在 `codex/native-foundation`。没有合并受保护分支或正式发布。
- 完整 AEC Revit 静态台账已完成：103 项工具、103 个映射，P0 六项；记录业务分组、schema、来源行号、语义差异和未核实项，不表示 103 项已实现。
- 锁定安装 19 个 Node 依赖、纯解析 owner 遗漏修复、第三方原始许可证公告和有限敏感扫描完成。历史来源记录仅追加更正，未改写 507 文件复制证据。见 `BASELINE-AUDIT.zh-CN.md`。
- 每小时自检任务 `buildx` 已启用，目标为本项目聊天，配置读回确认；已收到 2026-11-05 02:12（北京时间）的实际 heartbeat 并推进本轮私有编译器切片。
- 已执行 `node --check server.mjs`、`node --check source-panel.mjs`、`node --check public/app.js`，三项语法检查通过；这不证明运行依赖完整或真实 Revit 可用。
- 原提取宿主为 0.8.0；本工程新源码为 0.8.7。查询族及最低版本保持；具名单项写仍独立要求 0.8.5/v1。旧批量参数写现要求 0.8.7、`parameterWriteTargetPolicyVersion:1` 和 `parameterWriteTargetPolicy:instance_only`，整批目标预检和逐阶段重新获取均限制实例归属。新 DLL 只在隔离目录编译，未替换已安装插件。
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
- 真实 Revit/WebView/Codex、模型效果、客户安装升级和恢复尚未验收。

## 下一步

旧批量 setter 的显式类型目标已在新工程源码收口，BX-006 继续进行。下一项统一具名类型写的手动/AI 可信强制确认及写前原态/影响集复核；automatic/manual 普通确认仍不能直接作为类型整体授权，任意 C#/保存脚本仍有较宽权限，不声称通用沙盒。继续复用 setter 和权限/原回执 owner，不接收模型自报 ack。首版 Argus 功能边界及运行时、许可、数据升级恢复条件仍需核实，不扩展成 103 项全量迁移，不盲删仍有消费者的 Argus/ScriptRunner。真实安装/加载需要覆盖指定目录与 Revit 实例的具体授权，本轮未执行；真实设备及客户机验收仍单列。旧查询测试固定 35ms 等待的并行脆弱性待后续测试维护。
