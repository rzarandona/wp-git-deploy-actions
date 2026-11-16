import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { core } from '../src/core.mjs';
import { deploy } from '../src/deploy.mjs';
import { deployRelease } from '../src/release-deploy.mjs';
import { redactTokens } from '../src/oidc.mjs';

function boolean(name) {const text=core.getInput(name)||'false';if(!['true','false'].includes(text)) throw new Error(`invalid boolean input: ${name}`);return text==='true';}
const mode=core.getInput('mode')||'component';
if(mode==='website') {
  // Website mode (spec §K.1 release mode): no stored secret; each request carries a fresh GitHub OIDC token.
  try {
    const artifact=core.getInput('artifact',{required:true});
    const result=await deployRelease({siteUrl:core.getInput('site-url')||process.env.GIT_DEPLOY_SITE||'',credential:core.getInput('credential')||process.env.GIT_DEPLOY_CREDENTIAL||'',
      // A version 2 build's packed lines travel beside release.zip; a version 1 build has none.
      artifact:readFileSync(artifact),progressPath:join(dirname(artifact),'progress.json'),releaseInfo:JSON.parse(readFileSync(core.getInput('release-info',{required:true}),'utf8')),
      environment:core.getInput('environment',{required:true}),mode:core.getInput('release-mode',{required:true}),mappingEpoch:core.getInput('mapping-epoch',{required:true}),
      dispatchRequestId:core.getInput('dispatch-request-id'),dispatchCommit:core.getInput('dispatch-commit'),
      exclusionsSha256:core.getInput('exclusions-sha256',{required:true}),allowInsecure:boolean('allow-insecure'),waitTimeout:Number(core.getInput('wait-timeout')||'600')},
      {log:text=>process.stdout.write(`${text}\n`),summary:core.summary,mask:token=>core.setSecret(token)});
    core.setOutput('deployment',result.number??result.id);core.setOutput('state',result.state);
  } catch(error) {
    process.stderr.write(`Git Deploy website release failed: ${redactTokens(error?.message).replace(/[\x00-\x1f\x7f]/g,' ')}\n`);process.exitCode=1;
  }
} else if(mode==='component') {
  try {
    const key=core.getInput('key',{required:true});core.setSecret(key);
    const result=await deploy({key,siteUrl:core.getInput('site-url',{required:true}),
      artifact:readFileSync(core.getInput('artifact',{required:true})),buildInfo:JSON.parse(readFileSync(core.getInput('build-info',{required:true}),'utf8')),
      environment:core.getInput('environment',{required:true}),databaseEffect:core.getInput('database-effect')||'unknown',dryRun:boolean('dry-run'),allowInsecure:boolean('allow-insecure'),waitTimeout:Number(core.getInput('wait-timeout')||'600')},
      {log:text=>process.stdout.write(`${text}\n`),summary:core.summary});
    core.setOutput('deployment',result.number??result.id);core.setOutput('state',result.state);
  } catch {
    // The library's summaries/events carry safe status. Never dump input or transport errors containing secrets.
    process.stderr.write('Git Deploy failed; inspect the deployment status and safe job summary.\n');process.exitCode=1;
  }
} else {process.stderr.write('Git Deploy: mode must be component or website.\n');process.exitCode=1;}
