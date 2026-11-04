// Presentation only: app.js owns the account-bound catalog and selection.
export function mountModelPicker({document,window,CustomEvent}){
  const parent=document.querySelector('.composer-bottom');if(!parent)return;
  const root=document.createElement('div');root.className='model-picker';root.hidden=true;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='model-picker-toggle';toggle.setAttribute('aria-label','选择模型和思考强度');toggle.setAttribute('aria-haspopup','dialog');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','model-picker-menu');
  const icon=document.createElement('span');icon.className='model-picker-icon';icon.textContent='✦';icon.setAttribute('aria-hidden','true');
  const modelName=document.createElement('span');modelName.className='model-picker-current-model';modelName.textContent='选择模型';
  const currentEffort=document.createElement('span');currentEffort.className='model-picker-current-effort';currentEffort.hidden=true;
  const arrow=document.createElement('span');arrow.className='model-picker-chevron';arrow.textContent='⌄';arrow.setAttribute('aria-hidden','true');
  toggle.append(icon,modelName,currentEffort,arrow);
  const menu=document.createElement('div');menu.id='model-picker-menu';menu.className='model-picker-menu';menu.hidden=true;menu.setAttribute('role','dialog');menu.setAttribute('aria-label','模型和思考强度');
  const modelLabel=document.createElement('label');modelLabel.className='model-picker-field-label';modelLabel.setAttribute('for','model-picker-select');modelLabel.textContent='模型';
  const select=document.createElement('select');select.id='model-picker-select';select.setAttribute('aria-label','选择模型');
  const reasoning=document.createElement('div');reasoning.className='model-picker-reasoning';reasoning.hidden=true;
  const effortName=document.createElement('label');effortName.className='model-picker-effort-label';effortName.setAttribute('for','model-picker-effort');
  const effort=document.createElement('input');effort.id='model-picker-effort';effort.type='range';effort.step='1';effort.setAttribute('aria-label','选择思考强度');effort.hidden=true;
  reasoning.append(effortName,effort);
  const effortHint=document.createElement('span');effortHint.className='model-picker-effort-hint';effortHint.hidden=true;
  const refresh=document.createElement('button');refresh.type='button';refresh.className='model-picker-refresh';refresh.textContent='刷新模型列表';refresh.setAttribute('aria-label','刷新模型列表');
  const note=document.createElement('span');note.className='model-picker-note';note.setAttribute('role','status');
  menu.append(modelLabel,select,reasoning,effortHint,refresh,note);root.append(toggle,menu);
  const anchor=document.querySelector('#send');if(anchor&&anchor.parentNode===parent)parent.insertBefore(root,anchor);else parent.append(root);
  function setOpen(open){menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));}
  toggle.addEventListener('click',()=>setOpen(menu.hidden));
  window.addEventListener('click',event=>{if(!menu.hidden&&event.target&&!root.contains(event.target))setOpen(false);});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden){setOpen(false);toggle.focus();}});
  select.addEventListener('change',()=>window.dispatchEvent(new CustomEvent('buildx-model-picker-select',{detail:{model:select.value}})));
  let effortChoices=[];
  const effortAt=()=>{const index=Number(effort.value)-1;return Number.isInteger(index)?effortChoices[index]:undefined;};
  const labels={none:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高',ultra:'Ultra'};
  const effortLabel=choice=>{const raw=choice?.reasoningEffort;return raw?(Object.hasOwn(labels,raw)?labels[raw]:raw):'未选择';};
  const renderEffort=choice=>{const name=effortLabel(choice);effortName.textContent='思考强度：'+name;effort.title=reasoning.title=choice?.description?String(choice.description).slice(0,300):'思考强度：'+name;effort.setAttribute('aria-valuetext',name);};
  effort.addEventListener('input',()=>renderEffort(effortAt()));
  effort.addEventListener('change',()=>{const choice=effortAt();if(choice&&!effort.disabled)window.dispatchEvent(new CustomEvent('buildx-model-effort-select',{detail:{effort:choice.reasoningEffort}}));});
  refresh.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('buildx-model-picker-refresh')));
  window.addEventListener('buildx-model-picker-view',event=>{
    const view=event.detail||{};root.hidden=!view.enabled;if(!view.enabled)setOpen(false);select.replaceChildren();
    if(!view.selected){const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=view.loading?'读取模型…':'选择模型';select.append(placeholder);}
    for(const item of view.models||[]){const option=document.createElement('option');option.value=item.model;option.textContent=item.displayName+(item.isDefault?'（默认）':'');option.title=item.description||'';select.append(option);}
    select.value=view.selected||'';select.disabled=!view.ready||view.blocked||view.loading||!view.models?.length;
    const selectedModel=(view.models||[]).find(item=>item.model===view.selected);modelName.textContent=selectedModel?.displayName||'选择模型';
    select.title=selectedModel?'模型：'+selectedModel.displayName:'选择模型';select.setAttribute('aria-label',select.title);
    const efforts=Array.isArray(view.efforts)?view.efforts:[];effortChoices=efforts;
    effort.hidden=reasoning.hidden=!efforts.length;
    const selectedIndex=efforts.findIndex(choice=>choice.reasoningEffort===view.selectedEffort);
    // Position zero is present only while there is no confirmed selection.
    effort.min=selectedIndex<0?'0':'1';effort.max=String(Math.max(1,efforts.length));effort.value=String(selectedIndex+1);
    effort.disabled=!view.ready||view.blocked||view.loading;renderEffort(efforts[selectedIndex]);
    currentEffort.hidden=selectedIndex<0;currentEffort.textContent=selectedIndex<0?'':effortLabel(efforts[selectedIndex]);
    toggle.title=selectedModel?'模型：'+selectedModel.displayName+(selectedIndex<0?'':'，思考强度：'+effortLabel(efforts[selectedIndex])):'选择模型和思考强度';
    effortHint.hidden=view.effortUnknown!==true;effortHint.textContent=effortHint.hidden?'':'思考等级未提供；使用当前会话设置';
    refresh.disabled=!view.ready||view.blocked||view.loading;note.textContent=view.error||(view.effortInvalid?'思考等级数据无效，请刷新模型列表。':'');
  });
  window.dispatchEvent(new CustomEvent('buildx-model-picker-mounted'));
}
if(typeof window!=='undefined'&&typeof document!=='undefined')mountModelPicker({document,window,CustomEvent});
