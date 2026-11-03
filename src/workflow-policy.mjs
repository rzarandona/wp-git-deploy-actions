function requireThat(condition,message) {if(!condition) throw new Error(message);}
function hasSecret(value) {
  if(typeof value==='string') return /\bsecrets\s*(?:\.|\[)/.test(value) || value.includes('dak1.');
  if(Array.isArray(value)) return value.some(hasSecret);
  return value && typeof value==='object' ? Object.values(value).some(hasSecret) : false;
}
function pinned(ref) {return typeof ref==='string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(ref);}
const keyAction=/^rzarandona\/deploy-actions\/(?:deploy|edge-check)@/;
// v0.5.0 (Git Deploy spec §K.10, §K.2): the bound-site gate also receives the key, under every deploy-job rule.
const gateAction=/^rzarandona\/deploy-actions\/gate@/;
function isGate(job) {return Array.isArray(job.steps) && job.steps.some(step=>typeof step.uses==='string' && gateAction.test(step.uses));}
function dedicatedSecret(step) {return typeof step.with?.key==='string' && /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(step.with.key);}
/** Literal, case-insensitive runner labels; null when an expression or runner group hides the selection. */
function runnerLabels(runsOn) {
  const labels=typeof runsOn==='string'?[runsOn]:runsOn;
  if(!Array.isArray(labels) || labels.length===0 || !labels.every(x=>typeof x==='string' && x!=='' && !x.includes('${{'))) return null;
  return labels.map(x=>x.toLowerCase());
}
// One GitHub-hosted image label gives every job a fresh virtual machine. Any other label set,
// including a custom label without "self-hosted", may select a persistent runner.
const hostedImage=/^(?:ubuntu|windows|macos)-(?:latest|[0-9][0-9a-z.-]*)$/;
/**
 * A persistent self-hosted runner does not isolate one job from the next, so separate jobs
 * alone cannot keep build code away from the key. Each build job and the key job must select
 * mutually exclusive label sets. The deploy runner's separate OS identity is not visible here.
 */
function requireSeparateRunners(doc,keyName,keyJob) {
  const key=runnerLabels(keyJob['runs-on']);
  requireThat(key,'key-bearing job needs a literal runner label list');
  if(key.length===1 && hostedImage.test(key[0])) return;
  for(const [name,job] of Object.entries(doc.jobs)) {
    if(name===keyName || hasSecret(job) || job.secrets || job.uses || isOidc(job)) continue;
    const build=runnerLabels(job['runs-on']);
    requireThat(build,`build job ${name} needs literal runner labels when a key job runs on a self-hosted runner`);
    const lacks=(a,b)=>a.some(x=>!b.includes(x));
    requireThat(lacks(build,key) && lacks(key,build),`self-hosted runners must not be shared: build job ${name} and key job ${keyName} need mutually exclusive runner labels`);
  }
}
/**
 * v0.6.8 (Git Deploy spec §K.3, §K.1 release mode; D-50): the website workflow's gate and deploy jobs hold no secret but
 * may mint a GitHub OIDC token, which the site accepts as a deployment credential. `id-token: write` is therefore granted
 * per job, never workflow-wide, and only to a job that runs nothing but SHA-pinned first-party website actions (plus the
 * artifact download in the deploy job), under every deploy-job rule: a separate token-free build job and runner separation.
 */
const websiteAction=/^rzarandona\/deploy-actions\/(?:gate|deploy)@/;
function isOidc(job) {return job && typeof job.permissions==='object' && job.permissions!==null && Object.hasOwn(job.permissions,'id-token');}
function lintOidcJob(doc,name,job) {
  requireThat(job.permissions['id-token']==='write' && job.permissions.contents==='read' && Object.keys(job.permissions).length===2,'an OIDC job gets exactly contents: read and id-token: write');
  requireThat(!hasSecret(job) && !job.secrets && !job.uses && !job.env && !job.container && !job.services,'an OIDC job holds no secret, reusable workflow, job environment, container or service');
  requireThat(Array.isArray(job.steps) && job.steps.length>0,'OIDC job steps missing');
  const firstParty=job.steps.filter(step=>typeof step.uses==='string' && websiteAction.test(step.uses));
  for(const step of job.steps) {
    requireThat(!step.run && !step.env && pinned(step.uses),'an OIDC job must not execute build code or unpinned steps');
    requireThat(/^actions\/download-artifact@/.test(step.uses) || websiteAction.test(step.uses),'an OIDC job may only download the artifact and run the first-party website gate or deploy action');
    if(websiteAction.test(step.uses)) requireThat(step.with?.mode==='website' && step.with.key===undefined,'an OIDC job runs the first-party action in website mode, with no key');
  }
  requireThat(firstParty.length===1,'an OIDC job runs exactly one first-party website action');
  requireSeparateRunners(doc,name,job);
  if(/^rzarandona\/deploy-actions\/gate@/.test(firstParty[0].uses)) {
    requireThat(job.steps.length===1,'the website gate job runs only the SHA-pinned gate action');
    return false;
  }
  const needs=Array.isArray(job.needs)?job.needs:[job.needs];
  requireThat(needs.some(x=>x && x!==name && doc.jobs[x] && !hasSecret(doc.jobs[x]) && !doc.jobs[x].secrets && !isOidc(doc.jobs[x])),'a separate token-free build job is required');
  return true;
}
/** Lint the REQUIRED template tier, not an authority boundary or a substitute for repository access control. */
export function lintWorkflow(doc) {
  const triggers=typeof doc.on==='string'?[doc.on]:Array.isArray(doc.on)?doc.on:Object.keys(doc.on??{});
  requireThat(triggers.length>0 && triggers.every(x=>['push','release','workflow_dispatch'].includes(x)),'forbidden deployment trigger');
  requireThat(doc.permissions?.contents==='read' && Object.keys(doc.permissions).length===1,'minimal read-only permissions required');
  requireThat(doc.concurrency?.group && doc.concurrency['cancel-in-progress']===false,'environment concurrency must not cancel a live deployment');
  requireThat(!hasSecret(doc.env),'workflow-wide secrets are forbidden');
  let deployJobs=0;
  for(const [name,job] of Object.entries(doc.jobs??{})) {
    if(isOidc(job)) {if(lintOidcJob(doc,name,job)) deployJobs++;continue;}
    if(job.permissions) requireThat(job.permissions.contents==='read' && Object.keys(job.permissions).length===1,'job permission escalation');
    if(!hasSecret(job) && !job.secrets) {
      for(const step of job.steps??[]) if(step.uses) {
        requireThat(pinned(step.uses),'build action must be SHA-pinned');
        requireThat(!keyAction.test(step.uses) && !gateAction.test(step.uses),'dedicated deployment secret required');
      }
      continue;
    }
    requireThat(!hasSecret(job.env),'job-wide key exposure is forbidden');
    if(isGate(job)) {
      requireThat(!job.uses && job.steps.length===1 && !job.steps[0].run && !job.steps[0].env && pinned(job.steps[0].uses),'the gate job runs only the SHA-pinned gate action');
      requireThat(dedicatedSecret(job.steps[0]),'dedicated deployment secret required');
      requireSeparateRunners(doc,name,job);
      continue;
    }
    deployJobs++;
    const needs=Array.isArray(job.needs)?job.needs:[job.needs];
    requireThat(needs.some(x=>x && x!==name && doc.jobs[x] && !hasSecret(doc.jobs[x])),'a separate secret-free build job is required');
    if(job.uses) {
      requireThat(pinned(job.uses) && /\/\.github\/workflows\//.test(job.uses),'reusable workflow must be SHA-pinned');
      requireThat(job.secrets && typeof job.secrets==='object' && !Array.isArray(job.secrets) && Object.keys(job.secrets).length===1 && typeof job.secrets['deployment-key']==='string' && /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(job.secrets['deployment-key']),'pass only the explicit deployment key; never secrets: inherit');
    } else {
      requireThat(Array.isArray(job.steps) && job.steps.length>0,'deploy steps missing');
      let firstPartyKeyAction=false;
      for(const step of job.steps) {
        requireThat(!step.run && !step.env && pinned(step.uses),'deploy job must not execute build code or unpinned steps');
        requireThat(/^actions\/download-artifact@/.test(step.uses) || keyAction.test(step.uses),'deploy job may only download the artifact and execute first-party deployment code');
        if(keyAction.test(step.uses)) {
          firstPartyKeyAction=true;requireThat(dedicatedSecret(step),'dedicated deployment secret required');
        }
      }
      requireThat(firstPartyKeyAction,'deployment action is missing');
      requireSeparateRunners(doc,name,job);
    }
  }
  requireThat(deployJobs>0,'no dedicated deployment job');
}
