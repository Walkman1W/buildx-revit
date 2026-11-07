// Native, reusable field presentation. Tool schemas and the server continue to
// own validation and execution; controls only collect explicit user choices.
export const COMMAND_PARAMETER_LABELS = Object.freeze({
  action:'操作',baseline_token:'基线 token',expected_version:'固定事件版本',expected_snapshot:'上一页快照指纹',
  keyword:'关键词',category:'类别',category1:'第一类别',category2:'第二类别',name_contains:'名称包含',limit:'每页数量',offset:'起始位置',
  category_ids:'类别 ID（每行一个）',definition_guid:'共享参数 GUID',definition_id:'参数定义 ID',data_type:'数据类型 ID',element_uids:'构件 UniqueId（每行一个）',element_id:'构件',element_ids:'构件',type_id:'类型 ID',target_type_id:'目标类型 ID',old_type_id:'原族类型 ID',new_type_id:'新族类型 ID',parameter_id:'参数 ID',parameter_name:'参数名称',mode:'执行方式',code:'C# 方法体',command_id:'命令 ID',
  name:'名称',description:'说明',parameters:'参数定义',parameter_labels:'输入项名称',parameter_options:'下拉选项与模型来源',steps:'只读步骤',source_request_id:'关联执行请求 ID',
  revision:'命令版本',job_handle:'族作业标识',level_id:'标高',base_level_id:'底部标高 ID',top_level_id:'顶部标高 ID',wall_type_id:'墙类型',pipe_type_id:'管类型',conduit_type_id:'导管类型 ID',duct_type_id:'风管类型 ID',
  floor_type_id:'楼板类型',roof_type_id:'屋顶类型 ID',origin_xy_mm:'矩形原点 XY（mm）',symbol_id:'族类型',system_type_id:'系统类型',width_mm:'宽度（mm）',
  depth_mm:'深度（mm）',height_mm:'高度（mm）',thickness_mm:'板厚（mm）',shelf_count:'层板数量',
  diameter_mm:'管径（mm）',start_mm:'起点（mm）',end_mm:'终点（mm）',delta_mm:'位移（mm）',
  plane_origin_mm:'镜像平面原点（mm）',plane_normal:'镜像平面法向（水平单位向量）',wall_id:'墙 ID',facing_direction:'朝向（水平单位向量）',point_mm:'位置（mm）',point_xy_mm:'位置 XY（mm）',origin_mm:'起点（mm）',axis_origin_mm:'旋转中心（mm）',
  angle_degrees:'旋转角度（°）',offset_mm:'标高偏移（mm）',elevation_mm:'高程（mm）',tolerance_feet:'包围盒容差（英尺）',fields:'返回字段',template_id:'族模板',changes:'参数修改',
  reference_a:'第一稳定参照',reference_b:'第二稳定参照',source_sheet_id:'源图纸 ID',copy_option:'复制选项',view_id:'视图 ID',view_family_type_id:'视图类型 ID',sheet_id:'图纸 ID',number:'图纸编号',titleblock_id:'图框 ID',group_id:'模型组 ID',source_view_id:'参照视图',context_element_ids:'周边参照构件',
  x_mm:'图纸 X（mm）',y_mm:'图纸 Y（mm）',
  material_id:'目标材质 ID',expected_has_value:'原参数有值',expected_value_internal:'原材质参数值（ElementId）',
  red:'图形颜色红（0–255）',green:'图形颜色绿（0–255）',blue:'图形颜色蓝（0–255）',transparency:'图形透明度（0–100）',shininess:'光泽度（0–128）',smoothness:'光滑度（0–100）',
  text:'文字内容',text_type_id:'文字类型 ID',
  orientations:'检查视角',pixel_size:'图片长边（像素）',session_handle:'待恢复检查标识',
});

