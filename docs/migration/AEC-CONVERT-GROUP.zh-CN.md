# 构件转模型组：AEC 映射

AEC `revit_convert_to_group` 在 bridge 中调用 `doc.Create.NewGroup(element_ids)`；本工程的 `revit_create_group` 调用相同 Revit API。因此 `revit_convert_to_group` 作为已有操作的具名入口，内部映射到宿主 `create_group`，复用其权限、事务和原回执，不引入另一套建组逻辑。

输入映射为 `element_ids` 和 `name`。AEC 允许非空元素列表及可选名称，名称设置失败时可能忽略；本入口要求明确名称和 2–50 个不同、未成组的非组实例，接受安全整数或精确 ID 字符串，名称不符、成员被替换或增减均失败。宿主在写后、重生成及内层事务提交后核对组与直接成员身份，默认回滚预览，提交不保存。此受限契约不承诺覆盖 AEC 全部输入；真实 Revit 模型、Codex 和 WebView 尚待验收。
