# 单参数原生读取与精确 ID 验证

日期：2026 年 11 月 5 日。P1 `revit_get_parameter_value` 已完成自有 C#、具名输入/输出契约、原子队列、MCP 和精确 ID 表单接线。宿主及程序集升至 **0.8.4**。259 文件源码快照独立通过真实 Revit 2024 API 引用编译，内部候选生成并核对完成，**`releaseReady:false`，仍阻止安装**。

本轮没有加载新插件、替换已装 DLL/Addins、重启既有服务、执行真实 Revit 查询/写入或公开发布。BX-006 尚未全部完成。

## 交付行为

输入为精确 `element_id`，以及 `parameter_id`、`parameter_name` 两者中的一项。ID 支持安全整数或规范十进制字符串；参数 ID 可以为负，0/-1 不作为有效参数选择器。名称使用 ordinal 完整匹配，保留空格、大小写与 Unicode，不 trim、不猜第一项。

服务只扫描所选元素自身的 Parameters；实例缺少参数时不会暗中改读其类型。调用者需要类型参数时应明确选择实际类型 ID。即使早段已经匹配，仍完整扫描以证明唯一性；重复参数 ID、同名多候选、未找到或超预算明确失败。不读取未选中参数的值。最多扫描 2000 项，并沿用原时间、字符串与响应预算；不发布部分事实。

结果固定为 `{schema_version, element_id, element_name, parameter}`。单个 parameter 完全复用现有参数事实 owner，保留稳定 ID、存储类型、可写性、HasValue、原始值、显示值、单位和缺失状态。无值/空串/None/只读/ElementId 引用不另作推测或单位转换。回执再核对源元素及原 ID/完整名称选择器，错配保持 unknown 并保留原请求核对，不重发。

参数能力族仍为 `nativeParameterQueriesVersion:1`，具名操作扩为 `get_type_parameters` 和 `get_parameter_value`，host.json 与原子 snapshot 都声明。门禁按操作区分：旧类型查询最低 0.8.2，新单参数查询最低 0.8.4；没有将旧类型查询整体提高到 0.8.4。新操作入队前和回执到达后均验能力/操作/宿主，旧宿主零入队，无外部 provider fallback。六查询 v1、写入权限、文档绑定、事务和取消/未知回执机制保持。

产品 workspace 只读目录现为 22 项，原六查询加两项参数查询的基础目录为 8 项；legacy 外部六工具组保持六项。界面中精确 ID 改为普通文本输入，安全 ID 可发送 number，大 ID 保留原十进制字符串，不先用 Number/JSON.parse 舍入，不需用户填写 JSON 引号。参数 ID/名称均在主参数区显示，提示二选一并在提交前校验；服务端再次强校验。复杂数组/对象仍沿原控件；当前选择、附件及写入确认流程没有改动。界面验证为实际函数/轻 DOM，尚未在真实浏览器或 WebView 验收。

## 修正旧 Double ID 解析

旧公共 C# ID 解析方法确有一个精度问题：明确 boxed `System.Double` 的 `9007199254740991` 经 `Convert.ToDecimal` 后得到 `9007199254740990`，解析结果少 **1**。本轮从旧提交 `86365c6` 提取原方法，使用仅 System/mscorlib 的独立驱动实际复现；字符串与 boxed Int64 对照仍保留正确值，问题限定在该 Double 路径，不表示所有查询都错。

现将 Double 单独先验证有限、整数及安全范围，再直接转 long，避免中间 decimal 舍入。普通整数/decimal 保持原精确检查，signed/positive 共享同一规范 ID 解析核心；新参数 ID 覆盖 Int64 正负边界。相同 boxed Double 的新方法结果为 `9007199254740991`，producer 还实际注入 Double 正负安全上界、非有限值和超限值验证。证据：`artifacts/native-single-parameter-validation-20261105-01/double-id-check/double-id-comparison.json`。没有用 JavaScriptSerializer 自动产生的 long 假充 Double 测试，没有加载 Revit 或操作模型。

