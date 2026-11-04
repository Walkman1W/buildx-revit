import fs from 'node:fs/promises';
import path from 'node:path';

// Register shutdown before starting asynchronous resources. The app remains
// the sole owner of the history store and of any unconfirmed cleanup.
export async function runPanelService({app,lifecycle,root,processObject=process,filesystem=fs,output=console}){
  let stopping=false,signalClose=null;
  for(const signal of ['SIGINT','SIGTERM'])processObject.on(signal,()=>{
    if(signalClose)return;
    stopping=true;
    try{lifecycle.audit('lifecycle.jsonl',{code:'service_stopping',pid:processObject.pid,reason:signal},true);}
    catch{processObject.exitCode=1;output.error(JSON.stringify({service:'revit-local-codex',error_code:'service_audit_failed'}));}
    signalClose=Promise.resolve().then(()=>app.close()).then(result=>{
      if(result?.closed!==true)throw new Error('cleanup unconfirmed');
      output.log(JSON.stringify({service:'revit-local-codex',code:'service_closed'}));
    }).catch(()=>{
      processObject.exitCode=1;
      output.error(JSON.stringify({service:'revit-local-codex',error_code:'service_cleanup_pending'}));
    }).finally(()=>{signalClose=null;});
  });
  try{
    const address=await app.listen();
    if(!stopping){
      await filesystem.mkdir(path.join(root,'runtime'),{recursive:true});
      if(!stopping)await filesystem.writeFile(path.join(root,'runtime','server.json'),JSON.stringify({service:'revit-local-codex',pid:processObject.pid,...address,startedAt:new Date().toISOString()},null,2));
      if(!stopping){
        lifecycle.audit('lifecycle.jsonl',{code:'service_started',pid:processObject.pid,reason:'startup'},true);
        output.log(JSON.stringify({service:'revit-local-codex',port:address.port}));void app.connect();
      }
    }
  }catch(error){
    const errorCode=typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:stopping?'STARTUP_INTERRUPTED':'startup_failed';
    lifecycle.audit('lifecycle.jsonl',{code:'service_start_failed',pid:processObject.pid,error_code:errorCode},true);
    if(stopping&&errorCode!=='STARTUP_INTERRUPTED')output.error(JSON.stringify({service:'revit-local-codex',error_code:errorCode}));
    if(!stopping){
      output.error(JSON.stringify({service:'revit-local-codex',error_code:errorCode}));processObject.exitCode=1;
      try{const closed=await app.close();if(closed?.closed!==true)throw new Error('cleanup unconfirmed');}catch{output.error(JSON.stringify({service:'revit-local-codex',error_code:'service_cleanup_pending'}));}
      await lifecycle.flush();
    }
  }
  if(signalClose)await signalClose;
}
