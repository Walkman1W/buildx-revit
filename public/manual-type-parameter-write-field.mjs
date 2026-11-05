import {parseExactIdValue,isExactIdRule} from './command-fields.mjs';
import {parameterExpectedState} from './parameter-change-field.mjs';
import {commandFormDocument,sameCommandFormDocument,commandFormOwner} from './command-form-source.mjs';
import {parseTypeParameterWriteReview} from './type-parameter-write-review.mjs';

const readCommand='revit_get_type_parameter_impact',writeCommand='revit_set_type_parameter';
const raw=value=>value===null?'null':value===''?'空字符串（""）':typeof value==='string'?JSON.stringify(value):String(value);
const permissionOwner=value=>JSON.stringify([value?.modelPermission?.available,value?.modelPermission?.revision,value?.modelPermission?.level,
  value?.modelPermission?.documentLabel,value?.modelPermission?.expiresAt,value?.modelPermissionPending,value?.accessPolicy?.id,value?.accessPolicy?.revision,value?.accessPolicy?.mode]);

// This field creates only an intent. The backend observes the type again and
// the existing dynamic approval owner still requires a separate user decision.
export function createManualTypeParameterWriteField({document,Event=globalThis.Event,id,schema,onCommand,onSubmit,onChange=()=>{}}){
  const typeRule=schema?.properties?.type_id,parameterRule=schema?.properties?.parameter_id;
  if(!isExactIdRule(typeRule)||!isExactIdRule(parameterRule))throw new Error('Published type and parameter ID schemas are required');
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const element=make('div','model-command-field model-command-field-wide manual-type-parameter-write-field'),controls=[];
  const control=(tag,suffix)=>{const node=make(tag);node.id=id+'-'+suffix;controls.push(node);return node;};
  const field=(label,node)=>{const wrapper=make('label','parameter-change-label',label);wrapper.htmlFor=node.id;wrapper.append(node);return wrapper;};
  const input=make('input');input.id=id;input.type='hidden';input.dataset.defaultValue='';controls.push(input);
  const type=control('input','type-id'),parameter=control('input','parameter-id');
  for(const node of [type,parameter]){node.type='text';node.inputMode='numeric';node.maxLength=20;}
  const read=control('button','read-impact');read.type='button';read.textContent='读取影响';
  const factsView=make('p','parameter-change-current'),text=control('input','value'),number=control('input','number'),mode=control('select','mode');
  text.type='text';text.maxLength=8192;number.type='number';number.step='any';
  for(const [value,label] of [['rollback','回滚预览（不保留修改）'],['commit','应用修改（不保存模型）']]){const option=make('option','',label);option.value=value;mode.append(option);}mode.value='rollback';
  const valueLabel=make('label','parameter-change-label'),valueHeading=make('span','','拟议值');valueLabel.append(valueHeading,text,number);
  const submit=control('button','submit');submit.type='button';submit.textContent='提交并逐次审阅';
  const status=make('p','parameter-change-status','填写稳定类型 ID 和参数 ID，先读取完整类型影响。');status.setAttribute('role','status');
  element.append(input,field('类型 ID',type),field('参数 ID',parameter),read,factsView,valueLabel,field('执行方式',mode),
    make('p','command-field-help','提交后会重新核查原态和完整直接实例清单，并逐次审阅确认；自动应用和回滚预览均不会跳过最后确认。'),submit,status);
  let snapshot=null,owner=null,permission=null,pending=null,facts=null,source=null,target=null,submission=null;
  const notify=()=>{input.dispatchEvent(new Event('input',{bubbles:true}));onChange();};
  function available(node,yes){node.dataset.fieldUnavailable=String(!yes);node.disabled=!yes||input.disabled;}
  function sync(){
    const locked=Boolean(submission),storage=facts?.parameter.storage_type;
    available(type,!locked);available(parameter,!locked);available(read,!locked&&!pending);
    text.hidden=storage!=='String';number.hidden=!['Integer','Double'].includes(storage);valueLabel.hidden=!storage;
    number.step=storage==='Integer'?'1':'any';valueHeading.textContent=storage==='Double'?'拟议值（Revit 内部单位 internal）':'拟议值';
    available(text,storage==='String'&&!locked&&!pending);available(number,['Integer','Double'].includes(storage)&&!locked&&!pending);
    available(mode,Boolean(facts&&!locked&&!pending));available(submit,Boolean(facts&&source&&!locked&&!pending));
  }
  function clearFacts(message){facts=null;source=null;target=null;factsView.textContent='';text.value='';number.value='';mode.value='rollback';if(message)status.textContent=message;}
  function reset(message){pending=null;submission=null;clearFacts(message);sync();}
  function selectedTarget(){
    const result={type_id:parseExactIdValue(typeRule,type.value),parameter_id:parseExactIdValue(parameterRule,parameter.value)};
    const typeId=BigInt(result.type_id),parameterId=BigInt(result.parameter_id);
    if(typeId<1n||typeId>9223372036854775807n||parameterId< -9223372036854775808n||parameterId>9223372036854775807n||parameterId===0n||parameterId===-1n)throw new Error('类型或参数 ID 超出契约范围。');
    return result;
  }
  function restoreLocked(){if(submission){type.value=submission.type;parameter.value=submission.parameter;text.value=submission.text;number.value=submission.number;mode.value=submission.mode;}}
  for(const node of [type,parameter])for(const event of ['input','change'])node.addEventListener(event,()=>{
    if(submission){restoreLocked();return;}pending=null;clearFacts('目标已变化，请重新读取完整类型影响。');notify();sync();
  });
  for(const node of [text,number,mode])for(const event of ['input','change'])node.addEventListener(event,()=>{if(submission){restoreLocked();return;}notify();sync();});
  read.addEventListener('click',()=>{
    if(read.disabled||submission)return;
    let chosen;try{chosen=selectedTarget();}catch{status.textContent='请填写合法的精确类型 ID 和参数 ID；参数 ID 不能为 0 或 -1。';return;}
    const previous=snapshot?.commands?.find(item=>item.commandId===readCommand);
    pending={target:chosen,previousExecutionId:previous?.executionId,executionId:null,seen:false,seenPending:false};
    clearFacts('正在读取当前文档的完整类型影响…');notify();sync();
    if(onCommand?.({commandId:readCommand,parameters:chosen})===false){pending=null;clearFacts('当前无法发起影响读取，请核对连接和命令状态。');sync();}
  });
  function parameters(){
    if(submission)throw new Error('本次草稿已锁定，请完成原审阅或核对原回执。');
    if(pending||!facts||!source||!target)throw new Error('请先读取当前目标的完整类型影响。');
    const chosen=selectedTarget();if(String(chosen.type_id)!==String(target.type_id)||String(chosen.parameter_id)!==String(target.parameter_id))throw new Error('目标已变化，请重新读取影响。');
    const storage=facts.parameter.storage_type;let value;
    if(storage==='String'){value=text.value;if(value.length>8192)throw new Error('字符串最多 8192 个字符。');}
    else {if(number.value.trim()===''||!Number.isFinite(Number(number.value)))throw new Error('请填写有限的拟议数值。');value=Number(number.value);
      if(storage==='Integer'&&(!Number.isInteger(value)||value< -2147483648||value>2147483647))throw new Error('整数必须在 Int32 范围内。');}
    if(!['rollback','commit'].includes(mode.value))throw new Error('请选择回滚预览或应用修改。');
    const expected_state=parameterExpectedState(facts.parameter);if(!expected_state)throw new Error('参数前态不完整，请重新读取。');
    // Use the same complete, bounded review shape as the final read-only card.
    parseTypeParameterWriteReview(JSON.stringify({...facts,document:source,mode:mode.value,value,value_unit:storage==='Double'?'internal':null}));
    return {...chosen,value,...storage==='Double'?{value_unit:'internal'}:{},mode:mode.value,expected_state:{...expected_state},expected_instance_ids:[...facts.instance_ids]};
  }
  function validate(){try{parameters();return {ok:true};}catch(error){return {ok:false,error:error.message};}}
  function lock(){
    parameters();const previous=snapshot?.commands?.find(item=>item.commandId===writeCommand);
    submission={type:type.value,parameter:parameter.value,text:text.value,number:number.value,mode:mode.value,
      previousExecutionId:previous?.executionId,executionId:null,seenPending:false};
    status.textContent='本次草稿已锁定，正在重新核查并等待逐次审阅；请完成原操作，不重复提交。';sync();
  }
  submit.addEventListener('click',()=>{if(submit.disabled||submission)return;onSubmit?.();});
  function update(value){
    const nextOwner=commandFormOwner(value),nextPermission=permissionOwner(value);
    if(owner!==null&&owner!==nextOwner){type.value='';parameter.value='';reset('身份、文档上下文或对话已变化，请重新读取影响。');}
    else if(permission!==null&&permission!==nextPermission){pending=null;clearFacts('权限或文档授权已变化，请重新读取影响。');if(submission){restoreLocked();status.textContent='权限已变化，本次草稿继续锁定，等待原操作终态。';}}
    owner=nextOwner;permission=nextPermission;snapshot=value;
    if(submission){
      const command=value?.commands?.find(item=>item.commandId===writeCommand);
      if(command?.status==='pending')submission.seenPending=true;
      if(command&&typeof command.executionId==='string'&&command.executionId!==submission.previousExecutionId){
        if(submission.executionId&&command.executionId!==submission.executionId){sync();return;}
        submission.executionId=command.executionId;
        if(['completed','failed','interrupted'].includes(command.status))reset('本次操作已结束；再次修改前请重新读取完整类型影响。');
      }else if(command&&submission.seenPending&&!value.busy&&!value.blocked&&['completed','failed','interrupted'].includes(command.status))reset('本次提交未被接受，请重新读取影响后发起。');
      sync();return;
    }
    if(!pending){sync();return;}
    const command=value?.commands?.find(item=>item.commandId===readCommand);
    if(!command){if(pending.seen){pending=null;clearFacts('读取所属执行已变化，请重新读取影响。');}sync();return;}
    if(command.status==='pending'){pending.seen=true;pending.seenPending=true;sync();return;}
    if(!command.executionId){if(pending.seen&&['failed','unknown','interrupted'].includes(command.status)){pending=null;clearFacts('读取未完成，请核对原结果后重新读取。');}sync();return;}
    if(command.executionId===pending.previousExecutionId){
      if(pending.seenPending&&!value.busy&&!value.blocked&&['completed','failed','unknown','interrupted'].includes(command.status)){pending=null;clearFacts('本次读取未被接受，请重新读取。');}sync();return;
    }
    if(pending.executionId&&pending.executionId!==command.executionId){pending=null;clearFacts('读取任务已变化，请重新读取。');sync();return;}
    pending.executionId=command.executionId;pending.seen=true;
    if(['running','stopping'].includes(command.status)){sync();return;}
    const request=pending;pending=null;
    if(command.status!=='completed'){clearFacts(command.status==='unknown'?'读取结果待核对，请先核对原回执。':'读取未完成，请重新读取。');sync();return;}
    try{
      const observed=commandFormDocument(command.result),data=command.result?.data,payload=data&&Object.hasOwn(data,'value')?data.value:data,coverage=payload?.coverage;
      if(!observed||!observed.path||payload?.schema_version!==1||!coverage||coverage.complete!==true||coverage.scope!=='current_document_direct_type_references'||coverage.indirect_effects!=='not_assessed'||
        !Number.isSafeInteger(coverage.scanned_elements)||coverage.scanned_elements<payload.instance_count||coverage.scanned_elements>20000||payload.write_authorization!=='not_granted'||
        String(payload.type_id)!==String(request.target.type_id)||String(payload.parameter?.parameter_id)!==String(request.target.parameter_id))throw new Error();
      if(source&&!sameCommandFormDocument(source,observed))throw new Error();
      const storage=payload.parameter.storage_type,state=parameterExpectedState(payload.parameter);if(!state)throw new Error();
      const accepted=parseTypeParameterWriteReview(JSON.stringify({schema_version:1,document:observed,type_id:payload.type_id,type_name:payload.type_name,parameter:payload.parameter,
        mode:'rollback',value:storage==='String'?'':0,value_unit:storage==='Double'?'internal':null,instance_ids:payload.instance_ids,instance_count:payload.instance_count,scope:coverage.scope,indirect_effects:coverage.indirect_effects}));
      source=Object.freeze({...observed});target=Object.freeze({...request.target});facts=accepted;
      if(storage==='String')text.value=state.value_internal??'';else number.value=state.value_internal===null?'':String(state.value_internal);
      factsView.textContent='类型 '+(payload.type_name===null?'未知':payload.type_name)+' · #'+payload.type_id+'；参数 '+payload.parameter.name+' · #'+payload.parameter.parameter_id+
        '；'+storage+'；HasValue='+state.has_value+'；原始内部值 '+raw(state.value_internal)+'。当前文档直接实例 '+payload.instance_count+' 个；间接影响未评估。';
      status.textContent='已读取完整直接影响清单；填写拟议值后提交，仍须逐次审阅确认。';notify();
    }catch{clearFacts('读取结果的来源、目标、完整范围或原始参数事实不匹配，请重新读取。');}
    sync();
  }
  Object.defineProperty(input,'value',{get:()=>'',set:()=>{if(!submission)reset('请重新读取当前目标的完整类型影响。');},configurable:true});
  input.focus=()=>type.focus();sync();
  return {element,input,controls,update,validate,parameters,lock,sourceDocument:()=>source?{...source}:null};
}
