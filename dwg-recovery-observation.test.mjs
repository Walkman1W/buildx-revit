import test from 'node:test';
import assert from 'node:assert/strict';
import {stagedExportJournal, advanceExportJournal} from './lib/dwg-export-journal.mjs';
import {compareOriginalExportObservation as compare} from './lib/dwg-recovery-observation.mjs';

const id='12345678-1234-4234-8234-123456789abc', hash='a'.repeat(64);
const plan={request_id:id,host_session:'host',document_id:'doc',view_id:'1',stage_id:id,stage_directory_identity:'stage',destination_path:'C:\\test',destination_directory_identity:'dir',selection_id:id,files:[{name:'drawing.dwg',source_identity:'src',sha256:hash,bytes:5}]};
function next(r,kind,extra={}) {return advanceExportJournal(r,{kind,revision:r.revision,digest:r.digest,...extra},{now:1});}
const staged=stagedExportJournal(plan), approved=next(staged,'approve',{deadline:100}), inflight=next(approved,'start_file',{index:0});
const complete=next(inflight,'finish_file',{index:0,status:'published',target_identity:'target',target_created:true});
const observation={request_id:id,digest:complete.digest,revision:complete.revision,directory_identity:'dir',files:[{name:'drawing.dwg',identity:'target',bytes:5,sha256:hash,regular_file:true,single_link:true}]};
test('matching observation is only an untrusted readback, never permission',()=>assert.deepEqual(compare(complete,observation),{outcome:'observed_match',reason:'untrusted_observation_only',mayReplay:false,mayPublish:false}));
test('missing, stale, conflicting, or incomplete evidence fails closed',()=>{
  const variants=[null,{...observation,request_id:'other'},{...observation,digest:'b'.repeat(64)},{...observation,revision:0},{...observation,directory_identity:'other'},{...observation,files:[]},{...observation,files:[...observation.files,observation.files[0]]},...['name','identity','bytes','sha256','regular_file','single_link'].map(k=>({...observation,files:[{...observation.files[0],[k]:null}]}))];
  for(const item of variants) assert.equal(compare(complete,item).outcome,'unconfirmed');
  for(const record of [staged,approved,inflight,next(inflight,'interrupt'),null]) assert.equal(compare(record,observation).outcome,'unconfirmed');
});
