// Isolated production composer fixture. No browser, sockets or native process.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as chatView from '../public/chat-view.mjs';
import {mountModelWorkspace} from '../public/model-workspace.mjs';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
export const flush=async()=>{for(let index=0;index<5;index++)await new Promise(resolve=>setImmediate(resolve));};
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export class UiEvent {
  constructor(type,extra={}){this.type=type;Object.assign(this,extra);}
  preventDefault(){this.defaultPrevented=true;}
  stopImmediatePropagation(){this.stopped=true;}
}
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.events=new Map();this.style={};this.dataset={};this.attributes=new Map();this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.className='';this.scrollHeight=60;this.scrollTop=0;this.clientHeight=300;this.clientWidth=300;this.selectionStart=0;this._text='';this.isConnected=true;}
  addEventListener(type,fn,capture=false){const list=this.events.get(type)||[];list.push({fn,capture});this.events.set(type,list);}
  dispatchEvent(event){event.target=this;for(const {fn} of [...this.events.get(event.type)||[]].sort((a,b)=>Number(b.capture)-Number(a.capture))){fn(event);if(event.stopped)break;}return true;}
  append(...items){for(let item of items){if(typeof item==='string'){const text=new Element('#text');text.textContent=item;item=text;}item.remove();item.parent=this;this.children.push(item);}}
  prepend(...items){for(const item of [...items].reverse()){item.remove();item.parent=this;this.children.unshift(item);}}
  before(item){if(this.parent)this.parent.insertBefore(item,this);}
  after(item){if(this.parent){const next=this.parent.children[this.parent.children.indexOf(this)+1];this.parent.insertBefore(item,next);}}
  insertBefore(item,next){item.remove();item.parent=this;const at=this.children.indexOf(next);if(at<0)this.children.push(item);else this.children.splice(at,0,item);}
  replaceChildren(...items){for(const item of this.children)item.parent=null;this.children=[];this._text='';this.append(...items);}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(item=>item!==this);this.parent=null;}}
  contains(item){return this===item||this.children.some(child=>child.contains(item));}
  querySelectorAll(selector){const name=selector.startsWith('.')?selector.slice(1):null;return this.children.flatMap(item=>[...(name&&item.className.split(' ').includes(name)?[item]:[]),...item.querySelectorAll(selector)]);}
  get childElementCount(){return this.children.length;}
  get textContent(){return this._text+this.children.map(item=>item.textContent).join('');}
  set textContent(value){this.replaceChildren();this._text=String(value);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);}
  get classList(){return {add:name=>{this.className=[...new Set([...this.className.split(' '),name])].join(' ');},remove:name=>{this.className=this.className.split(' ').filter(item=>item!==name).join(' ');},contains:name=>this.className.split(' ').includes(name)};}
  setSelectionRange(start){this.selectionStart=start;}
  focus(){this.focused=true;}
  click(){this.clicked=true;this.dispatchEvent(new UiEvent('click'));}
  scrollIntoView(){}
}
export const session=(id='chat-a',messages=[],readOnly=false)=>({conversation:{id,readOnly},messages,context:{document:null,selection:null,capturedAt:null},contextEpoch:0,historyTruncated:false});
export const file=(name,value,type='')=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return {name,type,size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer};};
export async function createInputUi({kind='model',capability=true,layout=true,localStorage,timers=null}={}) {
  const nodes=new Map(),body=new Element('body'),window=new Element('window'),document=new Element('document');let sequence=0,account={required:false};
  const find=(parent,id)=>parent.id===id?parent:parent.children.map(child=>find(child,id)).find(Boolean);
  const get=id=>{const found=find(body,id);if(found)return found;if(!nodes.has(id)){const item=new Element();item.id=id;nodes.set(id,item);body.append(item);}return nodes.get(id);};
  const topbar=get('topbar');topbar.className='topbar';const connection=get('connection');connection.className='connection';const tools=get('tools-panel');tools.className='tools-panel';
  const composer=get('composer'),bottom=get('composer-bottom'),hint=new Element('span');bottom.className='composer-bottom';hint.textContent='Ctrl + Enter 发送';bottom.append(hint,get('stop'),get('send'));composer.append(get('prompt'),bottom);body.append(get('messages'),composer);get('messages').append(get('welcome'),get('transcript'));
  document.body=body;document.getElementById=get;document.querySelector=selector=>({'.topbar':topbar,'.connection':connection,'.tools-panel':tools,'.composer-bottom':bottom,'.composer-bottom > span':hint})[selector]||null;document.querySelectorAll=()=>[];
  document.createElement=tag=>new Element(tag);document.createComment=text=>{const value=new Element('#comment');value.textContent=text;return value;};document.createTextNode=text=>{const value=new Element('#text');value.textContent=text;return value;};document.createDocumentFragment=()=>new Element('#fragment');
  const requests=[],views=[],imageUrls=[];window.addEventListener('buildx-model-view',event=>views.push(event.detail));
  class Stream {static all=[];constructor(){this.events=new Map();Stream.all.push(this);}addEventListener(type,fn){const list=this.events.get(type)||[];list.push(fn);this.events.set(type,list);}emit(type,data){for(const fn of this.events.get(type)||[])fn({data:JSON.stringify(data)});}close(){this.closed=true;}}
  window.localStorage=localStorage;
  const sandbox={__chatView:chatView,window,document,Blob,AbortController,URL:{createObjectURL:blob=>{const item={url:'blob:fixture-'+imageUrls.length,blob,revoked:false};imageUrls.push(item);return item.url;},revokeObjectURL:url=>{const item=imageUrls.find(item=>item.url===url);if(item)item.revoked=true;}},localStorage,sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>`ui-id-${++sequence}`},TextEncoder,TextDecoder,Uint8Array,atob:value=>Buffer.from(value,'base64').toString('binary'),btoa:value=>Buffer.from(value,'binary').toString('base64'),Event:UiEvent,CustomEvent:UiEvent,EventSource:Stream,setTimeout:timers?.setTimeout??setTimeout,clearTimeout:timers?.clearTimeout??clearTimeout,queueMicrotask,navigator:{clipboard:{writeText:async()=>{}}},fetch:async(url,options)=>{
    if(url==='/api/status')return {ok:true,json:async()=>({csrf:'fixture-csrf',ready:!account.required||account.signedIn,message:'已连接',account,codexConfirmation:{localConnectionConfirmed:true},workspace:{kind,supportsModelContext:kind==='model'},toolCount:4,toolCatalog:[{name:'revit_get_selection',label:'当前选择'}],historyAvailable:true,turnAttachmentsAvailable:capability})};
    if(url.startsWith('/api/chats?'))return {ok:true,json:async()=>({ok:true,available:true,sessions:[],complete:true})};
    const response=deferred();requests.push({url,body:JSON.parse(options.body),options,...response});return response.promise;
  }};
  const context=vm.createContext(sandbox);vm.runInContext(source.replace(/^import \{([^}]+)\} from '\.\/chat-view\.mjs';/,'const {$1} = __chatView;'),context,{filename:'production/public/app.js'});await flush();
  const emit=(type,data)=>Stream.all.at(-1).emit(type,data),conversation=(id,messages=[],readOnly=false)=>emit('conversation',{busy:false,session:session(id,messages,readOnly),history:{available:true,activeId:id}});
  emit('snapshot',{busy:false,session:session(),history:{available:true,activeId:'chat-a'}});
  if(layout&&kind==='model')mountModelWorkspace({document,window,CustomEvent:UiEvent,Event:UiEvent});
  const intent=async(type,detail)=>{window.dispatchEvent(new UiEvent(type,{detail}));await flush();};
  return {get,document,window,requests,views,imageUrls,view:()=>views.at(-1),emit,conversation,intent,
    input:value=>{get('prompt').value=value;get('prompt').selectionStart=value.length;get('prompt').dispatchEvent(new UiEvent('input'));},
    add:files=>intent('buildx-attachments-add',{files}),remove:id=>intent('buildx-attachments-remove',{id}),
    submit:async()=>{get('composer').dispatchEvent(new UiEvent('submit'));await flush();},
    respond:async(request,data={ok:true},ok=true)=>{request.resolve({ok,json:async()=>data});await flush();},
    reject:async(request,message)=>{request.reject(new Error(message));await flush();},
    close:async()=>{account={required:true,signedIn:false};window.dispatchEvent(new UiEvent('buildx-account-changed'));await flush();},
  };
}
