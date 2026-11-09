import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=fileURLToPath(new URL('..',import.meta.url));

export async function createManagedWorkbenchFixture(dir,{holdSelectionReceipt=false}={}){
  const stage=path.join(await fs.realpath(dir),'synthetic-workbench');
  await fs.mkdir(stage);
  const entry=path.join(stage,'workbench-mcp.mjs');
  const workbenchRoot=path.join(stage,'workbench');
  const queue=path.join(workbenchRoot,'queue');
  const inbox=path.join(queue,'inbox');
  const processing=path.join(queue,'processing');
  const outbox=path.join(queue,'outbox');
  const version='0.8.8';
  const session='d1ed'.repeat(8);
  const receiptMarker='fixture-managed-private-receipt-detail';
  const document=Object.freeze({title:'fixture-managed-private-title',
    path:'D:\\fixture-managed-original\\isolated-project.rvt',activeViewId:12,activeViewType:'ThreeD',modified:false});
  const capabilities={atomicReadSnapshot:true,nativeModelQueriesVersion:1,nativeModelQueryOperations:[]};
  const requests=new Map();
  const selectionReceiptGate=holdSelectionReceipt?Promise.withResolvers():null;
  const releaseSelectionReceipt=()=>selectionReceiptGate?.resolve();
  let activeDocument=document,stopped=false;

  // Copy source into a clean program root so the actual MCP resolves its
  // queue relative to the fixture, without any installed BuildX configuration.
  await fs.copyFile(path.join(project,'workbench-mcp.mjs'),entry);
  for(const directory of ['lib','public','release']){
    await fs.cp(path.join(project,directory),path.join(stage,directory),{
      recursive:true,
      filter:async filename=>{
        const entry=await fs.lstat(filename);
        return entry.isDirectory()||entry.isFile()&&['.mjs','.json'].includes(path.extname(filename));
      }
    });
  }
  await Promise.all([inbox,processing,outbox].map(directory=>fs.mkdir(directory,{recursive:true})));
  await fs.writeFile(path.join(queue,'host.json'),JSON.stringify({sessionId:session,pid:process.pid,version,...capabilities}));
  const {invokeModelTool}=await import(pathToFileURL(path.join(stage,'lib','model-tool-dispatch.mjs')).href);
  const {workbenchFailureEvidence:readContextFailure}=await import(pathToFileURL(path.join(stage,'lib','workbench-client.mjs')).href);

  const pump=(async()=>{
    while(!stopped){
      for(const filename of await fs.readdir(inbox)){
        if(!filename.endsWith('.json'))continue;
        const claimed=path.join(processing,filename);
        await fs.rename(path.join(inbox,filename),claimed);
        const request=JSON.parse(await fs.readFile(claimed,'utf8'));
        assert.equal(filename,request.id+'.json');
        assert.equal(request.targetSession,session);
        assert.equal(request.atomicRead,true);
        assert.ok(!requests.has(request.id));
        assert.ok(['status','get_selection'].includes(request.operation));
        if(request.operation==='status')assert.deepEqual(request.args,{});
        else assert.deepEqual(Object.keys(request.args),['expected_document']);
        const record={request,receipt:null};
        requests.set(request.id,record);

        const snapshot={hostSession:session,hostVersion:version,document:activeDocument,capabilities};
        const result={operation:request.operation,hostSession:session,atomicReadSnapshot:true,snapshot};
        if(request.operation==='status')result.value={...snapshot};
        else result.value={operation:'get_selection',hostSession:session,
          document:{path:activeDocument.path,title:activeDocument.title},modifiedByOperation:false,
          value:{total:2,returned:2,truncated:false,items:[
            {element_id:42,name:receiptMarker},{element_id:'9223372036854775807'}
          ]}};

        const mismatch=request.operation==='get_selection'&&request.args.expected_document!==activeDocument.path;
        const observedDocument=activeDocument;
        if(request.operation==='get_selection'&&selectionReceiptGate)await selectionReceiptGate.promise;
        const receipt={id:request.id,completedUtc:new Date().toISOString(),...(mismatch
          ?{ok:false,hostSession:session,error:{code:'DOCUMENT_MISMATCH',message:receiptMarker+' '+observedDocument.path},
            execution:{phase:'validation',started:false,reason:null}}
          :{ok:true,result})};
        const temp=path.join(outbox,filename+'.tmp');
        await fs.writeFile(temp,JSON.stringify(receipt));
        await fs.rename(temp,path.join(outbox,filename));
        record.receipt=receipt;
      }
      if(!stopped)await delay(4);
    }
  })();
  // Surface an early worker error at close without an unhandled rejection.
  pump.catch(()=>{});

  return {
    entry,document,session,receiptMarker,requests,readContextFailure,releaseSelectionReceipt,
    invokeManagedWorkbenchRead(name,args,control){
      return invokeModelTool(name,args,{...control,root:workbenchRoot,
        ...(holdSelectionReceipt&&name==='revit_get_selection'?{timeout:700}:{})});
    },
    changeDocument(){
      activeDocument=Object.freeze({...document,title:'fixture-managed-replacement-title',
        path:'D:\\fixture-managed-replacement\\different-project.rvt'});
      return activeDocument;
    },
    async close(){stopped=true;releaseSelectionReceipt();await pump;}
  };
}
