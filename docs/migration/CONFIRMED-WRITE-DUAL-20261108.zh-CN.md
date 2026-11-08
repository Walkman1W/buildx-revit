# BuildX 双版本读写版安装说明

版本 `0.8.8-confirmed-write.1`，适用于 Windows x64、Revit 2024 和 Revit 2025 初始版 `25.0.2.419`（`20240307_1300(x64)`）。一个 ZIP 包含两版各自的 DLL 和同一套 BuildX 界面。此版保留模型查询、资料库、选择 ID 预览和 Codex 对话，开放单个实例参数、类型参数和模型组创建三类具名写入。

## 安装前准备

- 目标机已有对应 Revit、WebView2 Evergreen Runtime x64、Node.js x64 22.17+、Python 3.11+ 及 `pypdf`。用向导选定的 Python 运行 `python.exe -c "from pypdf import PdfReader"`，缺失时用同一个 Python 执行 `python.exe -m pip install pypdf`。
- 目标机使用自己已登录且支持 `app-server` 的 `codex.exe`。安装向导只记录所选程序路径，登录仍由本机 Codex 管理。
- 2025 组件限定上述完整构建，预检会核对目标电脑上两份 Autodesk API 文件。DLL 和 WebView2 加载组件位于 ZIP 内 `packages/2024/revit-addin/bin/` 和 `packages/2025-net8/revit-addin/bin/`。

## 从只读版切换

先保存模型，退出全部 Revit。在对应年份的 Addins 目录找到旧 `BuildX.addin`，用记事本核对其中 `Assembly` 指向旧版的程序目录，再将该 `.addin` 移到 Addins 目录外备份。每个已安装年份分别处理，保留旧程序和旧数据目录。若提示系统级 Addins 中存在相同插件 ID，也先核对它的来源和归属。

新安装用新数据目录。旧版聊天、资料和回执保留在旧数据目录，可随旧版恢复。当前向导按独立安装处理历史数据。

## 安装

1. 完整解压 ZIP，双击顶层 `BuildX-Setup.cmd`。向导读取当前电脑已安装的 Revit 和可用运行程序。必要时手动选 `node.exe`、`python.exe` 和 `codex.exe`。
2. 选择一个 Revit 版本。核对其程序、数据和 Addins 路径，点击“检查安装计划”，检查通过后点击安装并确认。另一版重复一次。
3. 打开对应 Revit，加载 BuildX，打开已保存的项目模型。在输入栏将访问权限设为「项目范围」，选择模型所在目录并授权，再选「确认后应用」或「回滚预览」。每次应用或预览先在 BuildX 核对本次操作，再在 Revit 弹窗确认。选择「否」或等到请求到期后，提交会被拒绝。模型保存由使用者在 Revit 内完成。

| Revit | 当前用户的插件目录 | 本地服务端口 |
| --- | --- | --- |
| 2024 | `%APPDATA%\Autodesk\Revit\Addins\2024` | `41876` |
| 2025 初始版 | `%APPDATA%\Autodesk\Revit\Addins\2025` | `41877` |

如需回退，退出 Revit，核对并备份这次生成的 `BuildX.addin`，把对应年份的旧入口放回原处。保留两版的程序、历史和回执。插件回退不会改变 Revit 中已提交的模型操作。

## 使用范围和验证

模型组命令使用明确的构件 ID。逐层读取墙体构造并自动分类仍需专用查询。此包的模型写入限定为上面三类，任意脚本、终端、族写入及其他尚未纳入的操作保持关闭。

两版已用真实 Revit API 编译，安装与审批通过隔离测试。实际 Revit 加载、WebView 和真实模型事务需要目标机验收。第一次检查可用单独的项目副本，先用「回滚预览」核对确认和回执，再验证实际提交。
