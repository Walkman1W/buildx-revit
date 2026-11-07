// Standalone test peer. Only the addon owns the Win32 file handle.
import net from 'node:net';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const [name,file,addon,requestId]=process.argv.slice(2);const bridge=createRequire(import.meta.url)(addon);
const handle=bridge.create(file,false);if(typeof handle!=='bigint'||handle<=0n)process.exit(2);
const socket=net.createConnection('\\\\.\\pipe\\'+name);socket.on('connect',()=>socket.write(handle.toString(16)+(requestId?'|'+requestId+'|'+createHash('sha256').update('identical controlled request').digest('hex'):'')+'\n'));
socket.on('data',data=>{if(data.toString().trim()==='position')socket.write(bridge.position(handle).toString()+'\n');});socket.on('error',()=>process.exitCode=1);
