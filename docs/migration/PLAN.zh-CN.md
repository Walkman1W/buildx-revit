# BuildX 独立项目瘦身与 Revit 安装包规划

日期：2026 年 11 月 4 日。GitHub 可见性已确定为先私有，稳定后再评估公开。

AEC 与 Argus 的调整方向：用 BuildX 自有 Revit C# 实现替代当前外部查询和恢复业务，保留所需功能后移除依赖。范围、阶段与验收见 [BuildX 原生查询标注与系统图替代规划](NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md)。

建议在 `D:\code\BuildX` 按文件清单建立独立工程，保留现有开发与运行目录作为回退。先解除路径和研究依赖，再裁剪功能、建立 GitHub 仓库及制作安装候选；新工程通过验证后，再单独执行旧目录清理。源码仓库、用户数据、开发归档和客户安装包各有独立清单。

## 当前项目位置与运行引用

| 用途 | 当前地址或状态 |
| --- | --- |
| BuildX 主工程 | `D:\code\REA\local-codex-panel` |
| 所在 Git 仓库 | `D:\code\REA`，远端为 `https://github.com/morluto/rea.git` |
| BuildX Git 状态 | 没有独立 `.git`，整个目录未被 REA Git 跟踪 |
| 当前产品入口 | `server.mjs`，模型工作区 profile；旧 README 中固定工具数量不能作为当前规格 |
| 本地面板地址 | `http://127.0.0.1:41873/` |
| 当前监听 | 只读采样时为 PID 5188，进程命令匹配旧目录 `server.mjs`；这不代表完成服务健康验收 |
| Revit 插件源码 | `revit-addin/` 和 `family-core/` |
| 当前安装清单 | `%APPDATA%\Autodesk\Revit\Addins\2024\LocalCodexRevit.addin` |
| 清单指向的 DLL | `revit-addin/bin-native-active-window-wake-20261104-r3/LocalCodexRevit.dll`；仅核对了磁盘清单，未证明当前进程已加载哪份 DLL |
| 安装链路 | `tools/buildx-installer.mjs`、`tools/buildx-setup.ps1`、`revit-addin/build.ps1` |
| 独立目标目录 | 建议 `D:\code\BuildX`，采样时尚不存在 |
| GitHub 目标 | 建议独立私有仓库 `buildx-revit`；账户归属和实际地址在创建时确定 |
| 宣传视频工程 | `D:\code\REA\outputs\buildx-vibe-20261027`，独立素材工程，不是产品界面 |

采样期间发现文件仍在变化。提取时须固定源码快照和逐项哈希，不能把不同时间的源码、DLL 与旧候选混成同一个版本。当前安装清单引用的构建目录和运行数据不进入第一轮删除清单。

## 核心代码与调用关系

```text
Revit 面板 LocalCodexRevit.cs / WebView2
  → server.mjs → panel-server.mjs / panel-server-core.mjs
      ├─ public/app.js / model-workspace.mjs：对话和产品界面
      ├─ CodexClient / codex-client-core.mjs：用户自备 Codex app-server
      ├─ 项目资料、技能、聊天历史、账号与许可
      └─ model-tool-dispatch / model-permission-owner
          → workbench-client → 本地队列与回执
          → WorkbenchHost / ExternalEvent → Revit API
```

| 责任 | 保留及整理的源码 |
| --- | --- |
| 启动与应用组装 | `server.mjs`、`lib/panel-server.mjs`、`lib/panel-profile.mjs` |
| HTTP、SSE、会话生命周期 | `lib/panel-server-core.mjs`、聊天与会话模块 |
| Web 界面 | `public/`，重点是 `app.js`、`model-workspace.mjs`、资料库与命令表单 |
| Codex 连接 | `lib/codex-client.mjs`、`codex-client-core.mjs`、`codex-profile.mjs`、`local-runtimes.mjs` |
| 命令与模型操作 | `lib/model-tool-dispatch.mjs`、`model-command-catalog.mjs`、`command-store.mjs`、`workbench-client.mjs` |
| 权限与结果归属 | `model-permission-*`、`access-*`、回执 owner、取消和进程清理模块 |
| 资料库与技能 | `project-knowledge.mjs`、`project-files-*`、`project-agent-bridge.mjs`、解析辅助程序、产品 prompt 与 Skill |
| 账号和许可 | `buildx-auth.mjs`、`buildx-runtime-config.mjs`、对应前端和数据库迁移定义 |
| Revit 宿主 | `LocalCodexRevit.cs`、`WorkbenchHost.cs`、`WorkbenchActions.cs`、`AccessPolicy.cs` |
| 自有专业能力 | `family-core/`、`Schematic*.cs`、`CadGeometry*.cs`、`VisualInspection.cs`，按选定功能及验收情况进入安装包 |

