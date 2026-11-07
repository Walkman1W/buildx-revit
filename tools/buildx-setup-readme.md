# BuildX Windows 安装向导开发候选

## 跨电脑只读测试包

包含 `buildx-test-scope.json` 的只读测试包使用独立的内部安装计划。运行包根目录中的 `BuildX-Setup.cmd`，按同目录的 `INSTALL.zh-CN.md` 核对环境与步骤。向导验证 Windows x64、Revit 2024、WebView2 Runtime、目标机自有运行程序、包文件和只读宿主编译证据，再登记当前 Windows 用户的 Revit 2024 插件。范围为对话与模型概况、选择、标高和构件搜索四项只读查询。以下通用开发候选说明中的发布阻断适用于原有完整功能候选。

构建该包时，使用 `revit-addin/build.ps1 -IsolatedBuild -NativeReadonlyTest` 编译宿主，并运行 `node tools/buildx-installer.mjs --build-native-readonly-candidate <新目录> <插件输出目录> <版本>`。专用 CLI 安装入口是 `--plan-internal-test` 和 `--apply-internal-test`，参数与普通预检和安装一致。内部测试继续标记为 `releaseReady:false`。

## 通用开发候选

在候选包根目录双击 `BuildX-Setup.cmd` 可打开开发候选向导；从源码目录测试时可双击 `tools/buildx-setup.cmd`。向导需要同目录 `buildx-setup.ps1`、`buildx-installer.mjs` 及父目录的 `lib/local-runtimes.mjs`。当前候选尚不是完整安装包。

窗口首次显示时，如果已从 PATH 找到可信的 `node.exe`，会自动执行一次只读检测；否则请手动选择已有的 `node.exe` 再点击“检测 / 重新检测已有程序”。找到 Codex 后会预填其路径；检查仅识别路径，不代表 Codex 已登录或版本、工具协议兼容，已有登录由 BuildX 启动后的账号和工具握手确认。若找不到可直接运行的 `codex.exe`，可点击官方安装说明，安装完成后点击“重新检测”，或手动选择已有程序。检测变为缺失或歧义时会清除上次自动填入的旧路径；手动输入或选择的路径会保留，并在安装计划中检查。不会自动安装或升级 Codex。CLI 安装仅提供命令包装、或新安装的 PATH 尚未被向导进程读取时，自动检测可能无法定位 `codex.exe`，需手动选择或重新打开向导；检测到多个无法确定的候选时不会猜选。

向导会检查两个确定的位置：`tools` 的父目录，或其父目录下的 `package` 子目录。如果恰有一个目录包含 `buildx-package.json`，会预填该目录；找不到或两个位置都有时请手动选择。预填仅表示发现清单，安装计划仍需重新核查包及依赖。

开发候选的双击入口需要以下布局：

```text
候选根目录/
  BuildX-Setup.cmd               # package 根入口；源码运行时可省略
  tools/buildx-setup.cmd
  tools/buildx-setup.ps1
  tools/buildx-installer.mjs
  lib/local-runtimes.mjs
  package/buildx-package.json    # 及清单所列的全部资源
```

也可把 `tools/` 与 `lib/` 放在候选包根目录；此时 `buildx-package.json` 与它们同级。请保留脚本引用关系和清单资源，不要把单个 cmd 文件当作独立安装包。

填写候选包、安装目录、独立数据目录和 Revit 2024 Addins 目录后点击“检查安装计划”。数据目录必须是新的规范绝对路径，父目录已存在且没有链接，与程序、包、Addins 均不重叠；已有数据不会被自动接管或迁移。候选缺项、已有插件冲突、Revit 运行或其他不可确认状态均会阻止安装。只有检查允许后，安装按钮才可用，点击后还需明确确认。更改任何路径（包括数据位置）都会使旧计划失效。安装使用后端同一所有者再次验证，不会读取或复制 Codex 登录凭据。

新安装写入 schemaVersion=2 的 `buildx-installation.json` 和独立数据根的 `buildx-data-owner.json`。程序资源保持在安装目录；聊天、附件、资料引用、日志、队列和回执由共享数据布局放在独立数据根。程序私有运行时预留 `private-runtime/`，当前候选仍使用明确选择的已有 Node 22.17+、Python 3.11+，不代表已经捆绑运行时；Codex 始终为用户已有程序，不复制或升级。旧 schemaVersion=1 的读取兼容不表示自动迁移，升级/回退/历史恢复仍需单独验收。

