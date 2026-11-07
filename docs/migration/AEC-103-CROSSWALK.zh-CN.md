# AEC Revit 103 项与 BuildX 工具对照

按固定的 AEC Revit provider 清单核对 **103 个工具名称**。当前 BuildX 工作区候选源码注册 **104 项**，包括 45 项只读查询和 59 项其他操作。工作区另有 BuildX 自有能力，工具总数与 AEC 覆盖数分别统计。本表按源码和契约核对，试用宿主是否已经加载这些能力以实际验证记录为准。[AEC 源清单](aec-revit-command-inventory.json)

AEC 侧有 **27 项已有同名工具、44 项具名候选、14 项有关联工具、9 项尚无具名入口、9 项暂缓**。同名工具按 BuildX 的 ID、单位、分页、权限和回执契约使用。具名候选和关联工具可能只覆盖原工具的一部分用途；下表注明边界，不代表真实 Revit 验收。暂缓项涉及文档、中心模型、反射或通用脚本的较高权限。

本次新增 22 个 AEC 具名候选，覆盖高频图纸、建模、材质、选择和会话变更；原 31 个未接入名称中还余 9 个没有具名入口。若干已登记候选仍不覆盖 AEC 全部输入和副作用，[本批范围与验证](AEC-HIGH-FREQUENCY-BATCH-20261107.zh-CN.md)。

本批增加竖直剖面视图。既有候选涵盖墙上放窗、文字注释、视图样板、视口放置、普通和占位图纸、直风管、直线电气导管、楼层平面图、等轴测三维视图、材料用量、碰撞候选、标高、直线轴网、固定构件和取消固定。管道连接查询 `revit_get_pipe_network` 是 BuildX 自有能力，未计入 AEC 的 103 行。[剖面验收](AEC-SECTION-WRITE.zh-CN.md) · [放窗验收](AEC-WINDOW-WRITE.zh-CN.md) · [文字注释验收](AEC-TEXT-NOTE-WRITE.zh-CN.md) · [视图样板验收](AEC-VIEW-TEMPLATE-WRITE.zh-CN.md) · [视口验收](AEC-VIEWPORT-WRITE.zh-CN.md) · [图纸验收](AEC-SHEET-WRITE.zh-CN.md) · [风管验收](AEC-DUCT-WRITE.zh-CN.md) · [导管验收](AEC-CONDUIT-WRITE.zh-CN.md) · [视图验收](AEC-VIEW-WRITES.zh-CN.md) · [工作区验收](AEC-WORKSPACE-WAVE.zh-CN.md)

