import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

const headerNames = ['X-Deploy-Key-Id', 'X-Deploy-Timestamp', 'X-Deploy-Nonce', 'X-Deploy-Content-SHA256', 'X-Deploy-Signature'];
const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function decodeStrict(value, bytes) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'invalid base64url');
  const decoded = Buffer.from(value, 'base64url');
  requireThat(decoded.length === bytes && decoded.toString('base64url') === value, 'noncanonical base64url');
  return decoded;
}
export function privateKey(token) {
  const match = /^dak1\.([0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
  requireThat(match && match[0] === token, 'invalid deployment credential');
  const seed = decodeStrict(match[2], 32);
  try {
    return { id: match[1], key: createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format:'der', type:'pkcs8' }) };
  } finally { seed.fill(0); }
}

/** Same reject-only grammar as the accepted PHP SigningGrammar; fixture host_header is never read. */
export function canonicalRequest(r) {
  requireThat(r.method === 'GET' || r.method === 'POST', 'invalid method');
  requireThat(!(r.override_headers ?? []).some(x => x.toLowerCase() === 'x-http-method-override'), 'method override');
  const headers = new Map();
  for (const [name, value] of r.headers) {
    const canonical = headerNames.find(x => x.toLowerCase() === name.toLowerCase());
    if (!canonical) continue;
    requireThat(!headers.has(canonical) && typeof value === 'string' && value.length > 0 &&
      /^[\x20-\x7e]+$/.test(value) && value.trim() === value && !value.includes(','), 'invalid signed header');
    headers.set(canonical, value);
  }
  requireThat(headerNames.every(x => headers.has(x)), 'missing signed header');
  const id = headers.get(headerNames[0]);
  const timestamp = headers.get(headerNames[1]);
  const nonce = headers.get(headerNames[2]);
  requireThat(ulid.test(id), 'invalid key id');
  requireThat(/^[1-9][0-9]{9,10}$/.test(timestamp), 'invalid timestamp');
  requireThat(r.now - Number(timestamp) <= 300 && Number(timestamp) - r.now <= 60, 'clock skew');
  decodeStrict(nonce, 32);
  decodeStrict(headers.get(headerNames[4]), 64);
  requireThat(/^[0-9a-f]{64}$/.test(r.body_sha256), 'invalid body hash');
  requireThat(r.content_literal === undefined || r.content_literal === 'oversize-canary', 'invalid hash exception');
  requireThat(r.content_literal === undefined ? /^[0-9a-f]{64}$/.test(headers.get(headerNames[3])) : headers.get(headerNames[3]) === r.content_literal, 'invalid hash header');
  requireThat(typeof r.canonical_host === 'string' && /^[\x20-\x7e]+$/.test(r.canonical_host), 'invalid canonical host');
  const query = new Map();
  for (const pair of r.query_string === '' ? [] : r.query_string.split('&')) {
    requireThat(pair.split('=').length === 2, 'invalid query pair');
    const [name, value] = pair.split('=');
    requireThat(/^[a-z_]{1,32}$/.test(name) && !query.has(name) && name !== '_method' && name !== '_envelope', 'invalid query key');
    requireThat(name === 'rest_route' || /^[A-Za-z0-9._~-]{0,128}$/.test(value), 'invalid query value');
    query.set(name, value);
  }
  const route = query.get('rest_route');
  requireThat(typeof route === 'string' && /^\/deploy-agent\/v1(?:\/[a-z0-9_-][a-z0-9._-]*)+$/.test(route) && Object.hasOwn(r.route_allowlist, route), 'invalid route');
  query.delete('rest_route');
  for (const [name, value] of query) requireThat(r.route_allowlist[route].includes(name) && (value !== '' || (r.empty_allowed ?? []).includes(name)), 'query not allowed');
  const canonicalQuery = [...query.keys()].sort().map(name => `${name}=${query.get(name)}`).join('&');
  return ['DEPLOY-SIG-V1', r.canonical_host, id, timestamp, nonce, r.method, route, canonicalQuery, r.content_literal ?? r.body_sha256].join('\n');
}

