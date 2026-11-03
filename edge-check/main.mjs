import { core } from '../src/core.mjs';
import { edgeCheck } from '../src/edge.mjs';
try {
  const key=core.getInput('key',{required:true});core.setSecret(key);
  const insecure=core.getInput('allow-insecure')||'false';if(!['true','false'].includes(insecure)) throw new Error('invalid boolean input');
  const result=await edgeCheck({key,siteUrl:core.getInput('site-url',{required:true}),allowInsecure:insecure==='true'});
  core.setOutput('status',result.status??result.edge_status);core.summary('Git Deploy edge report was accepted. This is asserted path evidence, not proof that every origin path is capped.\n');
} catch {process.stderr.write('Git Deploy edge check failed; upstream rejection was not certified.\n');process.exitCode=1;}