目录体积和代码维护复杂度分开治理。`panel-server-core.mjs` 约 224 KB、`app.js` 约 151 KB、`model-workspace.mjs` 约 104 KB；优先按路由、会话、界面状态和回执归属拆分，不同时更换语言或前端框架。

根目录有约 197 个测试文件，`lib` 内另有约 16 个；当前 `package.json` 没有统一 test 脚本，`check` 只检查三个文件。正式工程应提供可复现的检查入口，保留权限、文档身份、取消、未知结果及清理恢复覆盖。

## 体积与清理边界

以下为文件逻辑长度的只读采样，跳过链接与重解析点；总量约 992 MiB、2.78 万文件，现场变化可能改变数字。

| 目录 | 大小约 MiB | 处理方式 |
| --- | ---: | --- |
| `workbench/` | 687.86 | 拆分研究依赖、运行数据和验证素材，不能整删 |
| `artifacts/` | 218.33 | 历史候选与验证产物留在私有归档，不进新源码仓库 |
| `revit-addin/` | 42.96 | 源码保留；历史 `bin-*`、备份另行归档，保留当前清单引用 |
| `node_modules/` | 21.68 | 不入仓；按锁文件恢复，安装包另算生产依赖闭包 |
| `runtime-history/` | 11.29 | 用户数据，迁移保留，不入仓或客户包 |
| `runtime/` | 2.60 | 日志、锁和运行记录，按生命周期保留 |
| `lib/` | 1.47 | 核心应用代码 |
| `public/` | 0.51 | 产品界面 |
| `family-core/` | 0.40 | 族代码与相关验证，按功能保留 |
| `tools/` | 0.28 | 区分正式构建安装工具与开发探针 |
| `ui-preview/` | 0.75 | 核实测试和文档引用后归档 |

`workbench/runtime` 约 388.87 MiB，`validation` 约 216.53 MiB，`samples` 约 39.71 MiB，`experiments` 约 20.80 MiB。验证记录和原始模型先归档；`queue`、`commands`、`command-store-state`、权限配置和 `visual-captures` 属于运行数据，不能当缓存处理。

第一轮通过白名单提取减少新工程内容，不在旧目录删除。第二轮在新工程解除引用后移除未选模块。第三轮在新项目及安装候选验收后，列出旧目录准确路径、归档位置、哈希和回退方式，再执行获授权的清理。`release/` 含被代码导入的组件定义，也不能按目录名整删。

## 功能范围与必须解除的依赖

建议首版保留完整的产品主线：Codex 对话、Revit 查询与自有建模操作、命令、资料库、技能、账号许可、权限确认和执行回执。已接入的族与专业能力逐项验收；瘦身不自动缩减现有功能，也不删除保护逻辑。

| 项目 | 当前事实 | 独立工程处理 |
| --- | --- | --- |
| 开发根目录 | `LocalCodexRevit.cs:614,655-690` 含旧路径回退及固定目录推导 | 统一拥有程序根、配置根、数据根和队列根，开发与安装模式均支持可核实的清单 |
| 外部 AEC provider | `lib/aec-model-adapter.mjs:14,26-40` 依赖相邻 PumpBIM Python 环境及源文件路径和哈希 | 将六项查询迁入自有 Revit C# 服务，核对输入和输出后替换主入口；通过验收后移除 provider、Python 中继和外部契约快照依赖 |
| C# 编译器 | `ScriptRunner.cs:14` 从 REA `_reference` 的研究目录找编译器 | 保留用户命令需求，改为固定版本、来源可追溯的编译依赖；未解决前不宣称可独立分发 |
| Argus 重建算法 | `ArgusTools.cs:26-28` 与宿主分派仍使用研究程序集 | 以原生规则标注和现有原生系统图替代当前两项能力；替代验收后移除恢复入口、程序集及其专属运行依赖，保留原研究材料归档 |
| 源码调查工作区 | `codex-profile.mjs:5`、`panel-profile.mjs:2` 静态导入 source 工具 | 先解除主产品 profile 的依赖，再将 `source-*` 入口移到开发区 |
| 独立纯聊天组件 | `customer-server.mjs`、`lib/customer-chat*` 与完整 Revit 产品并行 | 从首版完整插件安装清单排除，核查共享模块后再决定移出或保留为独立组件 |
| 外部 MCP 和 API 实验 | 部分扩展 owner 没有进入主入口 | 隔离实验和依赖，保留范围与验证记录，不进首版运行时 |
| 旧模型查看器 | 主入口未注入 viewer service，相关接口返回未连接 | 移除未交付入口或单独排期接通；不能仅因有源文件就列为现成功能 |
| WebView2 SDK | 当前构建从本机 AECModelBridge 目录复制 DLL | 改用固定包版本、明确 Loader 和许可公告，客户机 Runtime 单独检测 |
| 资源清单 | HTTP 资源表、安装白名单与纯聊天组件定义各自维护 | 建一个产品清单 owner，由资源服务、依赖验证及打包消费，消除重复解释 |

