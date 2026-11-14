import test from 'node:test';
import assert from 'node:assert/strict';
import {mountProjectFiles} from './public/project-knowledge-ui.mjs';

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.textContent='';this.value='';this.hidden=false;this.open=false;this.attributes={};this.className='';this.classList={add:name=>{this.className+=' '+name;}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,listener){(this.listeners[name]??=[]).push(listener);}
  fire(name,event={}){for(const listener of this.listeners[name]||[])listener({preventDefault(){},...event});}
  focus(){}
}
const doc={createElement:tag=>new Element(tag)};
const walk=node=>[node,...node.children.flatMap(walk)];
const css=(root,cls)=>walk(root).find(n=>n.className.split(' ').includes(cls));
const all=(root,cls)=>walk(root).filter(n=>n.className.split(' ').includes(cls));
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

test('a first library load can be retried in the open panel',async()=>{
  const root=new Element('section');let reads=0;
  const ui=mountProjectFiles({root,document:doc,request:async()=>{
    if(++reads===1)throw new Error('资料库连接暂时不可用。');
    return {roots:[{id:'reference',name:'说明.txt',path:'D:\\说明.txt',kind:'file',source:'user'}]};
  }});
  await ui.refresh();
  assert.match(css(root,'project-files-status').textContent,/连接暂时不可用/);
  const retry=css(root,'project-files-retry');
  assert.ok(retry);
  retry.fire('click');retry.fire('click');await flush();
  assert.equal(reads,2);
  assert.ok(css(root,'project-files-file'));
  assert.equal(css(root,'project-files-retry'),undefined);
});

test('a replaced library address requires explicit revalidation before attachment',async()=>{
  const root=new Element('section'),calls=[];
  let state='available',attached=0;
  const request=async(action,args)=>{
    calls.push([action,args]);
    if(action==='list-roots')return {roots:[{id:'p',name:'说明.txt',path:'D:\\说明.txt',kind:'file',source:'user',status:state}]};
    if(action==='add-root'){state='revalidated';return {};}
    if(action==='read-attachment'){
      if(state==='revalidated')return {name:'说明.txt'};
      state='needs-confirmation';
      throw Object.assign(new Error('资料地址对应的文件已变化，请重新选择后再试。'),{code:'ROOT_CHANGED'});
    }
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request,onBeginAttach:async()=>({ok:true,binding:'owned'}),onAddToContext:async()=>{attached++;return {ok:true};}});
  await ui.refresh();
  css(root,'project-files-add-context').fire('click');await flush();
  assert.match(css(root,'project-files-status').textContent,/已变化/);
  assert.equal(css(root,'project-files-add-context'),undefined);
  assert.equal(attached,0);
  assert.equal(calls.some(([action])=>action==='add-root'),false);
  css(root,'project-files-enable').fire('click');await flush();
  assert.deepEqual(calls.find(([action])=>action==='add-root')[1],{path:'D:\\说明.txt',kind:'file'});
  css(root,'project-files-add-context').fire('click');await flush();
  assert.equal(attached,1);
});

test('directory authorization is a separate explicit intent, not implied by adding or browsing references',async()=>{
  const root=new Element('section'),calls=[],selected=[];
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:[
      {id:'project-root',name:'工作区',path:'D:\\项目',kind:'directory',source:'project',status:'available'},
      {id:'file-root',name:'参考.txt',path:'D:\\参考.txt',kind:'file',source:'user',status:'available'},
      {id:'old-root',name:'待启用',path:'D:\\旧资料',kind:'directory',source:'user',status:'needs-confirmation'}
    ]};throw new Error('unexpected mutation');
  };
  const ui=mountProjectFiles({root,document:doc,request,onAuthorizeDirectory:value=>selected.push(value)});await ui.refresh();
  assert.equal(selected.length,0);assert.equal(all(root,'project-files-authorize').length,1);
  const authorize=css(root,'project-files-authorize');authorize.fire('click');
  assert.deepEqual(selected,[{rootId:'project-root',path:'D:\\项目',label:'工作区'}]);assert.deepEqual(calls,[['list-roots',{}]]);
  ui.reset();authorize.fire('click');assert.equal(selected.length,1);ui.destroy();
});

