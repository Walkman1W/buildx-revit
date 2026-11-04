# 参数化双接口阀门示范模块

`BuildX.FamilyRevit.ParametricValveBuilder` 为自研 C#5/Revit 2024.3 模块。它仅处理调用方传入的独立族文档，不调用活动项目、Save、Load、Close 或 Transaction。模板建议使用本机公制常规模型 RFT，在族事务中明确切换为 `OST_PipeAccessory`、`PartType.ValveNormal`；模板是否接受这些设置必须以实际运行结果为准。

## 调用与回执

```csharp
Dictionary<string, object> built = ParametricValveBuilder.Build(familyDocument, 200, 50);
Dictionary<string, object> inspected = ParametricValveBuilder.Inspect(familyDocument);
```

Build 必须位于调用方已打开的族事务中。任何类别、原生尺寸标签、参数关联或尺寸回读失败都会抛出异常，由调用方回滚该事务。Build 返回时事务仍由调用方持有，因此回执明确 `family_transaction_committed=false`、`saved=false`、`loaded_into_project=false`。成功提交、保存、加载与关闭应由工作流分别记录，不能凭此方法返回宣称完成。

Inspect 不重生成、不切换 CurrentType、不写模型。它返回当前族类型、各类型已保存的参数值，以及当前类型的形体/连接器事实；各类型几何验证记录由 Build 的 `type_validation` 提供，不能将 Inspect 的参数列表当作全部类型已重生成的证据。`created_element_ids` 仅包含主对象，`created_element_ids_complete=false`，不用于按列表盲删或推断全部副作用。

## 原生参数与尺寸验证

形体为沿族局部 Z 轴的一个实心圆柱，作为教学阀门占位体。参数为族类型参数：

| 参数 | 原生关联 |
|---|---|
| Length | Extrusion End 通过 FamilyManager 原生参数关联 |
| Diameter | 原生圆弧直径尺寸 Dimension.FamilyLabel 驱动 |
| ConnectorRadius | 公式 `Diameter / 2`，连接器 Radius 原生关联；模板只暴露可关联 Diameter 时直接关联 Diameter |

创建两个固定类型 `BuildX_Valve_A`、`BuildX_Valve_B`。A 使用输入毫米值，B 使用 Length×1.25、Diameter×1.5。分别设置类型并重生成，读取圆柱包围盒、正实体体积、两个圆形 Piping Connector 的坐标、法线、口径与参数关联，再切回 A 重生成和复查。参数值与长度/口径的容许误差为 0.05mm；体积另外核对理论圆柱值。任一失败都不能降级成两个静态类型并返回成功。

族局部两接口位置为 `(0,0,0)`、`(0,0,Length)`，对应朝外法线 `-Z`、`+Z`。项目放置、旋转后的世界坐标与实际管段连接，需要在项目中重新读取实例连接器并独立验证，不能凭族内坐标或外形相接判定接管成功。

## 范围与限制

- 这是实心简单圆柱阀门示范，不包含内孔、阀芯、手轮、执行器、法兰、压降/额定压力、厂家外观或工程认证。
- 输入必须为有限值，长度和半径超过当前 Revit 的 ShortCurveTolerance，A/B 尺寸均处于 Revit 设计范围。
- 为防重复建模，要求新族中没有已有 Extrusion、Connector 或保留参数名；不接管已有用户族。
- 模板必须具备可用平面视图、可用原生直径尺寸类型、可切换管道附件类别与 PartType、可关联的连接器尺寸参数。安装目录中的 RFT 存在和字节哈希不证明这些 API 操作会成功。
- 通用 C# 执行器权限没有扩大；文档所有权、线程/API 回调、模板哈希、事务、保存、加载及失败清理仍由独立工作流负责。

## 离线编译

运行 `compile-parametric-valve.ps1` 使用本机已有 Framework csc、`/langversion:5 /platform:x64` 和实际安装的 RevitAPI.dll。每次输出独立证据目录，含源码/API/XML/脚本输入哈希、10项精确 XML API 契约、编译日志、产物信息和时间。脚本不安装软件、不实例化 Revit 类型、不创建族或执行 API。

编译只证明签名与 C#5 兼容；几何、参数 flex、Connector、保存和项目加载是否成功，必须以实际样例工作流回执验收。未实测的 CPU、进程族峰值、tokens、冷暖及前后性能基线保留为 null。
