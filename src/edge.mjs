import { Readable } from 'node:stream';
import { signRequest } from './signing.mjs';

/**
 * The edge check (spec §I.8, Q8-30): a signed request larger than the site's edge cap must be refused by the web
 * server or proxy in front of WordPress, before PHP runs; the site then accepts a signed report of that refusal and
 * records the edge as VERIFIED. Each failure carries a `kind`, so a caller can explain it in plain words:
 * `discovery` (the site's limits could not be read), `redirect`, `reached_php` (the test upload reached WordPress,
 * which records the edge as FAILED), `not_refused` (no 413, or no answer), and `report_refused`.
 *
 * Requests are signed with a deploy key (`key`) or, in the website workflow, with a signer such as `oidcSigner`
 * (`signer.sign({route, method, body, contentHash})`). With `cap` given, the site's limits are not read again.
 */
export class EdgeCheckError extends Error {
  constructor(kind, message, details = {}) { super(message); this.kind = kind; Object.assign(this, details); }
}

const MAX_CAP = 1024 * 1024 * 1024 + 1024 * 1024;
const validCap = cap => Number.isSafeInteger(cap) && cap >= 1 && cap <= MAX_CAP;

export async function edgeCheck(options, {fetch: fetchRequest=globalThis.fetch}={}) {
  const timeout=options.timeout ?? 300;
  if(!Number.isFinite(timeout) || timeout<=0 || timeout>600) throw new Error('invalid edge timeout');
  const signal=AbortSignal.timeout(Math.ceil(timeout*1000));
  async function sign(route, method, bytes, contentHash) {
    if(options.signer) return options.signer.sign({route, method, body:bytes, contentHash});
    return signRequest({key:options.key,siteUrl:options.siteUrl,allowInsecure:options.allowInsecure===true,method,route,body:bytes,contentHash});
  }
  async function request(route,{method='GET',bytes=Buffer.alloc(0),oversize=false,size=0}={}) {
    const signed=await sign(route, method, bytes, oversize?'oversize-canary':undefined);
    const headers={...signed.headers}; let body=method==='GET'?undefined:bytes;
    if(oversize) {
      const chunk=Buffer.alloc(1024*1024);
      body=Readable.from((function*(){for(let sent=0;sent<size;sent+=chunk.length) yield chunk.subarray(0,Math.min(chunk.length,size-sent));})());
      headers['Content-Type']='application/octet-stream'; headers['Content-Length']=String(size);
    } else if(method==='POST') headers['Content-Type']='application/json';
    return fetchRequest(signed.url,{method,headers,body,redirect:'manual',signal,...(oversize?{duplex:'half'}:{})});
  }
  let cap=options.cap;
  if(cap===undefined) {
    const discovery=await request('/deploy-agent/v1/agent');
    if(!discovery.ok) { await discovery.body?.cancel(); throw new EdgeCheckError('discovery', 'edge discovery refused'); }
    cap=(await discovery.json()).limits?.edge_cap_bytes;
  }
  if(!validCap(cap)) throw new EdgeCheckError('discovery', 'invalid edge cap');
  const size=cap+1024*1024;
  let response;
  try { response=await request('/deploy-agent/v1/edge-canary',{method:'POST',oversize:true,size}); }
  catch(error) {
    // A server that refuses early may close the connection while the body is still being sent. With no answer at
    // all, nothing proves where the upload was stopped.
    throw new EdgeCheckError('not_refused', 'edge is not proven: the oversize test got no answer', {cap, cause:error});
  }
  const type=response.headers.get('Content-Type') ?? '';
  await response.body?.cancel();
  if(response.status>=300 && response.status<400) throw new EdgeCheckError('redirect', 'edge is not proven: the oversize test was redirected', {cap, status:response.status});
  // WordPress PHP errors are JSON. Ambiguous JSON (including proxy JSON) is never certified upstream.
  if(response.status===413 && (/json/i.test(type) || response.headers.has('X-WP-Nonce'))) {
    throw new EdgeCheckError('reached_php', 'edge is not proven: the oversize test reached WordPress', {cap, status:response.status});
  }
  if(response.status!==413) throw new EdgeCheckError('not_refused', 'edge is not proven: expected a non-PHP 413', {cap, status:response.status});
  const report=await request('/deploy-agent/v1/edge-report',{method:'POST',bytes:Buffer.from(JSON.stringify({result:'rejected_before_php',status:413,bytes_sent:size}))});
  if(!report.ok) {
    let code=null; try { code=(await report.json())?.code ?? null; } catch {}
    throw new EdgeCheckError('report_refused', 'edge report refused by agent', {cap, status:report.status, code});
  }
  return report.json();
}

/**
 * Whether a production site needs the edge check before this run: its edge is not VERIFIED, or the proof ends within
 * `marginMs` (7 days by default; a proof lasts 30). `valid_until` is the site's UTC `Y-m-d H:i:s[.u]`.
 */
export function edgeCheckDue(edgeStatus, nowMs = Date.now(), marginMs = 7 * 86400 * 1000) {
  if(!edgeStatus || typeof edgeStatus !== 'object' || edgeStatus.status !== 'VERIFIED') return true;
  const until=typeof edgeStatus.valid_until === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(edgeStatus.valid_until)
    ? Date.parse(`${edgeStatus.valid_until.slice(0, 19).replace(' ', 'T')}Z`) : NaN;
  return !Number.isFinite(until) || until - nowMs < marginMs;
}
