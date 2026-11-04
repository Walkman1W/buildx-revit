// Triangle surfaces and fallback bounds are associated with snapshot element IDs. Identity, freshness and
// selection remain owned by the shared service and calling application.
export function mountModelViewer({container,onSelect=()=>{}}) {
  const doc=container.ownerDocument;
  const make=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(text,fn)=>{const n=make('button','',text);n.type='button';n.addEventListener('click',fn);return n;};
  const toolbar=make('div','bx-viewer-toolbar'), message=make('p','bx-viewer-status','尚无模型快照。');
  const canvas=make('canvas','bx-viewer-canvas'), details=make('div','bx-viewer-details','选择构件以查看属性。');
  const chooser=make('select','bx-viewer-chooser');chooser.setAttribute('aria-label','选择快照中的构件');
  canvas.tabIndex=0;canvas.setAttribute('aria-label','模型快照预览；拖动旋转，滚轮缩放');
  let snapshot=null,selected=null,hidden=new Set(),yaw=-0.65,pitch=0.55,zoom=1,drag=null,hit=[];
  const reset=button('显示全部',()=>{hidden.clear();draw();});
  const hide=button('隐藏所选',()=>{if(selected){hidden.add(selected);clearSelection(true);}draw();});
  const isolate=button('隔离所选',()=>{if(!selected||!snapshot)return;for(const i of snapshot.value.items)if(i.element_id!==selected)hidden.add(i.element_id);draw();});
  toolbar.append(reset,hide,isolate,chooser);container.replaceChildren(toolbar,message,canvas,details);
  chooser.addEventListener('change',()=>{if(chooser.value)select(chooser.value,true);});
  function renderDetails(){
    const item=snapshot?.value.items.find(x=>x.element_id===selected);details.replaceChildren();
    if(!item){details.textContent='选择构件以查看属性。';return;}
    for(const [k,v] of [['名称',item.name||'未命名'],['类别',item.category||'未知'],['构件 ID',item.element_id],['UniqueId',item.unique_id],...(item.meshStatus?[['网格状态',({complete:'已遍历可见表面',partial:'部分采集',missing:'无表面网格',failed:'采集失败'})[item.meshStatus]]]:[])] ){
      const row=make('p','');row.append(make('strong','',k+'：'),doc.createTextNode(v));details.append(row);
    }
  }
  function draw(){
    const rect=canvas.getBoundingClientRect(),dpr=doc.defaultView?.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));
    const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);hit=[];
    const items=snapshot?.value.items.filter(i=>!hidden.has(i.element_id))||[];if(!items.length)return;
    const bounds={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
    for(const item of items)for(const k of ['x','y','z']){bounds.min[k]=Math.min(bounds.min[k],item.min[k]);bounds.max[k]=Math.max(bounds.max[k],item.max[k]);}
    const center=Object.fromEntries(['x','y','z'].map(k=>[k,(bounds.min[k]+bounds.max[k])/2]));
    const span=Math.max(1,...['x','y','z'].map(k=>bounds.max[k]-bounds.min[k]));
    const scale=Math.min(rect.width,rect.height)*0.62/span*zoom;
    const project=p=>{const x=p.x-center.x,y=p.y-center.y,z=p.z-center.z;const a=x*Math.cos(yaw)-y*Math.sin(yaw),b=x*Math.sin(yaw)+y*Math.cos(yaw);return [rect.width/2+a*scale,rect.height/2+(b*Math.sin(pitch)-z*Math.cos(pitch))*scale,b*Math.cos(pitch)+z*Math.sin(pitch)];};
    const edges=[[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]], surfaces=[];
    for(const item of items){
      if(item.mesh?.length){
        for(let n=0;n<item.mesh.length;n+=9){
          const triangle=[];for(let v=0;v<3;v++){const j=n+v*3;triangle.push(project({x:item.mesh[j],y:item.mesh[j+1],z:item.mesh[j+2]}));}
          surfaces.push({id:item.element_id,triangle,depth:triangle.reduce((sum,p)=>sum+p[2],0)/3});
        }
      } else {
        const corners=[];for(let x=0;x<2;x++)for(let y=0;y<2;y++)for(let z=0;z<2;z++)corners.push(project({x:x?item.max.x:item.min.x,y:y?item.max.y:item.min.y,z:z?item.max.z:item.min.z}));
        ctx.beginPath();for(const [a,b] of edges){ctx.moveTo(corners[a][0],corners[a][1]);ctx.lineTo(corners[b][0],corners[b][1]);}
        ctx.strokeStyle=item.element_id===selected?'#ff9933':'#7ca9c4';ctx.lineWidth=item.element_id===selected?2:1;ctx.stroke();
        const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);hit.push({id:item.element_id,left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)});
      }
    }
    surfaces.sort((a,b)=>a.depth-b.depth);
    for(const surface of surfaces){
      const [a,b,c]=surface.triangle;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.lineTo(c[0],c[1]);ctx.closePath();
      ctx.fillStyle=surface.id===selected?'#d97831':'#527d98';ctx.fill();ctx.strokeStyle=surface.id===selected?'#ffb15e':'#81a9bf';ctx.lineWidth=.5;ctx.stroke();hit.push(surface);
    }

  }
  function select(id,notify=false){
    if(!snapshot||!snapshot.value.items.some(i=>i.element_id===id))return false;
    selected=id;chooser.value=id;hidden.delete(id);renderDetails();draw();if(notify)onSelect({snapshotId:snapshot.snapshotId,identity:structuredClone(snapshot.identity),elementId:id});return true;
  }
  function clearSelection(notify=false){selected=null;chooser.value='';renderDetails();if(notify)onSelect(null);}
  canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>1)drag.moved=true;yaw+=dx*.01;pitch=Math.max(-1.5,Math.min(1.5,pitch+dy*.01));drag.x=e.clientX;drag.y=e.clientY;draw();});
  canvas.addEventListener('pointerup',e=>{if(!drag)return;if(!drag.moved){const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;const contains=h=>{if(!h.triangle)return x>=h.left&&x<=h.right&&y>=h.top&&y<=h.bottom;const [a,b,c]=h.triangle;const cross=(p,q)=>(q[0]-p[0])*(y-p[1])-(q[1]-p[1])*(x-p[0]);const u=cross(a,b),v=cross(b,c),w=cross(c,a);return Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))>1e-6&&((u>=0&&v>=0&&w>=0)||(u<=0&&v<=0&&w<=0));};const match=hit.slice().reverse().find(contains);if(match)select(match.id,true);}drag=null;});
  canvas.addEventListener('pointercancel',()=>{drag=null;});
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.1,Math.min(10,zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(draw):null;resize?.observe(canvas);
  return Object.freeze({
    load(value){snapshot=structuredClone(value);selected=null;hidden.clear();zoom=1;chooser.replaceChildren();const blank=make('option','','选择构件');blank.value='';chooser.append(blank);for(const item of snapshot.value.items){const option=make('option','',`${item.name||'未命名'} · ${item.element_id}`);option.value=item.element_id;chooser.append(option);}renderDetails();const c=snapshot.value.coverage;message.textContent=snapshot.value.geometry==='triangle_mesh_with_bounds'?`表面网格 ${c.triangles} 三角形 · ${c.exported} 个构件 · 部分 ${c.meshPartial} · 无网格 ${c.meshMissing} · 网格失败 ${c.meshFailed}（无网格时显示包围盒） · 无包围盒 ${c.missingBoundingBox} · 构件失败 ${c.failed}${c.omittedBudget?` · 预算遗漏 ${c.omittedBudget}`:''}${c.meshBudgetLimited?` · 网格预算受限 ${c.meshBudgetLimited}`:''}${c.truncated?' · 达到构件上限':''} · 新鲜度需核对`:`包围盒近似 · ${c.exported} 个构件 · 无包围盒 ${c.missingBoundingBox} · 失败 ${c.failed}${c.truncated?' · 达到上限，未覆盖全部构件':''} · 新鲜度需核对`;draw();},
    select, clearSelection, setStatus(text){message.textContent=text;}, destroy(){resize?.disconnect();container.replaceChildren();}
  });
}
