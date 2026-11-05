// Presentation only: parameter identities and values come from the native read
// contract. The existing command owner retains transport and write authority.
import {commandElementId,commandFormDocument,sameCommandFormDocument,commandFormOwner} from './command-form-source.mjs';
import {isExactIdRule,parseExactIdValue} from './command-fields.mjs';

const parameterId = value => Number.isSafeInteger(value) && value !== 0 && value !== -1;

export function parameterInputKind(parameter,{exactIds=false,idRule}={}) {
  let validId=parameter&&parameterId(parameter.parameter_id);
  if(exactIds)try{parseExactIdValue(idRule,parameter?.parameter_id);validId=true;}catch{validId=false;}
  if (!parameter || !validId || typeof parameter.name !== 'string' || parameter.is_read_only !== false) return null;
  if (parameter.storage_type === 'String') return 'text';
  if (parameter.storage_type === 'Integer') return /^autodesk\.spec:spec\.bool-\d+\.\d+\.\d+$/.test(parameter.data_type) ? 'yesno' : 'integer';
  if (parameter.storage_type === 'Double' && /^autodesk\.spec\.aec:length-\d+\.\d+\.\d+$/.test(parameter.data_type)) return 'length';
  return null;
}

export function parameterExpectedState(parameter) {
  if(!parameter||!['String','Integer','Double'].includes(parameter.storage_type)||typeof parameter.has_value!=='boolean'||
    !Object.hasOwn(parameter,'value_internal')||!Object.hasOwn(parameter,'data_type')||parameter.data_type!==null&&typeof parameter.data_type!=='string')return null;
  const value=parameter.value_internal;
  if(!parameter.has_value&&value!==null||value!==null&&(parameter.storage_type==='String'?typeof value!=='string':
    parameter.storage_type==='Integer'?!Number.isInteger(value)||value<-2147483648||value>2147483647:typeof value!=='number'||!Number.isFinite(value)))return null;
  return {storage_type:parameter.storage_type,has_value:parameter.has_value,value_internal:value,data_type:parameter.data_type};
}

