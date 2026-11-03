// Independent Node implementation of the exclusion-list/v1 matcher (spec §K.8a),
// checked against contracts/exclusions/match-vectors.json. deploy-actions uses the
// same algorithm in its `release` packaging mode; the PHP site implementation is
// Core\Release\ExclusionList. Both must agree on every vector. Dev tool only.
//
// Matching is over the UTF-8 bytes of the path (Gatekeeper S2): the path is
// re-read as one character per byte, so `?` matches one byte and `*` a run of
// bytes, exactly as PHP sees them. No regular expression is used anywhere in
// matching: the anchored walk is a dynamic programme over (pattern segment,
// path segment) and one segment is matched by a dynamic programme over
// (pattern byte, subject byte), so the cost is bounded by pattern bytes × path
// bytes whatever the pattern repeats (Gatekeeper S4 and its re-review).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_PATTERN_BYTES = 200;

export function validatePattern(p) {
  if (p === '') return 'empty';
  if (Buffer.byteLength(p, 'utf8') > MAX_PATTERN_BYTES) return 'too_long';
  for (const ch of p) {
    const c = ch.codePointAt(0);
    if (c < 0x21 || c > 0x7e || ch === '!' || ch === '\\' || ch === '[' || ch === ']') return 'character';
  }
  let body = p.startsWith('/') ? p.slice(1) : p;
  if (body.endsWith('/')) body = body.slice(0, -1);
  if (body === '') return 'matches_everything';
  const segments = body.split('/');
  if (segments.some((s) => s === '')) return 'empty_segment';
  if (segments.some((s) => s === '.' || s === '..')) return 'dot_segment';
  if (segments.some((s) => s.includes('**') && s !== '**')) return 'double_star_in_segment';
  if (p.endsWith('/') && segments[segments.length - 1] === '**') return 'double_star_dir';
  if (![...body].some((c) => c !== '*' && c !== '?' && c !== '/')) return 'matches_everything';
  return null;
}

// One pattern segment against one path segment, byte by byte: the subject is the latin1 view of the
// UTF-8 bytes (one character per byte) and the pattern is ASCII. `?` is any one byte, `*` any run of
// bytes (a segment never contains a slash), anything else only itself. A dynamic programme over
// (pattern byte, subject byte): reach[j] says whether the pattern bytes read so far can match the
// first j subject bytes, so the work is at most pattern.length × (subject.length + 1) steps whatever
// the pattern repeats — no RegExp, no backtracking (Gatekeeper S4, re-review).
export function segmentMatches(pattern, subject) {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === subject;
  const n = subject.length;
  let reach = new Array(n + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < pattern.length; i++) {
    const byte = pattern.charCodeAt(i);
    const next = new Array(n + 1).fill(false);
    if (byte === 0x2a) { // *
      let running = false;
      for (let j = 0; j <= n; j++) { running = running || reach[j]; next[j] = running; }
    } else {
      for (let j = 0; j < n; j++) if (reach[j] && (byte === 0x3f || subject.charCodeAt(j) === byte)) next[j + 1] = true; // ? or the byte itself
    }
    if (!next.includes(true)) return false; // nothing read so far can match any prefix: no later byte can revive it
    reach = next;
  }
  return reach[n];
}

const bytesView = (path) => Buffer.from(path, 'utf8').toString('latin1');

export function matches(pattern, path, isDir) {
  if (validatePattern(pattern) !== null) throw new Error('invalid pattern: ' + pattern);
  if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('\0')) throw new Error('exclusion match needs a relative path');
  const segs = bytesView(path).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new Error('exclusion match needs a relative path');
  const dirOnly = pattern.endsWith('/');
  let body = dirOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.startsWith('/') || body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  const n = segs.length;
  if (!anchored) {
    for (let i = 0; i < n; i++) {
      if (segmentMatches(body, segs[i])) {
        const atDir = i < n - 1 || isDir;
        if (!dirOnly || atDir) return true;
      }
    }
    return false;
  }
  for (const k of ends(body.split('/'), segs)) {
    if (k === 0) continue;
    if (k < n) return true;
    if (!dirOnly || isDir) return true;
  }
  return false;
}

// Every number of path segments the anchored pattern can consume from the start (dynamic programme).
function ends(parts, segs) {
  const n = segs.length;
  let reach = new Array(n + 1).fill(false);
  reach[0] = true;
  parts.forEach((part, pi) => {
    const next = new Array(n + 1).fill(false);
    if (part === '**') {
      const offset = pi === parts.length - 1 ? 1 : 0; // a trailing ** needs at least one segment
      let running = false;
      for (let k = 0; k <= n; k++) {
        if (k - offset >= 0 && reach[k - offset]) running = true;
        next[k] = running;
      }
    } else {
      for (let si = 0; si < n; si++) if (reach[si] && segmentMatches(part, segs[si])) next[si + 1] = true;
    }
    reach = next;
  });
  const out = [];
  reach.forEach((r, k) => { if (r) out.push(k); });
  return out;
}

export function canonical(patterns) {
  const seen = [];
  for (const p of patterns) {
    const why = validatePattern(p);
    if (why !== null) throw new Error(`invalid pattern (${why}): ${p}`);
    if (!seen.includes(p)) seen.push(p);
  }
  seen.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return seen.map((p) => p + '\n').join('');
}

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node exclusion-check.mjs contracts/exclusions/match-vectors.json'); process.exit(2); }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  let failures = 0;
  let slowest = 0;
  for (const v of doc.vectors) {
    const start = performance.now();
    const got = matches(v.pattern, v.path, v.dir);
    const ms = performance.now() - start;
    slowest = Math.max(slowest, ms);
    if (got !== v.match) { console.log(`FAIL ${v.id}: ${v.pattern} vs ${v.path} (dir=${v.dir}) → ${got}, expected ${v.match}`); failures++; }
    // An alarm, not the mechanism: the matcher is bounded by construction (exclusion-match.test.mjs exercises the adversarial cases directly).
    if (ms > 250) { console.log(`FAIL ${v.id}: one match took ${ms.toFixed(1)} ms; matching must stay bounded by pattern bytes × path bytes`); failures++; }
  }
  for (const i of doc.invalid_patterns) {
    const got = validatePattern(i.pattern);
    if (got !== i.refusal) { console.log(`FAIL invalid ${i.id}: refusal ${got}, expected ${i.refusal}`); failures++; }
  }
  for (const c of doc.canonical) {
    const text = canonical(c.input);
    if (text !== c.text || sha256(text) !== c.sha256) { console.log(`FAIL canonical ${c.id}`); failures++; }
  }
  const list = JSON.parse(readFileSync(new URL('../../contracts/exclusions/exclusion-list-v1.json', import.meta.url), 'utf8'));
  const defaults = list.groups.filter((g) => g.fixed || g.default_enabled).flatMap((g) => g.patterns);
  if (sha256(canonical(defaults)) !== list.default_canonical_sha256) { console.log('FAIL default_canonical_sha256 does not match the groups'); failures++; }
  console.log(failures === 0
    ? `EXCLUSIONS OK (${doc.vectors.length} vectors, ${doc.invalid_patterns.length} refusals, ${doc.canonical.length} canonical forms; slowest match ${slowest.toFixed(2)} ms)`
    : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
