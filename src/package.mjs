import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

function requireThat(condition,message) {if(!condition) throw new Error(message);}
export function ignored(name,patterns) {
  let excluded=false;
  for(const text of patterns) {
    if(!text || text.startsWith('#')) continue;
    const negate=text.startsWith('!'); const pattern=negate?text.slice(1):text;
    requireThat(!pattern.includes('\\') && !pattern.includes('['),'unsupported distignore escape or character class');
    const directory=pattern.endsWith('/');const anchored=pattern.startsWith('/');
    const raw=pattern.replace(/^\//,'').replace(/\/$/,'');
    let regex='';
    for(let i=0;i<raw.length;i++) {
      const c=raw[i];
      if(c==='*' && raw[i+1]==='*') {i++;if(raw[i+1]==='/') {i++;regex+='(?:.*/)?';}else regex+='.*';}
      else if(c==='*') regex+='[^/]*';else if(c==='?') regex+='[^/]';else regex+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    }
    const prefix=anchored || raw.includes('/') ? '^' : '(?:^|/)';
    if(new RegExp(`${prefix}${regex}${directory?'(?:/|$)':'(?:$|/)'}`).test(name)) excluded=!negate;
  }
  return excluded;
}
export function zip(files,slug) {return zipNamed(files.map(({name,bytes})=>({name:`${slug}/${name}`,bytes})));}
/** The normalized writer with complete entry names (a website release names plugins/{slug}/… and themes/{slug}/…). */
export function zipNamed(files) {
  const local=[];const central=[];let offset=0;
  for(const {name,bytes} of files) {
    const filename=Buffer.from(name);const crc=crc32(bytes);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(0x21,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,bytes);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(0x0314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(0x21,14);
    c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE((0o100644<<16)>>>0,38);c.writeUInt32LE(offset,42);
    central.push(c,filename);offset+=header.length+filename.length+bytes.length;
  }
  const cd=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
export function validatePackage(path,hash,context) {
  execFileSync('php',[fileURLToPath(new URL('../bin/validate-package.php',import.meta.url)),path,hash,JSON.stringify(context)],{stdio:'pipe'});
}
export function packageComponent(options,{validate=validatePackage}={}) {
  requireThat(['plugin','theme'].includes(options.type) && typeof options.slug==='string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(options.slug) && !/[\r\n]/.test(options.slug),'invalid component type or slug');
  const path=resolve(options.path);const output=resolve(options.output);
  const outRelative=relative(path,output);
  requireThat(outRelative.startsWith('..') || isAbsolute(outRelative),'output must be outside component');
  requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),'component must be a real directory');
  const ignorePath=join(path,options.excludeFrom??'.distignore');let patterns=[];
  try {patterns=readFileSync(ignorePath,'utf8').split(/\r?\n/).map(x=>x.trim());}catch(error) {if(error.code!=='ENOENT') throw error;}
  const names=[];
  function walk(directory,prefix='') {
    for(const name of readdirSync(directory)) {
      if(['.git','.hg','.svn'].includes(name)) continue;
      const entry=join(directory,name);const stat=lstatSync(entry);const relativeName=prefix+name;
      requireThat(!stat.isSymbolicLink(),'source symlink refused');
      if(stat.isDirectory()) walk(entry,`${relativeName}/`);
      else {requireThat(stat.isFile(),'unsupported source entry type');if(!ignored(relativeName,patterns)) names.push(relativeName);}
    }
  }
  walk(path);
  const exported=new Set();
  let inGit=false;try {execFileSync('git',['rev-parse','--show-toplevel'],{cwd:path,stdio:'pipe'});inGit=true;}catch{}
  if(inGit && names.length) {
    const attributes=execFileSync('git',['check-attr','-z','--stdin','export-ignore'],{cwd:path,input:names.join('\0')+'\0',encoding:'utf8'}).split('\0');
    for(let i=0;i<attributes.length-2;i+=3) if(attributes[i+2]==='set') exported.add(attributes[i]);
  }
  const files=[];let total=0;
  for(const name of names.filter(x=>!exported.has(x)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))) {
    const size=lstatSync(join(path,name)).size;
    requireThat(size<=128*1024*1024 && total+size<=128*1024*1024,'package size limit exceeded');
    const bytes=readFileSync(join(path,name));total+=bytes.length;files.push({name,bytes});
  }
  requireThat(files.length>0 && files.length<=20000,'invalid package entry count');
  let main;
  if(options.type==='plugin') {
    const candidates=files.filter(x=>!x.name.includes('/') && x.name.endsWith('.php') && /^[ \t\/*#@]*Plugin Name\s*:/mi.test(x.bytes.toString('utf8')));
    main=candidates.find(x=>x.name===`${options.slug}.php`)?.name;
    if(!main) {requireThat(candidates.length===1,'plugin main header missing or ambiguous');main=candidates[0].name;}
  } else requireThat(files.some(x=>x.name==='style.css' && /^[ \t\/*#@]*Theme Name\s*:/mi.test(x.bytes.toString('utf8'))),'theme header missing');
  const archive=zip(files,options.slug);requireThat(archive.length<=128*1024*1024,'compressed package limit exceeded');
  const hash=createHash('sha256').update(archive).digest('hex');
  const artifact=join(output,`${options.slug}.zip`);const buildInfo=join(output,'build-info.json');
  let wroteArtifact=false;let wroteInfo=false;
  try {
    writeFileSync(artifact,archive,{flag:'wx'});wroteArtifact=true;
    validate(artifact,hash,{slug:options.slug,component:options.type,plugin_file:main??'',allow_server_config:false,protected_slugs:['deploy-agent'],target_root:'/srv/site/public/wp-content',site_php:options.sitePhp??'8.2',site_wordpress:options.siteWordpress??'6.6',installed_parents:options.installedParents??[]});
    const env=options.context??process.env;
    const source={provider:'github'};for(const [field,key] of Object.entries({repository:'GITHUB_REPOSITORY',repository_id:'GITHUB_REPOSITORY_ID',ref:'GITHUB_REF',commit_sha:'GITHUB_SHA'})) if(env[key]) source[field]=env[key];
    source.path=options.sourcePath??'.';
    const build={provider:'github-actions',run_id:env.GITHUB_RUN_ID??'local',run_attempt:Number(env.GITHUB_RUN_ATTEMPT??1)};
    if(env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) build.run_url=`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    if(env.GITHUB_WORKFLOW) build.workflow=env.GITHUB_WORKFLOW;if(env.GITHUB_ACTOR) build.actor=env.GITHUB_ACTOR;
    build.created_at=new Date().toISOString().replace(/\.[0-9]{3}Z$/,'Z');
    const mainEntry=files.find(x=>x.name===(main??'style.css'));
    const componentVersion=/^[ \t\/*#@]*Version\s*:\s*([^\r\n]+)/mi.exec(mainEntry?.bytes.toString('utf8')??'')?.[1].trim();
    writeFileSync(buildInfo,JSON.stringify({target:{type:options.type,slug:options.slug},source,build,...(componentVersion?{component_version:componentVersion}:{})},null,2)+'\n',{flag:'wx'});wroteInfo=true;
    return {artifact,sha256:hash,size:archive.length,buildInfo};
  } catch(error) {if(wroteInfo) unlinkSync(buildInfo);if(wroteArtifact) unlinkSync(artifact);throw error;}
}
