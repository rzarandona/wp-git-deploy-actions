import { signRequest } from './signing.mjs';

/**
 * The bound-site workflow's early automatic-deployment gate (Git Deploy spec v0.5.0 §K.10, OD4).
 * It reads the target's source binding with a signed GET and decides whether build and deploy run:
 * - an unbound target: proceed (Slice 8 behaviour);
 * - a workflow_dispatch run: proceed (Deploy Now; the site's intake decides authoritatively);
 * - otherwise: proceed only when automatic deployment is on.
 * This only saves CI work. Intake on the site is the authoritative check. A site that cannot be read
 * fails the gate, so nothing is built.
 */
export async function gate(options, {fetch: fetchRequest=globalThis.fetch}={}) {
  const {key, siteUrl, type, slug, eventName, allowInsecure=false} = options;
  if(!['plugin','theme'].includes(type) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(slug ?? '')) throw new Error('invalid target');
  if(typeof eventName!=='string' || eventName==='') throw new Error('the workflow event is unknown');
  const signed=signRequest({key, siteUrl, allowInsecure: allowInsecure===true, method:'GET', route:`/deploy-agent/v1/targets/${type}/${slug}`});
  const response=await fetchRequest(signed.url,{method:'GET',headers:signed.headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(!response.ok) {await response.body?.cancel(); throw new Error(`the site refused the target read (${response.status})`);}
  const resource=await response.json();
  if(!resource || typeof resource!=='object' || !Object.hasOwn(resource,'source_binding')) throw new Error('the site did not report the target binding');
  const binding=resource.source_binding;
  if(binding===null) return {proceed:true, reason:'unbound'};
  if(typeof binding!=='object' || typeof binding.automatic!=='boolean') throw new Error('the site reported an invalid binding');
  if(eventName==='workflow_dispatch') return {proceed:true, reason:'dispatch'};
  return binding.automatic ? {proceed:true, reason:'automatic'} : {proceed:false, reason:'automatic-off'};
}
