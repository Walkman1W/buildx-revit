# BuildX

简体中文 · [English](README.en.md)

BuildX 是 Autodesk Revit 的 AI 工作台。在 Revit 侧栏里使用自己的 Codex 对话，查询当前模型、引用项目资料，或检查并确认支持的模型操作。模型操作由本机 Revit 插件通过原生 API 执行。

## 能做什么

- **对话与资料库**。连接本机已安装的 Codex，选择项目资料、附件与技能作为本轮上下文。
- **模型查询与命令**。查询当前文档、选择集和构件参数。搜索内置命令和已加载的个人命令，在本次会话中收藏常用命令。
- **受控模型写入**。确认写入候选支持指定的实例参数、类型参数和创建模型组操作。核对当前文档及项目授权后，在 BuildX 和 Revit 中逐次确认。需要检查模型变化时可用回滚预览。若请求超时且结果未知，按原请求查回执，避免重复执行。
- **项目自动应用预览**。在独立候选中，明确授权后可在绑定项目内自动提交支持的实例参数和模型组操作。类型参数和回滚预览继续逐次确认。已完成受控测试，真实 Revit 事务待验收。
- **水泵族候选**。从对话确认外形尺寸、管口规格和输出位置，生成带进出水连接件的独立卧式端吸泵 `.rfa`。已有内部候选在 Revit 2024 加载。内嵌 WebView 以及生成、保存和重开的实机验收见实施状态。
- **可选对话工具预览**。独立预览提供扫描 PDF 的本机 OCR、确认后生成 Excel，以及通过 Codex 实时搜索和生图。启用方式、依赖和实测范围见[对话工具联调记录](docs/migration/CHAT-LOCAL-TOOLS-20261115.zh-CN.md)。

当前为内部测试阶段，候选安装包标记为 `releaseReady:false`。当前集成候选验证以 Windows x64 / Revit 2024 为主。早期双版本候选覆盖 Revit 2025 的指定构建 `25.0.2.419`。请根据对应候选的构建记录核对功能与验收范围。[实施状态](docs/migration/STATUS.md) · [双版本安装记录](docs/migration/CONFIRMED-WRITE-DUAL-20261108.zh-CN.md)

## 安装与使用

1. 使用团队提供、与 Revit 版本匹配的内部候选。准备 WebView2 Evergreen Runtime x64、Node.js x64 22.17 或更新版本、Python 3.11 或更新版本及 `pypdf`，并确认已有可运行和登录的 `codex.exe`。
2. 保存工作并退出相应的 Revit。完整解压候选，运行 `BuildX-Setup.cmd`，选择目标 Revit、现有运行程序、程序目录及独立数据目录，再检查安装计划。更新已有安装时先核对并备份旧插件清单，保留历史数据。[安装与回退](docs/migration/CONFIRMED-WRITE-DUAL-20261108.zh-CN.md)
3. 启动对应的 Revit，在功能区点击 **BuildX** 打开侧栏。先连接 Codex，在测试模型中执行一条只读查询。需要应用修改时，先选择项目访问范围，再核对待确认的文档、目标及操作。

若 Codex 路径检测出现歧义，在安装向导选择现有 `codex.exe` 的绝对路径。源码运行可用 `BUILDX_CODEX_EXE` 指定同一类路径。[Codex 运行时选择](docs/migration/LOCAL-RUNTIME-SELECTION-20261114.zh-CN.md)

## 从源码开发

在 Windows 的仓库根目录安装锁定依赖，运行入口语法检查和目标回归。部分测试通过系统已有的 .NET Framework C# 编译器运行受控宿主夹具。

```powershell
npm ci --ignore-scripts
npm run check
npm run test:native-queries
npm run test:layout
```

构建 Revit 2024 确认写入候选时，指向本机 Revit 2024 API、已还原的官方 WebView2 NuGet SDK `1.0.2478.35` 目录，以及新的输出目录。将示例路径替换为本机路径。构建和打包可在 Revit 安装入口之外完成。[安装器与打包说明](tools/buildx-setup-readme.md)

```powershell
New-Item -ItemType Directory -Force '.\artifacts' | Out-Null
.\revit-addin\build.ps1 -IsolatedBuild -ConfirmedWrite `
  -RevitDirectory 'C:\Program Files\Autodesk\Revit 2024' `
  -WebView2PackageDirectory 'C:\path\to\microsoft.web.webview2\1.0.2478.35' `
  -OutputDirectory '.\artifacts\buildx-revit2024'

node tools/buildx-installer.mjs --build-confirmed-write-candidate `
  '.\artifacts\buildx-candidate' '.\artifacts\buildx-revit2024' '0.8.9-local-test'
```

## 项目导航

| 位置 | 用途 |
| --- | --- |
| [`revit-addin/`](revit-addin/) · [`family-core/`](family-core/) | Revit 插件、原生命令与族能力 |
| [`server.mjs`](server.mjs) · [`lib/`](lib/) · [`public/`](public/) | 本地服务、Codex 连接、权限与回执、Web 界面 |
| [`tools/buildx-installer.mjs`](tools/buildx-installer.mjs) · [`buildx-installation.example.json`](buildx-installation.example.json) | 安装器入口与配置模板 |

- [版本记录](CHANGELOG.md) · [实施状态](docs/migration/STATUS.md) · [任务台账](docs/migration/TASKS.json)
- [运行布局](docs/migration/RUNTIME-LAYOUT.zh-CN.md) · [原生迁移规划](docs/migration/NATIVE-DEPENDENCY-REPLACEMENT.zh-CN.md)
- [第三方公告](THIRD-PARTY-NOTICES.md)

本仓库未指定通用开源许可证。第三方组件各自适用的许可见上述公告。