上述功能裁剪是实施建议。删除前按工具 ID 对齐已用功能和受影响测试；首版需要的专业能力完成自有实现或依赖闭包后再纳入。当前 npm 包主要被外部 MCP 实验使用，分离实验后重新计算生产依赖，不将整份 `node_modules` 打包。

## 独立工程与 GitHub

建议保持单仓库、少量明确目录，不引入额外 monorepo 编排工具。

```text
D:\code\BuildX\
  app/                 Node 服务、lib、public、prompts 与产品 Skill
  revit/               标准 C# 工程、宿主及族代码
  installer/           检测、安装向导、升级、回退与卸载
  tests/               自动化测试与可分发的最小夹具
  scripts/             构建、检查与开发验证入口
  docs/                架构、开发、安装与使用说明
  manifests/           产品文件和依赖清单
  README.md
  AGENTS.md
  package.json
  package-lock.json
  .gitignore
```

先固定独立副本，再逐步调整布局与路径，不能只搬文件。程序输出放被忽略的构建目录；归档放项目外；真实项目、聊天、附件、账号会话、许可配置、队列、模型和日志不入仓。

GitHub 从清理后的源码建立初始提交，不复制 REA 的 `.git` 或整个历史。先检查 `git ls-files`、文件大小、机器路径、敏感配置和依赖来源，再推送私有仓库。提供配置模板与小型合成夹具，不复制本机配置。BuildX 的授权范围和第三方公告单独整理，不能直接沿用 REA 根许可证覆盖全部材料。

自动化先覆盖语法、目标测试、产品清单和哈希检查。Revit API 由构建环境合法提供；没有实际 Revit 的 CI 只能报告静态或编译结果，安装和设备验收另记。当前规划不要求重写为 TypeScript 或更换 Web 框架。

## Revit 安装包方案

