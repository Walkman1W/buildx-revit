import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createMaterialIndex} from './project-files.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-files-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'folder'));
  await fs.writeFile(path.join(root,'folder','note.txt'),'项目资料\nline 2');
  await fs.writeFile(path.join(root,'document.rvt'),'fixture');
  return root;
}

test('select folder or single file, browse one level and view exact text',async t=>{
  const base=await fixture(t), index=createMaterialIndex();
  const folder=await index.addRoot({path:base,kind:'directory'});assert.equal(folder.ok,true);
  const id=folder.value.root.id;
  assert.deepEqual((await index.listChildren({rootId:id,path:''})).value.entries.map(e=>e.name),['folder','document.rvt']);
  const nested=await index.listChildren({rootId:id,path:'folder'});
  assert.deepEqual(nested.value.entries,[{name:'note.txt',path:'folder/note.txt',kind:'file'}]);
  const read=await index.readFile({rootId:id,path:'folder/note.txt'});
  assert.equal(read.value.text,'项目资料\nline 2');assert.equal(read.value.byteLength,Buffer.byteLength(read.value.text));
  const file=await index.addRoot({path:path.join(base,'folder','note.txt'),kind:'file'});
  assert.equal((await index.readFile({rootId:file.value.root.id,path:''})).value.text,read.value.text);
  assert.equal((await index.addRoot({path:base,kind:'directory'})).value.existing,true);
  assert.equal(index.removeRoot({id}).ok,true);
  assert.equal((await index.readFile({rootId:id,path:'folder/note.txt'})).ok,false);
});

test('reject traversal, root replacement, binary, hard links and oversized content',async t=>{
  const base=await fixture(t), index=createMaterialIndex({maxFileBytes:40});
  await fs.writeFile(path.join(base,'binary.bin'),Buffer.from([0,1,2]));
  await fs.writeFile(path.join(base,'large.txt'),'a'.repeat(41));
  const root=(await index.addRoot({path:base,kind:'directory'})).value.root;
  for(const p of ['../x','folder/../document.rvt','/document.rvt','folder\\note.txt'])assert.equal((await index.readFile({rootId:root.id,path:p})).ok,false);
  assert.equal((await index.readFile({rootId:root.id,path:'binary.bin'})).error.code,'FILE_NOT_TEXT');
  assert.equal((await index.readFile({rootId:root.id,path:'large.txt'})).error.code,'FILE_TOO_LARGE');
  await fs.link(path.join(base,'folder','note.txt'),path.join(base,'hardlink.txt'));
  assert.equal((await index.readFile({rootId:root.id,path:'hardlink.txt'})).ok,false);
  const moved=base+'-original';await fs.rename(base,moved);await fs.mkdir(base);
  t.after(()=>fs.rm(moved,{recursive:true,force:true}));
  assert.equal((await index.listChildren({rootId:root.id,path:''})).ok,false);
});

test('links cannot be used to escape a selected directory',async t=>{
  const base=await fixture(t), index=createMaterialIndex();
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-project-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.writeFile(path.join(outside,'private.txt'),'secret');
  await fs.symlink(outside,path.join(base,'shortcut'),'junction');
  const root=(await index.addRoot({path:base,kind:'directory'})).value.root;
  const listed=await index.listChildren({rootId:root.id,path:''});assert.equal(listed.value.entries.some(e=>e.name==='shortcut'),false);
  assert.equal((await index.readFile({rootId:root.id,path:'shortcut/private.txt'})).ok,false);
  assert.equal((await index.addRoot({path:path.join(base,'shortcut'),kind:'directory'})).ok,false);
});

test('default project directory requires a verified saved rvt and switches without erasing user roots',async t=>{
  const first=await fixture(t), second=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-next-project-'));t.after(()=>fs.rm(second,{recursive:true,force:true}));
  await fs.writeFile(path.join(second,'next.rvt'),'fixture');
  const index=createMaterialIndex(), user=(await index.addRoot({path:path.join(first,'folder'),kind:'directory'})).value.root;
  assert.equal((await index.setProjectDocument({documentPath:''})).value.projectStatus,'unsaved');
  const one=await index.setProjectDocument({documentPath:path.join(first,'document.rvt')});assert.equal(one.value.projectStatus,'available');
  const again=await index.setProjectDocument({documentPath:path.join(first,'document.rvt')});assert.equal(again.value.root.id,one.value.root.id);
  const two=await index.setProjectDocument({documentPath:path.join(second,'next.rvt')});assert.notEqual(two.value.root.id,one.value.root.id);
  assert.equal((await index.listChildren({rootId:one.value.root.id,path:''})).ok,false);
  assert.equal(index.listRoots().value.roots.some(root=>root.id===user.id),true);
  assert.equal((await index.setProjectDocument({documentPath:path.join(second,'missing.rvt')})).value.projectStatus,'unavailable');
  assert.equal(index.listRoots().value.roots.some(root=>root.source==='project'),false);
});

