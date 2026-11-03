import { createHash, generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { signWithKey } from './signing.mjs';

/**
 * GitHub OIDC for the website workflow (Git Deploy spec v0.6.8 §K.3, D-50; Slice 10f-A A3 plan decisions 1 and 9).
 *
 * - Each job makes one ephemeral Ed25519 key. It lives only in this process and is never written or logged.
 * - Every request gets a fresh OIDC token whose audience is `{site}#dagent-k={base64url(sha256(raw public key))}`, where
 *   `{site}` is the site's canonical URL exactly as the workflow names it. A token is never reused.
 * - The request is signed with the unchanged DEPLOY-SIG-V1 canonical string by the ephemeral key, under the site's OIDC
 *   credential id, and carries the token and the public key in `X-Deploy-Oidc-Token` and `X-Deploy-Ephemeral-Key`.
 */

const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TOKEN_BYTES = 8192;
function requireThat(condition, message) { if (!condition) throw new Error(message); }

export class OidcTokenError extends Error {}

/** The per-job ephemeral key: the private KeyObject, the raw 32-byte public key and its 43-character base64url form. */
export function createEphemeralKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicB64 = publicKey.export({ format: 'jwk' }).x;
  const publicRaw = Buffer.from(publicB64, 'base64url');
  requireThat(publicRaw.length === 32 && publicRaw.toString('base64url') === publicB64, 'invalid ephemeral public key');
  return { privateKey, publicRaw, publicB64 };
}

/** base64url, unpadded, of SHA-256 over the raw 32-byte public key. */
export function keyHash(publicRaw) {
  requireThat(Buffer.isBuffer(publicRaw) && publicRaw.length === 32, 'an ephemeral public key is 32 bytes');
  return createHash('sha256').update(publicRaw).digest('base64url');
}

/** The audience the site expects: the canonical URL verbatim, then `#dagent-k=` and the key hash. */
export function audienceFor(siteUrl, publicRaw) {
  requireThat(typeof siteUrl === 'string' && siteUrl !== '' && !siteUrl.includes('#'), 'invalid site URL');
  return `${siteUrl}#dagent-k=${keyHash(publicRaw)}`;
}

/** A compact JWS as the site accepts it: three non-empty unpadded base64url segments, at most 8 KiB. */
export function tokenShape(token) {
  return typeof token === 'string' && Buffer.byteLength(token) <= MAX_TOKEN_BYTES && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Requests one new token from the runner's OIDC endpoint. Never cached and never reused: one call, one token.
 * A missing endpoint (the job lacks `permissions: id-token: write`) or a refusal fails clearly; the token is never logged.
 */
export async function requestOidcToken(audience, { env = process.env, fetch: fetchRequest = globalThis.fetch, sleep = delay, mask = () => {} } = {}) {
  const endpoint = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!endpoint || !bearer) throw new OidcTokenError('no GitHub OIDC token is available to this job: the job needs "permissions: id-token: write"');
  let url;
  try { url = new URL(endpoint); } catch { throw new OidcTokenError('the runner\'s OIDC token endpoint is not a URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new OidcTokenError('the runner\'s OIDC token endpoint is not HTTPS');
  }
  url.searchParams.set('audience', audience);
  let last = 'no response';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetchRequest(url.href, { method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch {
      last = 'network error';
      if (attempt < 3) { await sleep(1000 * attempt); continue; }
      break;
    }
    if (response.status >= 500 && attempt < 3) { await response.body?.cancel(); last = `HTTP ${response.status}`; await sleep(1000 * attempt); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new OidcTokenError(`GitHub refused the OIDC token request (HTTP ${response.status})`); }
    let token;
    try { token = (await response.json())?.value; } catch { throw new OidcTokenError('GitHub\'s OIDC token response is not JSON'); }
    if (!tokenShape(token)) throw new OidcTokenError('GitHub\'s OIDC token response holds no usable token');
    mask(token);
    return token;
  }
  throw new OidcTokenError(`could not obtain a GitHub OIDC token (${last})`);
}

/**
 * A signer for one job: every call to `sign` obtains a fresh token, a fresh nonce and the current time.
 * `credential` is the site's OIDC credential id (a ULID, the workflow's GIT_DEPLOY_CREDENTIAL).
 */
export function oidcSigner({ siteUrl, credential, allowInsecure = false, ephemeral = createEphemeralKey(), ...ports }) {
  requireThat(typeof credential === 'string' && ulid.test(credential), 'invalid OIDC credential id (GIT_DEPLOY_CREDENTIAL must be the ULID WordPress gave)');
  const audience = audienceFor(siteUrl, ephemeral.publicRaw);
  return {
    audience,
    publicKey: ephemeral.publicB64,
    async sign({ route, method = 'GET', body = Buffer.alloc(0), query = {} }) {
      const token = await requestOidcToken(audience, ports);
      const signed = signWithKey({ keyId: credential, privateKey: ephemeral.privateKey, siteUrl, allowInsecure, route, method, body, query });
      return { ...signed, headers: { ...signed.headers, 'X-Deploy-Oidc-Token': token, 'X-Deploy-Ephemeral-Key': ephemeral.publicB64 } };
    },
  };
}

/** Removes anything shaped like a JWT from text before it is shown. */
export function redactTokens(text) {
  return String(text ?? '').replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}