首个候选限定 Windows x64 和 Revit 2024，这是当前源码、构建脚本和安装路径的明确范围。后续年份需单独构建和实机验证：Autodesk 文档要求 Revit 2025 插件迁移到 .NET 8，且已公告 2025 与 2026 的 .NET 10 迁移计划；后续支持需按具体更新版本核实。[Autodesk 迁移文档](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-API/files/Revit_API_Developers_Guide/Introduction/Getting_Started/Using_the_Autodesk_Revit_API/Revit_API_Revit_API_Developers_Guide_Introduction_Getting_Started_Using_the_Autodesk_Revit_API_NET8_Update_html.html)、[后续运行时迁移公告](https://aps.autodesk.com/blog/call-preview-testing-revit-20262025-migration-net-10)。

沿用不捆绑 Codex 的既定方案。检测已有 `codex.exe`，多版本时选择，缺失时引导官方安装；分别核实文件身份、app-server 握手、登录和模型访问。不要复制用户凭证或替换全局 Codex。

| 内容 | 安装包处理 |
| --- | --- |
| 插件与自有功能 DLL | 从固定源码和标准 C# 工程构建，带版本和哈希 |
| 本地 Node 服务和 Web 资源 | 由产品白名单生成，覆盖动态调用和辅助文件 |
| Node | 建议使用仅供 BuildX 的私有运行时，核实版本、来源和分发条件；不依赖 Codex 桌面缓存，不更改系统 Node |
| Python 和文档解析依赖 | 当前 PDF 等解析需要它；保留功能时提供可追溯的私有运行时，迁移后再评估是否能去掉 |
| C# 命令编译依赖 | 按实际命令功能纳入，解除 `_reference` 依赖 |
| WebView2 SDK 与 Loader | 固定来源和版本，随插件清单核对 |
| WebView2 Runtime | 优先检测并使用 Evergreen，缺失时提供明确安装或引导步骤；离线部署单独提供依赖包 |
| Revit 与 Revit API | 从目标机器和合法开发环境使用，不将开发机 Autodesk API 文件顺手混入客户包 |
| Codex、研究程序集、真实模型、用户配置 | 不随包复制 |

Evergreen 可共享 Runtime；Fixed Version 会增加超过 250 MB 的二进制，并需自行维护更新。以安装包瘦身为目标，优先 Evergreen，同时测试企业网络和缺失 Runtime 的情形。[Microsoft WebView2 分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

安装向导复用已有检测、预检、身份检查和哈希语义，交付入口改为独立 `BuildX-Setup.exe`，不要求用户先手动安装开发环境。具体封装工具在打包验证阶段确定，避免为换壳重写安装规则。程序放版本目录，用户数据放独立的本地数据根；宿主、服务、队列、历史、命令和权限配置同步迁移。

安装流程应覆盖检测 Revit 和已有安装、展示变更、写入自身文件和 Addins 清单、启动后验证、失败保留回退信息。运行中的 Revit 或插件冲突应提示处理，不自动关闭进程。升级需要数据备份与恢复验证；卸载仅移除安装记录中自身拥有的程序与清单，默认保留用户数据。程序回滚不能撤销已发生的 Revit 模型操作。

当前 `buildx-installer.mjs:81-108` 明确生成 `releaseReady:false` 并列出未解决依赖；现有执行入口只支持新目录安装，不具备正式升级或卸载。旧内部候选的自测通过不代表目前源码可安装，不能直接改就绪标记后发出。

## 实施顺序与完成条件

| 阶段 | 主要工作 | 可核对的完成条件 |
| --- | --- | --- |
| 1 固定基线 | 对齐当前使用功能、版本、安装引用；固定源码清单，按白名单提取独立副本 | 有来源与哈希，原服务和原始材料保留，新工程文件归属明确 |
| 2 解除耦合 | 统一路径和数据 owner，处理 AEC、编译器、Argus 及 source profile，补标准 C# 工程 | 新路径可运行，不依赖 REA 研究目录、桌面缓存和相邻开发项目 |
| 3 裁剪与建库 | 清除新工程未选功能、重复资源表、过期入口和文档，补检查脚本及忽略规则 | 功能和依赖清单一致、目标回归通过、Git 文件审查完成；建立私有仓库 |
| 4 安装候选 | 固定运行时与依赖来源，建立数据根及升级恢复流程，生成独立安装入口 | 同一源码生成可追溯候选，清单与包内容一致，不能遗漏动态依赖 |
| 5 客户验收 | 在目标 Revit 与干净 Windows 环境安装，验证 WebView、Codex、命令、资料库及所选专业功能 | 实际首装、升级、失败恢复、回退、卸载保留数据有记录；明确未支持版本 |
| 6 旧目录清理与发行 | 准备逐项旧文件清单和已验证归档；准备版本说明和下载产物 | 新工程可重建、回退材料可用；不可逆删除和正式发布分别在具体授权范围执行 |

最小真实验收还包括：缺失和多版本 Codex、Codex 更新后路径失效、服务重连、Revit 忙碌及晚到结果、取消后的回执核对、项目切换、模型写入审批、文档解析、安装失败与数据恢复。测试使用可丢弃模型，模型写入和宿主切换按具体测试范围授权。

源码仓库和安装包分别测量最终体积，不先承诺压缩比例。若改动声称降低分析成本，另测等价任务的 token、耗时、CPU 和进程族峰值内存；本次体积盘点不证明运行性能改善。

## 本次盘点范围

已核查 Git 状态、核心调用关系、目录体积、外部依赖、安装器源码以及磁盘 Addins 清单，并新增本规划。未删除或移动原文件，未创建远端仓库，未构建安装包，未替换插件或重启服务；运行、Revit 界面与客户安装验收属于后续实施。