test('shows the current project and browses folders and files only on demand',async()=>{
  const root=new Element('section'),calls=[];
  const request=async(action,args)=>{
    calls.push([action,args]);
    if(action==='list-roots')return {roots:[{id:'project',name:'项目',path:'D:\\项目',kind:'directory',source:'project'}],projectStatus:{message:'当前项目目录'}};
    if(action==='list-children'&&args.path==='')return {entries:[{name:'图纸',path:'图纸',kind:'directory'},{name:'说明.txt',path:'说明.txt',kind:'file'}],truncated:false};
    if(action==='list-children')return {entries:[{name:'子文件.txt',path:'图纸/子文件.txt',kind:'file'}],truncated:false};
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();
  assert.equal(calls.length,1);assert.equal(css(root,'project-files-status').textContent,'当前项目目录');
  assert.equal(all(root,'project-files-remove').length,0);
  const project=css(root,'project-files-directory');project.open=true;project.fire('toggle');await flush();
  assert.equal(calls[1][0],'list-children');assert.equal(calls[1][1].path,'');
  const child=all(root,'project-files-directory')[1];child.open=true;child.fire('toggle');await flush();
  const nested=all(root,'project-files-file').find(n=>n.children[1].textContent==='子文件.txt');nested.fire('click');await flush();
  assert.equal(nested.attributes['aria-pressed'],'true');assert.equal(calls.some(([action])=>action==='read-file'),false);
  assert.equal(all(root,'project-files-preview').length,0);
  ui.destroy();assert.deepEqual(root.children,[]);
});

test('adds and removes paths without deleting originals and represents an unsaved project',async()=>{
  const root=new Element('section'),calls=[];let items=[],changed=0;
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:items,projectStatus:'unsaved'};
    if(action==='add-root'){items=[{id:'1',name:'手册.txt',path:args.path,kind:args.kind,source:'user'}];return {};}
    if(action==='remove-root'){items=[];return {};}
    if(action==='open-file')return {opened:true};
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request,onChanged:()=>changed++});await ui.refresh();
  assert.match(css(root,'project-files-status').textContent,/尚未保存/);
  css(root,'project-files-manual').fire('click');const form=css(root,'project-files-form'),input=css(root,'project-files-path'),type=css(root,'project-files-kind');
  assert.equal(form.hidden,false);type.value='file';input.value='D:\\资料\\手册.txt';form.fire('submit');await flush();
  assert.deepEqual(calls.find(([name])=>name==='add-root')[1],{path:'D:\\资料\\手册.txt',kind:'file'});assert.equal(changed,1);
  css(root,'project-files-file').fire('click');await flush();assert.equal(calls.some(([action])=>action==='read-file'),false);
  css(root,'project-files-open-file').fire('click');await flush();assert.deepEqual(calls.at(-1),['open-file',{rootId:'1',path:''}]);
  const remove=css(root,'project-files-remove');assert.match(remove.title,/不删除原文件/);remove.fire('click');await flush();
  assert.deepEqual(calls.find(([name])=>name==='remove-root')[1],{id:'1'});assert.equal(changed,2);
});

test('native selection adds one chosen path; cancel, account reset and closing the page do not add',async()=>{
  const root=new Element('section'),calls=[];let resolveChoose,chooserSignal;
  const request=async(action,args,options)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:[]};
    if(action==='choose'){chooserSignal=options.signal;return new Promise(resolve=>{resolveChoose=resolve;});}
    if(action==='add-root')return {};
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();
  all(root,'project-files-add')[0].fire('click');resolveChoose({path:null});await flush();assert.equal(calls.filter(([name])=>name==='add-root').length,0);
  all(root,'project-files-add')[1].fire('click');resolveChoose({path:'D:\\资料\\手册.txt'});await flush();
  assert.deepEqual(calls.find(([name])=>name==='add-root')[1],{path:'D:\\资料\\手册.txt',kind:'file'});
  all(root,'project-files-add')[0].fire('click');ui.reset();resolveChoose({path:'D:\\旧账号'});await flush();assert.equal(calls.filter(([name])=>name==='add-root').length,1);
  all(root,'project-files-add')[0].fire('click');ui.close();assert.equal(chooserSignal.aborted,true);resolveChoose({path:'D:\\已离开'});await flush();assert.equal(calls.filter(([name])=>name==='add-root').length,1);
});

