import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { signRequest } from './signing.mjs';

const schema = JSON.parse(readFileSync(new URL('../contracts/schemas/deploy-request-v1.schema.json', import.meta.url)));
const terminal = new Set(['SUCCEEDED','FAILED','ROLLED_BACK','ROLLBACK_FAILED','CANCELLED','EXPIRED']);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function validate(value, rule, path='request') {
  if (rule.const !== undefined) requireThat(value === rule.const, `invalid ${path}`);
  if (rule.enum) requireThat(rule.enum.includes(value), `invalid ${path}`);
  if (rule.type === 'object') {
    requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `invalid ${path}`);
    for (const name of rule.required ?? []) requireThat(Object.hasOwn(value,name), `missing ${path}.${name}`);
    for (const [name, data] of Object.entries(value)) {
      requireThat(Object.hasOwn(rule.properties,name), `unknown ${path} field`);
      validate(data, rule.properties[name], `${path}.${name}`);
    }
  } else if (rule.type === 'string') {
    requireThat(typeof value === 'string', `invalid ${path}`);
    if (rule.pattern) {const match = new RegExp(rule.pattern).exec(value); requireThat(match && match[0] === value, `invalid ${path}`);}
  } else if (rule.type === 'integer') requireThat(Number.isSafeInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity), `invalid ${path}`);
  else if (rule.type === 'boolean') requireThat(typeof value === 'boolean', `invalid ${path}`);
}
function safe(text) {return String(text ?? 'unknown').replace(/[\x00-\x1f\x7f]/g,' ').replace(/dak1\.[A-Za-z0-9._-]+/g,'[redacted]');}
function escape(text) {return safe(text).replace(/[&<>"'`*\[\]\\_]/g,c=>`&#${c.charCodeAt(0)};`);}
export function deploymentSummary(resource,{siteUrl,packagedVersion}={}) {
  const recovery = resource.recovery ?? {};
  const state = resource.state === 'ROLLED_BACK' ? `rolled back — ${recovery.application === 'operational' ? 'operational' : 'needs attention'}` : resource.state;
  let link='';
  try {const url=new URL(siteUrl);if(url.protocol==='https:' && !url.username && !url.password) link=`\n\nWordPress: <${escape(url.href)}>`;}catch{}
  return `### Git Deploy\n\nDeployment: ${escape(resource.number ?? resource.id)}\n\nResult: ${escape(state)}\n\nComponent version (server reported): ${escape(resource.component_version)}\n\nPackaged version (asserted): ${escape(packagedVersion)}\n\nCommit: ${escape(resource.source?.commit_sha)}\n\nRecovery filesystem: ${escape(recovery.filesystem)}; database: ${escape(recovery.database)}; application: ${escape(recovery.application)}${link}\n\nDatabase and external side effects are never claimed to be reversed.\n`;
}

/** Accepted machine API only. Read-only readiness is diagnostic, never mutation authority. */
export async function deploy(options, ports={}) {
  const {fetch: fetchRequest=globalThis.fetch, now=Date.now, sleep=delay, log=()=>{}, summary=()=>{}} = ports;
  const seconds = options.waitTimeout ?? 600;
  requireThat(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600, 'invalid wait timeout');
  requireThat(Buffer.isBuffer(options.artifact) && options.artifact.length > 0, 'artifact is required');
  const info = options.buildInfo;
  requireThat(info && typeof info === 'object', 'build-info is required');
  const hash = createHash('sha256').update(options.artifact).digest('hex');
  const requestId = `gh-${info.build?.run_id}-${info.build?.run_attempt}-${createHash('sha256').update(`${info.target?.type}/${info.target?.slug}/${options.environment}`).digest('hex').slice(0,16)}`;
  const request = {schema:'deploy-request/v1',request_id:requestId,environment:options.environment,target:info.target,
    artifact:{format:'wp-component-zip/v1',sha256:hash,size:options.artifact.length},
    ...(info.source ? {source:info.source} : {}), ...(info.build ? {build:info.build} : {}),
    database_effect:options.databaseEffect ?? 'unknown', options:{dry_run:options.dryRun ?? false}};
  validate(request,schema);
  const body=Buffer.from(JSON.stringify(request));
  requireThat(body.length <= 16384, 'deployment request exceeds schema cap');
  const deadline=now()+seconds*1000;
  let id; let resource; let after=0;
  async function call(route,{method='GET',bytes=Buffer.alloc(0),upload=false,query={},retry=false,end=deadline}={}) {
    let attempt=0;
    while (true) {
      const remaining=end-now(); requireThat(remaining>0,'deployment wait timeout');
      const signed=signRequest({key:options.key,siteUrl:options.siteUrl,allowInsecure:options.allowInsecure===true,route,method,body:bytes,query});
      const headers={...signed.headers}; let sent=method==='GET' || bytes.length===0 ? undefined : bytes;
      if (upload) {sent=new FormData(); sent.append('artifact',new Blob([bytes],{type:'application/zip'}),`${info.target.slug}.zip`);}
      else if (sent) headers['Content-Type']='application/json';
      let response;
      try {response=await fetchRequest(signed.url,{method,headers,body:sent,redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(upload?300000:30000,Math.ceil(remaining))))});}
      catch {if (!retry || ++attempt>8) throw new Error('deployment network request failed'); await sleep(Math.min(1000*2**(attempt-1),10000,Math.max(0,end-now()))); continue;}
      // Never use response-supplied links to direct a signed request.
      requireThat(response.status<300 || response.status>=400,'deployment redirect refused');
      let data;
      try {const text=await response.text(); requireThat(Buffer.byteLength(text)<=1024*1024,'response too large'); data=JSON.parse(text);} catch {throw new Error('invalid deployment API response');}
      if (response.ok) {requireThat(data && typeof data==='object' && !Array.isArray(data),'invalid deployment API response'); return data;}
      if (retry && response.status===409 && data.code==='DEPLOYMENT_IN_PROGRESS') {
        attempt++;
        const requested=Number(response.headers.get('Retry-After'));
        const backoff=Number.isFinite(requested) && requested>=0 ? Math.max(100,requested*1000) : Math.min(1000*2**Math.min(attempt-1,4),10000);
        await sleep(Math.min(backoff,Math.max(0,end-now()))); continue;
      }
      throw new Error(`deployment API refused: ${safe(data.code ?? response.status)}`);
    }
  }
  try {
    const agent=await call('/deploy-agent/v1/agent',{retry:true});
    requireThat(agent.environment===options.environment,'agent environment mismatch');
    requireThat(agent.schemas?.deploy_request?.includes('deploy-request/v1') && agent.schemas?.artifact?.includes('wp-component-zip/v1'),'unsupported agent schema');
    const limit=agent.limits?.compressed_artifact_bytes;
    requireThat(Number.isSafeInteger(limit) && options.artifact.length<=limit,'artifact exceeds agent limit');
    requireThat(Number.isSafeInteger(agent.server_time) && Math.abs(Math.floor(Date.now()/1000)-agent.server_time)<=60,'agent clock skew');
    resource=await call('/deploy-agent/v1/deployments',{method:'POST',bytes:body,retry:true});
    id=resource.number ?? resource.id;
    requireThat(Number.isSafeInteger(id) && id>0,'invalid deployment number');
    if (resource.artifact?.upload_required===true) resource=await call(`/deploy-agent/v1/deployments/${id}/artifact`,{method:'POST',bytes:options.artifact,upload:true,retry:true});
    while (!terminal.has(resource.state)) {
      resource=await call(`/deploy-agent/v1/deployments/${id}`,{query:{events_after:String(after)},retry:true});
      for (const event of resource.events ?? []) {
        requireThat(Number.isSafeInteger(event.seq) && event.seq>after,'invalid event sequence');
        after=event.seq; log(`event: ${safe(event.message)}`);
      }
      if (!terminal.has(resource.state)) await sleep(Math.min(1000,Math.max(0,deadline-now())));
    }
    summary(deploymentSummary(resource,{siteUrl:options.siteUrl,packagedVersion:info.component_version}));
    requireThat(resource.state==='SUCCEEDED',`deployment ended ${safe(resource.state)}`);
    return resource;
  } catch (error) {
    const localFailure=!terminal.has(resource?.state);
    if (id && localFailure) {
      try {
        const cancelled=await call(`/deploy-agent/v1/deployments/${id}/cancel`,{method:'POST',end:now()+10000});
        if((cancelled.number??cancelled.id)===id) resource=cancelled;
      }
      catch {log('cancel: server did not confirm cancellation; inspect deployment status');}
    }
    if(localFailure) summary(`### Git Deploy client stopped\n\nRequest: ${escape(requestId)}\n\nLast observed state: ${escape(resource?.state)}\n\nCancellation is confirmed only if the last observed state is CANCELLED. Filesystem and database outcomes are not inferred from a client error.\n`);
    throw error;
  }
}