test('restored missing addresses stay visible and removable but never grant reads',async t=>{
  const base=await fixture(t),missingFile=path.join(base,'gone.txt'),missingFolder=path.join(base,'gone-folder');
  const index=createMaterialIndex(),file=await index.restoreRoot({path:missingFile,kind:'file'}),folder=await index.restoreRoot({path:missingFolder,kind:'directory'});
  assert.equal(file.ok,true);assert.equal(file.value.root.status,'unavailable');assert.equal(folder.value.root.status,'unavailable');
  assert.equal((await index.readFile({rootId:file.value.root.id,path:''})).ok,false);
  assert.equal((await index.listChildren({rootId:folder.value.root.id,path:''})).ok,false);
  assert.equal((await index.restoreRoot({path:missingFile,kind:'file'})).value.root.id,file.value.root.id);
  assert.equal(index.listRoots().value.roots.length,2);
  assert.equal(index.removeRoot({id:folder.value.root.id}).ok,true);assert.equal(index.listRoots().value.roots.length,1);
  await fs.writeFile(missingFile,'available again');
  const restored=await index.addRoot({path:missingFile,kind:'file'});
  assert.equal(restored.ok,true);assert.equal(restored.value.restored,true);assert.equal(restored.value.root.id,file.value.root.id);assert.equal(restored.value.root.status,'available');
  assert.equal((await index.readFile({rootId:file.value.root.id,path:''})).value.text,'available again');
  assert.equal(index.removeRoot({id:file.value.root.id}).ok,true);assert.equal(await fs.readFile(missingFile,'utf8'),'available again');
  assert.equal((await index.restoreRoot({path:'relative',kind:'file'})).ok,false);
});

test('a restored address is not read authority until the user explicitly selects it',async t=>{
  const base=await fixture(t),file=path.join(base,'folder','note.txt'),index=createMaterialIndex();
  const candidate=await index.restoreRoot({path:file,kind:'file'});assert.equal(candidate.ok,true);assert.equal(candidate.value.root.status,'needs-confirmation');
  const directory=await index.restoreRoot({path:base,kind:'directory'});assert.equal(directory.value.root.status,'needs-confirmation');
  assert.equal((await index.readFile({rootId:candidate.value.root.id,path:''})).ok,false);
  assert.equal((await index.listChildren({rootId:directory.value.root.id,path:''})).ok,false);
  assert.equal((await index.restoreRoot({path:file,kind:'file'})).value.root.status,'needs-confirmation');
  const confirmed=await index.addRoot({path:file,kind:'file'});assert.equal(confirmed.value.root.id,candidate.value.root.id);assert.equal(confirmed.value.root.status,'available');
  assert.match((await index.readFile({rootId:candidate.value.root.id,path:''})).value.text,/line 2/);
  assert.equal((await index.restoreRoot({path:file,kind:'file'})).value.root.status,'available');
  assert.equal(index.removeRoot({id:directory.value.root.id}).ok,true);
});

test('bounded listing reports truncation and user roots stay in current owner only',async t=>{
  const base=await fixture(t), index=createMaterialIndex({maxEntries:1});
  const root=(await index.addRoot({path:base,kind:'directory'})).value.root;
  const listed=await index.listChildren({rootId:root.id,path:''});assert.equal(listed.value.entries.length,1);assert.equal(listed.value.truncated,true);
  assert.equal(createMaterialIndex().listRoots().value.roots.length,0);
  assert.equal(index.removeRoot({id:'missing'}).ok,false);
});

test('directory pages cover a stable total order and reject changed or foreign cursors',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-pages-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  for(const name of ['Z-last.txt','a-first.txt','汉字.txt','é.txt','e\u0301.txt'])await fs.writeFile(path.join(base,name),'fixture');
  await fs.mkdir(path.join(base,'folder-a'));await fs.mkdir(path.join(base,'folder-b'));
  const index=createMaterialIndex({maxEntries:2}),root=(await index.addRoot({path:base,kind:'directory'})).value.root;
  const all=[];let cursor=null,firstCursor=null;
  do{
    const result=await index.listChildren({rootId:root.id,path:'',cursor});assert.equal(result.ok,true,JSON.stringify(result));
    all.push(...result.value.entries);cursor=result.value.nextCursor;
    if(!firstCursor&&cursor)firstCursor=cursor;
    assert.equal(result.value.truncated,cursor!==null);
  }while(cursor);
  const expected=['folder-a','folder-b',...['Z-last.txt','a-first.txt','汉字.txt','é.txt','e\u0301.txt'].sort()];
  assert.deepEqual(all.map(item=>item.name),expected);
  assert.equal((await index.listChildren({rootId:root.id,path:'folder-a',cursor:firstCursor})).error.code,'INVALID_CURSOR');
  const again=await index.listChildren({rootId:root.id,path:'',cursor:firstCursor});assert.equal(again.ok,true);
  await fs.writeFile(path.join(base,'new.txt'),'new');
  assert.equal((await index.listChildren({rootId:root.id,path:'',cursor:firstCursor})).error.code,'DIRECTORY_CHANGED');
  assert.equal((await index.listChildren({rootId:root.id,path:'',cursor:'missing'})).error.code,'INVALID_CURSOR');
});