export function signRequest({key, ...request}) {
  const credential = privateKey(key);
  return signWithKey({keyId: credential.id, privateKey: credential.key, ...request});
}

/**
 * DEPLOY-SIG-V1 with an already-loaded Ed25519 key: the stored dak1 key of the per-component client, or the website
 * workflow's per-job ephemeral key under the site's OIDC credential id (spec v0.6.8 §K.3). The canonical string is the same.
 */
export function signWithKey({keyId, privateKey: signingKey, siteUrl, route, method = 'GET', body = Buffer.alloc(0), query = {}, timestamp = Math.floor(Date.now()/1000), nonce = randomBytes(32).toString('base64url'), allowInsecure = false, contentHash}) {
  requireThat(typeof keyId === 'string' && ulid.test(keyId), 'invalid key id');
  const url = new URL(siteUrl);
  requireThat((url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:')) && !url.username && !url.password && !url.search && !siteUrl.includes('#') && !url.hostname.endsWith('.'), 'invalid site URL');
  requireThat(/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(url.host), 'invalid site host');
  requireThat(method !== 'GET' || body.length === 0, 'GET body is forbidden');
  let allowed = [];
  const agent = method === 'GET' && route === '/deploy-agent/v1/agent';
  const status = method === 'GET' && /^\/deploy-agent\/v1\/deployments\/[1-9][0-9]*$/.test(route);
  const create = method === 'POST' && route === '/deploy-agent/v1/deployments' && body.length > 0;
  const artifact = method === 'POST' && /^\/deploy-agent\/v1\/deployments\/[1-9][0-9]*\/artifact$/.test(route) && body.length > 0;
  const cancel = method === 'POST' && /^\/deploy-agent\/v1\/deployments\/[1-9][0-9]*\/cancel$/.test(route) && body.length === 0;
  const canary = method === 'POST' && route === '/deploy-agent/v1/edge-canary';
  const report = method === 'POST' && route === '/deploy-agent/v1/edge-report' && body.length > 0;
  // v0.5.0: the bound-site gate reads its target's binding (Git Deploy spec §K.10).
  const target = method === 'GET' && /^\/deploy-agent\/v1\/targets\/(?:plugin|theme)\/[a-z0-9][a-z0-9._-]{0,99}$/.test(route);
  // v0.6.0 (D-46): the website workflow reads the site mapping and creates a release (spec §F.2, §K.1 release mode).
  const site = method === 'GET' && route === '/deploy-agent/v1/site';
  const release = method === 'POST' && route === '/deploy-agent/v1/releases' && body.length > 0;
  requireThat(agent || status || create || artifact || cancel || canary || report || target || site || release, 'unsupported signed request');
  if (status) { allowed = ['events_after']; requireThat(query.events_after === undefined || /^[0-9]+$/.test(String(query.events_after)), 'invalid event cursor'); }
  requireThat(contentHash === undefined || (canary && contentHash === 'oversize-canary'), 'invalid hash exception');
  const hash = createHash('sha256').update(body).digest('hex');
  const headers = Object.fromEntries(headerNames.map((name, i) => [name, [keyId, String(timestamp), nonce, contentHash ?? hash, Buffer.alloc(64).toString('base64url')][i]]));
  const rawQuery = [`rest_route=${route}`, ...Object.entries(query).map(([name, value]) => `${name}=${value}`)].join('&');
  const canonical = canonicalRequest({method, query_string:rawQuery, headers:Object.entries(headers), body_sha256:hash, now:timestamp, canonical_host:url.host, route_allowlist:{[route]:allowed}, content_literal:contentHash});
  headers['X-Deploy-Signature'] = sign(null, Buffer.from(canonical), signingKey).toString('base64url');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/index.php`;
  // URLSearchParams would percent-encode rest_route, violating the signed grammar.
  url.search = rawQuery;
  return {url:url.href, method, headers, canonical};
}

export function artifactParts(parts) {
  requireThat(parts.length === 1 && parts[0].name === 'artifact' && typeof parts[0].filename === 'string' && parts[0].filename !== '', 'exactly one artifact file is required');
}