## 模型查询与检查

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_extract_snapshot` | 提取语义模型快照 | 关联能力 · `revit_capture_model_snapshot`。有限的包围盒快照，不覆盖流式语义导出。 |
| `revit_get_snapshot_delta` | 读取会话内构件增删改 | 具名候选 · 显式建立有界基线后按固定版本读取观察到的事件；身份不明或连续性失效即拒绝，多文档可能保守过期，并非净差异；真实 Revit 待验。 |
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
| `revit_batch_set_parameters_by_filter` | 按条件批量写参数 | 写入未接入 · 新增 BuildX 只读 `revit_preview_batch_parameter_filter`，有界完整列出匹配实例与原态，不授予写权限；批量写需单独的审批与回执闭环。 |

## 建模

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_create_wall` | 创建墙 | 已有同名 |
| `revit_create_floor` | 创建楼板 | 已有同名 |
| `revit_create_roof` | 创建屋面 | 候选 · 指定类型、标高、原点和宽深，仅零偏移矩形平屋顶；复杂轮廓与坡屋面未覆盖。 |
| `revit_create_level` | 创建标高 | 候选 · 明确名称与项目高程，单位为 mm。 |
| `revit_create_grid` | 创建轴网 | 候选 · 明确名称与两个等高端点，单位为 mm，当前支持直线。 |
| `revit_create_room` | 创建房间 | 候选 · 指定标高和内部 XY，房间阶段由 Revit 确定；要求封闭且面积为正。 |
| `revit_delete_element` | 删除构件 | 未接入 |
| `revit_create_column` | 创建结构柱 | 候选 · 指定类型、底/顶标高和位置，仅零偏移竖直结构柱。 |
| `revit_create_beam` | 创建结构梁 | 候选 · 指定类型、标高和两端点，仅非宿主直线结构梁。 |
| `revit_create_foundation` | 创建基础 | 候选 · 指定类型、标高和位置，仅非宿主单标高独立基础族。 |
| `revit_create_duct` | 创建风管 | 候选 · 精确风管类型、机械系统类型和标高 ID，毫米端点，回读实际中心线。 |
| `revit_create_pipe` | 创建管道 | 已有同名 |
| `revit_move_element` | 移动构件 | 关联能力 · `revit_move_elements`。批量接口可接收单一构件。 |
| `revit_copy_element` | 复制构件 | 关联能力 · `revit_copy_elements`。批量接口可接收单一构件。 |
| `revit_rotate_element` | 旋转构件 | 关联能力 · `revit_rotate_elements`。批量接口可接收单一构件。 |
| `revit_mirror_element` | 镜像构件 | 候选 · 单个非宿主点式族按竖直平面镜像复制；原地镜像及其他对象未覆盖。 |
| `revit_pin_element` | 固定构件 | 候选 · 明确单个实例 ID，回读固定状态。 |
| `revit_unpin_element` | 取消固定 | 候选 · 明确单个实例 ID，回读固定状态。 |
| `revit_create_group` | 创建模型组 | 候选 · 明确名称及 2–50 个实例；核对组与全部直接成员身份。 |
| `revit_ungroup` | 解散模型组 | 候选 · 单个顶层模型组；核对原成员身份，不支持嵌套组或附着详图组。 |
| `revit_create_conduit` | 创建电气导管 | 候选 · 精确类型与标高 ID，毫米坐标和公称直径，事务回读。 |
| `revit_create_material` | 创建材料 | 候选 · 创建具名材料及图形颜色、透明度、光泽度和平滑度；不设置渲染外观资产。 |
| `revit_set_element_material` | 指定构件或表面材料 | 候选 · 按实例材质参数 ID 和精确旧值设置材质；按面涂刷及类型材质未覆盖。 |
| `revit_convert_to_group` | 将构件转成模型组 | 候选 · 复用 create_group；名称必填，2–50 个未成组实例。[验收](AEC-CONVERT-GROUP.zh-CN.md) |