当前候选尚未完成完整功能、真实客户机和商业接入验证，不能作为正式安装包分发。安装器会保留明确的依赖和分发权检查；不要绕过它们。系统 PowerShell 执行策略可能禁止运行本脚本，启动器不修改或绕过这些策略，也不请求管理员权限。

## 首版候选范围与当前阻塞

候选构建清单包含项目资料、命令组合和软件许可等源码资源。是否包含 WebView2 许可与通知文件需以本次候选构建结果逐项核对；文件存在也不等于分发条件已审核通过。PDF 解析需要所选 Python 能导入外部 `pypdf`；安装计划检测此依赖，不自动安装或分发它。资源入包不代表相关功能完成客户验收。

安装计划独立复核清单、导入闭包和必需的非 JavaScript 资源；清空包中的缺项报告不能绕过检查。六项查询已接入自有原生契约，入口清单不再携带 AEC provider、中继或机器专属契约快照；这不证明当前安装的宿主已支持查询。私有脚本编译器可按以下固定来源流程单独纳入内部候选，安装预检重新核对全部载荷、许可证和来源记录；缺项、自改记录或仅删除清单项均不能通过。Argus 运行时及分发权、插件分发权、客户数据升级恢复、许可后端与客户配置等条件仍未验证，当前候选保持 `releaseReady:false` 并阻止实际安装。它不会复制开发机凭据和运行历史。隔离测试使用占位插件，不证明真实 DLL 可发布或加载。

## 内部候选生成

先用 `revit-addin/build.ps1` 的 `-RevitDirectory` 选择 Revit 2024 API，`-WebView2PackageDirectory` 选择官方 NuGet 缓存中的 `Microsoft.Web.WebView2/1.0.2478.35`，`-OutputDirectory` 使用新的绝对目录。没有显式 Revit 路径时仅检查标准安装目录，多个或缺失不会猜选。构建固定官方包 SHA-256，并把三项 SDK 文件及 LICENSE/NOTICE 与原 nupkg 内容逐项核对；WebView2 Evergreen Runtime 是独立外部先决条件，不从系统目录或 AEC 运行目录复制。

然后运行 `node tools/buildx-installer.mjs --build-candidate <新候选目录> <本次插件输出目录> [内部版本] [已核验私有编译器目录]`。按显式资源清单和导入闭包复制，包含锁文件、原始 npm 公告和 schema2 配置模板，不复制整个工程、node_modules 或用户状态。构建来源只发布相对源码路径、摘要和官方 SDK 包信息；原构建记录的开发机绝对路径不会进入候选。SDK 和插件文件存在不代表真实 Revit 或客户机验收已完成，缺项与阻塞保存在 `buildx-package.json`。

私有 C# 编译器使用官方 NuGet `Microsoft.Net.Compilers.Toolset 5.0.0` 原包；固定 SHA-256/SHA-512、16 项载荷与许可证由 `manifests/script-compiler-5.0.0.json` 管理。先自行取得原包，再运行 `powershell.exe -NoProfile -File tools/provision-script-compiler.ps1 -Nupkg <原包绝对路径> -OutputDirectory <全新私有编译器目录>`。该脚本不下载、不安装系统运行时、不覆盖已有目录；候选只复制核验通过的 17 项文件至 `private-runtime/script-compiler/`。原包的 MIT nuspec、ThirdPartyNotices 和官方 Roslyn 对应提交的 License 一同保留。未指定编译器目录时继续记录缺项。

此 Toolset 包依赖机器已有 .NET Framework 4.7.2+，官方不支持将其长期作为旧 MSBuild 的升级替代；当前只验证内部候选中的直接 `csc.exe /noconfig @rsp` 路径。离线测试可设置 `BUILDX_SCRIPT_COMPILER_DIR`、`BUILDX_SCRIPT_COMPILER`、`BUILDX_REVIT_API_DIR` 后运行 `npm run test:compiler`，真实 API 只参与编译引用，不会加载生成的用户脚本 DLL 或调用 Revit。没有显式选择 compiler/API 时相关案例明确跳过，不计为验收。

安装预检 CLI 使用 `--plan <组件目录> <新程序目录> <已有Addins目录> <node.exe> <python.exe> <codex.exe> <新独立数据目录>`，只检查，不发布插件。真实 `--apply` 仍需本次具体安装授权，当前候选阻塞不会被构建成功自动解除。
