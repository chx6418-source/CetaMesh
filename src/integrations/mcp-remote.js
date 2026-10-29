import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {safeHttpResponse} from '../safe-fetch.js';
import {integrationError} from './types.js';

/** Official remote MCP framing over Core's pinned HTTPS transport. */
export async function createRemoteMcpConnection(server,config={}, {resolveCredential,networkOptions={}}={}) {
 let url;
 try { url=new URL(config.url??server.url); } catch { throw integrationError('MCP_CONFIG_INVALID','Configure an HTTPS MCP endpoint'); }
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw integrationError('MCP_CONFIG_INVALID','MCP endpoint must use HTTPS without credentials, query or fragment');
 const timeoutMs=Math.min(600000,Math.max(100,config.timeoutMs??30000));
 if(!Array.isArray(config.allowedTools)||!config.allowedTools.length||config.allowedTools.length>100||config.allowedTools.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)))throw integrationError('MCP_CONFIG_INVALID','Owner must configure the allowed remote tool names');
 let secret;
 if(config.credentialRef){if(!resolveCredential)throw integrationError('MCP_AUTH_UNAVAILABLE','Credential resolver unavailable');secret=await resolveCredential(config.credentialRef,url.href);}
 const transport=new StreamableHTTPClientTransport(url,{
  // No OAuth browser launch, implicit credential forwarding or POST replay.
  requestInit:secret?{headers:{authorization:'Bearer '+secret}}:undefined,
  reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1},
  fetch:async(target,init={})=>{
   if(new URL(target).href!==url.href)throw integrationError('MCP_ENDPOINT_CHANGED','MCP request escaped its configured endpoint');
   const response=await safeHttpResponse(target,{...networkOptions,...init,timeoutMs});
   return response;
  }
 });
 const client=new Client({name:'cetamesh-remote-mcp',version:'1.0.0'});
 let closed=false,closeHandler=null,closePromise=null;
 client.onclose=()=>{closed=true;closeHandler?.();};
 // Remote text must not escape through diagnostics or public errors.
 client.onerror=()=>{};
 async function close(){
  if(closePromise)return closePromise;
  closePromise=(async()=>{try{await transport.terminateSession();}catch(error){void error; /* Remote termination may be unavailable; finally still closes every local stream. */}finally{await client.close();closed=true;}})();
  return closePromise;
 }
 try{await client.connect(transport,{timeout:timeoutMs});}catch{await close();throw integrationError('MCP_START_FAILED','Remote MCP initialization failed; check endpoint, credential binding and protocol version');}
 const sanitize=value=>secret?JSON.parse(JSON.stringify(value).replaceAll(secret,'[REDACTED]')):value;
 return {pid:null,
  onClose(handler){closeHandler=handler;if(closed)handler?.();},
  async listTools(){
   const tools=[],seen=new Set();let cursor,pages=0;
   try {
    do {
     if(++pages>10||(cursor&&seen.has(cursor)))throw integrationError('MCP_DISCOVERY_LIMIT','Remote discovery cursor or page limit exceeded');
     if(cursor)seen.add(cursor);
     const page=await client.listTools(cursor?{cursor}:undefined,{timeout:timeoutMs});
     tools.push(...page.tools);cursor=page.nextCursor;
     if(tools.length>500)throw integrationError('MCP_DISCOVERY_LIMIT','Remote discovery exceeds tool limit');
    }while(cursor);
    return sanitize(tools.filter(tool=>config.allowedTools.includes(tool.name)));
   }catch(error){
    // SDK errors can contain arbitrary remote text, including credential echoes.
    // Only locally generated stable codes and messages may reach diagnostics.
    if(error?.code==='MCP_DISCOVERY_LIMIT')throw integrationError('MCP_DISCOVERY_LIMIT','Remote discovery exceeded bounded limits');
    throw integrationError('MCP_DISCOVERY_FAILED','Remote tool discovery failed');
   }
  },
  async callTool(name,args,{signal}={}){
   signal?.throwIfAborted();if(closed)throw integrationError('PROVIDER_UNAVAILABLE','Remote MCP connection closed');
   const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});
   try{return sanitize(await client.callTool({name,arguments:args},undefined,{signal,timeout:timeoutMs}));}
   catch{const error=integrationError('MCP_OUTCOME_UNKNOWN','Remote MCP result is unknown; reconcile before retrying');error.effectStatus='unknown';throw error;}
   finally{signal?.removeEventListener('abort',abort);}
  },close
 };
}