## 视图、图纸与标注

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_list_views` | 列出视图 | 已有同名 |
| `revit_create_floor_plan_view` | 创建平面视图 | 候选 · 指定视图类型与标高 ID，受控事务回读。 |
| `revit_create_3d_view` | 创建三维视图 | 候选 · 指定视图类型 ID，创建等轴测视图并回读。 |
| `revit_create_section_view` | 创建剖面视图 | 候选 · 指定剖面类型、内部坐标底边中心、角度和毫米范围，回读竖直矩形剖面。[验收](AEC-SECTION-WRITE.zh-CN.md) |
| `revit_list_sheets` | 列出图纸 | 已有同名 |
| `revit_create_sheet` | 创建图纸 | 候选 · 指定名称、编号与可选图框类型 ID，留空创建占位图纸，回读事务结果。 |
| `revit_delete_sheet` | 删除图纸 | 未接入 |
| `revit_place_viewport_on_sheet` | 将视图放到图纸 | 候选 · 精确图纸与视图 ID，纸面毫米中心坐标，验证资格并回读实际视口。 |
| `revit_batch_create_sheets_from_csv` | 从 CSV 批量建图纸 | 候选 · 接收 1–50 条已解析行，整批原子建图纸；宿主不读取 CSV 路径。[验收](AEC-BATCH-SHEETS.zh-CN.md) |
| `revit_populate_titleblock` | 填写图框参数 | 候选 · 写指定图纸的唯一图框实例的 1–5 个参数，逐项核对旧值；AEC 原实现对图纸参数写入的语义未覆盖。 |
| `revit_list_titleblocks` | 列出已载图框类型 | 已有同名 |
| `revit_get_sheet_info` | 读取图纸详情 | 已有同名 |
| `revit_duplicate_sheet` | 复制图纸 | 候选 · 仅普通图纸空白复制，保留唯一图框，不复制视口、视图或明细表。 |
| `revit_renumber_sheets` | 批量重编号 | 候选 · 指定 1–50 张图纸的原编号和新编号，整批原子处理交换；自动前缀编号未覆盖。[验收](AEC-RENUMBER-SHEETS.zh-CN.md) |
| `revit_set_selection` | 设置当前选择 | 候选 · 界面选择为非事务效果，逐次确认，按 0–200 个精确实例 ID 设置并回读。 |
| `revit_select_by_unique_ids` | 按 UniqueId 选择并缩放 | 候选 · 精确解析 1–200 个 UniqueId 并回读选择；不缩放，任何缺失项整批拒绝。 |
| `revit_create_text_note` | 创建文字注释 | 候选 · 指定视图与文字类型精确 ID、内部坐标毫米锚点及纯文本，回读文本和位置。[验收](AEC-TEXT-NOTE-WRITE.zh-CN.md) |
| `revit_create_tag` | 标记构件 | 关联能力 · `revit_smart_annotate`。以当前视图、选中构件和标签类型为条件。 |
| `revit_create_schedule` | 创建明细表 | 候选 · 按精确内置类别与名称创建常规空明细表，不承诺已配置字段。 |
| `revit_get_schedule_data` | 读取明细表单元格 | 已接入候选 · 按明细表 ID 读取正文显示值，行列分别分页。尚未实机验证。 |
| `revit_create_dimension` | 创建线性尺寸 | 候选 · 当前平面/剖面/立面中，以两个本地平面面的稳定参照创建线性尺寸；不自动发现参照。 |
| `revit_get_revision_sequences` | 读取按序号排列的修订实例 | 已接入候选 · 返回修订实例及签发状态，行为与 AEC 实现一致。尚未实机验证。 |
| `revit_tag_all_in_view` | 批量标记视图内的构件 | 关联能力 · `revit_smart_annotate`。已有指定构件标记，按整视图自动筛选另议。 |
| `revit_get_view_templates` | 列出视图样板 | 关联能力 · `revit_list_views`。读取视图后按 is_template 筛选。 |
| `revit_apply_view_template` | 应用视图样板 | 候选 · 精确视图和样板 ID，验证兼容性，回读关联与前一状态。 |

## 族与类型

| AEC 工具 | 用途 | BuildX 对照 |
| --- | --- | --- |
| `revit_place_family_instance` | 放置族实例 | 已有同名 |
| `revit_place_door` | 在墙上放置门 | 已有同名 |
| `revit_place_window` | 在墙上放置窗 | 候选 · 指定窗类型、直墙、标高和内部坐标位置，支持水平朝向，回读宿主、位置和尺寸。[验收](AEC-WINDOW-WRITE.zh-CN.md) |
| `revit_list_families` | 列出已载族及类型 | 关联能力 · `revit_list_family_types`。以类型为主，未提供完整族层级。 |
| `revit_edit_family` | 打开族编辑 | 关联能力 · `revit_family_inspect_job`。读取已存在的族作业，任意现有族打开编辑另议。 |
| `revit_change_element_type` | 批量更换构件类型 | 候选 · 按实例和目标类型 ID 更改单个未成组实例；自动批量搜索未覆盖。 |
| `revit_replace_family_type` | 按族和类型名称批量换型 | 候选 · 按旧/新类型 ID 对 1–50 个显式实例原子换型；名称匹配与全模型自动筛选未覆盖。 |

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
