# 共享参数隔离候选调查

AEC 本机基线 `BridgeCommandFactory.ExecuteCreateSharedParameter` 读取名称、类型、组和类别后抛出 `NotImplementedException`；不能把它描述为已有可工作的语义。本候选没有注册工具，也没有创建定义或文件。

Revit 2024 本机 API 文档指出 `Application.SharedParametersFilename` 是应用级可读写路径，`OpenSharedParameterFile()` 使用该路径打开磁盘定义文件，应用一次使用一个共享参数文件。`ExternalDefinitionCreationOptions` 接受名称和 `ForgeTypeId`，GUID 必须显式设置，否则会随机生成。定义文件是磁盘副作用，不能假设文档事务回滚会恢复文件。

尚未建立可靠的隔离创建链路：临时设置路径后，读取当前值再恢复原值并不是原子比较交换；若其他插件或用户在检查和恢复之间更改该设置，可能覆盖其变化。即使检测到漂移后拒绝恢复，也不能声称应用状态已恢复。还需解决隔离目录身份和重解析点、独占新建、定义写入及精确读取、异常清理、文件身份漂移，以及可信用户文件授权和原请求回执。必须先证明可安全协调实际宿主上的全局设置，或找到不修改该设置的受支持 API；否则不能公开登记。

本次仅做本地源码和 Revit 2024 API XML 静态核查；没有实现或编译候选，没有运行模拟测试，也没有执行真实 Revit、模型或共享参数文件操作。
