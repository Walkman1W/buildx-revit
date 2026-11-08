# BuildX 2026-11-08 交付完结报告

本次交付版本为 **`0.8.8-confirmed-write.1`**，是 2026 年 11 月 8 日最新的 BuildX 安装版本。交付状态为私有仓库草稿，安装包与源码已对齐。目标机实机验收留在交接清单中。

| 用途 | 交接入口 |
| --- | --- |
| 安装到另一台电脑 | [下载读写版 ZIP](https://github.com/Walkman1W/buildx-revit/releases/download/untagged-162d501b9c7abb435ecd/BuildX-Revit2024-2025-x64-0.8.8-confirmed-write.1.zip) |
| 查看发布说明及校验文件 | [私有 GitHub 草稿](https://github.com/Walkman1W/buildx-revit/releases/tag/untagged-162d501b9c7abb435ecd) |
| 继续修改源码 | [交接分支 `codex/revit-confirmed-write-20261108`](https://github.com/Walkman1W/buildx-revit/tree/codex/revit-confirmed-write-20261108) |
| 复现安装包 | [构建提交 `fd31bf1`](https://github.com/Walkman1W/buildx-revit/commit/fd31bf183e54a197fcd317dd53b28da230b9078e) |

ZIP SHA-256 为 `8dfd6dc4cf293df6348b2da5982cf0011cdef5292249940882fc104a8662d025`。

## 本版范围

- 一套向导检测 Windows x64 上的 Revit 2024 和 Revit 2025 初始版 `25.0.2.419`（`20240307_1300(x64)`）。两版分别注册用户 Addins，使用各自的程序与数据目录，服务端口分别为 `41876` 和 `41877`。
- 保留项目资料、Codex 对话、具名查询、紧凑输入栏和当前选择 ID 展开。本机 Codex 握手确认了含 49 项只读工具的目录。
- 模型写入覆盖单个实例参数、类型参数和按明确构件 ID 创建模型组。应用与回滚预览均由 BuildX 和 Revit 逐次确认，宿主执行前复核当前文档、项目授权和请求期限。逐层读取墙体构造并自动分类仍待单独接入。

## 接手方式

**安装使用。** 退出两版 Revit，把同年份旧 `BuildX.addin` 移到 Addins 目录外备份。完整解压 ZIP，运行 `BuildX-Setup.cmd`，按年份分别检查和安装。旧程序、聊天和回执留在原目录，新版使用独立数据目录。目标机需要已有 Node.js x64 22.17+、Python 3.11+ 与 `pypdf`、WebView2 Runtime 和已登录的 `codex.exe`。安装、权限设置和回退详见[双版本安装说明](CONFIRMED-WRITE-DUAL-20261108.zh-CN.md)。

**继续开发。** 在另一台电脑登录有仓库权限的 GitHub 账号，克隆交接分支并打开 `BuildX` 源码目录。源码分支包含本报告，草稿附件固定在表中的构建提交。

```powershell
git clone --branch codex/revit-confirmed-write-20261108 https://github.com/Walkman1W/buildx-revit.git BuildX
```

Revit 加载对应的 `LocalCodexRevit.dll`，WebView2 显示本地面板。Node 服务调用目标电脑的 Codex，Revit 宿主执行具名命令并返回原回执。[安装向导](../../tools/buildx-setup.ps1) · [安装器](../../tools/buildx-installer.mjs) · [本地服务](../../server.mjs) · [Revit 宿主](../../revit-addin/WorkbenchHost.cs)

需要重打包时用各版本的 Revit API。2024 运行 `revit-addin/build.ps1`，加上 `-IsolatedBuild -ConfirmedWrite`。2025 运行 `revit-addin/2025/build.ps1`，使用签名匹配的 API 和 .NET SDK `8.0.427`。两版 WebView2 SDK 固定 `1.0.2478.35`。组件打包入口和产物规则见[安装器构建说明](../../tools/buildx-setup-readme.md#私有双版本确认写入候选)。

## 验证与交接

| 已验证 | 结果 |
| --- | --- |
| 编译与组件 | 两版用真实 Revit API 编译，ZIP 回读核对 282 个文件条目，GitHub 重新下载后的 SHA-256 一致 |
| 安装演练 | 两版隔离首装通过，旧数据保留，同 ID 插件冲突和 2025 构建错配均被阻断 |
| 运行与审批 | 两版隔离服务完成本机 Codex 握手并退出，未确认的写入、自动应用和完全访问请求均被拒绝 |
| 回归 | 安装布局 115/115，权限 97/97，界面 49/49，原生读取 12/12，受控宿主 109/109 |

换机后分别打开两版 Revit，在项目副本检查插件加载、内嵌面板、选择 ID、Codex 对话及写入回执。先核对回滚预览，再按需验证一次实际提交与手动保存。真实 Revit 事务、目标机 WebView 和 Codex 模型对话均以这次实机结果为准。
