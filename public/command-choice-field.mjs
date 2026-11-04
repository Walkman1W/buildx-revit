import {commandElementId,commandFormDocument,commandFormOwner} from './command-form-source.mjs';

// Model choices retain the document that produced the IDs. This module only
// emits existing named read intents; the application owns all requests.
export function createCommandChoiceField({document,Event=globalThis.Event,id,key,label,value='',onCommand,onChange=()=>{}}){
  const definitions={
    element_id:{commandId:'selection',text:'读取当前选择'},
    start_element_id:{commandId:'selection',text:'读取当前选择'},
    element_ids:{commandId:'selection',text:'使用当前选择',multiple:true},
    level_id:{commandId:'levels',text:'读取标高'},
    wall_type_id:{commandId:'revit_list_family_types',category:'OST_Walls',text:'读取墙类型'},
    floor_type_id:{commandId:'revit_list_family_types',category:'OST_Floors',text:'读取楼板类型'},
    pipe_type_id:{commandId:'revit_list_family_types',category:'OST_PipeCurves',text:'读取管类型'},
    system_type_id:{commandId:'revit_list_family_types',category:'OST_PipingSystem',text:'读取系统类型'},
    symbol_id:{commandId:'revit_list_family_types',text:'读取族类型'},
  };
  const definition=definitions[key];if(!definition)return null;
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const button=(text,cls)=>{const node=el('button',cls,text);node.type='button';return node;};
  const element=el('div','model-command-field model-command-choice');
  const title=el('label','',label);title.htmlFor=id+'-choice';
  const line=el('div','command-choice-line'),select=el('select');select.id=id+'-choice';select.setAttribute('aria-label',label);
  const read=button(definition.text,'command-choice-read'),next=button('下一页','command-choice-next'),previous=button('上一页','command-choice-previous');
  const note=el('small','command-choice-note','先在 Revit 中选择构件，再读取。');note.setAttribute('role','status');
  const advanced=el('details','command-choice-manual'),summary=el('summary','','手动填写 ID'),manual=el('input');manual.type='text';manual.id=id;manual.setAttribute('aria-label',label+'，手动填写 ID');
  advanced.append(summary,manual);line.append(select,read);element.append(title,line,note,advanced);
  const pages=el('div','command-choice-pages');pages.hidden=true;pages.append(previous,next);element.append(pages);
  const filter=el('input');filter.type='text';filter.placeholder='按名称筛选类型';filter.setAttribute('aria-label',label+'，筛选名称');
  if(definition.commandId==='revit_list_family_types')line.before(filter);
  const input=el('input'),controls=[input,select,manual,read,next,previous,filter];input.type='text';input.dataset.defaultValue='';
  let selectedValue='',source=null,choiceSource=null,pending=null,snapshot=null,owner=null,offset=0,items=[];
  const changed=()=>{onChange();input.dispatchEvent(new Event('input'));};
  const setOptions=()=>{
    select.replaceChildren();const empty=el('option','',definition.multiple?'尚未读取构件':'请选择');empty.value='';select.append(empty);
    if(definition.multiple){if(items.length){const option=el('option','', '已选择 '+items.length+' 个构件');option.value=JSON.stringify(items.map(item=>item.element_id));select.append(option);}}
    else for(const item of items){const option=el('option','',[item.family_name,item.name].filter(Boolean).join(' · ')+'  #'+item.element_id);option.value=String(item.element_id);select.append(option);}
    select.value=selectedValue;
  };
  const setValue=raw=>{selectedValue=raw===undefined?'':String(raw);manual.value=selectedValue;if(definition.multiple)try{const ids=JSON.parse(selectedValue);if(Array.isArray(ids))manual.value=ids.join(', ');}catch{}select.value=selectedValue;};
  Object.defineProperty(input,'value',{get:()=>selectedValue,set:raw=>{setValue(raw);if(!selectedValue){source=null;choiceSource=null;items=[];setOptions();}}});input.focus=()=>select.focus();
  setValue(value);setOptions();if(value)advanced.open=true;
  if(definition.commandId!=='selection')note.textContent='读取模型中的'+label+'后选择。';
  function request(page=0){
    if(read.disabled)return;
    offset=page;pending={previous:snapshot?.commands?.find(item=>item.commandId===definition.commandId)?.executionId??null};
    source=null;choiceSource=null;items=[];setValue('');setOptions();note.textContent='正在读取…';changed();
    if(onCommand({commandId:definition.commandId,parameters:definition.commandId==='revit_list_family_types'?{...(definition.category?{category:definition.category}:{}),name_contains:filter.value,limit:50,offset}: {}})===false){pending=null;note.textContent='当前无法读取，请等待连接就绪后重试。';}
  }
  read.addEventListener('click',()=>request());next.addEventListener('click',()=>request(offset+50));previous.addEventListener('click',()=>request(Math.max(0,offset-50)));
  select.addEventListener('change',()=>{setValue(select.value);source=selectedValue?choiceSource:null;changed();});
  manual.addEventListener('input',()=>{const raw=manual.value;selectedValue=definition.multiple?(raw.trim()?JSON.stringify(raw.trim().split(/[\s,，;；]+/u).map(token=>/^[1-9]\d*$/.test(token)&&Number.isSafeInteger(Number(token))?Number(token):token)):''):raw;select.value='';source=null;changed();});
  filter.addEventListener('input',()=>{source=null;choiceSource=null;items=[];setValue('');setOptions();note.textContent='点击读取以应用筛选。';changed();});
  return {element,input,controls,sourceDocument:()=>source,validate:()=>{
    if(pending)return {ok:false,error:'请等待读取'+label+'完成。'};
    if(definition.multiple&&selectedValue){let ids;try{ids=JSON.parse(selectedValue);}catch{}if(!Array.isArray(ids)||ids.length<1||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(ids).size!==ids.length)return {ok:false,error:'请选择 1–50 个不同构件。'};}
    return {ok:true};
  },update(nextSnapshot){
    const newOwner=commandFormOwner(nextSnapshot);snapshot=nextSnapshot;
    if(owner!==null&&owner!==newOwner){source=null;choiceSource=null;pending=null;items=[];setValue('');setOptions();note.textContent='模型连接或对话已变化，请重新读取。';changed();}owner=newOwner;
    if(!pending)return;
    const result=snapshot?.commands?.find(item=>item.commandId===definition.commandId);
    if(result?.status==='pending'){pending.seenPending=true;return;}
    if(!result||result.executionId===pending.previous){if(pending.seenPending&&!snapshot?.busy&&!snapshot?.blocked){pending=null;note.textContent='本次读取未被接受，请重新读取。';}return;}
    if(result.status==='running')return;
    pending=null;
    if(result.status!=='completed'){note.textContent='未能读取，请重试。';return;}
    const data=result.result?.data?.value??result.result?.data,newSource=commandFormDocument(result.result);
    if(!newSource||!Array.isArray(data?.items)){note.textContent='返回结果不完整，请重新读取。';return;}
    source=newSource;choiceSource=newSource;items=data.items.map(item=>({...item,element_id:commandElementId(item?.element_id)})).filter(item=>item.element_id!==null).filter(item=>key!=='symbol_id'||item.class_name==='FamilySymbol').slice(0,200);
    setValue(definition.multiple?items.length?JSON.stringify(items.map(item=>item.element_id)): '':'');setOptions();
    pages.hidden=definition.commandId!=='revit_list_family_types';previous.hidden=offset===0;next.hidden=data.has_more!==true;
    const excluded=data.items.some(item=>commandElementId(item?.element_id)===null);
    note.textContent='本次可选 '+items.length+' 项'+(data.has_more||data.truncated?'；还有未显示的项。':'。')+(excluded?' 部分构件编号超出当前工具范围，已排除。':'');
    if(!items.length)note.textContent='没有可选项，请核对模型或当前选择。';changed();
  }};
}
