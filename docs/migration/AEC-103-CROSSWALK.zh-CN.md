# AEC Revit 103 项与 BuildX 工具对照

按固定的 AEC Revit provider 清单核对 **103 个工具名称**。当前 BuildX 工作区候选源码注册 **73 项**，包括 43 项只读查询和 30 项其他操作。工作区另有 BuildX 自有能力，工具总数与 AEC 覆盖数分别统计。本表按源码和契约核对，试用宿主是否已经加载这些能力以实际验证记录为准。[AEC 源清单](aec-revit-command-inventory.json)

AEC 侧有 **27 项已有同名工具、14 项已接入候选、14 项有关联工具、39 项未接入、9 项暂缓**。同名工具按 BuildX 的 ID、单位、分页、权限和回执契约使用。关联工具可能仅覆盖一部分用途。暂缓项涉及文档、中心模型、反射或通用脚本的较高权限。

本批增加楼层平面图与等轴测三维视图。上一批涵盖材料用量、碰撞候选、标高、直线轴网、固定构件和取消固定。管道连接查询 `revit_get_pipe_network` 是 BuildX 自有能力，未计入 AEC 的 103 行。[视图验收](AEC-VIEW-WRITES.zh-CN.md) · [上一批验收](AEC-WORKSPACE-WAVE.zh-CN.md)

## 模型查询与检查

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_extract_snapshot` | 提取语义模型快照 | 关联能力 · `revit_capture_model_snapshot`。有限的包围盒快照，不覆盖流式语义导出。 |
| `revit_get_snapshot_delta` | 读取会话内构件增删改 | 未接入 |
| `revit_health` | 检查 Revit 连接 | 已有同名 |
| `revit_list_levels` | 列出标高 | 已有同名 |
| `revit_list_elements` | 按类别列出构件 | 关联能力 · `revit_get_elements_by_type`。支持按类别分页，类别按 BuildX 契约填写。 |
| `revit_get_document_info` | 读取当前文档及视图 | 已有同名 |
| `revit_get_selection` | 读取当前选择 | 已有同名 |
| `revit_get_categories` | 列出模型类别 | 已有同名 |
| `revit_get_element_type` | 按类别及族名查询类型 | 关联能力 · `revit_list_family_types`。可按类别及类型名称读取，暂无族名精确过滤。 |
| `revit_get_worksets` | 读取工作集 | 已有同名 |
| `revit_get_element_bounding_box` | 读取构件包围盒 | 关联能力 · `revit_get_element_geometry`。几何摘要包含模型坐标下的包围盒。 |
| `revit_get_phases` | 读取阶段 | 已有同名 |
| `revit_get_phase_filters` | 读取阶段过滤器 | 已有同名 |
| `revit_get_design_options` | 读取设计选项 | 已有同名 |
| `revit_get_group_members` | 读取模型组成员 | 候选 · 原序分页，按需读取成员字段。[验收](AEC-GROUP-MEMBERS.zh-CN.md) |
| `revit_get_rvt_links` | 列出 RVT 链接类型 | 本批候选 |
| `revit_get_link_instances` | 读取链接放置与坐标变换 | 本批候选 |
| `revit_check_clashes` | 检查类别之间的碰撞 | 候选 · 扩张轴对齐包围盒，最多比较 50,000 对，同类去重，分页返回候选并列出缺框数。实体相交待专门实现。 |
| `revit_calculate_material_quantities` | 汇总类别的材料用量 | 候选 · 按材料 ID 汇总非涂料体积，单位为立方英尺，分页返回材料总量。 |
| `revit_get_warnings` | 读取 Revit 项目警告 | 本批候选 |
| `revit_get_elements_by_type` | 按类型、类别及标高读取构件 | 已有同名 |
| `revit_get_element_geometry` | 读取构件几何摘要 | 已有同名 |

## 参数

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_get_element_parameters` | 读取构件参数 | 已有同名 |
| `revit_set_parameter_value` | 写入单个实例参数 | 已有同名 |
| `revit_get_parameter_value` | 读取单个参数值 | 已有同名 |
| `revit_list_shared_parameters` | 读取文档中的共享参数 | 已有同名 |
| `revit_create_shared_parameter` | 建立共享参数 | 未接入 |
| `revit_list_project_parameters` | 读取项目参数 | 已有同名 |
| `revit_create_project_parameter` | 建立项目参数 | 未接入 |
| `revit_batch_set_parameters` | 按显式构件批量写参数 | 关联能力 · `revit_set_parameters`。显式实例和参数 ID，按批次上限处理。 |
| `revit_get_type_parameters` | 读取类型参数 | 已有同名 |
| `revit_set_type_parameter` | 写入类型参数 | 已有同名 |
| `revit_batch_set_parameters_by_filter` | 按条件批量写参数 | 未接入 |

