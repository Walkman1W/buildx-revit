# 参数定义绑定的只读准备组件

本组件尚未注册为工具或工作台命令，也不执行模型写入。`ProjectParameterPreparation.Inspect` 在调用者已核对当前项目文档的前提下，按明确 GUID 检查当前文档内的共享参数元素与绑定状态，并核对 1–30 个明确的顶层类别 ID 是否允许绑定。已存在绑定的类别最多 200 项；返回 `absent`、`present_unbound` 或 `bound`，以及可读取到的实例/类型绑定事实。ID 使用十进制字符串。

这些事实不证明共享参数文件中存在对应定义、不检查同名不同 GUID、不评估实例影响，也不产生写入许可。它不访问共享参数文件、不更改 `Application.SharedParametersFilename`，不能用于声称后续文件操作会随 Revit 事务回滚。项目参数读取也不能因本组件推断其他非共享参数不存在。

AEC 只读来源：`D:\code\pumpbim\aec-model-bridge\packages\revit-bridge-addin\src\Bridge\BridgeCommandFactory.cs` 中 `ExecuteCreateSharedParameter`（约 1264 行）及 `ExecuteCreateProjectParameter`（约 1310 行）均为未实现入口。

后续若开放写操作，仍需独立实现并验证：受控现有外部定义和文件身份 owner、精确类别及实例/类型绑定前态、完整影响和逐次审批、宿主文档与请求绑定、事务内重查与提交后回读，以及独立的文件/全局设置副作用处理。禁止基于本准备结果直接执行写入。
