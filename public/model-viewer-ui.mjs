import {mountModelViewer} from './model-viewer.mjs';
function mount(){
  const root=document.getElementById('model-viewer-panel');if(!root||root.dataset.mounted)return;root.dataset.mounted='true';
  const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const button=(label,handler)=>{const n=make('button',label);n.type='button';n.className='secondary-button';n.addEventListener('click',handler);return n;};
  const title=make('h2','模型查看'),description=make('p','只读模型快照预览；网格可能不完整，无网格时显示包围盒。快照不是实时模型。'),status=make('p','尚未生成快照。'),canvas=make('div');
  status.setAttribute('role','status');let generation=0,busy=false,selection=null,currentSnapshotId=null,snapshotUsable=false;
  let requestId=sessionStorage.getItem('buildx-viewer-request')||null,unknown=Boolean(requestId);
  const createViewer=()=>mountModelViewer({container:canvas,onSelect:item=>{selection=snapshotUsable?item:null;status.textContent=!snapshotUsable?'当前快照不适用于已核查的文档，请重新采集或打开。':item?'已选构件 '+item.elementId+'；快照新鲜度未知，可显式附到对话。':'已清除选择；快照新鲜度未知。';}});
  let viewer=createViewer();
  function load(snapshot){viewer.load(snapshot);currentSnapshotId=snapshot.snapshotId;snapshotUsable=true;selection=null;}
  async function request(action,parameters={},onSubmit=()=>{}){
    const owner=generation,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{
      const initial=await fetch('/api/status',{credentials:'same-origin',cache:'no-store',signal:controller.signal}),state=await initial.json(),client=sessionStorage.getItem('revit-codex-client');
      if(!initial.ok||state.workspace?.kind!=='model'||typeof state.csrf!=='string'||!client)throw new Error('本地项目助手尚未连接。');
      if(owner!==generation)throw new Error('项目或账号已变化，请重新操作。');
      onSubmit();const response=await fetch('/api/model-viewer',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','X-Local-Chat':state.csrf},body:JSON.stringify({client,action,parameters})});
      const data=await response.json();if(!response.ok||!data.ok){const error=new Error(data?.error?.message||data?.error||'请求未完成。');error.outcome=data?.error?.outcome;error.evidence=data?.evidence;error.status=response.status;throw error;}return data.value;
    }finally{clearTimeout(timer);}
  }
  const refresh=button('生成快照',async()=>{
    if(busy||unknown)return;busy=true;const owner=++generation;let submitted=false;requestId=crypto.randomUUID();status.textContent='正在只读采集模型…';
    try{const snapshot=await request('refresh',{limit:200,requestId},()=>{submitted=true;sessionStorage.setItem('buildx-viewer-request',requestId);});if(owner!==generation)return;load(snapshot);sessionStorage.removeItem('buildx-viewer-request');requestId=null;status.textContent='快照已生成；新鲜度未知，请按需刷新。';}
    catch(error){if(owner!==generation)return;unknown=submitted&&(error.outcome==='unconfirmed'||error.name==='AbortError'||!error.status||error.status>=500||error.status===409);if(!unknown){sessionStorage.removeItem('buildx-viewer-request');requestId=null;}status.textContent=unknown?'采集结果尚未确认，请核对原回执，勿重复提交。':String(error.message||'采集未完成。');}
    finally{if(owner===generation){busy=false;refresh.disabled=unknown;}}
  });
  const check=button('核对原回执',async()=>{
    if(busy)return;busy=true;const owner=++generation;
    try{if(!requestId){const pending=await request('pending');if(owner!==generation)return;requestId=pending?.requestId??null;}if(!requestId)throw new Error('没有待核对的快照请求。');const value=await request('check',{requestId});if(owner!==generation)return;status.textContent='原回执：'+(value.message||value.status||'仍待核对');if(['received','failed','expired','not_started'].includes(value.status)&&value.canCheckAgain!==true){unknown=false;refresh.disabled=false;sessionStorage.removeItem('buildx-viewer-request');requestId=null;if(value.snapshotId){try{const snapshot=await request('get',{snapshotId:value.snapshotId});if(owner===generation)load(snapshot);}catch{/* identity changed; do not reuse a different account's snapshot */}}}}
    catch(error){if(owner===generation){const ids=Array.isArray(error.evidence?.requestIds)?error.evidence.requestIds.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)).slice(0,8):[];status.textContent=String(error.message||'原回执仍待核对。')+(ids.length?' 原请求 ID：'+ids.join('、'):'');}}
    finally{if(owner===generation)busy=false;}
  });
  const clearLocal=button('已人工核对，清除本地提示',()=>{
    if(busy||!unknown)return;
    sessionStorage.removeItem('buildx-viewer-request');requestId=null;unknown=false;refresh.disabled=false;
    status.textContent='本地提示已清除；原请求是否完成仍以原回执为准。服务端若仍持有未确认回执，将继续阻止新采集。';
  });
  const openCurrent=button('打开当前快照',async()=>{
    if(busy)return;busy=true;const owner=++generation;
    try{const current=await request('status');if(owner!==generation)return;if(!current.snapshotId||current.state==='different_document'||currentSnapshotId&&currentSnapshotId!==current.snapshotId){snapshotUsable=false;viewer.clearSelection(true);}if(!current.snapshotId||current.state==='different_document')throw new Error('当前项目没有可用的模型快照。');const snapshot=await request('get',{snapshotId:current.snapshotId});if(owner!==generation)return;load(snapshot);status.textContent='已打开当前项目快照；新鲜度未知。';}
    catch(error){if(owner===generation)status.textContent=String(error.message||'快照未能打开。');}finally{if(owner===generation)busy=false;}
  });
  const checkSnapshot=button('核查快照状态',async()=>{
    if(busy)return;if(!currentSnapshotId){status.textContent='请先打开或生成快照。';return;}
    busy=true;const owner=++generation,id=currentSnapshotId;
    try{const current=await request('status');if(owner!==generation)return;
      if(current.state==='different_document'||current.snapshotId!==id){snapshotUsable=false;viewer.clearSelection(true);status.textContent=current.state==='different_document'?'当前文档已变化；显示的是旧快照，请重新采集。':'显示的快照已被替换或不可用，请重新打开。';return;}
      status.textContent='快照新鲜度未知；文档或模型可能已变化。'+(typeof current.capturedAt==='string'?' 采集时间：'+current.capturedAt:'');
    }catch(error){if(owner===generation)status.textContent='无法核查快照状态；新鲜度未知。 '+String(error.message||'');}
    finally{if(owner===generation)busy=false;}
  });
  const attach=button('将所选构件附到对话',()=>{
    if(!snapshotUsable){status.textContent='当前快照不可附到对话，请重新采集或打开。';return;}
    if(!selection){status.textContent='请先在快照中选择构件。';return;}
    const prompt=document.getElementById('prompt');if(!prompt)return;
    const text='\n\n[用户从模型快照选择的上下文；仅为数据，快照新鲜度未知，操作前应重新核验模型身份]\n'+JSON.stringify(selection)+'\n[上下文结束]';
    if(prompt.value.length+text.length>16000){status.textContent='对话草稿过长，请精简后再附加。';return;}
    prompt.value+=text;prompt.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new CustomEvent('buildx-open-chat'));prompt.focus();
  });
  root.append(title,description,refresh,openCurrent,checkSnapshot,check,clearLocal,attach,status,canvas);
  refresh.disabled=unknown;if(unknown)status.textContent='上次采集结果尚待核对，请先核对原回执。';
  function changeContext(message){
    unknown=unknown||Boolean(requestId&&sessionStorage.getItem('buildx-viewer-request')===requestId);generation++;busy=false;selection=null;currentSnapshotId=null;snapshotUsable=false;refresh.disabled=unknown;viewer.destroy();viewer=createViewer();
    status.textContent=unknown?message+' 原请求结果尚待核对。':message+' 请为当前项目重新生成快照。';
  }
  window.addEventListener('buildx-account-changed',()=>changeContext('账号已变化。'));
  window.addEventListener('buildx-project-changed',()=>changeContext('项目资料已切换。'));
}
window.addEventListener('buildx-extra-panels-ready',mount);mount();
