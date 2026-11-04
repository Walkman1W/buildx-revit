import {createCommandField} from './command-fields.mjs';
import {createCommandChoiceField} from './command-choice-field.mjs';
import {sameCommandFormDocument} from './command-form-source.mjs';
import {validateCommandParameterOptions,validateCommandParameterValues} from './command-parameter-options.mjs';

const primitiveTypes=new Set(['string','number','integer','boolean']);
// Transport JSON may come from another realm (for example a WebView host or
// the production-composer fixture); its local Object.prototype is not identity.
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  Object.prototype.toString.call(value)==='[object Object]';

// The immutable revision owns this definition. Labels and widgets collect only
// its named primitive values; they never infer a script's parameters from code.
export function createPersonalCommandFields({document,Event=globalThis.Event,id,onChange=()=>{},onCommand=()=>false}) {
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const element=make('div','personal-command-fields command-field-wide');
  const heading=make('strong','personal-command-selected');
  const body=make('div','personal-command-fields-body');
  const input=make('input');input.id=id;input.type='hidden';input.hidden=true;input.dataset.defaultValue='';
  const controls=[input];element.append(heading,body,input);
  let definition=null,definitionError='',labels={},parameterOptions={},fields=new Map(),rawOverride=null,initializing=true,lastSnapshot=null;
  const labelFor=name=>Object.hasOwn(labels,name)?labels[name]:name;
  function notify(){if(initializing)return;input.dispatchEvent(new Event('input',{bubbles:true}));onChange();}
  function parseValues() {
    if(definitionError)return {ok:false,error:definitionError};
    if(rawOverride!==null)return {ok:false,error:definition?'输入值与所选版本的参数类型不一致，请重新填写。':'请先查看并选择完整命令版本，再填写运行参数。'};
    if(!definition)return {ok:true,parameters:null};
    const parameters={};
    for(const [name,type] of Object.entries(definition)){
      const field=fields.get(name),checked=field.validate?.();
      if(checked?.ok===false)return checked;
      const raw=field.input.value,label=labelFor(name);let value;
      if(type==='string')value=raw;
      else if(type==='boolean'){
        if(raw!=='true'&&raw!=='false')return {ok:false,error:'请选择 '+label+' 的“是”或“否”。'};
        value=raw==='true';
      }else{
        if(typeof raw!=='string'||!raw.trim()||!Number.isFinite(Number(raw)))return {ok:false,error:'请填写 '+label+' 的有效数字。'};
        value=Number(raw);
        if(type==='integer'&&!Number.isSafeInteger(value))return {ok:false,error:label+' 必须填写可精确表示的整数。'};
      }
      Object.defineProperty(parameters,name,{value,enumerable:true,writable:true,configurable:true});
    }
    try{validateCommandParameterValues(parameterOptions,definition,parameters);}catch{return {ok:false,error:'参数选择与所选命令版本的可选项不一致，请重新选择。'};}
    const sources=[...fields.values()].map(field=>field.sourceDocument?.()).filter(Boolean);
    if(sources.some(source=>!sameCommandFormDocument(source,sources[0])))return {ok:false,error:'所选参数来自不同模型，请重新读取后选择。'};
    return {ok:true,parameters};
  }
  function resetValues(){rawOverride=null;for(const field of fields.values())field.input.value='';}
  function setDefinition(record){
    definition=null;definitionError='';labels={};parameterOptions={};fields=new Map();controls.splice(1);rawOverride=null;body.replaceChildren();
    if(!record){heading.hidden=true;body.append(make('p','personal-command-fields-empty','先在个人命令列表中查看并选择一个版本。'));notify();return;}
    heading.hidden=false;heading.textContent='已选择：'+(typeof record.name==='string'?record.name:typeof record.command_id==='string'?record.command_id:'命令');
    const types=Object.hasOwn(record,'parameters')?record.parameters:{};
    if(!object(types)||Object.keys(types).length>32||Object.entries(types).some(([name,type])=>! /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)||!primitiveTypes.has(type))){
      definitionError='所选版本的参数定义不完整或暂不支持，请重新查看命令。';
      body.append(make('p','personal-command-fields-empty',definitionError));notify();return;
    }
    if(Object.hasOwn(record,'parameter_labels')){
      const metadata=record.parameter_labels;
      if(!object(metadata)||Object.keys(metadata).length>32||Object.entries(metadata).some(([name,label])=>!Object.hasOwn(types,name)||typeof label!=='string'||!label.trim()||label.length>80)){
        definitionError='所选版本的参数显示名称不完整或无效，请重新查看命令。';
        body.append(make('p','personal-command-fields-empty',definitionError));notify();return;
      }
      labels={...metadata};
    }
    try{parameterOptions=validateCommandParameterOptions(Object.hasOwn(record,'parameter_options')?record.parameter_options:{},types);}catch{
      definitionError='所选版本的参数可选项无效，请重新查看命令。';
      body.append(make('p','personal-command-fields-empty',definitionError));notify();return;
    }
    definition={...types};
    if(!Object.keys(definition).length)body.append(make('p','personal-command-fields-empty','此命令无需填写运行参数。'));
    else{
      body.append(make('span','command-field-label','运行参数'));
      for(const [name,type] of Object.entries(definition)){
        const option=parameterOptions[name],options={document,Event,id:id+'-'+name,key:name,rule:{type,...option?.kind==='enum'?{enum:option.values}:{}},label:labelFor(name),required:type!=='string'||Boolean(option),value:'',onChange:()=>{rawOverride=null;notify();},onCommand};
        const field=option?.kind==='model'?createCommandChoiceField({...options,key:option.source}):createCommandField(options);
        for(const control of field.controls)if(input.dataset.commandEnabled!==undefined)control.dataset.commandEnabled=input.dataset.commandEnabled;
        fields.set(name,field);body.append(field.element);controls.push(...field.controls);
        if(lastSnapshot)field.update?.(lastSnapshot);
      }
    }
    notify();
  }
  Object.defineProperty(input,'value',{configurable:true,get:()=>{
    if(rawOverride!==null)return rawOverride;
    if(!definition||!Object.keys(definition).length)return '';
    const values=parseValues();return values.ok?JSON.stringify(values.parameters):'!'+JSON.stringify(Object.fromEntries([...fields].map(([name,field])=>[name,field.input.value])));
  },set:value=>{
    resetValues();
    if(value===''||value===undefined||value===null){notify();return;}
    const raw=typeof value==='string'?value:JSON.stringify(value);let parsed;
    try{parsed=JSON.parse(raw);}catch{}
    if(!definition||!object(parsed)||Object.keys(parsed).length!==Object.keys(definition).length||Object.entries(definition).some(([name,type])=>{
      const entry=parsed[name];return !Object.hasOwn(parsed,name)||type==='string'&&typeof entry!=='string'||type==='boolean'&&typeof entry!=='boolean'||type==='number'&&(typeof entry!=='number'||!Number.isFinite(entry))||type==='integer'&&!Number.isSafeInteger(entry);
    })){rawOverride=raw;notify();return;}
    for(const [name,field] of fields)field.input.value=String(parsed[name]);notify();
  }});
  input.focus=()=>{const first=fields.values().next().value;if(first)first.input.focus();};
  setDefinition(null);initializing=false;
  return {element,input,controls,setDefinition,sourceDocument:()=>[...fields.values()].map(field=>field.sourceDocument?.()).find(Boolean)??null,update:snapshot=>{
    lastSnapshot=snapshot;for(const field of fields.values())field.update?.(snapshot);
  },validate:()=>{
    const result=parseValues();return result.ok?{ok:true}:{ok:false,error:result.error};
  }};
}
