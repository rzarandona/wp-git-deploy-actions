import { core } from '../src/core.mjs';
import { gate } from '../src/gate.mjs';
import { websiteGate } from '../src/website-gate.mjs';
import { redactTokens } from '../src/oidc.mjs';

const mode=core.getInput('mode')||'component';
if(mode==='website') {
  // Website mode (spec §K.1 release mode): no stored secret; each request carries a fresh GitHub OIDC token.
  try {
    const insecure=core.getInput('allow-insecure')||'false';if(!['true','false'].includes(insecure)) throw new Error('invalid boolean input: allow-insecure');
    const result=await websiteGate({siteUrl:core.getInput('site-url')||process.env.GIT_DEPLOY_SITE||'',credential:core.getInput('credential')||process.env.GIT_DEPLOY_CREDENTIAL||'',allowInsecure:insecure==='true',
      dispatchRequestId:core.getInput('dispatch-request-id'),dispatchCommit:core.getInput('dispatch-commit')},
      {mask:token=>core.setSecret(token)});
    core.setOutput('proceed',result.proceed?'true':'false');
    core.setOutput('reason',result.reason);
    core.setOutput('environment',result.environment);
    core.setOutput('mode',result.mode);
    core.setOutput('root_path',result.root_path);
    core.setOutput('scope',JSON.stringify(result.scope));
    core.setOutput('excluded_components',JSON.stringify(result.excluded_components));
    core.setOutput('exclusions',result.exclusions);
    core.setOutput('exclusions_sha256',result.exclusions_sha256);
    core.setOutput('mapping_epoch',String(result.mapping_epoch));
    core.setOutput('site_php',result.site_php);
    core.setOutput('site_wordpress',result.site_wordpress);
    core.setOutput('installed_parents',result.installed_parents.join(','));
    core.setOutput('commit_sha',result.commit_sha);
    core.summary(result.proceed
      ? `Git Deploy gate: build a website ${result.mode==='preview'?'preview':'release'} (${result.reason}) of ${result.root_path} for ${result.environment}. The site still checks the release.\n`
      : 'Git Deploy gate: automatic deployment is off for this site, so this push builds and deploys nothing. Use Deploy Now in WordPress.\n');
  } catch(error) {
    process.stderr.write(`Git Deploy gate failed, so nothing is built: ${redactTokens(error?.message)}\n`);process.exitCode=1;
  }
} else if(mode==='component') {
  try {
    const key=core.getInput('key',{required:true});core.setSecret(key);
    const insecure=core.getInput('allow-insecure')||'false';if(!['true','false'].includes(insecure)) throw new Error('invalid boolean input');
    const result=await gate({key,siteUrl:core.getInput('site-url',{required:true}),type:core.getInput('type',{required:true}),
      slug:core.getInput('slug',{required:true}),eventName:process.env.GITHUB_EVENT_NAME??'',allowInsecure:insecure==='true'});
    core.setOutput('proceed',result.proceed?'true':'false');
    core.summary(result.proceed
      ? `Git Deploy gate: proceed (${result.reason}). The site's intake still checks the deployment.\n`
      : 'Git Deploy gate: automatic deployment is off for this target, so this push builds and deploys nothing. Use Deploy Now in WordPress.\n');
  } catch {
    // Never dump inputs or transport errors, which may carry the credential.
    process.stderr.write('Git Deploy gate failed: the site could not be read, so nothing is built.\n');process.exitCode=1;
  }
} else {process.stderr.write('Git Deploy gate: mode must be component or website.\n');process.exitCode=1;}
