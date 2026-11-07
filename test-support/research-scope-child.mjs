import {createResearchScopeOwner} from '../lib/research-scope-owner.mjs';
const [root,id]=process.argv.slice(2);
const owner=createResearchScopeOwner(root,async()=>false);
await owner.reserve({document:'session/document',operation:'batch'},id,Buffer.from('request'));
process.send('reserved');setInterval(()=>{},1000);
