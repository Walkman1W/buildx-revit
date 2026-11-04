# 自研前端组件的独立构建

此入口只构建 BuildX 的六项 Web 资源，不是客户安装包，也不能单独登录、对话或操作 Revit。`releaseReady` 固定为 `false`。现有研究服务、完整宿主、原版 Argus 和启动器均不改变。

`release/customer-web-assets.json` 是本组件唯一文件白名单，记录原始字节长度、SHA256、资源职责与人工核对的静态依赖。当前 HTML 使用内联图形/CSS 标志，未引用两个独立 logo 文件；它们不进入组件。包中没有后端、MCP、DLL、RFA、用户配置、账号凭据、研究资源或第三方前端库。

从工程根目录执行：

```powershell
npm run customer:assets -- --plan
npm run customer:assets -- --build D:\code\REA\local-codex-panel\artifacts\customer-web-assets\my-candidate
npm run customer:assets -- --verify D:\code\REA\local-codex-panel\artifacts\customer-web-assets\my-candidate
```

默认只显示计划。构建目录必须是本工程 `artifacts/customer-web-assets` 下的新目录；不会覆盖、清空或自动删除任何旧输出。失败时保留新目录供检查，进程退出码非零；只有 `ok:true` 且 `verified:true` 才表示这个组件的字节核对完成。

构建只读白名单文件，不递归复制源码目录。输入发生变化、越界路径、符号链接/重解析路径或多硬链接会拒绝。输出只接受 `public/` 内逐项匹配的文件和最后生成的 `BUILD-MANIFEST.json`；多出一个文件、缺失、改名、内容变化或伪造清单都不能通过核对。核对使用工程内受信白名单，不采信产物自报的 SHA。

目录逐项读取，最多保留预期数量并多取一项用于判定超限。文件或目录关闭失败时，模块保留准确句柄并返回 `error.cleanupIds`，停止新构建/核对；同进程调用 `cleanupCustomerAssetReads({cleanupId})` 只重试原资源关闭，明确成功才释放。标识不能跨进程使用，CLI 遇到该错误仍以失败退出，不自动重放构建，也不声称已经清理成功。

同一输入重复构建具有相同字节；输出清单不含本机路径、时间、环境、会话或凭据。源文件改动后必须重新核对来源及依赖，显式修改受信白名单；脚本不会自动刷新哈希以放行新内容。

这些检查不是 JavaScript/HTML 语义分析、操作系统沙盒、法律授权审定或运行验收。依赖边是人工核对、与 SHA 绑定的声明；有权限修改白名单的人仍能改变输入信任范围。文件身份/字节复查不保证对同权限并发进程的原子隔离。现有前端仍依赖同源 `/api/*`、SSE、认证及 Codex 后端；后端与 Revit 完整宿主的研究依赖隔离、许可证与公告核对、安装回退、真实云账号和 WebView 验收仍须分别完成，不能因本组件构建成功而解除。

实现更新：前端与客户聊天组件现在复用 `lib/customer-component-builder.mjs` 的单一文件/清理算法，旧 `lib/customer-assets.mjs` 保留薄包装。前端metadata字节保持兼容，旧已构建组件仍核对通过；两组件的pending资源与cleanupId彼此隔离，见[CUSTOMER-COMPONENT.zh-CN.md](CUSTOMER-COMPONENT.zh-CN.md)。
