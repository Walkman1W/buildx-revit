// The server owns the path index. Selecting an address never uploads or moves
// the original file. Directory and file contents are fetched only on demand.
export function mountProjectFiles({root, document:doc=document, request, onChanged=()=>{}, onBeginAttach=async()=>({ok:false,error:'对话上下文尚未就绪。'}), onAddToContext=async()=>({ok:false,error:'对话上下文尚未就绪。'}), onOpenChat=()=>{},onAuthorizeDirectory=null}){
  if(!root || typeof request!=='function') throw new Error('Project files requires a root and request function');
  const node=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(label,cls,fn)=>{const n=node('button',cls,label);n.type='button';n.addEventListener('click',fn);return n;};
  root.classList.add('project-files');
  const header=node('div','project-files-header'), heading=node('div','project-files-heading');
  heading.append(node('h2','','资料库'),node('p','','添加资料用于参考；目录可另行设为读写工作区。'));
  const actions=node('div','project-files-actions');
  const addFolder=button('＋ 添加文件夹','project-files-add',()=>void choose('directory'));
  const addFile=button('＋ 添加文件','project-files-add',()=>void choose('file'));
  const manual=button('输入路径','project-files-manual',()=>openForm('directory'));
  actions.append(addFolder,addFile,manual);header.append(heading,actions);
  const form=node('form','project-files-form');form.hidden=true;
  const typeLabel=node('label','','类型'),type=node('select','project-files-kind');
  for(const [value,name] of [['directory','文件夹'],['file','文件']]){const option=node('option','',name);option.value=value;type.append(option);}typeLabel.append(type);
  const label=node('label','','本机绝对路径'),input=node('input','project-files-path');
  input.type='text';input.autocomplete='off';input.spellcheck=false;label.append(input);
  const hint=node('p','project-files-hint','请输入本机路径，原文件不会移动。');
  const formActions=node('div','project-files-form-actions'),submit=node('button','project-files-save','添加');submit.type='submit';
  const cancel=button('取消','project-files-cancel',()=>{form.hidden=true;input.value='';});formActions.append(submit,cancel);form.append(typeLabel,label,hint,formActions);
  const status=node('p','project-files-status','正在读取资料库…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const roots=node('div','project-files-roots');roots.setAttribute('aria-label','资料库文件树');
  root.replaceChildren(header,form,status,roots);
  let epoch=0,selecting=false,chooserAbort=null,disposed=false,selectedFile=null;
  function openForm(next){type.value=next;form.hidden=false;input.placeholder=next==='file'?'例如 D:\\项目\\说明.txt':'例如 D:\\项目\\资料';input.value='';input.focus();}
  type.addEventListener('change',()=>{input.placeholder=type.value==='file'?'例如 D:\\项目\\说明.txt':'例如 D:\\项目\\资料';});
  const current=token=>!disposed&&token===epoch;
  function errorText(error){return error?.name==='AbortError'?'请求超时，请稍后刷新。':String(error?.message||'操作未完成。');}
  async function call(action,parameters,options){return request(action,parameters,options);}
  async function addPath(path,kind,token){
    await call('add-root',{path,kind});if(!current(token))return;
    form.hidden=true;input.value='';onChanged();await refresh();
  }
  async function choose(kind){
    if(selecting)return;selecting=true;addFolder.disabled=addFile.disabled=true;const token=epoch;
    const chooser=new AbortController();chooserAbort=chooser;
    try{
      const value=await call('choose',{kind},{signal:chooser.signal});if(!current(token)||value?.path==null)return;
      if(typeof value.path!=='string'||!value.path)throw new Error('选择器未返回有效路径。');
      await addPath(value.path,kind,token);
    }catch(error){if(current(token)){openForm(kind);status.textContent=`${errorText(error)} 可手动输入路径。`;}}
    finally{if(chooserAbort===chooser)chooserAbort=null;selecting=false;addFolder.disabled=addFile.disabled=false;}
  }
  function file(item,path,label){
    const created=epoch,row=node('div','project-files-file-row');
    const select=button('','project-files-entry project-files-file',()=>{
      if(!current(created))return;
      selectedFile?.setAttribute('aria-pressed','false');selectedFile=select;select.setAttribute('aria-pressed','true');
    });
    select.setAttribute('aria-pressed','false');select.setAttribute('aria-label','选择文件 '+label);
    select.append(node('span','project-files-icon','▤'),node('span','project-files-entry-name',label));
    const menu=node('details','project-files-file-menu'),summary=node('summary','project-files-file-menu-toggle','打开 ▾');
    summary.setAttribute('aria-label','打开 '+label);const choices=node('div','project-files-file-menu-options');
    let busy=false;
    const run=async(action,control)=>{
      if(busy||!current(created))return;busy=true;control.disabled=true;
      try{
        if(action==='read-attachment'){
          status.textContent='正在准备对话资料…';
          const prepared=await onBeginAttach();if(!current(created))return;
          if(!prepared?.ok)throw new Error(prepared?.error||'对话上下文尚未就绪。');
          const value=await call(action,{rootId:item.id,path});if(!current(created))return;
          const result=await onAddToContext(value,prepared.binding);if(!current(created))return;
          if(!result?.ok)throw new Error(result?.error||'无法添加到对话上下文。');
          status.textContent=value?.sourceFormat==='extracted'?'已将提取文本添加到对话上下文。':'已添加到对话上下文。';
          onOpenChat();
        }else{
          await call(action,{rootId:item.id,path});if(!current(created))return;
          menu.open=false;status.textContent=action==='open-file'?'已请求用默认应用打开文件。':'已请求打开所在文件夹。';
        }
      }catch(error){if(current(created))status.textContent=action!=='read-attachment'&&error?.name==='AbortError'?'打开请求结果未确认，请先检查 Windows 窗口。':errorText(error);}
      finally{busy=false;control.disabled=false;}
    };
    const open=button('用默认应用打开','project-files-open-file',()=>void run('open-file',open));
    const folder=button('打开所在文件夹','project-files-open-folder',()=>void run('open-folder',folder));
    choices.append(open,folder);menu.append(summary,choices);
    const add=button('添加到对话上下文','project-files-add-context',()=>void run('read-attachment',add));
    add.setAttribute('aria-label','将 '+label+' 添加到对话上下文');row.append(select,menu,add);return row;
  }
  function directory(item,path,label,isRoot=false){
    const details=node('details','project-files-directory'),summary=node('summary','project-files-entry');
    summary.append(node('span','project-files-icon','▸'),node('span','project-files-entry-name',label));
    if(isRoot&&item.source==='project')summary.append(node('span','project-files-badge','当前项目'));
    details.append(summary);const children=node('div','project-files-children');details.append(children);
    let loaded=false,loading=false,dirGeneration=0,nextCursor=null,shown=[];
    function idleView(message){
      const tail=[];
      if(message)tail.push(node('p','project-files-error',message));
      if(nextCursor)tail.push(button('加载更多','project-files-more',()=>void loadPage(nextCursor)));
      children.replaceChildren(...shown,...tail);
    }
    async function loadPage(cursor){
      if(loading||!details.open)return;loading=true;const token=epoch,version=dirGeneration;
      children.replaceChildren(...shown,node('p','project-files-hint','正在读取…'));
      try{
        const parameters={rootId:item.id,path};if(cursor)parameters.cursor=cursor;
        const value=await call('list-children',parameters);if(!current(token)||version!==dirGeneration||!details.open)return;
        for(const entry of value.entries){
          if(entry.kind==='directory')shown.push(directory(item,entry.path,entry.name));
          else if(entry.kind==='file')shown.push(file(item,entry.path,entry.name));
        }
        nextCursor=typeof value.nextCursor==='string'&&value.nextCursor?value.nextCursor:null;loaded=true;
        if(!shown.length&&!nextCursor)shown.push(node('p','project-files-hint','文件夹为空。'));
        if(value.truncated&&!nextCursor)shown.push(node('p','project-files-hint','文件较多，仅显示部分内容。'));
        idleView();
      }catch(error){
        if(!current(token)||version!==dirGeneration||!details.open)return;
        if(error?.code==='DIRECTORY_CHANGED'||error?.code==='INVALID_CURSOR'){
          loaded=false;nextCursor=null;children.replaceChildren(...shown,node('p','project-files-error',error?.code==='INVALID_CURSOR'?'分页已失效，请关闭后重新展开。':'目录已变化，请关闭后重新展开。'));
        }else if(cursor){nextCursor=cursor;idleView(errorText(error));}
        else{children.replaceChildren(...shown,node('p','project-files-error',errorText(error)),button('重试','project-files-more',()=>void loadPage(null)));}
      }finally{if(version===dirGeneration)loading=false;}
    }
    details.addEventListener('toggle',()=>{
      if(!details.open){dirGeneration++;loading=false;return;}
      if(!loaded){shown=[];nextCursor=null;void loadPage(null);}
      else if(!loading)idleView();
    });
    return details;
  }
  function render(value){
    roots.replaceChildren();selectedFile=null;
    for(const item of value.roots){
      const card=node('section','project-files-root'),bar=node('div','project-files-root-bar');
      let rootEntry;
      if(item.status==='unavailable'||item.status==='needs-confirmation'){
        rootEntry=node('div','project-files-entry project-files-unavailable');rootEntry.setAttribute('aria-disabled','true');
        rootEntry.append(node('span','project-files-icon',item.kind==='directory'?'▸':'▤'),node('span','project-files-entry-name',item.name),node('span','project-files-unavailable-badge',item.status==='needs-confirmation'?'待启用':'不可访问'));
      }else rootEntry=item.kind==='directory'?directory(item,'',item.name,true):file(item,'',item.name);
      bar.append(rootEntry);
      if(typeof onAuthorizeDirectory==='function'&&item.kind==='directory'&&item.status!=='unavailable'&&item.status!=='needs-confirmation'){
        const created=epoch,authorize=button('设为读写工作区','project-files-authorize',()=>{
          if(!current(created))return;
          status.textContent='请在对话中确认此目录的访问范围。';
          onAuthorizeDirectory({rootId:item.id,path:item.path,label:item.name});
        });authorize.setAttribute('aria-label','将 '+item.name+' 设为读写工作区');bar.append(authorize);
      }
      if(item.source==='user'){
        if(item.status==='needs-confirmation'){
          const enable=button('启用','project-files-enable',async()=>{
            const token=epoch;enable.disabled=true;
            try{await call('add-root',{path:item.path,kind:item.kind});if(!current(token))return;onChanged();await refresh();}
            catch(error){if(current(token))status.textContent=errorText(error);}
            finally{enable.disabled=false;}
          });enable.title='启用前会重新核验此地址';bar.append(enable);
        }
        const remove=button('移除','project-files-remove',async()=>{
          const token=epoch;remove.disabled=true;
          try{await call('remove-root',{id:item.id});if(!current(token))return;onChanged();await refresh();}
          catch(error){if(current(token))status.textContent=errorText(error);}
          finally{remove.disabled=false;}
        });remove.title='只移除地址，不删除原文件';bar.append(remove);
      }
      card.append(bar,node('p','project-files-root-path',item.path));roots.append(card);
    }
    if(!value.roots.length)roots.append(node('p','project-files-empty','还没有添加文件或文件夹。'));
    const projectMessage=value.projectStatus==='unsaved'?'当前项目尚未保存，暂时没有项目目录。':value.projectStatus==='unavailable'?'当前项目目录暂不可用。':value.projectStatus?.message;
    const storageMessage=value.storageStatus==='unavailable'?(value.storageMessage||'资料库地址无法保存，重启后可能丢失。'):'';
    status.textContent=[projectMessage||'文件按需读取；原文件保留在原位置。',storageMessage].filter(Boolean).join(' ');
  }
  async function refresh(){
    const token=++epoch;chooserAbort?.abort();selectedFile=null;status.textContent='正在读取资料库…';
    try{const value=await call('list-roots',{});if(current(token))render(value);}
    catch(error){if(current(token)){roots.replaceChildren();status.textContent=errorText(error);}}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();const path=input.value.trim();if(!path){status.textContent='请输入文件或文件夹的绝对路径。';return;}
    const token=epoch;submit.disabled=true;
    try{await addPath(path,type.value,token);}
    catch(error){if(current(token))status.textContent=errorText(error);}
    finally{submit.disabled=false;}
  });
  return {refresh,close(){epoch++;chooserAbort?.abort();selectedFile=null;},reset(){epoch++;chooserAbort?.abort();selectedFile=null;form.hidden=true;input.value='';roots.replaceChildren();status.textContent='账号已变化，请重新打开资料库。';},destroy(){disposed=true;epoch++;chooserAbort?.abort();selectedFile=null;root.replaceChildren();}};
}

