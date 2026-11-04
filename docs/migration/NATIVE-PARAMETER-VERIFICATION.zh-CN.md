# 类型参数查询原生化验证

日期：2026 年 11 月 5 日。P1 `revit_get_type_parameters` 已完成自有 C# 实现、具名契约、原子队列和隔离验证，宿主升至 **0.8.2**。它读取实例对应的真实类型参数，直接输入 ElementType 时读取自身，明确返回源元素与类型身份。BX-006 仍在进行，其他参数和建模命令尚未全部迁移。

本轮没有加载新插件、替换用户 DLL/Addins、重启既有服务、执行真实模型操作或公开发布。新内部候选 **`releaseReady:false`，仍阻止安装**。

## 实际变化与边界

- `NativeParameterQueries.cs` 在同一 API 回调内取得源元素、实际 ElementType 及参数。缺类型、类型已失效、类型目标不是 ElementType 或实例自指均明确失败，不回落实例参数、不按名称猜测类型。
- 输入沿用精确 ElementId：安全整数或规范十进制字符串，超过 JSON 安全整数范围时保留字符串。输出明确 `element_id`、`element_name`、`source_is_type`、`type_id`、`type_name` 与参数列表；直接类型输入的源/类型 ID 和名称必须一致。
- 参数行复用 `NativeModelQueries.ParameterRows` 与现有 `WorkbenchActions.DescribeParameter(..., true)`，身份、存储类型、原始值、显示值和单位由原 owner 解释。沿用最多 2000 参数及扫描、时间、字符串、响应预算，超限失败，不发布部分参数列表。原六查询改为调用同一个行生产方法，单位和存储解析没有复制。
- 新能力族为 `nativeParameterQueriesVersion:1` / `nativeParameterQueryOperations:['get_type_parameters']`，同时发布于 host.json 与原子 snapshot；入队前和回执到达后均核对宿主至少 0.8.2、能力和操作。原六查询 `nativeModelQueriesVersion:1` 保留，旧宿主不会收到新查询，也不会回落外部 provider。
- 复用原文档/宿主绑定、只读效果分类、权限、取消、超时和原回执核对。发布后取消或结果不明仍保留原 request ID，不自动重放。MCP 成功结果发布完整 `structuredContent` 和命名 `outputSchema`，目录和界面增加“类型参数”。
- 产品 workspace 只读目录由 20 项变为 21 项，原六查询加新类型查询的基础目录为 7 项。legacy `model` profile 的外部 `revit_local` 仍明确保留原六项，不要求旧外部服务实现新工具；新功能在自有 workbench 提供。

103 项台账中原 `revit_get_type_parameters` 只记录了 related-only 的静态对应，本轮建立了具名实现；原 provider schema、来源和台账不覆盖，新映射记录于 `native-parameter-verification.json`。不假定兼容旧 provider 未知的输出结构。`revit_set_parameters` 原本已经是自有原生写命令，本轮没有重做或修改其写入语义。

## 已执行检查

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm run test:native-parameters` | **24/24，0 跳过** | 8 契约、7 实际 C# 受控 producer、9 临时队列/MCP 检查 |
| `npm run test:native-queries` | **182/182，0 跳过** | 原六查询、参数事实、目录及 legacy profile 回归 |
| `npm run test:layout` | **105/105，0 跳过** | 配置/归属、布局、安装阻塞、源闭包 |
| 受控宿主检查 | **80/80** | 原调度、身份、权限和请求验证；新读取分派和能力声明另做静态核实 |
| 新 DTO 一致性探针 | 通过 | 直接类型的空名称保留、矛盾名称拒绝；纯内存验证，无队列 |
| `npm run check`、diff 检查 | 通过 | 入口语法和补丁格式 |
| 完整源码/API 引用编译 | 242 文件，33 项 C# 输入，exit 0 | 从独立快照使用真实 Revit 2024 API/UI `24.3.30.11` 编译，没有加载插件 |
| 运行包清单/导入/本机路径核对 | 143 文件，97 JS/MJS、307 条导入，无缺项/bare npm/摘要错误 | 包内容、零 npm 运行依赖及产品 DLL `/debug-`；不等于实机功能验收 |

实际 C# 测试编译生产类型服务、共享查询类及原参数描述方法，在受控 API peers 执行，验证实例参数不冒充类型参数、直接类型、缺失/错误/自指类型、Int64、同名参数、空值和只读事实、2000 项与响应预算；对源事实做前后比对。临时队列/MCP 验证两侧能力、宿主/文档及 DTO 错配、发布前后取消、timeout 后原回执、failed/expired 和实际 SDK 客户端输出契约。没有把 peers、目录握手或 API 编译称为真实 Revit 执行。

初次回归发现旧目录测试把全部基础查询当成原六项，旧 Codex mock 也混用新七项列表；已按各自契约 owner 区分，新查询在本机目录可用，legacy 外部目录保留六项，并补兼容回归。修正后完整 182 项重跑通过。没有放宽目录校验。

## 可审阅产物

| 产物 | 路径与内容 |
| --- | --- |
| 源码/隔离构建 | `artifacts/buildx-source-20261105-05/source` / `build`；242 源文件、171 JS 模块及 506 条依赖/资源引用闭包完整 |
| 运行目录 | `artifacts/buildx-revit2024-native-parameters-20261105-01`；版本 `0.8.2-internal-parameters`，143 产品文件共 19,382,744 字节 |
| 运行 ZIP | `artifacts/BuildX-Revit2024-0.8.2-internal-parameters-20261105.zip`；7,641,604 字节，144 条目 |
| 源码 ZIP | `artifacts/BuildX-Source-0.8.2-internal-parameters-20261105.zip`；1,028,560 字节，244 条目，不含 build 产物 |
| 机器记录 | `docs/migration/native-parameter-verification.json`；测试、来源、摘要、候选及未验范围 |

运行 ZIP SHA-256：`20028b7aa7dc125cf24f59e23ebb49e5b469cbdfde74b592a602127c0d3372be`。

源码 ZIP SHA-256：`8468dbee3dab323576d0c2ada4ed53e0ad4cafcc329434393ee64a794caffdf4`。

DLL SHA-256：`e0d386d7292900762cb1dbc21a9fe5880d25a0b4d241e3cdbfe78f74a9225d03`。

每个 ZIP 条目回读和解压摘要均匹配；解压后的官方私有 compiler 17 项及源码 242 文件/闭包验证通过。无 node_modules 的运行包完成生产 `--workspace` stdio 目录握手，21 项工具包含原六项和类型参数，新 outputSchema 可由 Ajv 编译；只发送 initialize/initialized/tools/list，没有模型调用或队列创建。旧候选和证据完整保留。

## 未验证与下一步

真实 Revit 加载和类型参数读取、WebView/Codex 联动、干净客户机、实际安装、升级/恢复/卸载仍未验收。Argus 业务替代及分发、Node 引导和 Node/Python 私有运行时、WebView2 Runtime 等四项运行包缺项保留；插件分发、pypdf、许可后端及客户数据条件继续由安装器独立阻塞。

本轮静态检查另发现现有 `set_parameters` 在 Set 返回 true 时没有强制验证回读完全一致；尚未在真实 Revit 复现，旧写入 peers 也未覆盖此分支。下一切片先执行实际生产方法的受控 setter/事务/回滚测试，修复可复现问题，再推进具名参数写及其他常用命令；保持当前权限与未知结果处理，不执行真实模型写入。
