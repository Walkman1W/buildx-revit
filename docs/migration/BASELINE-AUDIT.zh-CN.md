# 独立源码基线核查

日期：2026 年 11 月 5 日。范围是 `D:\code\BuildX` 的私有源码基线、锁定 Node 依赖和明确遗漏修复，不是产品安装、运行或许可法律验收。旧工程仅作为只读来源；未启动旧服务、加载插件或操作真实模型。

## 来源与迁移修正

- 原始白名单复制证据保持 507 文件、5,602,302 字节及逐文件 SHA-256；`source-baseline.json` 的 `files`、复制时间与 `sourceStableDuringCopy` 未改写。后续实施文件与历史复制摘要不同属正常变化，不能把历史摘要当作当前文件验签。
- 原 `omitted` 的 “plugin binaries and build records” 描述过宽：`revit-addin/build-record.json` 与 `built-dll-inspection.json` 实际在 507 文件中。两条原始记录和摘要保留，生成文件由现有 `.gitignore` 排除；`scripts/import-legacy-baseline.mjs` 已显式排除这两个准确路径，未删除旧数据。更正追加到 `postExtractionCorrections`。
- `live-tool-receipt.test.mjs` 原先直接导入被排除的旧 `workbench/validation/20261023-buildx-live/`。纯 `parsePublicToolResult` 迁到 `test-support/public-tool-result.mjs`；`parseCardResult` 纯投影从真实验收脚本抽到 `test-support/live-dialogue-receipt.mjs`。没有复制真实验收 HTTP/SSE 工作流、运行目录或证据数据。原文件及迁入文件摘要记录在更正条目中。
- 客户聊天清单显式依赖的 `customer-chat.README.zh-CN.md` 已单独按原字节补入，8,732 字节，SHA-256 为 `a73e06e9572ba8ccb126cb038c8ace704b5f32a820f3332bcaa042c40adda77e`；来源证据追加在更正条目，不改历史 507 文件清单。
- 保留现有应用源码、原生系统图和族工作流源码来源记录。`ArgusTools.cs` 当前仍是加载研究程序集的适配器，`ScriptRunner.cs` 仍依赖研究工具链；这些代码尚未代表去依赖产品候选。没有把研究 DLL、模型、推理程序或恢复源码复制进本基线。

## 已执行检查

| 检查 | 结果与边界 |
| --- | --- |
| `node --check scripts/import-legacy-baseline.mjs` | 通过；未重新运行提取器覆盖现有工程 |
| `node --test live-tool-receipt.test.mjs` | 5 项通过；涵盖完整 JSON、显式 null 结构块、异常尾块、截断及失败卡片；不连接真实服务 |
| `npm ci --ignore-scripts --no-audit --no-fund` | 新工程原无 `node_modules`，按既有锁安装 19 包；未升级依赖、未执行安装脚本 |
| `npm ls --all` | 通过；依赖树完整 |
| 锁文件核对 | package 的 dependencies/devDependencies 与 lock 根记录相同，19 包均带 resolved 和 integrity |
| 静态导入解析 | 使用 Node `vm.SourceTextModule(...).dependencySpecifiers`，仅解析未求值；原生契约落盘后复核历史清单内 379 JS/MJS、2,056 条静态导入，0 语法失败、0 缺失路径；未执行被导入模块 |
| 有限敏感字面量扫描 | 历史清单文本内扫描 private-key PEM、OpenAI token、GitHub token、AWS access-key 四类模式，0 命中；未输出匹配值。不包括任意口令、编码秘密或运行数据的完整审计 |
| 发布清单路径 | `release/customer-web-assets.json` 6 条路径均存在；补入 README 后 `release/customer-chat-component.json` 23 条路径均存在。两份清单均为 `releaseReady:false`，其旧摘要不是本轮发布证明 |
| 六查询入口清单 | `tools/build-brain-candidate-files.json` 路径唯一，已替换 AEC adapter/relay/refresh 引用并包含 Node 原生契约和 C# 生产者；安装器及其测试语法检查通过。未生成安装候选，未执行会生成临时占位候选的安装器回归，留后续阶段验证 |

扫描中没有运行动态 import 或生产入口。Node 版本为 v22.17.0，npm 为 10.9.2。现有 19 个 npm 包的许可证文件均由锁定安装保留在各自 `node_modules` 包目录中；`node_modules` 不入 Git。

## 第三方公告与交付边界

旧工程白名单内未发现独立 `THIRD-PARTY-NOTICES` 或项目开源 `LICENSE`；`docs/BUILDX-LICENSE.zh-CN.md` 是应用账号/许可说明，不能替代源码版权或第三方公告。现已创建根目录 `THIRD-PARTY-NOTICES.md`，保留全部 19 个锁定 npm 包的原始许可证全文、包来源和许可证文件摘要。当前只核对用户拥有工程的私有迁移来源，没有推断公开再分发权利。正式安装候选仍需按实际打包内容保留许可证和公告。

锁定依赖清单如下；许可证类型来自 lock，并核对已安装包自带的 LICENSE/license/LICENSE.md 存在。

| 包 | 版本 | 许可 |
| --- | --- | --- |
| `@modelcontextprotocol/client` | 2.3.1 | Apache-2.0 |
| `@modelcontextprotocol/core` | 2.3.1 | Apache-2.0 |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 |
| `ajv` | 8.20.0 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.9 | BSD-3-Clause |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.14 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `which` | 2.0.2 | ISC |
| `zod` | 4.6.7 | MIT |

Revit API、WebView2、Roslyn/编译器、Python 运行时及可选 PDF 解析器应随实际交付方案逐项登记。当前 `revit-addin/build.ps1` 的 WebView2 来源仍是 `C:\ProgramData\AECModelBridge\bin\2024`，`LocalCodexRevit.cs` 的 DevelopmentRoot 仍指旧工程，`ScriptRunner.cs` 的 Roslyn 指 `_reference`。这些是独立布局/打包任务，不应据 Node 依赖通过宣称可独立安装。两个品牌 logo 来自原应用素材，摘要随历史清单保留；正式公开使用前仍需核对资产权属。

## 可纳入私有源码与待验

已修复的纯解析源码、对应测试、提取器修正、补入 README、第三方公告及本记录可以随审查后的业务源码纳入私有仓库；实际提交前应在六查询并行修改完成后复核静态导入和 Git 待提交列表，继续排除运行数据、凭证、已生成记录和第三方二进制。

源码关键词核查中，研究组件调用仍位于 `ArgusTools.cs` 和 `WorkbenchHost.cs` 的派发/解析及能力探测，研究编译器路径位于 `ScriptRunner.cs`；这些依赖是未完成去研究化的明确证据。未发现命名为恢复算法或推理实现的源码文件；这不是对所有算法历史的版权溯源证明。适配器可以留作私有迁移基线，不能据本记录将研究功能称为可发布原生实现。

本轮未验证真实 Revit/WebView/Codex、源模型内容、客户机安装升级、第三方二进制许可交付、完整发布清单和所有动态/外部依赖。旧安装路径应在对应后续任务中处理；不影响本轮 parser 目标回归的结论。
