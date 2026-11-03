#!/usr/bin/env node
import { generateCredential, proofOfPossession } from '../src/keygen.mjs';
try {
  if(process.argv.length===2) process.stdout.write(`${JSON.stringify(generateCredential(),null,2)}\n`);
  else if(process.argv.length===5 && process.argv[2]==='pop') process.stdout.write(`${JSON.stringify(proofOfPossession(process.env.DAGENT_KEY,process.argv[3],process.argv[4]),null,2)}\n`);
  else throw new Error('invalid invocation');
} catch {process.stderr.write('Usage: keygen.mjs (private output, off-site only), or DAGENT_KEY=… keygen.mjs pop SITE_UUID CHALLENGE\n');process.exitCode=1;}
