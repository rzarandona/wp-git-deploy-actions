import { Readable } from 'node:stream';
import { signRequest } from './signing.mjs';

export async function edgeCheck(options, {fetch: fetchRequest=globalThis.fetch}={}) {
  const timeout=options.timeout ?? 300;
  if(!Number.isFinite(timeout) || timeout<=0 || timeout>600) throw new Error('invalid edge timeout');
  const signal=AbortSignal.timeout(Math.ceil(timeout*1000));
  async function request(route,{method='GET',bytes=Buffer.alloc(0),oversize=false,size=0}={}) {
    const signed=signRequest({key:options.key,siteUrl:options.siteUrl,allowInsecure:options.allowInsecure===true,method,route,body:bytes,contentHash:oversize?'oversize-canary':undefined});
    const headers={...signed.headers}; let body=method==='GET'?undefined:bytes;
    if(oversize) {
      const chunk=Buffer.alloc(1024*1024);
      body=Readable.from((function*(){for(let sent=0;sent<size;sent+=chunk.length) yield chunk.subarray(0,Math.min(chunk.length,size-sent));})());
      headers['Content-Type']='application/octet-stream'; headers['Content-Length']=String(size);
    } else if(method==='POST') headers['Content-Type']='application/json';
    return fetchRequest(signed.url,{method,headers,body,redirect:'manual',signal,...(oversize?{duplex:'half'}:{})});
  }
  const discovery=await request('/deploy-agent/v1/agent');
  if(!discovery.ok) throw new Error('edge discovery refused');
  const agent=await discovery.json(); const cap=agent.limits?.edge_cap_bytes;
  if(!Number.isSafeInteger(cap) || cap<1 || cap>1024*1024*1024+1024*1024) throw new Error('invalid edge cap');
  const size=cap+1024*1024;
  const response=await request('/deploy-agent/v1/edge-canary',{method:'POST',oversize:true,size});
  const type=response.headers.get('Content-Type') ?? '';
  // WordPress PHP errors are JSON. Ambiguous JSON (including proxy JSON) is never certified upstream.
  if(response.status!==413 || /json/i.test(type) || response.headers.has('X-WP-Nonce')) {
    await response.body?.cancel(); throw new Error('edge is not proven: expected a non-PHP 413');
  }
  await response.body?.cancel();
  const report=await request('/deploy-agent/v1/edge-report',{method:'POST',bytes:Buffer.from(JSON.stringify({result:'rejected_before_php',status:413,bytes_sent:size}))});
  if(!report.ok) throw new Error('edge report refused by agent');
  return report.json();
}
