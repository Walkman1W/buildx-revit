# 三维真实渲染 API 边界

本机 Revit 2024 `RevitAPI.xml` 中，`View3D.GetRenderingSettings` / `SetRenderingSettings` 读取或设置渲染参数；`Document.ExportImage` 导出视图图像，这些接口本身不证明调用了真实渲染引擎。`CustomExporter` 与 `IPhotoRenderContext` 将适合渲染的几何和材料数据送给调用方的自定义上下文，调用方仍须实现图像渲染；`IsRenderingSupported` 不代表它返回完成的渲染图。

在已检查的本机 2024 公开 API XML 和 Autodesk 自定义导出文档中，未找到可编程启动 Revit 自带真实渲染并返回完成图像的受支持 API。这个结论限定于已检查资料，不排除将来其他版本或经验证的外部渲染器提供能力。AEC 本机 `ExecuteRender3DView` 使用 `ImageExportOptions`，不能据此声称已完成真实渲染。

本次不注册或实现渲染工具，也不将普通视图图像冒充渲染。以后若引入独立渲染器，需重新验证模型数据和材料语义、渲染完成证据、文件清单、目的地授权及原请求恢复；staging 研究本身不授予发布权限。未运行真实 Revit、模型或渲染，未做 API 编译或合成调用测试。

参考：Autodesk [Custom Export 开发指南](https://help.autodesk.com/cloudhelp/2020/ENU/Revit-API/files/Revit_API_Developers_Guide/Advanced_Topics/Export/Revit_API_Revit_API_Developers_Guide_Advanced_Topics_Export_Custom_export_html.html)。
