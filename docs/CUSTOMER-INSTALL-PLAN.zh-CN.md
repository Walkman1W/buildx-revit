# 客户组件的安装就绪计划

`customer-install-plan.mjs` 是开发侧只读计划入口。它核对一个当前源码支持的未运行候选，给出安装、升级或回退意图及阻塞项；不安装、暂存文件、修改active指针、探测进程或启用服务。当前所有成功计划均为 `planOnly:true`、`readyToApply:false`、`releaseReady:false`。

```powershell
npm run customer:install-plan -- --plan --artifact D:\code\REA\local-codex-panel\artifacts\customer-chat\20261025-account-delivery-candidate --target-root C:\BuildX-Review --operation install
```

目标是待审查的路径提议，上例不创建或检查 `C:\BuildX-Review`。`--operation`可选install、upgrade、rollback，默认install；这是调用者意图，不证明版本先后。未知/重复参数和`--apply`均拒绝。没有隐式安装模式。

## 事实和未知项

计划内部调用原 `verifyCustomerChatPackage`，不接收客户端自报的verified清单或替换验证函数。共享builder在同次已读取、关闭并逐字节比对的 `BUILD-MANIFEST.json` Buffer上返回SHA和长度，不再次读取或由消费者重造JSON。`releaseId`取该清单SHA，不用各包相同的`package.version=0.1.0`辨别版本。

当前候选的releaseId为`d8a058a4deae284fac909ac41b9d0011d4e2ec5d21630191231f53df8f290712`，24文件共251750字节；payload统计244645字节不含最后7105字节的BUILD文件。此处仅列本候选的实际build/verify事实；本轮未为该候选执行install-plan，上例是未来只读调用示意。账号响应断开修复及产物同场景输入变体验收见[本轮证据](../workbench/validation/20261025-account-delivery/README.zh-CN.md)。下文历史计划结果属于当时B，不可用当前源码替历史候选背书。计划提议 `target/releases/<releaseId>`，不表示该目录存在、可写、空闲或已安装。

Windows目标只做词法校验并保留调用者原值；UNC、设备/根相对路径、根目录、点分段、ADS和保留名等歧义拒绝。目标及祖先的物理身份、链接、存在性、权限、long-path支持、激活版本和进程状态均为`not_checked`。词法校验不是OS安全证明；目标可能与源码/候选或其物理别名重叠，故只声明“本组合未发起目标检查/修改”，不宣称目标物理树绝对零读取。

## 当前阻塞

| 项目 | 已核对事实 | 下一步 |
| --- | --- | --- |
| 实际数据目录准入 | 入口已要求BUILDX_DATA_ROOT、预存workspace及外部独立run；原RUNTIME_LAYOUT_COUPLED已不适用，计划现返回DATA_DIRECTORY_ADMISSION_NOT_CHECKED/status:not_checked | 选择并核对实际dataRoot、workspace、启动用户和写入适用性；隔离代码验收不能证明安装环境可用 |
| 历史回退信任 | 开发侧已固定登记account-delivery版本并支持独立只读字节核对；本安装计划仍只核当前源码，旧候选不能自报成为可信历史 | 后续需明确历史选择、撤销/适用性及实际安装授权；[登记边界](CUSTOMER-KNOWN-RELEASES.zh-CN.md) |
| 激活与进程 | active选择、准确进程归属、空闲及关闭均未观察 | 后续具体授权和新鲜回执；写指针不等于切换了存活进程 |
| 客户环境 | 外部Node/Codex/Python、启动用户、CODEX_HOME、专用账号配置及产品许可未验收 | 客户自备，不自动安装升级、不复制凭据；环境就绪后分别验收 |

原版Argus、Revit宿主和模型不属于此组件。计划不依赖Revit进程，也不因出现Revit自动恢复模型操作。

## 失败与恢复

验证失败原样返回原owner的错误、`cleanupIds`及`primaryCodes`，不生成成功计划、不自动重试。程序内可使用 `cleanupCustomerInstallPlan`；它与原组件的 `cleanupCustomerChatPackageReads` 是同一函数引用，只重试原句柄关闭，不重放验证或写入。

清理ID仅属于该进程和owner；另一次CLI不能使用上一次ID。CLI退出不代表每一次read.close都被明确确认；遇到未知关闭时保留失败回执，不把它当作可执行安装授权。以后若提供持续安装服务，仍需准确进程/资源owner及清理回执，不能另造跨进程通用ID绕过。

回退代码版本不恢复内存登录、Codex连接确认、对话、上下文、日志、云端状态或在途任务，也不自动重放未知消息。不存在全局回滚承诺。

## 安装计划历史验证

新增共享owner证据3项、领域组合5项、旧前端/聊天打包及真实CLI兼容37项通过，均无跳过。对真实B候选执行只读计划成功但仍阻塞；对旧A执行回退计划被原owner按当前信任来源拒绝，属于预期结果。候选、目标、原件和服务没有被安装或启用；真实账号、浏览器、模型与商业安装验收仍待。

[当时证据](../workbench/validation/20261025-customer-install-plan/README.zh-CN.md)。

客户entry现已消费外部dataRoot/cwd并以原audit新建run；纯角色函数的entryIntegrated:false只说明函数自身没有执行，不是入口未接线的证据。计划没有选择/核对实际数据目录，因此DATA_DIRECTORY_ADMISSION_NOT_CHECKED仍为not_checked；HISTORICAL_RELEASE_TRUST_UNAVAILABLE与COMMERCIAL_ACCEPTANCE_PENDING仍blocked，激活步骤仍blocked，readyToApply=false/planOnly=true，无Apply或目标检查。详见[目录契约](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)。

## 目录归属原型核查（2026-10-25）

仅workbench自建temp的原型，6项约束验收和2项实际排队写反例；不是8项产品或客户业务通过。该历史原型实测原audit跟随入队后被替换的junction/hardlink，当时生产/旧产物未改。此缺口现已在原生产者修复并保留准确关闭资源；本次外部dataRoot及独立run已接入口；实际环境准入和安装信任仍待，不能由代码接线解除全部阻塞。安装计划继续readyToApply=false；[证据](../workbench/validation/20261025-customer-directory-ownership/README.zh-CN.md)与[目录规则](CUSTOMER-DIRECTORY-LAYOUT.zh-CN.md)。

最新外部数据根入口及计划消费者见[本轮证据](../workbench/validation/20261025-customer-data-root/README.zh-CN.md)。plan5＋CLI3项通过，未为新候选另跑实际install-plan命令；上例是未来只读调用示意。最终隔离组合总51项不是安装/激活或真实云验收；历史真实Codex及全根774/1保留，本轮未重测。仍没有Apply、安装、激活、目标检查或服务控制。

## 固定登记版本的独立核对（2026-10-26）

仅当前安全account-delivery版本的原definition、输入manifest和预期BUILD已固定到开发侧源码；新只读verify-known不依赖后来改变/缺失的当前源。最终新6＋受影响打包34共40项通过，中间5/45不累计；当前登记CLI成功，旧未登记版本曾按预期拒绝。共享原builder/cleanup，未复制读取owner、重打包或启用服务。本计划未接历史选择，不解除HISTORICAL_RELEASE_TRUST_UNAVAILABLE，readyToApply=false/无Apply保持；签名、撤销/安装适用性及客户验收仍待。[说明](CUSTOMER-KNOWN-RELEASES.zh-CN.md) · [证据](../workbench/validation/20261026-known-release/README.zh-CN.md)。