export function commandChoiceLabel(value, key) {
  if (value === false) return '否';
  if (value === true) return '是';
  if (key === 'copy_option' && value === 'empty') return '空白图纸（仅图框）';
  if (key === 'action') return ({status:'查询基线状态',start:'显式建立或沿用基线',page:'读取事件页'})[value] ?? String(value);
  if (key === 'mode' && value === 'rollback') return '预览（不保留修改）';
  if (key === 'mode' && value === 'commit') return '应用修改（不保存模型）';
  if (key === 'category') return ({all:'全部类别',walls:'墙',pipes:'管道',equipment:'机械设备'})[value] ?? String(value);
  if (key === 'orientations') return ({isometric:'轴测',front:'正面',side:'侧面'})[value] ?? String(value);
  return String(value);
}

const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const textValue = value => value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const pointRule = rule => rule.type === 'object' && ['x','y'].every(axis => rule.properties?.[axis]?.type === 'number') && (Object.keys(rule.properties).length === 2 || Object.keys(rule.properties).length === 3 && rule.properties?.z?.type === 'number');

// Recognize only the published decimal-ID union. Other structured schemas
// retain their existing controls; the server still owns the ID's domain.
export function isExactIdRule(rule) {
  if(!Array.isArray(rule?.anyOf)||rule.anyOf.length!==2)return false;
  const numeric=rule.anyOf.find(entry=>entry?.type==='integer'),decimal=rule.anyOf.find(entry=>entry?.type==='string');
  return Boolean(numeric&&decimal&&['^[1-9]\\d{0,18}$','^-?(?:0|[1-9]\\d{0,18})$'].includes(decimal.pattern));
}

