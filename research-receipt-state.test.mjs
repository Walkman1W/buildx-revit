import {test} from 'node:test';
import assert from 'node:assert/strict';
import {begin,published,recover} from './lib/research-receipt-state.mjs';
const id='a'.repeat(32), digest='b'.repeat(64);
test('published request remains unknown after timeout or restart without receipt',()=>{
 const original=published(begin(id,digest));
 const recovered=JSON.parse(JSON.stringify(original));
 assert.deepEqual(recover(recovered,null),original);
 assert.throws(()=>published(recovered));
});
test('tampered, unauthenticated and nonterminal receipts do not resolve',()=>{
 const state=published(begin(id,digest));
 for(const receipt of [{requestId:'c'.repeat(32),digest,authenticated:true,outcome:'committed'},{requestId:id,digest:'c'.repeat(64),authenticated:true,outcome:'committed'},{requestId:id,digest,authenticated:false,outcome:'committed'},{requestId:id,digest,authenticated:true,outcome:'pending'}]) assert.deepEqual(recover(state,receipt),state);
});
test('only the matching authenticated terminal receipt resolves once',()=>{
 const state=published(begin(id,digest));
 const terminal=recover(state,{requestId:id,digest,authenticated:true,outcome:'committed'});
 assert.equal(terminal.state,'committed');
 assert.throws(()=>recover(terminal,{requestId:id,digest,authenticated:true,outcome:'committed'}));
});