export function createParameterChangeField({document,Event=globalThis.Event,id,onCommand,onChange=()=>{},rule,maxChanges=50,exactIds=false}) {
  if(!Number.isInteger(maxChanges)||maxChanges<1||maxChanges>50)throw new Error('Invalid parameter change limit');
  const elementRule=rule?.items?.properties?.element_id,idRule=rule?.items?.properties?.parameter_id;
  if(exactIds&&(!isExactIdRule(elementRule)||!isExactIdRule(idRule)))throw new Error('Exact parameter changes require the published ID schemas');
  const normalizeId=(value,signed=false)=>{
    if(!exactIds)return signed?parameterId(value)?value:null:commandElementId(value);
    try{return parseExactIdValue(signed?idRule:elementRule,value);}catch{return null;}
  };
  const kindOf=parameter=>exactIds&&!parameterExpectedState(parameter)?null:parameterInputKind(parameter,{exactIds,idRule});
  const make = (tag,className,text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const element=make('div','model-command-field model-command-field-wide parameter-change-field');
  const input=make('input');input.id=id;input.type='hidden';input.dataset.defaultValue='';
  const controls=[input];
  const control = (tag,suffix) => {const node=make(tag);node.id=id+'-'+suffix;controls.push(node);return node;};
  const button = (suffix,text) => {const node=control('button',suffix);node.type='button';node.textContent=text;return node;};
  const option = (select,value,text) => {const node=make('option','',text);node.value=String(value);select.append(node);};
  const field = (text,node) => {const label=make('label','parameter-change-label',text);label.htmlFor=node.id;label.append(node);return label;};
  const readSelection=button('read-selection','读取当前选择');readSelection.className='parameter-change-read';
  const elementSelect=control('select','element');
  const readParameters=button('read-parameters','读取参数');readParameters.className='parameter-change-read';
  const parameterSelect=control('select','parameter');
  const valueText=control('input','value');valueText.type='text';
  const valueNumber=control('input','number');valueNumber.type='number';valueNumber.step='any';
  const valueBoolean=control('select','yesno');option(valueBoolean,'','请选择');option(valueBoolean,0,'否');option(valueBoolean,1,'是');valueBoolean.value='';
  const current=make('p','parameter-change-current');
  const valueLabel=make('label','parameter-change-label parameter-change-value','新值');
  const valueHeading=make('span','','新值');valueLabel.textContent='';valueLabel.append(valueHeading,valueText,valueNumber,valueBoolean);
  const add=button('add','加入修改');add.className='parameter-change-add';
  const list=make('div','parameter-change-list');
  const status=make('p','parameter-change-status','先在 Revit 中选中元素，再读取当前选择。');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const error=make('p','parameter-change-error');error.setAttribute('role','alert');error.hidden=true;
  const selectionStep=make('div','parameter-change-step');selectionStep.append(make('strong','parameter-change-step-title','1 选择元素'),readSelection,field('元素',elementSelect),readParameters);
  const valueStep=make('div','parameter-change-step');valueStep.append(make('strong','parameter-change-step-title','2 填写修改'),field('参数',parameterSelect),current,valueLabel,add);
  element.append(input,selectionStep,valueStep,status,error,list);
  let snapshot=null,owner=null,source=null,elements=[],parameters=[],changes=[],pending=null,dirty=false,readBlocked=false,removedButtons=[];
  const observations=new Map();

  function notify() {error.hidden=true;input.dispatchEvent(new Event('input',{bubbles:true}));onChange();}
  function available(node,yes) {node.dataset.fieldUnavailable=String(!yes);node.disabled=!yes || input.disabled;}
  function selectedElement() {return elements.find(item=>String(item.element_id)===elementSelect.value) || null;}
  function selectedParameter() {return parameters.find(item=>String(item.parameter_id)===parameterSelect.value) || null;}
  function sync() {
    available(readSelection,!pending);
    available(elementSelect,elements.length>0&&!pending);
    available(readParameters,Boolean(selectedElement()&&source&&!pending));
    available(parameterSelect,parameters.length>0&&!pending);
    const parameter=selectedParameter(),kind=kindOf(parameter);
    valueText.hidden=kind!=='text';valueNumber.hidden=!['length','integer'].includes(kind);valueBoolean.hidden=kind!=='yesno';
    valueLabel.hidden=!kind;current.hidden=!kind;
    available(valueText,kind==='text'&&!pending);available(valueNumber,['length','integer'].includes(kind)&&!pending);available(valueBoolean,kind==='yesno'&&!pending);
    available(add,Boolean(kind&&source&&!pending&&changes.length<maxChanges));
    for(const node of removedButtons)available(node,!pending);
  }
  function clearParameters() {parameters=[];observations.clear();parameterSelect.replaceChildren();option(parameterSelect,'','请先读取参数');parameterSelect.value='';valueText.value='';valueNumber.value='';valueBoolean.value='';current.textContent='';dirty=false;}
  function clearElements() {elements=[];elementSelect.replaceChildren();option(elementSelect,'','请先读取当前选择');elementSelect.value='';clearParameters();}
  function renderChanges() {
    for(const node of removedButtons){const index=controls.indexOf(node);if(index>=0)controls.splice(index,1);}removedButtons=[];list.replaceChildren();
    if(!changes.length){list.append(make('p','parameter-change-empty','尚未加入修改'));return;}
    list.append(make('strong','parameter-change-list-title','待修改 · '+changes.length+' 项'));
    changes.forEach((entry,index)=>{
      const row=make('div','parameter-change-item'),copy=make('div','parameter-change-item-copy');
      copy.append(make('strong','',entry.elementName+' · '+entry.parameterName),make('small','',entry.displayValue));
      const remove=button('remove-'+index,'移除');remove.className='parameter-change-remove';remove.setAttribute('aria-label','移除 '+entry.elementName+' 的 '+entry.parameterName);removedButtons.push(remove);
      remove.addEventListener('click',()=>{if(remove.disabled)return;changes.splice(index,1);renderChanges();notify();sync();});row.append(copy,remove);list.append(row);
    });
  }
  function reset(message='先在 Revit 中选中元素，再读取当前选择。') {pending=null;source=null;changes=[];readBlocked=false;clearElements();renderChanges();status.textContent=message;sync();}
  function failure(message) {error.textContent=message;error.hidden=false;}
  function pickParameter() {
    const parameter=selectedParameter(),kind=kindOf(parameter);dirty=false;valueText.value='';valueNumber.value='';valueBoolean.value='';
    valueHeading.textContent=kind==='length'?'新值（mm）':kind==='integer'?'新值（整数）':'新值';
    const currentValue=parameter?.value_internal;
    if(kind==='text'&&typeof currentValue==='string')valueText.value=currentValue;
    else if(kind==='integer'&&Number.isInteger(currentValue))valueNumber.value=String(currentValue);
    else if(kind==='length'&&typeof currentValue==='number'&&Number.isFinite(currentValue*304.8))valueNumber.value=String(currentValue*304.8);
    else if(kind==='yesno'&&(currentValue===0||currentValue===1))valueBoolean.value=String(currentValue);
    let shown='未设置';
    if(parameter?.has_value===true){
      if(kind==='length'&&valueNumber.value!=='')shown=valueNumber.value+' mm';
      else if(kind==='yesno'&&(currentValue===0||currentValue===1))shown=currentValue===1?'是':'否';
      else if(typeof parameter.value_display==='string')shown=parameter.value_display===''?'空文本':parameter.value_display;
      else if(typeof currentValue==='string'||typeof currentValue==='number')shown=String(currentValue);
    }
    current.textContent='当前值：'+shown;valueLabel.htmlFor=kind==='text'?valueText.id:kind==='yesno'?valueBoolean.id:valueNumber.id;
    valueNumber.step=kind==='integer'?'1':'any';valueNumber.min=kind==='integer'?'-2147483648':'';valueNumber.max=kind==='integer'?'2147483647':'';sync();
  }
  function begin(commandId,parameters,sourceDocument) {
    const previous=snapshot?.commands?.find(command=>command.commandId===commandId);
    pending={commandId,previousExecutionId:previous?.executionId,executionId:null,seen:false,seenPending:false,elementId:parameters.element_id,source:sourceDocument};readBlocked=true;
    clearParameters();status.textContent=commandId==='selection'?'正在读取当前选择…':'正在读取参数…';notify();sync();
    onCommand({commandId,parameters,...sourceDocument?{sourceDocument:{...sourceDocument}}:{}});
  }
  readSelection.addEventListener('click',()=>{if(readSelection.disabled)return;clearElements();begin('selection',{});});
  elementSelect.addEventListener('change',()=>{clearParameters();notify();sync();});
  readParameters.addEventListener('click',()=>{if(readParameters.disabled)return;const item=selectedElement();if(item&&source)begin(exactIds?'revit_get_element_parameters':'revit_describe_parameters',{element_id:item.element_id},source);});
  parameterSelect.addEventListener('change',()=>{pickParameter();notify();});
  for(const node of [valueText,valueNumber,valueBoolean])for(const event of ['input','change'])node.addEventListener(event,()=>{dirty=true;notify();});
  add.addEventListener('click',()=>{
    if(add.disabled)return;const item=selectedElement(),parameter=selectedParameter(),kind=kindOf(parameter);if(!item||!kind||!source)return;
    if(changes.some(entry=>entry.change.element_id===item.element_id&&entry.change.parameter_id===parameter.parameter_id)){failure('此元素的该参数已在列表中；请先移除原项再修改。');return;}
    let value,displayValue;
    if(kind==='text'){value=valueText.value;displayValue=value===''?'空文本':value;}
    else if(kind==='yesno'){
      if(!['0','1'].includes(valueBoolean.value)){failure('请选择“是”或“否”。');return;}
      value=Number(valueBoolean.value);displayValue=value===1?'是':'否';
    }else{
      if(!valueNumber.value.trim()||!Number.isFinite(Number(valueNumber.value))){failure('请填写有效数字。');return;}
      value=Number(valueNumber.value);
      if(kind==='integer'&&(!Number.isInteger(value)||value < -2147483648||value > 2147483647)){failure('请填写 -2147483648 到 2147483647 之间的整数。');return;}
      displayValue=String(value)+(kind==='length'?' mm':'');if(kind==='length')value/=304.8;
      if(!Number.isFinite(value)){failure('该数字超出可用范围。');return;}
    }
    const expectedState=exactIds?observations.get(String(parameter.parameter_id)):null;
    if(exactIds&&!expectedState){failure('请重新读取参数，以核对修改前的原始值。');return;}
    const change={element_id:item.element_id,parameter_id:parameter.parameter_id,value,...kind==='length'?{value_unit:'internal'}:{},...exactIds?{expected_state:{...expectedState}}:{}};
    changes.push({change,elementName:item.name,parameterName:parameter.name,displayValue});dirty=false;renderChanges();status.textContent=maxChanges===1?'已加入 1 项修改；更换目标前请先移除该项。':'已加入 '+changes.length+' 项修改；可继续选择其他参数。';notify();sync();
  });
  Object.defineProperty(input,'value',{get:()=>JSON.stringify(changes.map(entry=>entry.change)),set:value=>{
    reset(value && value!=='[]'?'请重新读取元素和参数，以核对这份修改的来源。':undefined);notify();
  },configurable:true});
  input.focus=()=>{(elements.length?elementSelect:readSelection).focus();};
  function update(value) {
    const nextOwner=commandFormOwner(value);
    if(owner!==null&&owner!==nextOwner){reset('身份或对话已变化，请重新读取当前选择。');notify();}
    owner=nextOwner;snapshot=value;
    if(!pending){sync();return;}
    const command=value?.commands?.find(entry=>entry.commandId===pending.commandId);
    if(!command){if(pending.seen){pending=null;status.textContent='读取结果已失效，请重新读取。';sync();}return;}
    if(command.status==='pending'){pending.seen=true;pending.seenPending=true;sync();return;}
    if(typeof command.executionId!=='string'||!command.executionId){
      if(pending.seen&&['failed','unknown','interrupted'].includes(command.status)){pending=null;clearParameters();status.textContent='读取未完成，请核对结果后重新读取。';notify();sync();}
      return;
    }
    if(command.executionId===pending.previousExecutionId){
      // HTTP rejection restores the previous result in the app owner. Once our
      // pending transport has been observed, that old execution is a rejection,
      // never the answer to the newly requested read.
      if(pending.seenPending&&['completed','failed','unknown','interrupted'].includes(command.status)&&!value.busy&&!value.blocked){
        pending=null;clearParameters();status.textContent='本次读取未被接受，请核对状态后重新读取。';notify();sync();
      }
      return;
    }
    if(pending.executionId&&pending.executionId!==command.executionId){pending=null;clearParameters();status.textContent='读取任务已变化，请重新读取。';notify();sync();return;}
    pending.executionId=command.executionId;pending.seen=true;
    if(['running','stopping'].includes(command.status)){sync();return;}
    const request=pending;pending=null;
    if(command.status!=='completed'){status.textContent=command.status==='unknown'?'读取结果待核对，请先核对原回执。':'读取未完成，请重新读取。';clearParameters();notify();sync();return;}
    const receivedSource=commandFormDocument(command.result);
    if(!receivedSource){reset('读取结果缺少模型来源，无法填写修改；请重新读取。');notify();return;}
    if(source&&!sameCommandFormDocument(source,receivedSource)||request.source&&!sameCommandFormDocument(request.source,receivedSource)){
      reset('当前模型已变化，原修改列表已清空；请重新读取当前选择。');notify();return;
    }
    if(request.commandId==='selection'){
      const data=command.result?.data;
      if(!Array.isArray(data?.items)){reset('选择结果格式不完整，请重新读取。');notify();return;}
      source=receivedSource;
      // Legacy writes retain their safe-integer boundary. The guarded mode uses
      // its published exact-ID schema and never rounds a native decimal ID.
      elements=[];let unsupportedIds=0,unsupportedTypes=0;
      for(const item of data.items){
        if(item?.is_type===true||item?.is_element_type===true||item?.class_name==='ElementType'||item?.class_name==='FamilySymbol'){unsupportedTypes++;continue;}
        const element_id=normalizeId(item?.element_id);
        if(element_id===null)unsupportedIds++;
        else if(typeof item.name==='string')elements.push({...item,element_id});
      }
      elementSelect.replaceChildren();option(elementSelect,'','请选择元素');
      for(const item of elements)option(elementSelect,item.element_id,item.name+(typeof item.category==='string'?' · '+item.category:'')+' · #'+item.element_id);
      elementSelect.value=elements.length===1?String(elements[0].element_id):'';
      const partial=data.truncated===true||data.has_more===true||Number.isSafeInteger(data.total)&&data.total>elements.length||elements.length<data.items.length;
      status.textContent=elements.length?'已读取 '+elements.length+' 个元素'+(partial?'（仅本次返回；可缩小 Revit 中的选择后重读）':'')+'，选择元素后读取参数。':'当前没有可用的已选元素，请先在 Revit 中选择。';
      if(unsupportedIds)status.textContent+=' '+unsupportedIds+' 个元素编号超出当前表单支持范围或格式无效，已排除。';
      if(unsupportedTypes)status.textContent+=' '+unsupportedTypes+' 个元素类型已排除；本操作仅修改实例参数。';
    }else{
      const data=command.result?.data?.value;
      if((exactIds?String(normalizeId(data?.element_id))!==String(request.elementId):data?.element_id!==request.elementId)||!Array.isArray(data?.parameters)){
        clearParameters();status.textContent='参数结果与所选元素不一致，请重新读取。';notify();sync();return;
      }
      parameters=data.parameters.filter(parameter=>kindOf(parameter)).map(parameter=>({...parameter,parameter_id:normalizeId(parameter.parameter_id,true)}));
      const ids=new Set();parameters=parameters.filter(parameter=>{if(ids.has(parameter.parameter_id))return false;ids.add(parameter.parameter_id);return true;});
      if(exactIds)for(const parameter of parameters)observations.set(String(parameter.parameter_id),Object.freeze(parameterExpectedState(parameter)));
      parameterSelect.replaceChildren();option(parameterSelect,'','请选择参数');
      for(const parameter of parameters)option(parameterSelect,parameter.parameter_id,parameter.name+' · #'+parameter.parameter_id);
      parameterSelect.value='';
      const omitted=data.parameters.length-parameters.length;
      status.textContent=parameters.length?'可填写 '+parameters.length+' 个参数'+(omitted?'；已略去 '+omitted+' 个只读或暂不支持的类型/单位。':'。'):'没有可填写的参数；只读和暂不支持的类型/单位已略去。';
    }
    readBlocked=false;notify();sync();
  }
  reset();
  return {element,input,controls,update,sourceDocument:()=>source?{...source}:null,validate:()=>{
    if(pending)return {ok:false,error:'请等待读取完成。'};
    if(readBlocked)return {ok:false,error:'上次读取尚未成功，请重新读取并核对元素和参数。'};
    if(dirty)return {ok:false,error:'新值尚未加入列表，请先点击“加入修改”。'};
    if(!source||!changes.length)return {ok:false,error:'请先选择参数、填写新值，并加入修改。'};
    return {ok:true};
  }};
}