function mount(){
  const root=document.getElementById('project-knowledge-panel');if(!root||root.dataset.mounted)return;
  root.dataset.mounted='true';
  if(!document.getElementById('project-files-style')){const link=document.createElement('link');link.id='project-files-style';link.rel='stylesheet';link.href='/project-files.css';document.head.append(link);}
  async function request(action,parameters={},options={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),action==='choose'?310000:30000);
    const onAbort=()=>controller.abort();if(options.signal?.aborted)controller.abort();else options.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const first=await fetch('/api/status',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const state=await first.json(),client=sessionStorage.getItem('revit-codex-client');
      if(!first.ok||state.workspace?.kind!=='model'||typeof state.csrf!=='string'||!client)throw new Error('请先连接本地项目助手。');
      const response=await fetch('/api/project-files',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client,action,parameters})});
      const data=await response.json();if(!response.ok||!data.ok){const error=new Error(data?.error?.message||data?.error||'资料操作未完成。');error.code=data?.error?.code;throw error;}return data.value;
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);}
  }
  function beginAttachment(){
    return new Promise(resolve=>{
      let answered=false;
      const reply=value=>{answered=true;resolve(value);};
      window.dispatchEvent(new CustomEvent('buildx-project-attach-begin',{detail:{resolve:reply}}));
      // The begin event obtains the current conversation synchronously. If the
      // composer is unavailable, do not leave a disabled button waiting forever.
      if(!answered)resolve({ok:false,error:'对话上下文尚未就绪。'});
    });
  }
  const ui=mountProjectFiles({root,request,onChanged:()=>window.dispatchEvent(new CustomEvent('buildx-project-changed')),
    onBeginAttach:beginAttachment,
    onAddToContext:(value,binding)=>new Promise(resolve=>window.dispatchEvent(new CustomEvent('buildx-project-attach',{detail:{value,binding,resolve}}))),
    onAuthorizeDirectory:detail=>window.dispatchEvent(new CustomEvent('buildx-access-project-request',{detail})),
    onOpenChat:()=>window.dispatchEvent(new CustomEvent('buildx-open-chat'))});
  window.addEventListener('buildx-project-files-opened',()=>void ui.refresh());
  window.addEventListener('buildx-project-files-closed',()=>ui.close());
  window.addEventListener('buildx-account-changed',()=>ui.reset());
}
if(typeof window!=='undefined'&&typeof document!=='undefined'){window.addEventListener('buildx-extra-panels-ready',mount);mount();}