## 已执行检查

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm run test:single-parameter` | **79/79，0 跳过** | 10 契约、17 实际 C# producer、11 队列/MCP、41 精确字段/原界面回归 |
| 实际 C# producer | **17/17** | signed Int64、强制 Double、原样名称、完整扫描/歧义、2000/2001、真实等待触发 5 秒预算、不读无关坏值、无类型 fallback、源事实不变 |
| 真实临时队列/MCP | **11/11** | 两种选择器、四组实际 C# DTO 跨 Node、双侧门禁、sourceDocument、取消/timeout/原回执、不重放、SDK schema/structuredContent |
| 原六查询/目录 | **182/182，0 跳过** | 旧查询、参数事实及 legacy 目录兼容 |
| 旧类型参数查询 | **24/24，0 跳过** | 0.8.2/v1 按操作兼容，新族全集与旧单操作分开验证 |
| 参数写入回归 | **117/117，0 跳过** | 0.8.3 setter/事务和回执补强保留 |
| 布局/安装/闭包 | **105/105，0 跳过** | 源码、独立布局、数据归属和安装阻塞 |
| 受控宿主 | **80/80** | 原调度/身份/权限和请求验证；新读分派及双处能力声明另作静态核实 |
| 从新快照构建 | 259 文件，33 项 C# 输入，exit 0 | 真实 Revit 2024 API/UI 引用；不等于加载插件 |
| `npm run check` / diff 检查 | 通过 | 源码入口语法、补丁格式 |

第一次 strict Ajv 检查发现 oneOf 分支 required 未在本分支声明 properties，已补引用占位，字段规则仍由顶层唯一 owner 持有，没有关闭 strictRequired 或放宽 XOR。表单测试也随普通文本输入更新，取消旧的高级 JSON 引号输入约定；不把经过 JSON.parse 舍入后被拒绝的 number 称为无损控件。

## 可审阅产物

| 产物 | 内容 |
| --- | --- |
| `artifacts/buildx-source-20261105-07` | 259 源文件、186 JS 模块、550 条依赖/资源引用完整；同目录 build 为该快照隔离构建 |
| `artifacts/buildx-revit2024-single-parameter-20261105-01` | `0.8.4-internal-single-parameter`；144 产品文件共 19,401,467 字节；98 JS/MJS、308 条导入，无 bare npm、缺项、摘要错误或本机开发根字节；DLL 调试目录为 0 |
| `artifacts/BuildX-Revit2024-0.8.4-internal-single-parameter-20261105.zip` | 7,396,663 字节，145 条目 |
| `artifacts/BuildX-Source-0.8.4-internal-single-parameter-20261105.zip` | 1,085,120 字节，261 条目，不含 build |
| `docs/migration/single-parameter-verification.json` | 测试、源码/包摘要、Double 对照、scope 与未验清单 |

运行 ZIP SHA-256：`0989d58510c027d08a5cb38be3379bed90ef96fd428f4844b23d191da2bd0225`。

源码 ZIP SHA-256：`f5f7e8c3ccd0e3f029a26c44201eaccec1c9ebaff01a6e42785d14f35b7580b3`。

DLL SHA-256：`6e7c1485be652f6133e8ecec413011078e82bae38dadf012b0a47a0e4dd1c6ce`。

所有 ZIP 条目回读、解压及原清单摘要一致；固定 compiler 17 项、源码闭包通过。无 node_modules 的解压运行包完成 22 项 `--workspace` MCP 目录握手；single input/output 经 strict Ajv 编译，单选/双选/缺 selector 按预期。解压 owner 纯内存校验精确 ID、原样名称、错配及 XOR，没有模型调用/队列创建，临时目录核实归属后清理。旧产物和失败/精度证据保留。

## 未验证与下一步

真实 Revit 参数读取、实际浏览器/WebView/Codex 联动、干净客户机、安装升级恢复卸载、模型效果与性能仍未验收。原四项包缺项和安装器许可、pypdf、客户数据/许可后端条件继续阻塞，不因目录或编译成功解除。

下一切片核查 P1 具名单参数/类型参数写入的已有消费者、类型影响范围与已审批输入，在复用已验证 setter 的前提下实施；之后继续常用建模、原生系统图和标注。保留文档身份、权限、取消、未知结果和原回执核对，不执行真实模型写入。