export function parseExactIdValue(rule,value) {
  if(!isExactIdRule(rule)||typeof value!=='string'&&typeof value!=='number'||typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('Invalid exact ID');
  const raw=String(value),decimal=rule.anyOf.find(entry=>entry.type==='string'),numeric=rule.anyOf.find(entry=>entry.type==='integer');
  if(!new RegExp(decimal.pattern).test(raw)||decimal.maxLength!==undefined&&raw.length>decimal.maxLength||decimal.minLength!==undefined&&raw.length<decimal.minLength)throw new Error('Invalid exact ID');
  const exact=BigInt(raw);
  if(exact.toString()!==raw||(rule.not?.enum||[]).some(entry=>entry===raw||typeof entry==='number'&&Number.isSafeInteger(entry)&&BigInt(entry)===exact))throw new Error('Invalid exact ID');
  if(exact>=BigInt(Number.MIN_SAFE_INTEGER)&&exact<=BigInt(Number.MAX_SAFE_INTEGER)){
    const number=Number(exact);
    if((numeric.minimum===undefined||number>=numeric.minimum)&&(numeric.maximum===undefined||number<=numeric.maximum)&&
      (numeric.exclusiveMinimum===undefined||number>numeric.exclusiveMinimum)&&(numeric.exclusiveMaximum===undefined||number<numeric.exclusiveMaximum))return number;
  }
  return raw;
}

export function createCommandField({document,Event=globalThis.Event,id,key,rule,label=COMMAND_PARAMETER_LABELS[key] ?? key,required=false,value,multiline=false,onChange=()=>{}}) {
  const make = (tag,className,text) => {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text !== undefined)node.textContent=text;
    return node;
  };
  const initial=value === undefined ? has(rule,'default') ? rule.default : '' : value;
  const exactId=isExactIdRule(rule),complex=!exactId&&(rule.type === 'array' || rule.type === 'object' || rule.anyOf || rule.oneOf);
  const isPoint=pointRule(rule),isStringIds=['element_uids','category_ids'].includes(key)&&rule.type==='array'&&rule.items?.type==='string',isIds=rule.type === 'array' && (rule.items?.type === 'integer'||isExactIdRule(rule.items)||isStringIds);
  const multilineText=multiline&&rule.type==='string';
  const element=make(isPoint ? 'div' : 'label','command-field'+(isPoint?' command-field-point':isIds?' command-field-ids':''));
  const title=make('span','command-field-label',label);
  element.append(title);
  const input=make(Array.isArray(rule.enum) || rule.type === 'boolean' ? 'select' : complex && !isPoint && !isIds || key === 'code' || multilineText ? 'textarea' : 'input');
  input.id=id;input.required=required;
  if(!isPoint)element.htmlFor=id;
  input.dataset.defaultValue=textValue(has(rule,'default')?rule.default:'');
  if(rule.description)input.title=rule.description;
  const controls=[input];
  for(const type of ['input','change'])input.addEventListener(type,onChange);

  if (isPoint || isIds) {
    input.type='hidden';input.hidden=true;
    const forward=(control,type) => control.addEventListener(type,()=>input.dispatchEvent(new Event(type)));
    let read,write,focus;
    if(isPoint) {
      const axes={},group=make('div','command-point-axes');
      let invalidSource='';
      for(const axis of Object.keys(rule.properties)) {
        const axisLabel=make('label','command-point-axis',axis.toUpperCase()),control=make('input');
        control.id=id+'-'+axis;control.type='number';control.step='any';
        control.setAttribute('aria-label',label+' '+axis.toUpperCase());axisLabel.htmlFor=control.id;
        axisLabel.append(control);group.append(axisLabel);axes[axis]=control;controls.push(control);
        for(const type of ['input','change']) {
          control.addEventListener(type,()=>{invalidSource='';});forward(control,type);
        }
      }
      element.append(group);
      read=()=>{
        if(invalidSource)return '!'+invalidSource;
        const values=Object.fromEntries(Object.entries(axes).map(([axis,control])=>[axis,control.value.trim()]));
        if(Object.values(values).every(entry=>entry===''))return '';
        if(Object.values(values).some(entry=>entry==='' || !Number.isFinite(Number(entry))))return '!'+JSON.stringify(values);
        return JSON.stringify(Object.fromEntries(Object.entries(values).map(([axis,entry])=>[axis,Number(entry)])));
      };
      write=next=>{
        invalidSource='';
        if(next === '' || next === undefined || next === null) {for(const control of Object.values(axes))control.value='';return;}
        let parsed=next;
        try {if(typeof parsed==='string')parsed=JSON.parse(parsed);}catch {parsed=null;}
        if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Object.keys(parsed).some(name=>!has(axes,name))) {
          invalidSource=textValue(next);for(const control of Object.values(axes))control.value='';
        }else {
          if(Object.entries(parsed).some(([,entry])=>typeof entry!=='number' || !Number.isFinite(entry)))invalidSource=textValue(next);
          for(const [axis,control] of Object.entries(axes))control.value=textValue(parsed[axis]);
        }
      };
      focus=()=>axes.x.focus();
    }else {
      const control=make(isStringIds?'textarea':'input','command-element-ids');control.id=id+'-list';if(!isStringIds)control.type='text';
      if(!isStringIds)control.inputMode='numeric';control.placeholder=isStringIds?(key==='category_ids'?'每行填写一个类别 ID':'每行粘贴一个 UniqueId'):'例如：123, 456';control.setAttribute('aria-label',label);
      element.htmlFor=control.id;element.append(control);controls.push(control);
      const help=make('small','command-field-help',isStringIds?(key==='category_ids'?'每行一个精确类别 ID':'每行一个完整 UniqueId'):'多个构件编号用逗号分隔');element.append(help);
      read=()=>{
        const raw=control.value.trim();if(raw==='')return '';
        if(raw==='[]')return rule.minItems>0?'![]':'[]';
        const tokens=isStringIds?raw.split(/\r?\n/u):raw.split(/[\s,，;；]+/u);
        if(isStringIds){if(tokens.some(token=>!token||token!==token.trim()||/[\u0000-\u001f\u007f]/u.test(token)||rule.items.minLength!==undefined&&token.length<rule.items.minLength||rule.items.maxLength!==undefined&&token.length>rule.items.maxLength)||rule.minItems!==undefined&&tokens.length<rule.minItems||rule.maxItems!==undefined&&tokens.length>rule.maxItems||rule.uniqueItems===true&&new Set(tokens).size!==tokens.length)return '!'+raw;return JSON.stringify(tokens);}
        let ids;try {ids=isExactIdRule(rule.items)?tokens.map(token=>parseExactIdValue(rule.items,token)):tokens.map(token=>{if(!/^-?\d+$/.test(token)||!Number.isSafeInteger(Number(token)))throw new Error();return Number(token);});}catch{return '!'+raw;}
        const item=rule.items;
        if(ids.some(entry=>item.minimum !== undefined && entry<item.minimum || item.maximum !== undefined && entry>item.maximum) ||
          rule.minItems !== undefined && ids.length<rule.minItems || rule.maxItems !== undefined && ids.length>rule.maxItems ||
          rule.uniqueItems === true && new Set(ids.map(String)).size!==ids.length)return '!'+raw;
        return JSON.stringify(ids);
      };
      write=next=>{
        const display=entries=>isStringIds?entries.join('\n'):!entries.length?'[]':entries.every(entry=>typeof entry==='number' && Number.isSafeInteger(entry)||isExactIdRule(rule.items)&&typeof entry==='string'&&/^[1-9]\d*$/.test(entry))?entries.join(', '):JSON.stringify(entries);
        if(Array.isArray(next)){control.value=display(next);return;}
        const raw=textValue(next);
        try {const parsed=JSON.parse(raw);if(Array.isArray(parsed)){control.value=display(parsed);return;}}catch {}
        control.value=raw;
      };
      focus=()=>control.focus();
      for(const type of ['input','change'])forward(control,type);
    }
    Object.defineProperty(input,'value',{configurable:true,get:read,set:write});input.focus=focus;
    input.value=initial;element.append(input);
    return {element,input,controls};
  }

  if(Array.isArray(rule.enum) || rule.type === 'boolean') {
    const choices=Array.isArray(rule.enum) ? rule.enum : [false,true];
    if(!has(rule,'default')) {const option=make('option','',required?'请选择':'未指定');option.value='';input.append(option);}
    for(const choice of choices) {const option=make('option','',commandChoiceLabel(choice,key));option.value=String(choice);input.append(option);}
  }else if(multilineText) {
    input.rows=4;
    if(rule.maxLength !== undefined)input.maxLength=rule.maxLength;
  }else if(!complex && key !== 'code') {
    input.type=rule.type === 'number' || rule.type === 'integer' ? 'number' : 'text';
    if(exactId){input.inputMode='numeric';const maxLength=rule.anyOf.find(entry=>entry.type==='string').maxLength;if(maxLength!==undefined)input.maxLength=maxLength;}
    if(input.type === 'number')input.step=rule.type === 'integer'?'1':'any';
    if(rule.minimum !== undefined)input.min=String(rule.minimum);
    if(rule.maximum !== undefined)input.max=String(rule.maximum);
    if(rule.maxLength !== undefined)input.maxLength=rule.maxLength;
  }
  if(complex) {
    input.rows=4;input.placeholder=rule.type === 'array'?'[ … ]':'{ … }';
    element.append(make('small','command-field-help','高级输入（JSON）'));
  }
  input.value=textValue(initial);element.append(input);
  return {element,input,controls};
}

