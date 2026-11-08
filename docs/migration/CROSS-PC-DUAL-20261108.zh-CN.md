# BuildX 双版本内部只读测试

版本 `0.8.8-cross-pc-dual-test.1`。适用于 Windows x64、Revit 2024 和 Revit 2025 初始版 `25.0.2.419`（`20240307_1300(x64)`）。向导检查本机安装与完整版本，按选择使用对应的 C# DLL。测试范围为模型概况、当前选择、标高和构件搜索四项原生只读查询。真实 Revit 加载和目标电脑验收需现场完成。

## 安装前准备

- 已安装并可运行对应的 Revit，以及 [Microsoft Edge WebView2 Evergreen Runtime x64](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)。Revit 2025 初始版使用 .NET 8，安装器核对本机 Revit 2025 API 文件版本、构建和摘要。[Autodesk 构建版本表](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-tie-the-Build-number-with-the-Revit-update.html) · [Autodesk .NET 8 迁移指南](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-API/files/Revit_API_Developers_Guide/Introduction/Getting_Started/Using_the_Autodesk_Revit_API/Revit_API_Revit_API_Developers_Guide_Introduction_Getting_Started_Using_the_Autodesk_Revit_API_NET8_Update_html.html)
- 已有 Windows x64 Node.js 22.17 或更高版本，以及 Python 3.11 或更高版本。用向导选定的 `python.exe` 检查 `-c "from pypdf import PdfReader"`，缺失时用同一个 Python 执行 `-m pip install pypdf`。
- 已有支持 `app-server` 的 `codex.exe`，并在目标电脑登录自己的 Codex。BuildX 使用向导选中的程序和该电脑已有的登录状态。

## 安装两版

1. 保存模型并关闭所有 Revit。把 ZIP 完整解压到新目录，双击顶层 `BuildX-Setup.cmd`。
2. 等待自动检测。必要时手动指定 `node.exe`、`python.exe`、`codex.exe`，点击“检测 / 重新检测已有程序”。
3. 从目标下拉框选择 **Revit 2024** 或 **Revit 2025**。使用向导预填的程序与数据目录，或选择各自独立、尚未创建的新目录。当前 Windows 用户的 Addins 目录要存在。若缺失，先打开对应 Revit 一次并退出，或在资源管理器中创建表中的目录。

| Revit | 当前用户插件目录 | 本地服务端口 |
| --- | --- | --- |
| 2024 | `%APPDATA%\Autodesk\Revit\Addins\2024` | `41873` |
| 2025 初始版 | `%APPDATA%\Autodesk\Revit\Addins\2025` | `41875` |

4. 点击“检查安装计划”，确认路径和依赖，点击安装并确认。电脑装有两版时，在同一个向导里切到另一版，再检查并安装一次。遇到已有 BuildX 或相同插件 ID 冲突时保留现有安装，记录向导提示。
5. 分别打开两版 Revit 和测试模型，在功能区打开 BuildX。测试 DLL 未签名。若 Revit 请求确认加载，核对它指向本次程序目录的 `revit-addin\bin\LocalCodexRevit.dll` 后按本机策略处理。

安装前可在解压目录的 `packages/2024/revit-addin/bin/` 和 `packages/2025-net8/revit-addin/bin/` 查看两份 `LocalCodexRevit.dll`。ZIP 同时提供本地 BuildX 面板、服务和 WebView2 加载组件。Revit、WebView2 Evergreen Runtime、Node.js、Python 和 Codex 使用目标机已有的安装。

## 验收与停用

每版分别核对模型概况、选中构件的 ID、标高和构件搜索。再用本机 Codex 发一轮对话，请它读取当前选择，核对回复和工具回执。若发生错误，保留版本号、界面提示和原回执。安装完成、程序可检测和真实 Revit 查询是分开的检查。

停用时先退出 Revit，核实对应版本的 `BuildX.addin` 指向本次安装目录，再移至备份位置。保留程序、数据目录和其他插件。2025 的其他构建会显示缺少对应组件，2025.5 及后续构建使用单独的运行时版本。[Autodesk .NET 10 更新说明](https://help.autodesk.com/view/RVT/2025/ENU/?caas=caas/sfdcarticles/sfdcarticles/Revit--Requirements-for-products-affected-by-the-Microsoft--NET-10-transition.html)
