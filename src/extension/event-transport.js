import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import {resolveSafeHost} from '../safe-fetch.js';
import {validateSchema} from '../model/input-schema.js';
import {extensionError} from './types.js';

const MAX_BYTES=65536, FRESH_MS=300000;
function unknown(code,message){return Object.assign(extensionError(code,message),{effectStatus:'unknown'});}
export function validateEventRequest(input){
 const url=new URL(String(input?.url));
 if(!['websocket','webhook'].includes(input.transport)||url.username||url.password||url.hash
   ||!/^plugin-[a-z0-9][a-z0-9._-]{0,55}$/.test(input.credentialRef??'')
   ||!Number.isInteger(input.limit)||input.limit<1||input.limit>20
   ||!Number.isInteger(input.timeoutMs)||input.timeoutMs<100||input.timeoutMs>60000
   ||input.responseSchema?.type!=='object')throw extensionError('EVENT_PLUGIN_INVALID','Bounded event endpoint required');
 if(input.transport==='websocket'){
  if(url.protocol!=='https:'||!input.subscription||Object.keys(input.subscription).join(',')!=='topic'
   ||typeof input.subscription.topic!=='string'||!input.subscription.topic||input.subscription.topic.length>128)
   throw extensionError('EVENT_PLUGIN_INVALID','Secure explicit event subscription required');
 }else if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1024||url.search||url.pathname==='/')
  throw extensionError('EVENT_PLUGIN_INVALID','Webhook must bind one explicit unprivileged loopback port and path');
 return url;
}
function checkedEvent(raw,input){
 let event;try{event=JSON.parse(String(raw));}catch{throw extensionError('EVENT_SCHEMA_INVALID','Invalid event JSON');}
 if(!event||event.protocolVersion!==1||typeof event.id!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(event.id)
   ||!Number.isSafeInteger(event.timestamp)||Math.abs(Date.now()-event.timestamp)>FRESH_MS)
  throw extensionError('EVENT_AUTH_FAILED','Event identity or freshness invalid');
 validateSchema(input.responseSchema,event.data);
 return {id:event.id,timestamp:event.timestamp,data:event.data};
}
/** Bounded protocol adapter. Only receives events; callbacks never acquire Task execution authority. */
export async function executeEventTransport(input,{signal,secret,WebSocketImpl=WebSocket}={}){
 const url=validateEventRequest(input);
 if(typeof secret!=='string'||secret.length<16||secret.length>4096||/[\r\n]/.test(secret))throw extensionError('NETWORK_CREDENTIAL_UNAVAILABLE','Dedicated event credential required');
 signal?.throwIfAborted();
 const pinned=input.transport==='websocket'?await resolveSafeHost(url.hostname):null;
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const events=[],seen=new Set();let finished=false,socket,server,reconnectTimer,attempts=0;
  const redact=result=>JSON.parse(JSON.stringify(result).replaceAll(secret,'[REDACTED]'));
  const finish=(error)=>{
   if(finished)return;finished=true;clearTimeout(timer);clearTimeout(reconnectTimer);signal?.removeEventListener('abort',onAbort);
   if(socket){socket.removeAllListeners('open');socket.removeAllListeners('message');socket.terminate();}
   if(server){server.closeAllConnections();server.close();}
   if(error)reject(error);else resolve(redact({protocolVersion:1,events}));
  };
  const onAbort=()=>finish(unknown('INVOKE_CANCEL_UNCONFIRMED','Event subscription cancelled; received effects may need review'));
  const timer=setTimeout(()=>finish(unknown('INVOKE_TIMEOUT','Event subscription timed out')),input.timeoutMs);
  signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){onAbort();return;}
  const accept=event=>{if(seen.has(event.id))return false;seen.add(event.id);events.push(event);return true;};
  if(input.transport==='websocket'){
   const connect=()=>{
    if(finished)return;attempts++;
    const target=new URL(url);target.protocol='wss:';
    try{socket=new WebSocketImpl(target.href,{headers:{authorization:'Bearer '+secret},followRedirects:false,rejectUnauthorized:true,
      maxPayload:MAX_BYTES,handshakeTimeout:Math.min(5000,input.timeoutMs),servername:url.hostname,
      lookup:(_host,options,callback)=>callback(null,options?.all?[{address:pinned,family:net.isIP(pinned)}]:pinned,net.isIP(pinned))});}
    catch{finish(extensionError('EVENT_CONNECTION_FAILED','Event connection could not start'));return;}
    socket.on('error',()=>{});
    socket.once('unexpected-response',()=>finish(extensionError('EVENT_AUTH_FAILED','Event endpoint rejected authentication or attempted redirect')));
    socket.once('open',()=>{if(!finished)socket.send(JSON.stringify({type:'subscribe',protocolVersion:1,topic:input.subscription.topic,after:events.at(-1)?.id??null}));});
    socket.on('message',raw=>{
     if(finished)return;
     try{if(Buffer.byteLength(raw)>MAX_BYTES)throw extensionError('EVENT_SCHEMA_INVALID','Event too large');const event=checkedEvent(raw,input);accept(event);if(events.length>=input.limit)finish();}
     catch(error){finish(error);}
    });
    socket.once('close',code=>{
     if(finished)return;if(code===1008){finish(extensionError('EVENT_AUTH_FAILED','Subscription denied'));return;}
     if(attempts>=3){finish(unknown('EVENT_CONNECTION_LOST','Event connection recovery exhausted'));return;}
     reconnectTimer=setTimeout(connect,50*attempts);
    });
   };connect();
  }else{
   server=http.createServer((request,response)=>{
    const respond=(status)=>{response.writeHead(status,{'connection':'close'});response.end();};
    if(request.method!=='POST'||request.url!==url.pathname||request.headers.host!==url.host){respond(405);return;}
    if(request.headers['content-type']?.split(';')[0]!=='application/json'){respond(415);return;}
    let bytes=0;const chunks=[];
    request.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES){respond(413);request.destroy();}else chunks.push(chunk);});
    request.on('error',()=>{});
    request.on('end',()=>{
     if(finished||bytes>MAX_BYTES)return;
     const raw=Buffer.concat(chunks),provided=request.headers['x-cetamesh-signature'];
     const expected=crypto.createHmac('sha256',secret).update(raw).digest();
     if(typeof provided!=='string'||!/^[a-f0-9]{64}$/.test(provided)||!crypto.timingSafeEqual(Buffer.from(provided,'hex'),expected)){respond(403);return;}
     let event;try{event=checkedEvent(raw,input);}catch{respond(403);return;}
     if(!accept(event)){respond(409);return;}
     if(events.length>=input.limit)response.once('finish',()=>finish());
     respond(202);
    });
   });
   server.requestTimeout=Math.min(input.timeoutMs,10000);server.headersTimeout=Math.min(input.timeoutMs,10000);
   server.on('error',()=>finish(extensionError('EVENT_LISTENER_UNAVAILABLE','The reviewed callback port is unavailable')));
   server.listen(Number(url.port),'127.0.0.1');
  }
 });
}
