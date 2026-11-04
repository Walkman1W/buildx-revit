// Native, reusable field presentation. Tool schemas and the server continue to
// own validation and execution; controls only collect explicit user choices.
export const COMMAND_PARAMETER_LABELS = Object.freeze({
  keyword:'关键词',category:'类别',name_contains:'名称包含',limit:'每页数量',offset:'起始位置',
  element_id:'构件',element_ids:'构件',parameter_id:'参数 ID',parameter_name:'参数名称',mode:'执行方式',code:'C# 方法体',command_id:'命令 ID',
  name:'名称',description:'说明',parameters:'参数定义',parameter_labels:'输入项名称',parameter_options:'下拉选项与模型来源',steps:'只读步骤',source_request_id:'关联执行请求 ID',
  revision:'命令版本',job_handle:'族作业标识',level_id:'标高',wall_type_id:'墙类型',pipe_type_id:'管类型',
  floor_type_id:'楼板类型',symbol_id:'族类型',system_type_id:'系统类型',width_mm:'宽度（mm）',
  depth_mm:'深度（mm）',height_mm:'高度（mm）',thickness_mm:'板厚（mm）',shelf_count:'层板数量',
  diameter_mm:'管径（mm）',start_mm:'起点（mm）',end_mm:'终点（mm）',delta_mm:'位移（mm）',
  point_mm:'位置（mm）',origin_mm:'起点（mm）',axis_origin_mm:'旋转中心（mm）',
  angle_degrees:'旋转角度（°）',offset_mm:'标高偏移（mm）',template_id:'族模板',changes:'参数修改',
  view_id:'截图视图',source_view_id:'参照视图',context_element_ids:'周边参照构件',
  orientations:'检查视角',pixel_size:'图片长边（像素）',session_handle:'待恢复检查标识',
});

export function commandChoiceLabel(value, key) {
  if (value === false) return '否';
  if (value === true) return '是';
  if (key === 'mode' && value === 'rollback') return '预览（不保留修改）';
  if (key === 'mode' && value === 'commit') return '应用修改（不保存模型）';
  if (key === 'category') return ({all:'全部类别',walls:'墙',pipes:'管道',equipment:'机械设备'})[value] ?? String(value);
  if (key === 'orientations') return ({isometric:'轴测',front:'正面',side:'侧面'})[value] ?? String(value);
  return String(value);
}

const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const textValue = value => value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const pointRule = rule => rule.type === 'object' && ['x','y','z'].every(axis => rule.properties?.[axis]?.type === 'number') && Object.keys(rule.properties).length === 3;

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

export function createCommandField({document,Event=globalThis.Event,id,key,rule,label=COMMAND_PARAMETER_LABELS[key] ?? key,required=false,value,onChange=()=>{}}) {
  const make = (tag,className,text) => {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text !== undefined)node.textContent=text;
    return node;
  };
  const initial=value === undefined ? has(rule,'default') ? rule.default : '' : value;
  const exactId=isExactIdRule(rule),complex=!exactId&&(rule.type === 'array' || rule.type === 'object' || rule.anyOf || rule.oneOf);
  const isPoint=pointRule(rule),isIds=rule.type === 'array' && rule.items?.type === 'integer';
  const element=make(isPoint ? 'div' : 'label','command-field'+(isPoint?' command-field-point':isIds?' command-field-ids':''));
  const title=make('span','command-field-label',label);
  element.append(title);
  const input=make(Array.isArray(rule.enum) || rule.type === 'boolean' ? 'select' : complex && !isPoint && !isIds || key === 'code' ? 'textarea' : 'input');
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
      for(const axis of ['x','y','z']) {
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
      const control=make('input','command-element-ids');control.id=id+'-list';control.type='text';
      control.inputMode='numeric';control.placeholder='例如：123, 456';control.setAttribute('aria-label',label);
      element.htmlFor=control.id;element.append(control);controls.push(control);
      const help=make('small','command-field-help','多个构件编号用逗号分隔');element.append(help);
      read=()=>{
        const raw=control.value.trim();if(raw==='')return '';
        if(raw==='[]')return rule.minItems>0?'![]':'[]';
        const tokens=raw.split(/[\s,，;；]+/u);
        if(tokens.some(token=>! /^-?\d+$/.test(token) || !Number.isSafeInteger(Number(token))))return '!'+raw;
        const ids=tokens.map(Number),item=rule.items;
        if(ids.some(entry=>item.minimum !== undefined && entry<item.minimum || item.maximum !== undefined && entry>item.maximum) ||
          rule.minItems !== undefined && ids.length<rule.minItems || rule.maxItems !== undefined && ids.length>rule.maxItems ||
          rule.uniqueItems === true && new Set(ids).size!==ids.length)return '!'+raw;
        return JSON.stringify(ids);
      };
      write=next=>{
        const display=entries=>!entries.length?'[]':entries.every(entry=>typeof entry==='number' && Number.isSafeInteger(entry))?entries.join(', '):JSON.stringify(entries);
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
