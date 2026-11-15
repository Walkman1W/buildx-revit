# BuildX 对话本机工具联调候选

分支 `codex/buildx-chat-tools-20261115`。候选采用 BuildX 原有模型对话、白底输入框、确认卡和文件卡。Revit 族文件继续走原生宿主，Excel 和 PNG 保存到本机对话目录。安装后只在专用运行进程设置 `BUILDX_INTERNAL_CHAT_TOOLS=1` 时开放本组工具。

| 对话任务 | 本机执行与交付 |
| --- | --- |
| 读扫描 PDF | 本轮显式添加 PDF 后，Codex 通过附件 ID 调用 OCR。直接提取带文字层的页面，在本机渲染和识别扫描页。工具返回页面文字、页码、来源、文件摘要和低置信区域，原 PDF 保存在本机。本轮单份附件最多 2 MiB，OCR 单次最多 8 页。 |
| 写 Excel | 确认卡显示工作表、单元格、公式和文件名。工作簿在本机生成，回读验证后显示下载和原回执。当工具准备公式时以 Excel 实际打开和重算核对数值。面板首版生成新文件。 |
| 搜索 | 每次展示准确查询，经确认后由固定 Brave MCP 2.1.4 通过本机 STDIO 发起公开网页搜索，工具结果提供可核对来源。 |
| 生图 | 用户确认提示词及本轮选定的参考图后，由本机调用配置的 Images API。PNG 验证完成后在对话内预览、下载，未知结果保留原回执。 |

## 本机运行依赖

- 沿用受信任的本机 Codex、Node 和 Python。扫描还需要 Python `pypdf` 和 `pypdfium2`、Tesseract 和 `eng`／`chi_sim` 语言数据。用启动进程的 `BUILDX_OCR_PYTHON_EXE`、`BUILDX_TESSERACT_EXE`、`BUILDX_TESSDATA_DIR` 指定隔离路径。
- Excel 需要 Python `openpyxl`。可用 `BUILDX_EXCEL_PYTHON_EXE` 或 `BUILDX_EXCEL_PYTHON_DEPS` 选择受信任的本地依赖。Excel 自身只用于最终重算及用户打开产物。
- 搜索用 `BUILDX_BRAVE_MCP_ROOT` 指向已检验版本的独立 Brave MCP 安装，使用进程提供的 `BRAVE_API_KEY`。生图使用本机进程提供的 `BUILDX_IMAGES_API_KEY`。这两项目前用受控服务验收，真实联网与真实生图仍需对应凭据和额度授权。候选不打包凭据、OCR 语言模型、第三方依赖或用户数据。
- 小版本只运行在各自的本机程序和数据目录。本轮测试使用独立循环监听端口 41918。Revit 注册、现有 `.3` 对话和数据保留在各自原位置。

## 验收

用合成中英文泵报价测试真实本机 OCR 和一次审批的 Excel 下载。实际 Excel 16 打开对话交付的 `.xlsx` 并核对 `BX-150-80`、数量 2、单价 12,500 CNY、金额和合计各为 25,000 CNY。回归同时覆盖旧 RFA 卡片及权限边界。参考图和联网协议通过受控供应商测试，仍需在真实供应商和 Revit WebView 上完成验收。

`0.8.9-chat-tools.20261115.2` 从 `e513668` 打包。Revit 2024 API 24.3.30.11 隔离编译，ZIP 152 个文件逐项核对。本机候选从独立程序和数据目录启动，Codex 就绪，浏览器确认白底输入区可暂存 PDF。该启动没有发布 Revit 插件清单。另一个会话仍可使用 `.3` 的 41876 实例。
