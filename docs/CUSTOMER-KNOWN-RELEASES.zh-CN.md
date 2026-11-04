# 已登记客户组件的只读核对

`customer:component -- --verify-known <BUILD SHA> <组件绝对路径>`仅核对开发侧已登记版本的字节。它不安装、激活、选择active版本、切换进程或修改运行数据，也不授予产品许可。未登记版本在读取组件前拒绝；不会扫描旧目录或根据组件自己的BUILD自动登记。

目前只登记`20261025-account-delivery-candidate`，BUILD SHA为`d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`。旧的未修复日志、目录或登录响应的候选没有登记；保留这些证据不等于允许回退。

```powershell
npm run customer:component -- --verify-known d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712 D:\code\REA\local-codex-panel\artifacts\customer-chat\20261025-account-delivery-candidate
```

输入信任来自开发侧`release/customer-chat-known-releases.mjs`中的固定数据：完整原版本definition、生成package正文、原输入manifest的精确字符串及预期BUILD摘要。该记录从已核验的源码定义、原manifest和保留构建回执登记；没有把产物BUILD解释为自己的信任来源。它是本地源码管理的字节预期，不是发布者签名、远程撤销系统、安装审批或客户环境证明。移除登记后，该ID即不可再通过这个固定入口核对；没有自动补录或回退到当前源码验证。

同一builder实例持有当前源码验证及登记版本验证，共用原`readBounded`、精确树、文件身份、SHA、预算、`pendingReads`和cleanup。当前manifest和源文件后来改变或缺失时，登记核对仍使用固定原版本；生成package和stage也取原版本快照。结果保持`releaseReady:false`，只新增`verifiedAgainst:known_release_definition`与登记`releaseId`标记，不把字节匹配解释为版本顺序、激活状态或可用权限。

任何raw、package、BUILD变化、额外runtime目录、链接或多硬链接仍被原读取器拒绝。文件/目录close未知时，两种验证以及plan/build都受同一owner阻塞；同进程cleanup只重试原句柄关闭，不重新读取、写入或换资源。cleanupId不能跨owner或进程使用。

`customer:install-plan`继续只使用当前源码验证，没有历史版本选择参数或Apply；其`HISTORICAL_RELEASE_TRUST_UNAVAILABLE`表示本安装计划没有核对历史定义、撤销和安装适用性。独立字节核对不会解除实际dataRoot、启动用户、进程归属/空闲/关闭、许可及客户验收门槛。代码回退也不恢复内存登录、确认、对话、日志、云端或在途结果，未知消息不重放。

本轮边界及实际检查记录见[验收记录](../workbench/validation/20261026-known-release/README.zh-CN.md)。原客户组件的22raw/14模块及全部产物不因开发侧登记而重打包，账号/本机Codex流程保持，真实Supabase/WebView、安装与商用验收仍待。
