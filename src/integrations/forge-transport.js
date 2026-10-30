import https from 'node:https';
import tls from 'node:tls';
import {capabilityError} from '../capability/types.js';

/** Trusted transport injection lets tests use real TLS without permitting caller supplied hosts. */
export function createForgeTransport({requestImpl=https.request,timeoutMs=10000,maxResponseBytes=512*1024}={}) {
  if(typeof requestImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000
    ||!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>1024*1024)throw capabilityError('FORGE_INVALID_CONFIG','Invalid Forge transport limits');
  // Windows enterprise gateways may chain to an OS-trusted CA. Use the normal
  // system trust store as well as bundled roots; hostname/TLS checks stay on.
  const trustedCa=process.platform==='win32'&&typeof tls.getCACertificates==='function'
    ?[...tls.getCACertificates('default'),...tls.getCACertificates('system')]:undefined;
  return (url,{method='GET',body,secret,signal,deadline}={})=>new Promise((resolve,reject)=>{
    if(!(url instanceof URL)||!['https://api.github.com','https://api.gitcode.com'].includes(url.origin)
      ||url.username||url.password||url.hash||url.searchParams.has('access_token'))return reject(capabilityError('FORGE_ENDPOINT_DENIED','Official Forge HTTPS endpoint required'));
    if(signal?.aborted)return reject(capabilityError('FORGE_ABORTED','Forge request cancelled'));
    let request,response,timer,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(error){response?.destroy();request?.destroy();reject(error);}else resolve(value);};
    const onAbort=()=>finish(capabilityError('FORGE_ABORTED','Forge request cancelled'));
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>finish(capabilityError('FORGE_TIMEOUT','Forge request timed out')),Math.max(1,Math.min(timeoutMs,typeof deadline==='number'?deadline-Date.now():timeoutMs)));
    const payload=body===undefined?null:JSON.stringify(body);
    if(payload&&Buffer.byteLength(payload)>32768)return finish(capabilityError('FORGE_INVALID_INPUT','Forge request body exceeds its limit'));
    try {
      request=requestImpl(url,{method,rejectUnauthorized:true,servername:url.hostname,...(trustedCa?{ca:trustedCa}:{}),headers:{accept:'application/json','accept-encoding':'identity','user-agent':'CetaMesh',
        ...(url.hostname==='api.github.com'?{'x-github-api-version':'2022-11-28'}:{}),
        ...(secret?{authorization:`Bearer ${secret}`} : {}),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},incoming=>{
        response=incoming;incoming.on('error',()=>finish(capabilityError('FORGE_NETWORK_ERROR','Forge response interrupted')));
        if(incoming.statusCode>=300&&incoming.statusCode<400)return finish(capabilityError('FORGE_REDIRECT_DENIED','Forge redirects are not allowed'));
        if(incoming.statusCode<200||incoming.statusCode>=300)return finish(capabilityError('FORGE_HTTP_ERROR',`Forge returned HTTP ${Number(incoming.statusCode)||0}`));
        if(incoming.statusCode===204){incoming.resume();return finish(null,null);}
        if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(incoming.headers['content-type']??'')
          ||(incoming.headers['content-encoding']&&incoming.headers['content-encoding']!=='identity'))return finish(capabilityError('FORGE_RESPONSE_INVALID','Forge JSON response required'));
        if(Number(incoming.headers['content-length'])>maxResponseBytes)return finish(capabilityError('FORGE_RESPONSE_TOO_LARGE','Forge response exceeds its limit'));
        const chunks=[];let bytes=0;
        incoming.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxResponseBytes)return finish(capabilityError('FORGE_RESPONSE_TOO_LARGE','Forge response exceeds its limit'));chunks.push(chunk);});
        incoming.on('end',()=>{if(settled)return;try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish(capabilityError('FORGE_RESPONSE_INVALID','Forge returned invalid JSON'));}});
      });
      request.on('error',error=>finish(capabilityError(/CERT|VERIFY|ISSUER|SIGNATURE/.test(String(error?.code??''))?'FORGE_TLS_UNTRUSTED':'FORGE_NETWORK_ERROR','Forge request failed')));
      if(payload)request.write(payload);request.end();
    }catch{finish(capabilityError('FORGE_NETWORK_ERROR','Forge request failed'));}
  });
}
