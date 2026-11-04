# 首批原生化实施交接

主要实施聊天：`01a1a752-4305-77f1-8b04-e8a1b338c1d0`，工作目录 `D:\code\BuildX`。本文件描述待实施范围，不是实现或运行通过的声明。

## 已建立的基础

已按白名单复制 507 份源码并核对哈希，保留浅层目录。私有远端为 `https://github.com/Walkman1W/buildx-revit`，分支 `codex/native-foundation`。规划与来源清单先提交；业务源码需要审查配置、来源和运行入口完整性后提交。旧工程、外部 AEC、研究归档和正在运行的资源只读。

每小时 `buildx` 自动化已指向本聊天；先核查是否存在正在实施的工作，避免多轮重复执行或互相覆盖。初次定时触发和实际后续推进尚未验证。

## 首个实施里程碑

完成六项 AEC 查询的原生实现闭环：健康/上下文、文档信息、视图、按类型查询元素、参数、几何摘要。实际公开工具名称及旧契约以源码和完整命令清单为准，保留调用方已明确选择的语义。

1. 新建 `lib/native-model-queries.mjs` 作为具名输入输出契约、操作映射和能力要求的唯一 owner。原六查询只有输入约束，输出应明确定义并验证；保留分页、扫描覆盖、单位、ElementId 精度、源文档事实和显式未知。
2. 在 `revit-addin/WorkbenchActions.cs` 复用现有事实生产者，补充原生读取。在 `WorkbenchHost.cs` 通过统一原子读取派发并宣告明确能力。可采用宿主 0.8.1 与 `nativeModelQueriesVersion: 1`，最终以实际实现记录。
3. 在 `lib/workbench-client.mjs` 绑定具名契约及原子操作，校验宿主版本、能力及支持操作。旧 DLL 的 `atomicReadSnapshot` 不能作为六查询支持证据；必须在入队前拒绝不支持的宿主，避免向用户旧插件发未知操作。
4. 在 `lib/model-tool-dispatch.mjs`、`panel-tools.mjs`、`model-command-catalog.mjs`、`panel-catalog.mjs`、`codex-profile.mjs` 和 `prompts/buildx-assistant.zh-CN.md` 接上自有契约，统一 sourceDocument 和权限，移除已替代 AEC 旁路及双桥指令。六查询切换完成后不回落外部 Python provider。
5. 分类名称与 OST 类别身份、类型/楼层/字段过滤不能简单退化成名称搜索。保留读取上限与真实覆盖结果；先估算几何表示大小，几何摘要不等于完整 mesh。
6. 保留并迁移取消、文档身份、未知回执及核对测试后，删除本工程内已替代的 AEC adapter、snapshot 和专属测试；完整 AEC 其他工具迁移仍有独立台账，不误报已全量替代。

## 必须执行的验证

- 为具名契约、原生宿主能力、旧宿主不入队、无 AEC 回落、真实 Node 队列边界及原子文档身份设置有意义的目标测试。
- 更新 `atomic-workbench-read.test.mjs`、`test-support/native-read-producer.mjs`、`model-workspace-registry.test.mjs` 以及受影响的指令、工作台客户端和派发集成回归；迁移旧 AEC 用例中独有的失败语义。
- 需要时更新 `tools/check-workspace-host.ps1` 与 `tools/workspace-host-checks.template.cs`，对真实本地 Revit API 引用编译。记录实际命令与结果，模拟生产者不能称真实 Revit 已通过。
- 先核查 `package.json`、入口引用和复制遗漏，补上新项目可重复执行的检查/目标测试入口；沿用锁定依赖，不借机升级。
- 基线审查已发现 `live-tool-receipt.test.mjs` 静态导入旧 `workbench/validation/20261023-buildx-live/` 下的纯解析模块。将有用的源码 owner 迁到本工程 `test-support` 或 `lib` 并改消费者，不复制整个旧运行目录。旧 `revit-addin/build-record.json` 与 `built-dll-inspection.json` 已列入忽略；导入器的生成记录排除规则及来源清单说明也应校正，保留实际复制证据。
- 不重启 Revit/旧面板、不替换已安装插件、不运行模型写入。可以在新目录编译内部候选；真实 Revit、WebView、Codex、客户机的未知项单列。

## 后续工作

首个闭环完成后更新 `STATUS.md`、`TASKS.json` 及实际检查记录，推进独立路径、全量命令迁移、自有系统图与标注，再瘦身和制作 Revit 2024 内部安装候选。资料解析与 Codex TOML 目前仍使用 Python，ScriptRunner 编译器来源也需单独处理；首批六查询成功不代表产品已无全部外部依赖。
