# NWC 暂存导出原型

本原型未注册，默认构建不包含，只有显式 `BUILDX_EXPERIMENTAL_NWC_EXPORT` 或测试宏才编译。它只针对当前项目的一个明确可打印 3D 视图；设置 View 范围、内部坐标、禁用 Revit 链接与链接 CAD 转换。选项为请求事实，不保证导出器完整遵守。

2024 本机 RevitAPI XML 和 [Autodesk 导出指南](https://help.autodesk.com/cloudhelp/2021/ENU/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Export_html.html) 说明 NWC 导出器为可选注册的外部组件，先查询 `IsNavisworksExporterAvailable()`；`Document.Export` 返回 void，正常返回并非验证产物可用。

实验工作流只接受宿主内部持有的随机目录 lease，检查原目录空、单 lease 防重复，记录实际观察的文件名、大小、身份及哈希。缺少导出器不调用 Export；异常、额外文件或清单无法读取时保留原请求与已产生文件，不自动重导或清理；结果不授予发布。单 lease 防重仅进程内有效，不构成持久原回执或跨进程去重。

目录身份在创建与观察时检查，并未在整个外部导出期间持有排他目录句柄，不能防止竞争、替换、重解析点或外部导出器写入其他路径；预检查为空也不能保证导出期间无覆盖。若输出超过观察上限或身份无法检查，记录不完整；未知不等于没有文件。现阶段没有可信的人类目的地选择、目的地目录身份与无覆盖发布绑定，不注册导出工具或发布任何文件。测试只使用模拟 Revit peers 与独立 artifacts 目录，不构成真实 Revit 导出或文件安全验收。