test('each file has one dropdown for opening and a separate context button',async()=>{
  const root=new Element('section'),calls=[],attached=[];let switched=0;
  const value={name:'说明.pdf',attachmentName:'说明.pdf.txt',sourceFormat:'extracted',data:'YQ==',byteLength:1};
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'项目',path:'D:\\项目',kind:'directory',source:'project'}]};
    if(action==='list-children')return {entries:[{name:'说明.pdf',path:'资料/说明.pdf',kind:'file'}]};
    if(action==='read-attachment')return value;
    return {opened:true};
  };
  const binding={token:'owned'};
  const ui=mountProjectFiles({root,document:doc,request,onBeginAttach:async()=>({ok:true,binding}),onAddToContext:async(file,owner)=>{attached.push({file,owner});return {ok:true};},onOpenChat:()=>switched++});
  await ui.refresh();const folder=css(root,'project-files-directory');folder.open=true;folder.fire('toggle');await flush();
  const menu=css(root,'project-files-file-menu');assert.equal(menu.children[0].textContent,'打开 ▾');
  assert.equal(menu.children[1].children[0].textContent,'用默认应用打开');assert.equal(menu.children[1].children[1].textContent,'打开所在文件夹');
  css(root,'project-files-open-file').fire('click');await flush();assert.deepEqual(calls.at(-1),['open-file',{rootId:'p',path:'资料/说明.pdf'}]);
  css(root,'project-files-open-folder').fire('click');await flush();assert.deepEqual(calls.at(-1),['open-folder',{rootId:'p',path:'资料/说明.pdf'}]);
  css(root,'project-files-add-context').fire('click');await flush();assert.deepEqual(calls.at(-1),['read-attachment',{rootId:'p',path:'资料/说明.pdf'}]);
  assert.deepEqual(attached,[{file:value,owner:binding}]);assert.equal(switched,1);assert.match(css(root,'project-files-status').textContent,/提取文本/);
});

test('rejected context and stale read cannot switch conversations or attach to another account',async()=>{
  const root=new Element('section'),calls=[];let resolveFile,switched=0,attached=0,allowed=false;
  const request=async(action,args)=>{calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'说明.txt',path:'D:\\说明.txt',kind:'file',source:'user'}]};
    if(action==='read-attachment')return new Promise(resolve=>{resolveFile=resolve;});throw new Error('unexpected');};
  const ui=mountProjectFiles({root,document:doc,request,onBeginAttach:async()=>allowed?{ok:true,binding:'old'}:{ok:false,error:'请先开启对话'},onAddToContext:async()=>{attached++;return {ok:true};},onOpenChat:()=>switched++});
  await ui.refresh();css(root,'project-files-add-context').fire('click');await flush();assert.match(css(root,'project-files-status').textContent,/请先开启对话/);assert.equal(calls.filter(([action])=>action==='read-attachment').length,0);
  allowed=true;css(root,'project-files-add-context').fire('click');await flush();ui.reset();resolveFile({name:'说明.txt',data:'YQ==',byteLength:1});await flush();assert.equal(attached,0);assert.equal(switched,0);
});

test('a rejected attachment or failed opening remains in the library and never reports success',async()=>{
  const root=new Element('section'),calls=[];let switched=0;
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'报告.pdf',path:'D:\\报告.pdf',kind:'file',source:'user'}]};
    if(action==='read-attachment')return {name:'报告.pdf',attachmentName:'报告.pdf.txt',sourceFormat:'extracted',data:'YQ==',byteLength:1};
    if(action==='open-folder')throw new Error('系统无法打开目录');throw new Error('unexpected');
  };
  const ui=mountProjectFiles({root,document:doc,request,onBeginAttach:async()=>({ok:true,binding:'owned'}),onAddToContext:async()=>({ok:false,error:'文本超出对话限制'}),onOpenChat:()=>switched++});
  await ui.refresh();css(root,'project-files-add-context').fire('click');await flush();
  assert.equal(switched,0);assert.match(css(root,'project-files-status').textContent,/文本超出对话限制/);
  css(root,'project-files-open-folder').fire('click');await flush();assert.equal(switched,0);assert.match(css(root,'project-files-status').textContent,/系统无法打开目录/);
});

