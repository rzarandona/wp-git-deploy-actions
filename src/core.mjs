import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Dependency-free implementation of the small runner protocol used by these actions.
export const core = {
  getInput(name,{required=false,env=process.env}={}) {
    const value=env[`INPUT_${name.replaceAll(' ','_').toUpperCase()}`]??'';
    if(required && value==='') throw new Error(`required input missing: ${name}`);
    return value;
  },
  setSecret(secret,{write=x=>process.stdout.write(x)}={}) {
    if(secret) write(`::add-mask::${secret.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')}\n`);
  },
  setOutput(name,value,{env=process.env}={}) {
    if(!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error('invalid output name');
    if(!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    let delimiter;do {delimiter=randomUUID();}while(String(value).includes(delimiter));
    appendFileSync(env.GITHUB_OUTPUT,`${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  },
  summary(value) {
    if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,value);
  },
};
