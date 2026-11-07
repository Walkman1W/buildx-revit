import fs from 'node:fs';import path from 'node:path';import {captureRecovery} from '../lib/research-recovery-adapter.mjs';
const [root,id]=process.argv.slice(2),queue=path.join(root,'queue'),tmp=path.join(queue,'inbox',id+'.tmp'),host={sessionId:'host',pid:123};
captureRecovery({queue,preparedPath:tmp,id,host,operation:'research.synthetic.write',version:1,recordPath:path.join(root,'record.json')});
fs.renameSync(tmp,path.join(queue,'inbox',id+'.json'));process.send('published');setInterval(()=>{},1000);