## 建模

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_create_wall` | 创建墙 | 已有同名 |
| `revit_create_floor` | 创建楼板 | 已有同名 |
| `revit_create_roof` | 创建屋面 | 未接入 |
| `revit_create_level` | 创建标高 | 候选 · 明确名称与项目高程，单位为 mm。 |
| `revit_create_grid` | 创建轴网 | 候选 · 明确名称与两个等高端点，单位为 mm，当前支持直线。 |
| `revit_create_room` | 创建房间 | 未接入 |
| `revit_delete_element` | 删除构件 | 未接入 |
| `revit_create_column` | 创建结构柱 | 未接入 |
| `revit_create_beam` | 创建结构梁 | 未接入 |
| `revit_create_foundation` | 创建基础 | 未接入 |
| `revit_create_duct` | 创建风管 | 未接入 |
| `revit_create_pipe` | 创建管道 | 已有同名 |
| `revit_move_element` | 移动构件 | 关联能力 · `revit_move_elements`。批量接口可接收单一构件。 |
| `revit_copy_element` | 复制构件 | 关联能力 · `revit_copy_elements`。批量接口可接收单一构件。 |
| `revit_rotate_element` | 旋转构件 | 关联能力 · `revit_rotate_elements`。批量接口可接收单一构件。 |
| `revit_mirror_element` | 镜像构件 | 未接入 |
| `revit_pin_element` | 固定构件 | 候选 · 明确单个实例 ID，回读固定状态。 |
| `revit_unpin_element` | 取消固定 | 候选 · 明确单个实例 ID，回读固定状态。 |
| `revit_create_group` | 创建模型组 | 未接入 |
| `revit_ungroup` | 解散模型组 | 未接入 |
| `revit_create_conduit` | 创建电气导管 | 未接入 |
| `revit_create_material` | 创建材料 | 未接入 |
| `revit_set_element_material` | 指定构件或表面材料 | 未接入 |
| `revit_convert_to_group` | 将构件转成模型组 | 未接入 |

## 视图、图纸与标注

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_list_views` | 列出视图 | 已有同名 |
| `revit_create_floor_plan_view` | 创建平面视图 | 候选 · 指定视图类型与标高 ID，受控事务回读。 |
| `revit_create_3d_view` | 创建三维视图 | 候选 · 指定视图类型 ID，创建等轴测视图并回读。 |
| `revit_create_section_view` | 创建剖面视图 | 未接入 |
| `revit_list_sheets` | 列出图纸 | 已有同名 |
| `revit_create_sheet` | 创建图纸 | 未接入 |
| `revit_delete_sheet` | 删除图纸 | 未接入 |
| `revit_place_viewport_on_sheet` | 将视图放到图纸 | 未接入 |
| `revit_batch_create_sheets_from_csv` | 从 CSV 批量建图纸 | 未接入 |
| `revit_populate_titleblock` | 填写图框参数 | 未接入 |
| `revit_list_titleblocks` | 列出已载图框类型 | 已有同名 |
| `revit_get_sheet_info` | 读取图纸详情 | 已有同名 |
| `revit_duplicate_sheet` | 复制图纸 | 未接入 |
| `revit_renumber_sheets` | 批量重编号 | 未接入 |
| `revit_set_selection` | 设置当前选择 | 未接入 |
| `revit_select_by_unique_ids` | 按 UniqueId 选择并缩放 | 未接入 |
| `revit_create_text_note` | 创建文字注释 | 未接入 |
| `revit_create_tag` | 标记构件 | 关联能力 · `revit_smart_annotate`。以当前视图、选中构件和标签类型为条件。 |
| `revit_create_schedule` | 创建明细表 | 未接入 |
| `revit_get_schedule_data` | 读取明细表单元格 | 已接入候选 · 按明细表 ID 读取正文显示值，行列分别分页。尚未实机验证。 |
| `revit_create_dimension` | 创建线性尺寸 | 未接入 |
| `revit_get_revision_sequences` | 读取按序号排列的修订实例 | 已接入候选 · 返回修订实例及签发状态，行为与 AEC 实现一致。尚未实机验证。 |
| `revit_tag_all_in_view` | 批量标记视图内的构件 | 关联能力 · `revit_smart_annotate`。已有指定构件标记，按整视图自动筛选另议。 |
| `revit_get_view_templates` | 列出视图样板 | 关联能力 · `revit_list_views`。读取视图后按 is_template 筛选。 |
| `revit_apply_view_template` | 应用视图样板 | 未接入 |

## 族与类型

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_place_family_instance` | 放置族实例 | 已有同名 |
| `revit_place_door` | 在墙上放置门 | 已有同名 |
| `revit_place_window` | 在墙上放置窗 | 未接入 |
| `revit_list_families` | 列出已载族及类型 | 关联能力 · `revit_list_family_types`。以类型为主，未提供完整族层级。 |
| `revit_edit_family` | 打开族编辑 | 关联能力 · `revit_family_inspect_job`。读取已存在的族作业，任意现有族打开编辑另议。 |
| `revit_change_element_type` | 批量更换构件类型 | 未接入 |
| `revit_replace_family_type` | 按族和类型名称批量换型 | 未接入 |

## 导出与渲染

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_export_dwg` | 导出 DWG | 未接入 |
| `revit_export_ifc` | 导出 IFC | 未接入 |
| `revit_export_navisworks` | 导出 NWC | 未接入 |
| `revit_export_image` | 导出视图图像 | 关联能力 · `revit_capture_view`。返回当前视图快照，独立文件导出另议。 |
| `revit_render_3d` | 渲染三维视图 | 未接入 |

## 文档管理与高权限操作

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_save_document` | 保存当前文档 | 暂缓 |
| `revit_close_document` | 关闭当前文档 | 暂缓 |
| `revit_create_new_document` | 新建项目文档 | 暂缓 |
| `revit_sync_to_central` | 同步到中心模型 | 暂缓 |
| `revit_relinquish_all` | 释放工作共享所有权 | 暂缓 |
| `revit_invoke_method` | 动态调用 Revit API 方法 | 暂缓 |
| `revit_reflect_get` | 动态读取 Revit API 属性 | 暂缓 |
| `revit_reflect_set` | 动态写入 Revit API 属性 | 暂缓 |
| `revit_execute_python` | 在 Revit 内运行 Python 脚本 | 暂缓 |
