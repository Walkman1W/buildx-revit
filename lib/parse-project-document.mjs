import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const parserPath=fileURLToPath(new URL('./project-knowledge-parser.py',import.meta.url));
const success=value=>({ok:true,value});
const fail=(code,message)=>({ok:false,error:{code,message}});

// A single, fixed parser shared by project search and file preview. User bytes
// are stdin data, never a path, executable, shell fragment, macro or PDF script.
export function parseProjectDocument(bytes,format,pythonExecutable,{timeoutMs=10000}={}) {
  return new Promise(resolve=>{
    let child,output=[],length=0,reason=null,timer,done=false;
    const finish=value=>{if(done)return;done=true;if(timer)clearTimeout(timer);resolve(value);};
    try{child=spawn(pythonExecutable,[parserPath,format],{stdio:['pipe','pipe','ignore'],windowsHide:true,shell:false});}
    catch{return finish(fail('PARSER_UNAVAILABLE','Document parser could not start.'));}
    timer=setTimeout(()=>{reason='PARSER_TIMEOUT';child.kill();},timeoutMs);
    child.on('error',()=>{reason='PARSER_UNAVAILABLE';});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      length+=chunk.length;
      if(length>12*1024*1024){reason='PARSER_OUTPUT_LIMIT';child.kill();}
      else output.push(chunk);
    });
    child.on('close',code=>{
      if(reason||code!==0)return finish(fail(reason||'PARSER_FAILED','Document extraction did not complete.'));
      try{
        const result=JSON.parse(Buffer.concat(output).toString('utf8'));
        if(!result.ok)return finish(fail(result.error?.code||'PARSER_FAILED','Document extraction failed.'));
        if(!Array.isArray(result.value?.segments)||result.value.segments.length>50000||
          result.value.segments.some(s=>typeof s.text!=='string'||!s.location||typeof s.location!=='object')||
          !Array.isArray(result.value.warnings))throw new Error('invalid parser response');
        finish(success(result.value));
      }catch{return finish(fail('INVALID_PARSER_RESULT','Document parser returned an invalid result.'));}
    });
    child.stdin.end(bytes);
  });
}
