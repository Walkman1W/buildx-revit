# Revit 2024 内部候选

日期：2026 年 11 月 5 日。版本 `0.8.1-internal`，Windows x64 / Revit 2024。已生成可审阅运行包与完整源码快照，**`releaseReady:false`，安装器仍阻止实际安装**。本轮没有替换已装 DLL/Addins、重启既有服务、加载新插件、写真实模型或公开发布。

## 本机产物

| 产物 | 位置 | 实际内容 |
| --- | --- | --- |
| 运行包 ZIP | `artifacts/BuildX-Revit2024-0.8.1-internal-20261105.zip` | 123 个显式产品文件和清单；ZIP 共 124 文件，1,086,373 字节 |
| 源码 ZIP | `artifacts/BuildX-Source-0.8.1-internal-20261105.zip` | 227 个白名单源码/测试/必要资源及两份清单；ZIP 共 229 文件，983,301 字节 |
| 运行目录 | `artifacts/buildx-revit2024-internal-20261105-03` | 运行包的未压缩核对对象，产品文件合计 3,150,406 字节 |
| 源码与隔离构建 | `artifacts/buildx-source-20261105-02` | `source/` 为完整快照，`build/` 为从该快照实际编译的产物 |
| 机器可读记录 | `docs/migration/internal-candidate-verification.json` | 源码、构建、包、ZIP 和测试摘要及未验范围 |

运行 ZIP SHA-256：`9b97e3cec2ea0ada76d066b260f43c5a1c2869ff7538bd2d4b8531ddb92c93ec`。

源码 ZIP SHA-256：`86001cd54bff1ab07759f79638f24c4271d29687052e2a7a17c89c5d450c5afb`。

最终 DLL SHA-256：`728dbffd2d8806d41f2da2955a6c1660b732417fb231696031cb9fba04846de4`。

旧的 `-01`、`-02` 运行目录是本轮中间检查记录；以上 `-03` 和两个 ZIP 是最终审阅对象，旧目录未覆盖或删除。

## 实际变化与核对

- schema 2 将程序资源、程序私有执行资源与用户数据分开；Node/MCP/C# 读取同一配置及数据归属标记。schema 1 保留旧位置，不自动迁移历史和未知回执。详见 `RUNTIME-LAYOUT.zh-CN.md`。
- 程序不再使用旧 DevelopmentRoot、个人 Node 例外或 Python 的 Codex 缓存兜底。ScriptRunner 和仍有消费者的 Argus 适配器源码保留，但执行资源只能从程序的 `private-runtime` 取；研究载荷未复制。
- WebView2 SDK 三项文件及原 LICENSE/NOTICE 从官方 NuGet `Microsoft.Web.WebView2 1.0.2478.35` 取得；原包固定 SHA 和五项载荷逐项核对。WebView2 Evergreen Runtime 单列为外部前提，未从系统或 AEC 运行目录复制。
- 完整源码快照校验 160 个 JS 模块、470 条依赖/资源引用，缺项为 0；覆盖动态字面量导入、网页路由、HTML/CSS、非 JS helper、源码测试入口及全部 32 项 C# 编译输入。然后从快照独立完成真实 Revit 2024 API 引用编译，源码前后摘要一致。
- 运行包 123 个文件哈希全部匹配；95 个 JS/MJS、297 条导入无缺项，无 bare npm 导入。SDK/AJV 当前只用于源码测试，运行包不带 `node_modules`；运行包的 package/lock 已投影为零 npm 运行依赖，仅保留已交付 `start`、`check` 脚本。若未来加入 npm 运行依赖，构建和预检会明确阻塞。
- 修复注册入口漏包：注册页及样式已纳入显式 WEB 清单。程序 DLL 以 `/debug-` 构建，PE 中调试目录为 0；包内未发现本机开发根/个人目录字节。包中没有模型、历史、队列、配置实例、凭证、研究程序集或推理程序。
- 两份 ZIP 的每个条目均回读比对哈希；再解压到唯一临时目录验证。无 `node_modules` 的运行包实际完成生产 MCP 目录握手：默认 42 项、workspace 20 项，均保留六项原生输出契约，无 stderr、无队列创建。源码 ZIP 解压后清单与闭包校验通过。

## 验证结果和限制

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm run check` | 通过 | 源码入口语法 |
| `npm run test:native-queries` | 181/181，0 跳过 | 六查询契约、实际 C# 方法的受控 peers、Node 队列、真实 MCP 客户端与回执 |
| `npm run test:layout` | 105/105，0 跳过 | 配置/归属、外置队列/命令库、视觉资产隔离、预检、向导、目录替换与源码闭包 |
| 受控宿主检查 | 80/80 | 原生产调度、身份和请求验证；Host 源码摘要仍匹配 |
| 从完整快照编译 | 32 项 C# 输入，exit 0 | 真实 Revit 2024 API 引用；没有加载 Revit 插件 |
| ZIP 内容与解压复核 | 124/229 个条目全部匹配 | 传输和解压后的源/运行文件一致，MCP 目录可以启动 |

真实 Revit API 查询、WebView/Codex 对话联动、实际安装、客户机、首装升级/回退及性能效果仍未验收。没有将 MCP 成功或 API 引用编译称为模型执行成功。

## 保留阻塞

运行包的五项缺项仍记录在 `buildx-package.json`：未替代 Argus 功能的恢复载荷及分发条件、私有脚本编译器、外置 Node 引导、Node/Python 运行时方案和 WebView2 Runtime 客户机状态。完整安装预检还独立保留插件分发条件、PDF 的外部 pypdf、数据升级恢复、客户许可后端/配置及客户验收约束；删除包内 missing 数组不能放行。

这些阻塞不会因已经生成 ZIP 而清除。下一步需要收敛首版实际交付功能及未交付执行资源，完成相应来源和运行验证后，才准备针对指定测试目录、指定 Revit 2024 实例的安装/加载授权。当前产物用于审阅，不能直接替换用户现有插件。

## 重建入口

从私有分支源码或源码 ZIP 的快照使用统一入口，不依赖旧 REA/AEC 工程。需要明确选择已有 Node、Revit 2024 API 与上述固定版本的官方 NuGet SDK 缓存；不下载、安装或升级 Codex。

```powershell
node tools/build-brain-candidate.mjs build "<新的快照目录>"
powershell.exe -NoProfile -File "<快照>/source/tools/build-brain-candidate-build.ps1" -Candidate "<快照>" -RevitDirectory "<Revit2024目录>" -WebView2PackageDirectory "<官方SDK包目录>"
node "<快照>/source/tools/buildx-installer.mjs" --build-candidate "<新的运行候选目录>" "<快照>/build" 0.8.1-internal
```

所有输出目录必须新建且不存在。已解压的源码 ZIP 已有快照及白名单，可直接从第二步开始。运行包不是测试源码包；如需跑源码回归，将 `source/` 复制到另一个工作目录后按锁执行 `npm ci --ignore-scripts`，保留原快照不变。本轮证明可按源码和固定 SDK 重建，未宣称 DLL 的时间戳/MVID 字节级确定性。
