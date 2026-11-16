import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { core } from '../src/core.mjs';
import { packageComponent } from '../src/package.mjs';
import { packageRelease } from '../src/release-package.mjs';
import { recordPackedProgress } from '../src/run-progress.mjs';

const mode=core.getInput('mode')||'component';
if(mode==='website') {
  // Website mode (spec §K.1 release mode): runs on the build runner and never holds a key or contacts the site.
  try {
    const progress=core.getInput('progress')||'false';if(!['true','false'].includes(progress)) throw new Error('invalid boolean input: progress');
    const temp=process.env.RUNNER_TEMP??tmpdir();
    const result=packageRelease({path:core.getInput('path')||'.',rootPath:core.getInput('root-path',{required:true}),scope:core.getInput('scope',{required:true}),
      excludedComponents:core.getInput('excluded-components')||'[]',exclusions:core.getInput('exclusions',{required:true}),exclusionsSha256:core.getInput('exclusions-sha256',{required:true}),
      databaseEffect:core.getInput('database-effect')||'unknown',sitePhp:core.getInput('site-php')||'8.2',siteWordpress:core.getInput('site-wordpress')||'6.6',
      installedParents:core.getInput('installed-parents').split(',').map(x=>x.trim()).filter(Boolean),output:mkdtempSync(join(temp,'dagent-release-')),scratch:temp},
      {log:text=>process.stdout.write(`${text}\n`)});
    for(const [name,value] of Object.entries({'directory':result.directory,'artifact':result.artifact,'sha256':result.sha256,'size':result.size,'release-info':result.releaseInfo})) core.setOutput(name,value);
    core.summary(`### Git Deploy website build\n\n${result.manifest.length} components, ${result.size} bytes, sha256 ${result.sha256}\n\n${result.manifest.map(c=>`- ${c.type} ${c.slug}${c.version?` ${c.version}`:''}`).join('\n')}\n`);
    // A version 2 workflow's packed lines (E-10), which the deploy job sends with its own sign-in. Best effort: never throws.
    if(progress==='true') recordPackedProgress({directory:result.directory,packed:result.packed},{log:text=>process.stdout.write(`${text}\n`)});
  } catch(error) {process.stderr.write(`Git Deploy website build failed; nothing was emitted: ${String(error?.message??'').replace(/[\x00-\x1f\x7f]/g,' ')}\nThe build requires 64-bit PHP with zip, intl, mbstring and zlib.\n`);process.exitCode=1;}
} else if(mode==='component') {
  try {
    const path=core.getInput('path',{required:true});
    const result=packageComponent({path,type:core.getInput('type',{required:true}),slug:core.getInput('slug',{required:true}),
      output:mkdtempSync(join(process.env.RUNNER_TEMP??tmpdir(),'dagent-package-')),sourcePath:path,
      excludeFrom:core.getInput('exclude-from')||'.distignore',sitePhp:core.getInput('site-php')||'8.2',siteWordpress:core.getInput('site-wordpress')||'6.6',installedParents:core.getInput('installed-parents').split(',').filter(Boolean)});
    for(const [name,value] of Object.entries({'artifact':result.artifact,'sha256':result.sha256,'size':result.size,'build-info':result.buildInfo})) core.setOutput(name,value);
  } catch {process.stderr.write('Git Deploy package failed validation; no publishable output was emitted. Requires 64-bit PHP with zip, intl, mbstring and zlib.\n');process.exitCode=1;}
} else {process.stderr.write('Git Deploy package: mode must be component or website.\n');process.exitCode=1;}
