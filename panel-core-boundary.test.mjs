import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPanelServerCore} from './lib/panel-server-core.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import {panelProfile} from './lib/panel-profile.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
class FakeCodex extends EventEmitter{
  constructor(kind='model'){
    super();this.state={ready:true,error:false,message:'construction fixture',
      mode:kind==='model'?'document-workbench':'source-development'};
    this.closes=0;this.executionCalls=0;
  }
  async close(){this.closes++;return {closed:true};}
  async start(){this.executionCalls++;throw new Error('No Codex start permitted');}
  async newThread(){this.executionCalls++;throw new Error('No Codex thread permitted');}
  async turn(){this.executionCalls++;throw new Error('No Codex turn permitted');}
}
function options(codex,selection){
  return {root,codex,selection,port:0,invokeWorkbench:async()=>{
    codex.executionCalls++;throw new Error('No model call permitted');
  }};
}
function assertRejected(selection){
  const codex=new FakeCodex();
  assert.throws(()=>createPanelServerCore(options(codex,selection)),/composition/);
  assert.equal(codex.executionCalls,0);
  assert.equal(codex.closes,0);
  assert.deepEqual(codex.eventNames(),[]);
}

test('real model and source compositions construct and close without listening or execution',async()=>{
  for(const kind of ['model','source-development']){
    const codex=new FakeCodex(kind),selection=panelProfile(kind);
    const app=createPanelServerCore(options(codex,selection));
    try{
      assert.equal(app.server.listening,false);
      assert.deepEqual(app.snapshot('construction-client').workspace,selection.workspace);
      assert.equal(codex.executionCalls,0);
      assert.ok(codex.listenerCount('notification')>0);
    }finally{
      assert.deepEqual(await app.close(),{closed:true});
    }
    assert.equal(codex.closes,1);
    assert.equal(codex.executionCalls,0);
    assert.deepEqual(codex.eventNames(),[]);
  }
});

test('frozen unknown kind and inconsistent model-context pairings fail before resource ownership',()=>{
  const base=panelProfile('model');
  for(const workspace of [
    {kind:'customer-other',supportsModelContext:true},
    {kind:'model',supportsModelContext:false},
    {kind:'source-development',supportsModelContext:true},
  ])assertRejected(Object.freeze({...base,workspace:Object.freeze(workspace)}));
});

test('a frozen catalog index accessor is rejected without executing its getter',()=>{
  let getterCalls=0;
  const catalog=[];
  Object.defineProperty(catalog,'0',{enumerable:true,configurable:false,
    get(){getterCalls++;return panelProfile('model').catalog[0];}});
  Object.freeze(catalog);
  assertRejected(Object.freeze({...panelProfile('model'),catalog}));
  assert.equal(getterCalls,0);
});

test('mutable top-level composition, workspace and session notices are rejected',()=>{
  const model=panelProfile('model'),source=panelProfile('source-development');
  assertRejected({...model});
  assertRejected(Object.freeze({...model,workspace:{...model.workspace}}));
  assertRejected(Object.freeze({...source,sessionNotices:{...source.sessionNotices}}));
});

test('the old wrapper resolves its named profile instead of accepting options.selection',async()=>{
  for(const kind of ['model','source-development']){
    const codex=new FakeCodex(kind),other=kind==='model'?'source-development':'model';
    const app=createPanelServer({...options(codex,panelProfile(other)),profile:kind});
    try{
      assert.equal(app.server.listening,false);
      assert.deepEqual(app.snapshot('wrapper-client').workspace,panelProfile(kind).workspace);
      assert.equal(codex.executionCalls,0);
    }finally{
      assert.deepEqual(await app.close(),{closed:true});
    }
    assert.equal(codex.closes,1);
    assert.deepEqual(codex.eventNames(),[]);
  }
});
