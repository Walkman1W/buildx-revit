import fs from 'node:fs';import path from 'node:path';import {captureRecovery} from '../lib/research-recovery-adapter.mjs';import {createResearchScopeOwner} from '../lib/research-scope-owner.mjs';
const [root,id,stage]=process.argv.slice(2),q=path.join(root,'queue'),tmp=path.join(q,'inbox',id+'.tmp'),payload=fs.readFileSync(tmp),host=JSON.parse(fs.readFileSync(path.join(q,'host.json'))),source=JSON.parse(fs.readFileSync(path.join(root,'source.json')));
await createResearchScopeOwner(root,async()=>false).reserve({document:source.path,operation:'bind_existing_project_parameter'},id,payload);
if(stage==='reserved')process.exit(0);
captureRecovery({queue:q,preparedPath:tmp,id,host,operation:'bind_existing_project_parameter',version:1,recordPath:path.join(root,'record.json'),sourceDocument:source});
if(stage==='prepared')process.exit(0);
fs.renameSync(tmp,path.join(q,'inbox',id+'.json'));process.exit(0);