test('page byte budgets remain bounded even with many long filenames',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'buildx-library-bytepages-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  for(let i=0;i<360;i++)await fs.writeFile(path.join(base,`${String(i).padStart(3,'0')}-${'x'.repeat(90)}.txt`),'');
  const index=createMaterialIndex({maxEntries:500}),root=(await index.addRoot({path:base,kind:'directory'})).value.root;
  let cursor=null,count=0,pages=0;
  do{
    const result=await index.listChildren({rootId:root.id,path:'',cursor});assert.equal(result.ok,true,JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result.value.entries))<=32*1024+1);
    count+=result.value.entries.length;cursor=result.value.nextCursor;pages++;
  }while(cursor);
  assert.equal(count,360);assert.ok(pages>1);
});

test('bounded images are returned only with verified image signatures',async t=>{
  const base=await fixture(t);
  const script=`from PIL import Image\nimport sys\nfrom pathlib import Path\np=Path(sys.argv[1])\nfor suffix,format in [('png','PNG'),('jpg','JPEG'),('gif','GIF'),('webp','WEBP')]:\n Image.new('RGB',(2,2),(12,34,56)).save(p/('tiny.'+suffix),format=format)\n`;
  await execFileAsync('python',['-c',script,base]);
  await fs.writeFile(path.join(base,'not-image.png'),Buffer.from([0,1,2,3]));
  const index=createMaterialIndex(), id=(await index.addRoot({path:base,kind:'directory'})).value.root.id;
  for(const [suffix,mime] of [['png','image/png'],['jpg','image/jpeg'],['gif','image/gif'],['webp','image/webp']]){
    const result=await index.readFile({rootId:id,path:`tiny.${suffix}`});
    assert.equal(result.ok,true);assert.equal(result.value.kind,'image');assert.equal(result.value.mimeType,mime);
    assert.equal(result.value.data,`data:${mime};base64,${(await fs.readFile(path.join(base,`tiny.${suffix}`))).toString('base64')}`);
  }
  assert.equal((await index.readFile({rootId:id,path:'not-image.png'})).error.code,'FILE_NOT_TEXT');
});

test('fixed parser extracts bounded office and PDF text, never PDF script',async t=>{
  const base=await fixture(t);
  const script=`
import sys, zipfile
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'brief.docx','w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Design height</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(p/'rooms.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rooms" sheetId="1" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Office</t></is></c></row></sheetData></worksheet>')
writer=PdfWriter(); page=writer.add_blank_page(width=200,height=200)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
stream=DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 10 100 Td (Room height) Tj ET'); page[NameObject('/Contents')]=writer._add_object(stream)
writer.add_js("app.alert('should not run')")
with open(p/'notes.pdf','wb') as f: writer.write(f)
blank=PdfWriter(); blank.add_blank_page(width=200,height=200)
with open(p/'blank.pdf','wb') as f: blank.write(f)
`;
  await execFileAsync('python',['-c',script,base]);
  const index=createMaterialIndex(), id=(await index.addRoot({path:base,kind:'directory'})).value.root.id;
  for(const [file,format,expected] of [['brief.docx','docx','Design height'],['rooms.xlsx','xlsx','Rooms A1: Office'],['notes.pdf','pdf','Room height']]){
    const read=await index.readFile({rootId:id,path:file});assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.value.kind,'text');assert.equal(read.value.sourceFormat,format);assert.match(read.value.text,new RegExp(expected));assert.equal(read.value.truncated,false);
  }
  const blank=await index.readFile({rootId:id,path:'blank.pdf'});assert.equal(blank.ok,true);assert.ok(blank.value.warnings.includes('PDF_NO_EXTRACTABLE_TEXT'));
  const unavailable=createMaterialIndex({pythonExecutable:path.join(base,'does-not-exist')});
  const unavailRoot=(await unavailable.addRoot({path:base,kind:'directory'})).value.root.id;
  assert.equal((await unavailable.readFile({rootId:unavailRoot,path:'brief.docx'})).error.code,'PARSER_UNAVAILABLE');
});
