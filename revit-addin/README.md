# Revit 2024 本地 Codex 面板

独立 `IExternalApplication`，添加 **BuildX → BuildX** 按钮和右侧可停靠 WPF 面板。点击图标或面板的“启动并重新连接”都会检查并按需拉起本地服务。面板只打开固定地址 `http://127.0.0.1:41873/`，不切换端口。

默认采用手动启动：等待 Revit 启动完成后，点击功能区的 **BuildX** 按钮打开面板并按需拉起本地服务。功能区的 **自动启动：开/关** 按钮可选择是否在下次 Revit 启动时自动打开 BuildX，默认关闭，设置保存在当前 Windows 用户的注册表中；已明确开启的设置会保留。关闭自动启动不会停止已运行的服务；点击 BuildX 或面板中的“启动并重新连接”仍可手动打开并启动服务。设置无法读取时显示“未知”，不自动启动；设置保存失败会显示提示。若 Revit 在关闭自动启动后恢复了已停靠的面板，该面板会等待用户点击 BuildX 或“启动并重新连接”。

自动或手动打开时，插件先异步检查 `/api/service-identity` 的 `service` 必须为 `revit-local-codex`，并核对安装身份；已运行则复用。该接口仅返回服务名和安装 ID，不读取账号、Codex 就绪状态或工具目录，避免完整 `/api/status` 超过 8 KiB 时误报连接失败。身份响应保留 8 KiB 上限和 5 秒超时。连接被拒绝且确认为无监听时，直接以现有 Node 可执行文件启动当前安装目录中的 `server.mjs`，使用隐藏窗口、`UseShellExecute=false`，不调用 cmd/PowerShell。身份不符或超时不会抢占端口。面板先显示，连接检查和等待服务就绪均异步进行，不等待 Codex 后端初始化。退出 Revit 仅释放自身进程句柄和 WebView2 控件，不终止服务。

身份接口修复需要同时更新本地服务和插件 DLL。Revit 已加载的 DLL 不会在更新清单后热替换，须下次启动 Revit 后生效。

网页仅在首次打开、服务恢复或点击“启动并重新连接”时导航。隐藏后重新打开面板、停靠造成的再次 Loaded 事件会保留原网页和当前聊天，不强制刷新。

原版 Argus 和已有 AECModelBridge 不需要改动。0.3 版使用 ExternalEvent 在 Revit 主线程处理本地队列，提供脚本、标注、系统图以及十项查询和建模操作。WebView2 不暴露 HostObjects 或网页直接执行 C# 的入口；模型操作经 MCP 和样例文档核对后调度。WebView2 用户数据独立存放在 `%LOCALAPPDATA%\RevitLocalCodex\WebView2`。

## 构建

```powershell
& 'D:\code\REA\local-codex-panel\revit-addin\build.ps1'
```

使用既有 Windows .NET C# 编译器、已安装 Revit 2024 的 API 和 AECModelBridge 已有的 Microsoft WebView2 SDK 依赖，不安装系统软件。构建只写本目录。

- 源码：`LocalCodexRevit.cs`、`WorkbenchHost.cs`、`WorkbenchActions.cs`、`ScriptRunner.cs`、`ArgusTools.cs`
- 产物与私有 WebView2 SDK 副本：`bin-workbench/`；旧 `bin/` 保留
- 待安装清单：`LocalCodexRevit.addin`（当前指向工作区 DLL）
- 编译日志与输入/输出 SHA-256：`build.log`、`build-record.json`

`build.ps1` 不写用户 Addins 目录、不关闭或重启 Revit。安装若改为复制到别处，清单的 `<Assembly>` 必须指向最终 DLL 路径，并保持两份 WebView2 DLL 和 `runtimes/win-x64/native/WebView2Loader.dll` 的相对结构。

重建的 Argus 学习程序集位于 `../workbench/runtime/2024/ArgusLearning.Core.dll`，完整源码仍在 `../../_reference/argus-source-reconstruction-20261019`。用 `../workbench/prepare-argus-core.ps1` 重建学习程序集；该命令会读取已验证的编译输入、附加 `RecoveredTools.cs` 并复制私有运行依赖。原 DLL 不作为输出。运行中的 DLL 不应替换，更新前先保存模型并关闭相关 Revit。

## 验证边界

BIM-X 图标源文件位于 `../public/bim-x-logo.svg`，对应 PNG 为 `../public/bim-x-logo.png`。构建将 PNG 嵌入 DLL，按钮分别解码为 16 和 32 像素，不依赖外部图标绝对路径。此前图标版本位于 `bin-bim-x/`。0.3 工具扩充版输出到 `bin-workbench-next/`，保留该内嵌图标；实际安装指向以用户 Addins 清单和 `../runtime/install-record.json` 为准。旧目录保留，已打开的 Revit 需在下次启动时加载更新。

编译通过证明 API 引用和语法满足现场组件。真实 Revit 注册、停靠、WebView2 初始化和本地服务连接需安装入口后在 Revit 中验证。面板显示“本地面板已打开”仅说明网页导航成功，Codex 后端连接状态由页面自身显示。

## 官方 API 依据

- [Autodesk Revit 2024 Dockable Dialog Panes](https://help.autodesk.com/cloudhelp/2024/ENU/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Dockable_Dialog_Panes_html.html)
- [Microsoft WebView2 WPF initialization](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.wpf.webview2.ensurecorewebview2async)
- [Microsoft WebView2 environment and userDataFolder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createasync)
