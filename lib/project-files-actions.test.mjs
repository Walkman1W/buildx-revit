import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createMaterialIndex} from './project-files.mjs';

const exec=promisify(execFile);
async function ownedTemp(t,prefix){
  const base=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(base,prefix));
  t.after(async()=>{
    const absolute=path.resolve(root),actual=await fs.realpath(absolute);
    if(path.dirname(absolute)!==base||path.dirname(actual)!==base||!path.basename(absolute).startsWith(prefix)||(await fs.lstat(absolute)).isSymbolicLink())throw new Error('Refusing to remove a non-owned fixture directory');
    await fs.rm(absolute,{recursive:true,force:true});
  });
  return root;
}
async function fixture(t){
  const root=await ownedTemp(t,'buildx-library-actions-');
  await fs.mkdir(path.join(root,'子目录'));
  await fs.writeFile(path.join(root,'子目录','项目 $`说明.txt'),Buffer.from('\ufeff内容\n','utf8'));
  const calls=[];
  const index=createMaterialIndex({openLocal:async request=>{calls.push(request);return {ok:true,value:{accepted:true}};}});
  const added=await index.addRoot({path:root,kind:'directory'});assert.equal(added.ok,true);
  return {root,index,calls,id:added.value.root.id};
}
test('opens the selected file and its actual folder through the owned root only',async t=>{
  const {root,index,calls,id}=await fixture(t),relative='子目录/项目 $`说明.txt';
  assert.deepEqual(await index.openFile({rootId:id,path:relative}),{ok:true,value:{opened:true}});
  assert.deepEqual(await index.openFolder({rootId:id,path:relative}),{ok:true,value:{opened:true}});
  assert.deepEqual(calls,[{path:path.join(root,'子目录','项目 $`说明.txt'),kind:'file'},{path:path.join(root,'子目录'),kind:'directory'}]);
  assert.equal((await index.openFolder({rootId:id,path:'子目录',kind:'directory'})).ok,true);
  assert.deepEqual(calls.at(-1),{path:path.join(root,'子目录'),kind:'directory'});
  const file=(await index.addRoot({path:path.join(root,'子目录','项目 $`说明.txt'),kind:'file'})).value.root;
  assert.equal((await index.openFolder({rootId:file.id,path:''})).ok,true);
  assert.deepEqual(calls.at(-1),{path:path.join(root,'子目录'),kind:'directory'});
});
test('rejects invalid, stale, reauthorized and executable identities before launching',async t=>{
  const {root,index,calls,id}=await fixture(t);
  for(const ext of ['cmd','py','pyw','pyz','jar','msix','msixbundle','appx','appxbundle','application','gadget','msc','dll','sct','wsc','ws','msh2xml','chm']){
    const name='运行.'+ext;await fs.writeFile(path.join(root,name),'do not execute');
    assert.equal((await index.openFile({rootId:id,path:name})).error.code,'FILE_OPEN_UNSUPPORTED',ext);
  }
  assert.equal((await index.openFolder({rootId:id,path:'运行.cmd'})).ok,true);calls.length=0;
  for(const invalid of ['../outside','/absolute','子目录/../运行.cmd','子目录\\项目.txt'])assert.equal((await index.openFile({rootId:id,path:invalid})).ok,false);
  let check=0;assert.equal((await index.openFile({rootId:id,path:'子目录/项目 $`说明.txt'},{isCurrent:()=>++check<2})).error.code,'FILE_CONTEXT_CHANGED');
  assert.equal(calls.length,0);
  const restored=(await index.restoreRoot({path:path.join(root,'子目录','项目 $`说明.txt'),kind:'file'})).value.root;
  assert.equal((await index.openFile({rootId:restored.id,path:''})).ok,false);
  index.removeRoot({id});assert.equal((await index.openFile({rootId:id,path:'子目录/项目 $`说明.txt'})).ok,false);assert.equal(calls.length,0);
});
test('a successful launch followed by identity loss reports the already-sent action accurately',async t=>{
  const root=await ownedTemp(t,'buildx-actions-account-');
  await fs.writeFile(path.join(root,'note.txt'),'ok');let current=true,launches=0;
  const index=createMaterialIndex({openLocal:async()=>{launches++;current=false;return {ok:true,value:{accepted:true}};}});
  const id=(await index.addRoot({path:root,kind:'directory'})).value.root.id;
  const result=await index.openFile({rootId:id,path:'note.txt'},{isCurrent:()=>current});
  assert.equal(launches,1);assert.equal(result.error.code,'FILE_CONTEXT_CHANGED_AFTER_OPEN');assert.match(result.error.message,/可能已发送/);
});
test('revalidates the chosen file, folder and root identity before invoking the launcher',async t=>{
  const {root,index,calls,id}=await fixture(t),outside=await ownedTemp(t,'buildx-actions-outside-');
  await fs.writeFile(path.join(outside,'other.txt'),'external');
  await fs.symlink(outside,path.join(root,'shortcut'),'junction');
  assert.equal((await index.openFile({rootId:id,path:'shortcut/other.txt'})).ok,false);
  await fs.link(path.join(root,'子目录','项目 $`说明.txt'),path.join(root,'hard.txt'));
  assert.equal((await index.openFile({rootId:id,path:'hard.txt'})).ok,false);
  assert.equal((await index.readAttachment({rootId:id,path:'hard.txt'})).ok,false);
  assert.equal(calls.length,0);
});
test('original text bytes are preserved; limits, unsafe paths and invalid data are rejected',async t=>{
  const {root,index,id}=await fixture(t),relative='子目录/项目 $`说明.txt',original=await fs.readFile(path.join(root,'子目录','项目 $`说明.txt'));
  const file=await index.readAttachment({rootId:id,path:relative});assert.equal(file.ok,true,JSON.stringify(file));
  assert.equal(file.value.sourceFormat,'original');assert.equal(file.value.name,'项目 $`说明.txt');assert.equal(file.value.attachmentName,file.value.name);
  assert.deepEqual(Buffer.from(file.value.data,'base64'),original);assert.equal(file.value.byteLength,original.length);
  await fs.writeFile(path.join(root,'big.txt'),Buffer.alloc(65537,65));assert.equal((await index.readAttachment({rootId:id,path:'big.txt'})).error.code,'FILE_TOO_LARGE');
  await fs.writeFile(path.join(root,'bad.txt'),Buffer.from([255]));assert.equal((await index.readAttachment({rootId:id,path:'bad.txt'})).error.code,'FILE_ATTACHMENT_INVALID');
  await fs.writeFile(path.join(root,'binary.dwg'),Buffer.from([0,1,2]));assert.equal((await index.readAttachment({rootId:id,path:'binary.dwg'})).error.code,'FILE_ATTACHMENT_UNSUPPORTED');
  assert.equal((await index.readAttachment({rootId:id,path:'../outside'})).ok,false);
  let check=0;assert.equal((await index.readAttachment({rootId:id,path:relative},{isCurrent:()=>++check<2})).error.code,'FILE_CONTEXT_CHANGED');
});
test('office documents are explicitly represented as extracted text, and partial/large results are refused',async t=>{
  const {root,index,id}=await fixture(t);
  const script="import sys,zipfile\nfrom pathlib import Path\np=Path(sys.argv[1])\nfor name,text in [('small.docx','Design height'),('large.docx','x'*33000)]:\n with zipfile.ZipFile(p/name,'w') as z:z.writestr('word/document.xml','<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>')";
  await exec('python',['-c',script,root]);
  const small=await index.readAttachment({rootId:id,path:'small.docx'});assert.equal(small.ok,true,JSON.stringify(small));
  assert.equal(small.value.sourceFormat,'extracted');assert.equal(small.value.attachmentName,'small.docx.txt');assert.match(Buffer.from(small.value.data,'base64').toString('utf8'),/Design height/);
  const large=await index.readAttachment({rootId:id,path:'large.docx'});assert.equal(large.ok,false);assert.ok(['FILE_ATTACHMENT_INVALID','FILE_ATTACHMENT_TOO_LARGE'].includes(large.error.code));
});
