# 本机 MCP 回执：私有目录与持久性核查

本文件记录 2026-11-01 的只读核查。它不是私有目录验证器，不授权启用本机 MCP，也不是断电持久性的证明。没有修改 ACL、创建私有根、启动 MCP 或操作 Revit。

## 当前证据

- `external-mcp-receipts.mjs` 要求宿主提供冻结的 `privateRootOwner.verify({ root, accountDirectory })`；该函数必须验证实际安全状态，不能因为路径被选中就返回 `true`。根路径和账户子目录还受当前代码的路径身份检查约束。
- 只读 `Get-Acl` 显示，`D:\code\REA\local-codex-panel\runtime-history` 的 ACL 未禁用继承；继承规则中有 `Authenticated Users` 的修改权限、`Users` 的读取权限和其他主体的修改权限。该目录不能直接作为已证实的私有根。
- 只读 `Get-Acl` 显示，`%LOCALAPPDATA%\BuildX` 的 ACL 未禁用继承；存在授予 `CodexSandboxUsers` 和另一个未识别主体 `DeleteSubdirectoriesAndFiles, Modify` 的继承规则。不能假定该主体只包含当前用户，也不能把该目录直接视为已证实的私有根。
- `Get-Acl` 的文本展示是现场筛查，不是完整访问令牌、全部特权、所有父级及重解析点或操作期间身份稳定性的证明。没有审查或改变所有父级目录的安全配置。
- 回执先同步暂存文件内容，再建立最终硬链接并删除暂存链接。代码没有证明最终名称对应的目录项在突然断电后已持久化。文件同步成功或紧接着 `lstat` 成功，不能单独证明此点。

## 宿主实现必须回答的事项

1. 读取由系统返回的安全描述符、所有相关 ACE、继承标志与所有者，并以 SID 而非本地化显示名判定；NULL DACL、读取不完整、无法解释的 ACE 或未知主体的实际权限均不能默认为安全。用户认可的可信主体集合及管理员、系统服务、同用户其他进程是否在威胁模型内，需要明确记录，不能静默把组视为单用户。
2. 对现存私有根与账户目录分别核查读取和修改风险；对所有祖先考虑对象删除权限、父目录 `FILE_DELETE_CHILD`、可更改 DACL/所有者的权限、继承及其他影响路径替换的权限。不能单靠子目录自身 DACL 声称其名称不可替换。对具有复杂条件、组成员或特权的访问控制，应有可信的有效访问评估或保守失败，而不是仅按 ACE 文本匹配。
3. `verify` 在 `mkdir(accountDirectory)` 前和后都会被调用：第一次允许安全根下叶目录尚不存在，但必须证明创建和继承可受控；第二次必须实际核查创建出的目录和其身份。已有目录同样必须完整核查，不能将 `EEXIST` 当成所有权证明。
4. 以 Windows 原生句柄和文件身份核验路径链、卷与重解析点，并考虑 ACL、目录名称和对象身份在检查与操作之间改变的竞态。需要明确句柄持有、共享模式、所有操作的路径解析和替换防护；两次路径快照相同不是竞态安全的证明。权限不足、重解析点无法解释、身份不可确认时保持关闭。
5. 为回执发布定义受支持的 Windows、文件系统、缓存和故障模型；验证暂存文件同步、最终链接建立、目录项及必要元数据的持久化顺序与失败处理。须有可信 API 契约和断电/崩溃故障注入证据，覆盖记录创建、链接、清理各阶段。进程崩溃、操作系统崩溃和断电是不同的验证等级；不能把普通进程退出测试当作断电证明。
6. 如果重启后不能证明操作前回执已持久化，缺失回执不等于操作未发生；涉及未知结果的调用应停止自动重发并要求核对原回执或外部状态。可证明持久性之前，回执组件不能对外承诺跨断电的自动去重。

## 参考依据

- [Microsoft: file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)：新建文件及目录默认安全描述符的继承和文件访问权。
- [Microsoft: DeleteFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-deletefile)：文件删除或重命名可由文件 DELETE 或父目录 DELETE_CHILD 授权。
- [Microsoft: file caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching)：数据及元数据缓存和刷新语义。此文档本身不证明上述硬链接发布流程的目录项持久性。
- [Microsoft: directory handles](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)：打开已有目录句柄的要求；不代表仅持有句柄即可解决路径竞态。
