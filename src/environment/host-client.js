import net from 'node:net';
import crypto from 'node:crypto';
import {startIpcProtocol} from '../control/ipc-protocol.js';
import {environmentError} from './contracts.js';
const methods=new Set(['environment.profiles','environment.preflight','environment.run','environment.status','environment.cancel']);
function validateEndpoint(pipe,token) {
 if(typeof pipe!=='string' || (process.platform==='win32'?!/^\\\\\.\\pipe\\CetaMeshEnvironment-[a-zA-Z0-9-]+$/.test(pipe):!pipe.startsWith('/')) || !/^[0-9a-f]{64}$/.test(token || ''))throw environmentError('ENV_HOST_CONFIG_INVALID','Private local pipe and 256-bit token required');
}
export async function listenEnvironmentHost({pipe,token,host}) {
 validateEndpoint(pipe,token);const sockets=new Set();
 const server=net.createServer(socket=>{
  if(sockets.size>=8){socket.destroy();return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  startIpcProtocol({input:socket,output:socket,dispatchTimeoutMs:3660000,maxFrameBytes:1048576,
   authenticate:r=>r.role==='environment-core' && typeof r.authToken==='string' && /^[0-9a-f]{64}$/.test(r.authToken) && crypto.timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(r.authToken,'hex')),
   methodFilter:m=>methods.has(m),dispatch:({method,params},{signal})=>{
    if(method==='environment.profiles')return host.profiles();
    if(method==='environment.preflight')return host.preflight(params.profileId);
    if(method==='environment.run')return host.run(params.binding,{signal});
    if(method==='environment.cancel')return host.cancel(params.binding);
    return host.status(params.binding);
   }}).done.catch(()=>socket.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
 return {close:()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(resolve);})};
}
export function createEnvironmentHostClient({pipe,token}) {
 validateEndpoint(pipe,token);
 function call(method,params={}, {signal}={}) {
  return new Promise((resolve,reject)=>{
   if(signal?.aborted)return reject(environmentError('ENV_CANCELLED','Request cancelled before dispatch'));
   const socket=net.createConnection(pipe),id=crypto.randomUUID();let buffer=Buffer.alloc(0),settled=false;
   const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(result);};
   const abort=()=>finish(environmentError('ENV_HOST_DISCONNECTED','Cancelled Host request; effects require reconciliation'));
   const timer=setTimeout(()=>finish(environmentError('ENV_HOST_TIMEOUT','Host reply not confirmed')),method==='environment.run'?3660000:35000);
   signal?.addEventListener('abort',abort,{once:true});
   socket.once('connect',()=>{const body=Buffer.from(JSON.stringify({version:1,id,method,params,role:'environment-core',authToken:token}));if(body.length>1048576)return finish(environmentError('ENV_SCHEMA_INVALID','Request too large'));const frame=Buffer.alloc(4+body.length);frame.writeUInt32LE(body.length);body.copy(frame,4);socket.write(frame);});
   socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>1048580)return finish(environmentError('ENV_HOST_PROTOCOL','Response too large'));
    while(buffer.length>=4 && !settled) {
     const size=buffer.readUInt32LE(0);
     if(size>1048576)return finish(environmentError('ENV_HOST_PROTOCOL','Response frame too large'));
     if(buffer.length<size+4)return;
     const body=buffer.subarray(4,4+size);buffer=buffer.subarray(4+size);
     try {
      const r=JSON.parse(body);
      if(r.version===1 && r.event==='core.ready')continue;
      if(r.id!==id||r.version!==1)throw new Error('foreign frame');
      if(r.ok!==true)return finish(environmentError(r.error?.code || 'ENV_HOST_FAILED',r.error?.message || 'Host failed'));
      finish(null,r.result);
     }catch{finish(environmentError('ENV_HOST_PROTOCOL','Invalid response'));}
    }
   });
   socket.once('error',()=>finish(environmentError('ENV_HOST_UNAVAILABLE','Private environment Host unavailable')));
   socket.once('close',()=>{if(!settled)finish(environmentError('ENV_HOST_DISCONNECTED','Host disconnected; effects require reconciliation'));});
  });
 }
 return {profiles:()=>call('environment.profiles'),preflight:profileId=>call('environment.preflight',{profileId}),run:(binding,options)=>call('environment.run',{binding},options),status:binding=>call('environment.status',{binding}),cancel:binding=>call('environment.cancel',{binding})};
}