// Explicit sheet IDs and numbers are entered as rows; the shared schema remains
// the validation owner and the hidden input is only the form adapter.
export function createSheetRenumberField({document,Event=globalThis.Event,id,rule,value,onChange=()=>{}}){
  const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const element=make('div');element.className='model-command-field model-command-field-wide';
  const title=make('span','逐行填写图纸 ID、原编号和新编号');title.className='command-field-label';
  const input=make('input');input.type='hidden';input.id=id;input.dataset.defaultValue='';
  const list=make('div'),add=make('button','添加图纸');add.type='button';add.id=id+'-add';
  const rows=[],controls=[input,add],idRule=rule.items.properties.sheet_id;let serial=0;
  const changed=()=>{input.dispatchEvent(new Event('input',{bubbles:true}));onChange();};
  function appendRow(data={}){
    if(rows.length>=50)return;
    const node=make('div');node.className='parameter-change-step';const fields={},rowId=serial++;
    for(const [key,label] of [['sheet_id','图纸 ID'],['expected_number','原编号'],['new_number','新编号']]){
      const wrap=make('label',label),field=make('input');field.type='text';field.id=id+'-'+rowId+'-'+key;field.value=data[key]===undefined?'':String(data[key]);field.setAttribute('aria-label',label);wrap.append(field);node.append(wrap);fields[key]=field;controls.push(field);
      for(const event of ['input','change'])field.addEventListener(event,changed);
    }
    const remove=make('button','删除');remove.type='button';node.append(remove);controls.push(remove);
    const row={node,fields};rows.push(row);remove.addEventListener('click',()=>{if(rows.length===1){for(const field of Object.values(fields))field.value='';}else{rows.splice(rows.indexOf(row),1);node.remove();}changed();});list.append(node);
  }
  add.addEventListener('click',()=>{appendRow();changed();});
  Object.defineProperty(input,'value',{configurable:true,get(){
    try{return JSON.stringify(rows.map(row=>({sheet_id:parseExactIdValue(idRule,row.fields.sheet_id.value),expected_number:row.fields.expected_number.value,new_number:row.fields.new_number.value})));}catch{return '!invalid';}
  },set(raw){
    let parsed=raw;try{if(typeof raw==='string')parsed=JSON.parse(raw);}catch{parsed=[];}
    rows.length=0;list.replaceChildren();if(Array.isArray(parsed)&&parsed.length&&parsed.length<=50)for(const row of parsed)appendRow(row);else appendRow();
  }});
  input.focus=()=>rows[0]?.fields.sheet_id.focus();element.append(title,input,list,add);input.value=value??'';
  return {element,input,controls};
}

