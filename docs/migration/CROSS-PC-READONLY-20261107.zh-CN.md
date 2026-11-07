# BuildX 跨电脑内部只读测试安装说明

版本 `0.8.8-cross-pc-test.2`，用于 Windows x64、Autodesk Revit 2024 的内部试用。测试范围为模型概况、当前选择、标高和构件搜索四项原生只读查询。测试使用单独的程序目录、数据目录和测试模型。真实客户机首装与 Revit 内嵌面板待验。

本机已验证的安装档案名为 `BuildX-Revit2024-x64-0.8.8-cross-pc-test.2.zip`，SHA-256 为 `edad89a4553a036be73a7ce56aa858143a02de01d4faabcf15a5c2ac86a3d974`。源码分支保留构建入口与说明。安装档案独立交付。[构建和预检入口](../../tools/buildx-setup-readme.md#跨电脑只读测试包)

已核对 ZIP 解压后的 136 个清单文件、隔离安装、Edge 面板和真实本机 Codex 四工具握手。同步前在独立工作树重建候选，引用真实 Revit 2024 API 编译 36 份 C#，相关 Node 测试 119/119，受控只读宿主 8/8，默认宿主 102/102。历史重开仍有一项基线失败。测试范围为首装和只读链路。

## 安装前准备

- 已安装并可运行 Revit 2024，以及 Microsoft Edge WebView2 Evergreen Runtime x64。[Autodesk 系统要求](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Revit-2024-products.html) · [Microsoft WebView2 Runtime](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)
- 已安装 Node.js x64 22.17 或更高版本，以及 Python 3.11 或更高版本。向导所选 `python.exe` 需要能运行 `python.exe -c "from pypdf import PdfReader"`。如果缺少库，用同一个 Python 执行 `python.exe -m pip install pypdf`。
- 已有可运行的 `codex.exe`，支持 `app-server`，并由使用者自行完成 Codex 登录。发现程序或版本不代表登录和模型访问已验证；安装器不会复制或升级 Codex，也不会复制登录凭据。
- 准备两个互不重叠且尚不存在的新目录，分别作为程序目录和数据目录；它们的父目录必须已存在，且不得与解压目录或 Revit 插件目录重叠。

## 安装

1. 将 ZIP 完整解压到新目录，保留目录结构。保存模型并退出所有 Revit 进程。
2. 在解压目录双击 `BuildX-Setup.cmd`。如 Node 未自动识别，选择已有的 `node.exe` 并重新检测；选择对应的 `python.exe` 和 `codex.exe`。找不到 Codex 时可通过向导中的官方安装说明处理，再重新检测。
3. 核对解压后的组件目录、两个新的程序和数据目录，以及当前 Windows 用户的 `%APPDATA%\Autodesk\Revit\Addins\2024`。如果插件目录不存在，请先在文件资源管理器中创建该目录。该测试包使用本机端口 `41873`。
4. 点击“检查安装计划”，阅读依赖、目标路径及冲突提示。只有计划允许后才点击安装并确认；不要绕过阻断项或覆盖现有插件。如果提示现有 BuildX 插件或相同插件 ID 冲突，请保留现有文件并先核对，不要直接删除。
5. 安装完成后启动 Revit 2024，打开测试模型并打开 BuildX 面板。测试 DLL 未签名，若出现加载提示，先核对它指向本次安装目录中的 `revit-addin\bin\LocalCodexRevit.dll`，再按本机策略选择。若 Windows PowerShell 脚本策略阻止向导，请保留提示并核对本机策略。

## 基本验证

在面板中依次查看模型概况、选择少量构件后读取当前选择、读取标高、按条件搜索构件，核对结果与模型一致。随后用自己的 Codex 登录状态发起一轮简单 AI 对话，并请求读取上述只读信息；确认实际回复和工具回执。若查询等待过长或状态未知，保留原回执，不要自动重发。测试成功需要实际看到结果；安装完成或检测到可执行文件不等于验证通过。

## 问题与回退

安装计划失败时保留提示信息；安装中断时保留安装器报告中的程序和数据目录，不要反复覆盖安装。运行问题请记录发生时间、操作、界面提示和相关回执；日志和队列位于所选独立数据目录中，分享前检查并移除账号信息、项目资料及其他敏感内容，不要发送密钥。

如需停用，先保存并退出 Revit，确认 `%APPDATA%\Autodesk\Revit\Addins\2024\BuildX.addin` 确实由本次安装生成并指向本次新程序目录，再将该清单移至安全备份位置；保留程序目录、数据目录和原有其他插件。重新打开 Revit 后核对试用插件已停用。程序回退不会撤销模型或云端操作；本测试不自动迁移或删除用户数据。遇到身份不明确或已有插件冲突时先停止并核对。
