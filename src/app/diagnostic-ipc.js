// Read-only authenticated ping over the same native transport used by Desktop.
import net from 'node:net';
import crypto from 'node:crypto';
const fault=code=>Object.assign(new Error(code),{code});
export function probeNativeIpc({pipeName,token,timeoutMs=1000}={}){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(pipeName),id='diagnostics-'+crypto.randomUUID();let pending=Buffer.alloc(0),sent=false;
  const timer=setTimeout(()=>finish(fault('CHECK_TIMEOUT')),timeoutMs);
  function finish(error){clearTimeout(timer);socket.removeAllListeners();socket.on('error',()=>{});socket.destroy();error?reject(error):resolve(true);}
  socket.on('error',finish);socket.on('close',()=>finish(fault('IPC_DISCONNECTED')));
  socket.on('data',data=>{
   pending=Buffer.concat([pending,data]);if(pending.length>1024*1024+4){finish(fault('IPC_FRAME_INVALID'));return;}
   while(pending.length>=4){const len=pending.readUInt32LE(0);if(len>1024*1024){finish(fault('IPC_FRAME_INVALID'));return;}if(pending.length<len+4)return;
    let value;try{value=JSON.parse(pending.subarray(4,len+4).toString('utf8'));}catch(e){finish(e);return;}pending=pending.subarray(len+4);
    if(!sent){if(value.version!==1||value.event!=='core.ready'){finish(fault('IPC_HANDSHAKE_INVALID'));return;}
     sent=true;const bytes=Buffer.from(JSON.stringify({version:1,id,method:'core.ping',role:'console',authToken:token,params:{}}));const frame=Buffer.alloc(bytes.length+4);frame.writeUInt32LE(bytes.length);bytes.copy(frame,4);socket.write(frame);
    }else if(value.id===id){finish(value.version===1&&value.ok===true&&value.result?.status==='pong'?null:fault(['IPC_AUTH_DENIED','UNSUPPORTED_VERSION'].includes(value.error?.code)?value.error.code:'IPC_HANDSHAKE_INVALID'));return;}
   }
  });
 });
}