test('a pending action on one file is not duplicated by repeated clicks',async()=>{
  const root=new Element('section'),calls=[];let resolveOpen;
  const request=async(action,args)=>{calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'说明.txt',path:'D:\\说明.txt',kind:'file',source:'user'}]};
    if(action==='open-file')return new Promise(resolve=>{resolveOpen=resolve;});throw new Error('unexpected');};
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();const open=css(root,'project-files-open-file');
  open.fire('click');open.fire('click');await flush();assert.equal(calls.filter(([action])=>action==='open-file').length,1);
  assert.equal(open.disabled,true);resolveOpen({opened:true});await flush();assert.equal(open.disabled,false);
});

test('a timed-out Windows open action reports an unconfirmed outcome without retrying',async()=>{
  const root=new Element('section'),calls=[];
  const request=async(action,args)=>{calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'说明.txt',path:'D:\\说明.txt',kind:'file',source:'user'}]};
    if(action==='open-file'){const error=new Error('deadline');error.name='AbortError';throw error;}throw new Error('unexpected');};
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();css(root,'project-files-open-file').fire('click');await flush();
  assert.match(css(root,'project-files-status').textContent,/结果未确认.*检查 Windows 窗口/);assert.equal(calls.filter(([action])=>action==='open-file').length,1);
});

test('folder pagination appends pages, retries errors and reopens on directory change',async()=>{
  const root=new Element('section'),calls=[];let count=0,changed=false;
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:[{id:'p',name:'项目',path:'D:\\项目',kind:'directory',source:'project'}]};
    if(action==='list-children'&&!args.cursor)return {entries:[{name:'A.txt',path:'A',kind:'file'}],truncated:true,nextCursor:'opaque-1'};
    if(action==='list-children'&&args.cursor==='opaque-1'){
      count++;if(count===1)throw new Error('暂时无法读取');
      return {entries:[{name:'B.txt',path:'B',kind:'file'}],truncated:true,nextCursor:'opaque-2'};
    }
    if(action==='list-children'&&args.cursor==='opaque-2'){changed=true;const error=new Error('目录已变化');error.code='DIRECTORY_CHANGED';throw error;}
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();const folder=css(root,'project-files-directory');folder.open=true;folder.fire('toggle');await flush();
  css(root,'project-files-more').fire('click');await flush();assert.equal(all(root,'project-files-file').length,1);assert.match(css(root,'project-files-error').textContent,/暂时无法读取/);
  css(root,'project-files-more').fire('click');await flush();assert.deepEqual(all(root,'project-files-file').map(n=>n.children[1].textContent),['A.txt','B.txt']);
  assert.deepEqual(calls.find(([action,args])=>action==='list-children'&&args.cursor==='opaque-1')[1],{rootId:'p',path:'',cursor:'opaque-1'});
  css(root,'project-files-more').fire('click');await flush();assert.equal(changed,true);assert.match(css(root,'project-files-error').textContent,/重新展开/);
  folder.open=false;folder.fire('toggle');folder.open=true;folder.fire('toggle');await flush();assert.deepEqual(all(root,'project-files-file').map(n=>n.children[1].textContent),['A.txt']);
});

