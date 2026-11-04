// Command parameter choices are immutable revision data, shared by storage
// validation and the browser. A model source is explicit, never inferred from
// a parameter's display name or execution key.
export const COMMAND_PARAMETER_MODEL_SOURCES=Object.freeze(['element_id','level_id','wall_type_id','floor_type_id','pipe_type_id','system_type_id','symbol_id']);
// Together with the command owner's 64,000-byte C# source limit, this keeps
// JSON escape expansion inside its 512 KiB record budget. Count before copying
// or serializing the complete options map.
export const MAX_PARAMETER_OPTIONS_JSON_BYTES=64*1024;
export const PARAMETER_OPTIONS_SCHEMA={
  type:'object',maxProperties:32,
  description:'Optional dropdown metadata for existing C# parameters, at most 64 KiB as JSON. Requires code and parameters. Enum values must match the declared primitive type; model sources require integer IDs. Included in the immutable revision.',
  additionalProperties:{oneOf:[
    {type:'object',properties:{kind:{const:'enum'},values:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{anyOf:[{type:'string',minLength:1,maxLength:160},{type:'number'},{type:'boolean'}]}}},required:['kind','values'],additionalProperties:false},
    {type:'object',properties:{kind:{const:'model'},source:{type:'string',enum:[...COMMAND_PARAMETER_MODEL_SOURCES]}},required:['kind','source'],additionalProperties:false},
  ]},
};
const object=value=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===null||Object.getPrototypeOf(prototype)===null;
};
const fail=message=>{throw new Error('Command parameter options: '+message);};
const set=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});
const matches=(type,value)=>type==='string'?typeof value==='string':type==='boolean'?typeof value==='boolean':type==='integer'?Number.isSafeInteger(value):type==='number'&&typeof value==='number'&&Number.isFinite(value);
function exact(value,keys){return object(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));}
function stringJsonBytes(value){
  let length=2;
  for(const character of value){const code=character.codePointAt(0);length+=code===34||code===92?2:code<32?([8,9,10,12,13].includes(code)?2:6):code>=0xd800&&code<=0xdfff?6:code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;}
  return length;
}

export function validateCommandParameterOptions(options,types){
  if(!object(options)||!object(types)||Object.keys(options).length>32||Object.keys(types).length>32)fail('expected at most 32 named parameter options');
  const result={};let encodedBytes=2,entries=0;
  const charge=amount=>{encodedBytes+=amount;if(encodedBytes>MAX_PARAMETER_OPTIONS_JSON_BYTES)fail('encoded options exceed the 64 KiB command metadata budget');};
  for(const key of Reflect.ownKeys(options)){
    if(typeof key!=='string'||!Object.hasOwn(types,key)||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(options,key)??{},'value'))fail('option must belong to a declared parameter');
    const type=types[key],option=options[key],kind=object(option)?Object.getOwnPropertyDescriptor(option,'kind')?.value:null;
    charge((entries++?1:0)+stringJsonBytes(key)+1);
    if(!['string','number','integer','boolean'].includes(type))fail('unknown parameter type for '+key);
    if(kind==='enum'){
      if(!exact(option,['kind','values'])||!Array.isArray(option.values)||option.values.length<1||option.values.length>100||Reflect.ownKeys(option.values).length!==option.values.length+1)fail('invalid enum options for '+key);
      charge('{"kind":"enum","values":[]}'.length);
      const values=[],seen=new Set();
      for(let index=0;index<option.values.length;index++){
        if(!Object.hasOwn(Object.getOwnPropertyDescriptor(option.values,String(index))??{},'value'))fail('invalid enum value for '+key);
        const value=option.values[index];
        if(!matches(type,value)||typeof value==='string'&&(!value.trim()||value.length>160)||seen.has(value))fail('enum values must be distinct and match the parameter type for '+key);
        charge((index?1:0)+(typeof value==='string'?stringJsonBytes(value):JSON.stringify(value).length));
        seen.add(value);values.push(value);
      }
      set(result,key,{kind:'enum',values});
    }else if(kind==='model'){
      if(!exact(option,['kind','source'])||type!=='integer'||!COMMAND_PARAMETER_MODEL_SOURCES.includes(option.source))fail('model options require an integer parameter and a supported explicit source for '+key);
      charge('{"kind":"model","source":'.length+stringJsonBytes(option.source)+1);
      set(result,key,{kind:'model',source:option.source});
    }else fail('unknown option kind for '+key);
  }
  return result;
}

// The storage owner first checks the complete primitive parameter contract.
// This helper applies the same revision-owned choices to already typed values.
export function validateCommandParameterValues(options,types,values){
  const canonical=validateCommandParameterOptions(options,types);
  if(!object(values))fail('parameter values must be an object');
  for(const [key,option] of Object.entries(canonical)){
    if(!Object.hasOwn(values,key)||!matches(types[key],values[key]))fail('invalid typed parameter '+key);
    if(option.kind==='enum'&&!option.values.includes(values[key]))fail('parameter '+key+' must use a declared enum value');
    if(option.kind==='model'&&values[key]<1)fail('model parameter '+key+' must be a positive safe integer');
  }
  return values;
}
