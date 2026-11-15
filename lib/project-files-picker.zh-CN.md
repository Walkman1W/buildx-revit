# 资料库 Windows 文件选择器（隔离组件）

`createProjectFilesPicker()` 是本地面板持有的只读选择器。`pick({kind:'file'|'directory',signal?})` 调用固定 WinForms 对话框脚本，返回 `{ok:true,value:{path}}`；用户取消时 `path:null`。它不读取、移动或删除所选文件，也不自动把地址加入资料库。其余情况返回 `{ok:false,error:{code,message}}`。

允许同时存在一个原始子进程。超时、取消或关闭要求该进程的 `close` 事件确认；清理未确认时返回 `PICKER_CLEANUP_PENDING` 并保留进程 owner，拒绝新对话框。面板退出前必须调用并检查 `close(): {closed:boolean}`；若未确认，应保留 owner、等待或重试清理。服务端路由必须只在用户主动点击时调用，绑定当前账号、面板会话、CSRF，并在异步结果返回时重新核对；选择后仍应由资料索引验证文件类型和地址身份。

子进程使用固定的系统 PowerShell 路径、固定脚本、`shell:false`，不拼接输入；标准错误不回显。它与用户可见窗口的前后台层级、面板进程异常退出后的表现以及当前 Windows/Revit 会话中的可交互性尚未实机验证。系统 PowerShell 路径及用户会话能力也依赖实际运行环境；本模块不提供跨用户沙箱或文件句柄级身份保证。无 Windows 环境时明确不可用。

`node --test tests/lib/project-files-picker.test.mjs` 使用模拟子进程验证成功、取消、并发、超时和清理未确认；不会打开真实窗口，不能作为 UI 验收证据。本组件尚需面板路由、静态界面及服务关闭流程共同接线。
