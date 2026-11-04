# 私有 C# 编译器与内部候选验证

日期：2026 年 11 月 5 日。已为保留的 ScriptRunner 建立官方来源、固定载荷和候选包校验，并实际通过七项生产脚本离线编译。新候选版本为 `0.8.1-internal-compiler`，**`releaseReady:false`，仍不能安装**。本次未替换用户 DLL/Addins、重启既有服务、执行真实 Revit 操作或发布正式版本。

## 实际变化

`manifests/script-compiler-5.0.0.json` 是来源与字节清单的唯一 owner。`tools/provision-script-compiler.ps1` 仅接受显式官方原包和全新输出目录，校验 SHA-256/SHA-512、nuspec ID、版本及 MIT 声明后提取 16 项固定文件，再写入来源记录。原包的 nuspec、ThirdPartyNotices.rtf 和对应官方 Roslyn 提交的 License.txt 均保留。17 文件共 16,200,956 字节；不复制 VB、交互式编译器或编译服务器，不安装全局 SDK/运行时。

原包来自 [官方 NuGet](https://www.nuget.org/packages/Microsoft.Net.Compilers.Toolset/5.0.0)，SHA-256 为 `e3f0207e7a8caf2cf79ad8f276eb20b2b880b3a7bb0e8ad27b4d3183d0a81627`，下载大小 22,199,160 字节，SHA-512 与官方 catalog 相符。License 原文来自 [Roslyn 对应提交](https://raw.githubusercontent.com/dotnet/roslyn/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09/License.txt)。Toolset 要求已有 .NET Framework 4.7.2+；官方说明该包不是长期升级旧 MSBuild 的受支持方案。本次验证的是内部候选直接调用 `csc.exe /noconfig @rsp`，不将包来源和许可证保留等同于客户机或正式分发验收。

`lib/script-compiler-package.mjs` 按固定清单重新核验文件、字节数、摘要、来源记录和目录归属，拒绝额外文件、链接及自改记录。候选构建在核验后读取载荷时再次绑定固定摘要；安装预检同时把清单中的复制 SHA 绑定到 owner 摘要，防止两个检查之间切换文件造成来源与复制内容脱节。删除 missing、删除文件清单项或修改来源记录不能解除阻塞。只有这条编译器缺项通过本身验证后移除，其他条件继续独立检查。

现有 `revit-addin/ScriptRunner.cs` 的权限、文档身份、事务、取消和未知回执路径未改。旧建模 opt-in 测试改用显式 compiler/API 选择和新证据目录，退出研究路径、固定 Revit 盘符及旧 workbench 输出。

## 已执行检查

| 检查 | 结果与范围 |
| --- | --- |
| compiler 来源/载荷与安装目标组 | 16/16，0 跳过；真实 17 文件 payload，含改字节、缺依赖/许可证、链接、自改 stamp、核验/复制间切换及 manifest/owner SHA 不一致 |
| 实际生产 preparation 与离线编译组 | 3/3，0 跳过；七个实际编译案例全部 exit 0，compiler `5.0.0-2.25567.12 (6c4a46a3)` |
| 七个编译案例 | 旋转、放族、放门、建楼板、门朝向、结构化参数、中文 C#14 `nameof(List<>)`；真实 Revit API/UI `24.3.30.11` 仅作编译引用 |
| 六查询回归 | 181/181，0 跳过；48 个 Git 跟踪 C# 文件在检查前后逐文件摘要一致 |
| 布局/安装/闭包回归 | 最终 105/105，0 跳过；首次遗漏建模测试的源码白名单导致 1 项失败，补齐后完整重跑通过 |
| 完整源码快照与构建 | 235 文件，166 JS 模块、487 条依赖/资源引用无缺项；32 项 C# 输入从快照独立通过真实 Revit 2024 API 引用编译 |
| 最终运行包 | 142 产品文件、19,369,557 字节；96 JS/MJS、301 条导入无缺项或 bare npm 依赖，所有清单摘要匹配；未发现本机开发根/个人目录字节，产品 DLL 调试目录为 0 |

离线 helper 提取实际生产 preparation、wrapper 和 RSP，仅把 `typeof(...).Assembly.Location` 替换为显式 API 文件，沿用生产 `/noconfig`、30 秒单次期限和 GC 环境。生成 DLL **没有加载**，没有实例化 UIApplication，也没有执行模型事务。实际七案证据为 `artifacts/script-compiler-offline-20261105-01/summary.json`，SHA-256 `d0346d822883320fb70f41fc76688a47a34667bcd988f9892c7713503ba038fc`；源码、RSP、DLL 均逐项回读一致。

默认 `npm run test:compiler` 会明确跳过未选择的外部编译器/API 案例。此次来源与安装组显式选择了真实 compiler；七案另以显式 compiler/API 运行。旧 `BUILDX_COMPILE_MODELLING` 重复入口在合并静态检查中跳过一次，不当作新增验收。

## 产物与未验项

最终源码位于 `artifacts/buildx-source-20261105-04/source`，对应隔离构建位于同级 `build`；运行包目录为 `artifacts/buildx-revit2024-compiler-20261105-02`。中间 `-03` 源码、`-01` 运行目录保留为检查过程证据，最终对象以上述新目录为准。ZIP 与逐条目回读/解压记录见 `script-compiler-verification.json`。

| ZIP | 字节 / 条目 | SHA-256 |
| --- | --- | --- |
| `artifacts/BuildX-Revit2024-0.8.1-internal-compiler-20261105.zip` | 7,637,777 / 143 | `5e48d86ca343fa4017a64e292ce3b1c35b0a836ae515d7d89702c8e8b576e989` |
| `artifacts/BuildX-Source-0.8.1-internal-compiler-20261105.zip` | 1,010,404 / 237 | `e37dd7bc7f78ff992456e2c3444b43a361b7ca9abe687c6c2a1d88a003bb8f8d` |

全部条目摘要回读相符。新临时目录解压后，运行包的固定 17 文件 compiler 核验通过，源码包的 235 文件及闭包核验通过且不含 build 产物。无 node_modules 的解压运行包以生产 workspace profile 完成真实 stdio MCP 目录握手：20 项工具及六查询齐全，子进程 exit 0；只发送 initialize/initialized/tools/list，未调用模型工具或创建队列。临时目录验证归属后清理。该结果只证明目录启动和包完整性。

运行清单仍保留四项缺项：未替代 Argus 载荷及分发条件、外置 Node 引导、Node/Python 私有运行时分发、WebView2 Runtime 客户机状态。完整安装预检另保留插件分发条件、Python/pypdf、客户数据升级恢复、许可后端/配置等检查。真实 Revit 加载、用户脚本执行、WebView/Codex 联动、实际安装、干净客户机和恢复卸载均未验证。

本轮仅消除研究编译器来源和私有布局这一项。下一步按命令台账完成常用参数命令的具名原生切片，继续沿用现有权限、队列、取消与原回执核对；原生系统图、标注及仍有消费者的 Argus 退出条件保持单列。