export function createSheetBatchField({document,Event=globalThis.Event,id,rule,value,onChange=()=>{}}){
  const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const element=make('div');element.className='model-command-field model-command-field-wide';
  const title=make('span','逐行填写图纸名称、编号和可选图框 ID');title.className='command-field-label';
  const input=make('input');input.type='hidden';input.id=id;input.dataset.defaultValue='';
  const list=make('div'),add=make('button','添加图纸');add.type='button';add.id=id+'-add';
  const rows=[],controls=[input,add],idRule=rule.items.properties.titleblock_id;let serial=0;
  const changed=()=>{input.dispatchEvent(new Event('input',{bubbles:true}));onChange();};
  function appendRow(data={}){
    if(rows.length>=50)return;
    const node=make('div');node.className='parameter-change-step';const fields={},rowId=serial++;
    for(const [key,label] of [['name','图纸名称'],['number','图纸编号'],['titleblock_id','图框 ID（可留空）']]){
      const wrap=make('label',label),field=make('input');field.type='text';field.id=id+'-'+rowId+'-'+key;field.value=data[key]===undefined?'':String(data[key]);field.setAttribute('aria-label',label);wrap.append(field);node.append(wrap);fields[key]=field;controls.push(field);
      for(const event of ['input','change'])field.addEventListener(event,changed);
    }
    const remove=make('button','删除');remove.type='button';node.append(remove);controls.push(remove);
    const row={node,fields};rows.push(row);remove.addEventListener('click',()=>{if(rows.length===1){for(const field of Object.values(fields))field.value='';}else{rows.splice(rows.indexOf(row),1);node.remove();}changed();});list.append(node);
  }
  add.addEventListener('click',()=>{appendRow();changed();});
  Object.defineProperty(input,'value',{configurable:true,get(){
    try{return JSON.stringify(rows.map(row=>({name:row.fields.name.value,number:row.fields.number.value,...(row.fields.titleblock_id.value.trim()?{titleblock_id:parseExactIdValue(idRule,row.fields.titleblock_id.value)}:{})})));}catch{return '!invalid';}
  },set(raw){
    let parsed=raw;try{if(typeof raw==='string')parsed=JSON.parse(raw);}catch{parsed=[];}
    rows.length=0;list.replaceChildren();if(Array.isArray(parsed)&&parsed.length&&parsed.length<=50)for(const row of parsed)appendRow(row);else appendRow();
  }});
  input.focus=()=>rows[0]?.fields.name.focus();element.append(title,input,list,add);input.value=value??'';
  return {element,input,controls};
}
