// Controlled peer: no Revit, service, or network port. The JSON PID is
// deliberately false; the server must use the kernel pipe identity.
import net from 'node:net';
const [mode,name]=process.argv.slice(2);
if(mode==='idle')setInterval(()=>{},1000);
else if(mode==='connect'){
 const socket=net.createConnection('\\\\.\\pipe\\'+name);
 socket.on('connect',()=>socket.write(JSON.stringify({claimedPid:1})+'\n'));
 socket.on('data',()=>socket.end());
 socket.on('error',()=>process.exitCode=1);
}else process.exitCode=2;
