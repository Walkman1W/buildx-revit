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
- 每小时自检任务 `buildx` 已启用，目标为本项目聊天，配置读回确认；自动化尚未经历一次实际定时触发。
- 已执行 `node --check server.mjs`、`node --check source-panel.mjs`、`node --check public/app.js`，三项语法检查通过；这不证明运行依赖完整或真实 Revit 可用。
- 原提取宿主为 0.8.0；本工程新源码为 0.8.1，`nativeModelQueriesVersion:1` 和具名操作均在入队前及原子回执校验。新 DLL 只在隔离目录编译，未替换已安装插件。
- 独立运行布局源码已完成：schema 2 程序/私有执行资源/数据/队列分离，Node、MCP、命令库与 C# 使用同一配置；schema 1 保留原数据位置。旧开发根、个人 Node 例外和 Python 私有缓存兜底已退出生产启动路径。见 `RUNTIME-LAYOUT.zh-CN.md`。
- 布局修改后六查询 **181/181** 保持通过，布局/安装/归属相关组 **105/105**，受控宿主 **80/80**；227 文件完整源码快照以官方 NuGet WebView2 SDK 独立通过 Revit 2024 API 编译。首次六查询记录的摘要属于 93b324c 历史切片，当前构建和包摘要见 `internal-candidate-verification.json`。
- 内部候选已完成：运行包 ZIP 1,086,373 字节（123 产品文件及清单），源码 ZIP 983,301 字节（227 源文件及两份清单），全部条目回读与解压验证通过。无 node_modules 的解压运行包能启动生产 MCP 目录并保留六项契约，未创建队列。详见 `INTERNAL-CANDIDATE-20261105.zh-CN.md`。
- 去掉 AEC 后，资料解析和 Codex TOML 配置读取仍依赖 Python；C# 用户命令的编译器来源单独处理。
- 真实 Revit/WebView/Codex、模型效果、客户安装升级和恢复尚未验收。

## 下一步

本轮已完成独立可重建的内部审阅候选，`releaseReady:false` 且安装器仍阻止 Apply。下一步先收敛首版未替代执行资源与功能边界，并核实运行时、许可及数据升级恢复条件；不扩展成 103 项全量迁移，不盲删仍有消费者的 Argus/ScriptRunner。真实安装/加载需要覆盖指定目录与 Revit 实例的具体授权，当前未请求或执行该操作。真实 Revit/WebView/Codex 与客户机验收仍单列，不能用在线旧 AEC、目录握手或隔离编译替代。