test('page results arriving after folder collapse or account reset are ignored',async()=>{
  const root=new Element('section');let resolvePage;
  const request=async(action,args)=>{
    if(action==='list-roots')return {roots:[{id:'p',name:'项目',path:'D:\\项目',kind:'directory',source:'project'}]};
    if(action==='list-children'&&!args.cursor)return {entries:[{name:'A.txt',path:'A',kind:'file'}],nextCursor:'next'};
    return new Promise(resolve=>{resolvePage=resolve;});
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();const folder=css(root,'project-files-directory');folder.open=true;folder.fire('toggle');await flush();
  css(root,'project-files-more').fire('click');folder.open=false;folder.fire('toggle');resolvePage({entries:[{name:'stale',path:'stale',kind:'file'}],nextCursor:null});await flush();
  folder.open=true;folder.fire('toggle');assert.deepEqual(all(root,'project-files-file').map(n=>n.children[1].textContent),['A.txt']);
  css(root,'project-files-more').fire('click');ui.reset();resolvePage({entries:[{name:'foreign',path:'foreign',kind:'file'}]});await flush();assert.equal(all(root,'project-files-file').length,0);
});

test('expired cursor directs the user to reload the folder',async()=>{
  const root=new Element('section');
  const request=async(action,args)=>{
    if(action==='list-roots')return {roots:[{id:'p',name:'项目',path:'D:\\项目',kind:'directory',source:'project'}]};
    if(!args.cursor)return {entries:[{name:'A.txt',path:'A',kind:'file'}],nextCursor:'expired'};
    const error=new Error('分页已失效');error.code='INVALID_CURSOR';throw error;
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();const folder=css(root,'project-files-directory');folder.open=true;folder.fire('toggle');await flush();
  css(root,'project-files-more').fire('click');await flush();assert.match(css(root,'project-files-error').textContent,/关闭后重新展开/);
  folder.open=false;folder.fire('toggle');folder.open=true;folder.fire('toggle');await flush();assert.equal(all(root,'project-files-file').length,1);assert.ok(css(root,'project-files-more'));
});

test('unavailable saved paths are labeled and removable but cannot be opened, with storage failure visible',async()=>{
  const root=new Element('section'),calls=[];let items=[{id:'missing',name:'旧资料',path:'D:\\旧资料',kind:'directory',source:'user',status:'unavailable'}];
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:items,projectStatus:'unsaved',storageStatus:'unavailable',storageMessage:'地址记录未能保存。'};
    if(action==='remove-root'){items=[];return {};}
    throw new Error('unavailable root must not be opened');
  };
  const ui=mountProjectFiles({root,document:doc,request});await ui.refresh();
  assert.match(css(root,'project-files-status').textContent,/地址记录未能保存/);
  assert.equal(css(root,'project-files-unavailable').attributes['aria-disabled'],'true');
  assert.equal(css(root,'project-files-unavailable-badge').textContent,'不可访问');
  assert.equal(all(root,'project-files-directory').length,0);assert.equal(all(root,'project-files-file').length,0);
  css(root,'project-files-remove').fire('click');await flush();assert.deepEqual(calls.find(([action])=>action==='remove-root')[1],{id:'missing'});
  assert.equal(calls.some(([action])=>action==='list-children'||action==='read-file'),false);
});

test('restored paths require explicit revalidation before opening and can be removed',async()=>{
  const root=new Element('section'),calls=[];let status='needs-confirmation',removed=false,changed=0;
  const request=async(action,args)=>{
    calls.push([action,args]);if(action==='list-roots')return {roots:removed?[]:[{id:'restored',name:'资料',path:'D:\\资料',kind:'directory',source:'user',status}]};
    if(action==='add-root'){status='available';return {};}
    if(action==='remove-root'){removed=true;return {};}
    if(action==='list-children')return {entries:[]};
    throw new Error('unexpected action');
  };
  const ui=mountProjectFiles({root,document:doc,request,onChanged:()=>changed++});await ui.refresh();
  assert.equal(css(root,'project-files-unavailable-badge').textContent,'待启用');
  assert.equal(all(root,'project-files-directory').length,0);assert.ok(css(root,'project-files-remove'));
  css(root,'project-files-enable').fire('click');await flush();
  assert.deepEqual(calls.find(([action])=>action==='add-root')[1],{path:'D:\\资料',kind:'directory'});assert.equal(changed,1);
  const folder=css(root,'project-files-directory');folder.open=true;folder.fire('toggle');await flush();assert.ok(calls.some(([action])=>action==='list-children'));
  css(root,'project-files-remove').fire('click');await flush();assert.equal(removed,true);
});
