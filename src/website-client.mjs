import { setTimeout as delay } from 'node:timers/promises';
import { OidcTokenError } from './oidc.mjs';

/**
 * The website workflow's machine API calls (spec §F.2, §K.1 release mode), each signed by `signer.sign` with a fresh OIDC
 * token and nonce. API redirects are refused and response-supplied links are never followed. Retries reuse the exact body.
 */
export class ApiRefusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function safe(text) { return String(text ?? 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300); }
const busy = new Set(['DEPLOYMENT_IN_PROGRESS', 'MAINTENANCE_IN_PROGRESS']);

export function websiteClient(signer, { fetch: fetchRequest = globalThis.fetch, now = Date.now, sleep = delay } = {}) {
  return async function call(route, { method = 'GET', bytes = Buffer.alloc(0), upload = null, query = {}, retry = false, end = now() + 30000 } = {}) {
    let attempt = 0;
    while (true) {
      const remaining = end - now();
      if (remaining <= 0) throw new Error('deployment wait timeout');
      // A token that cannot be obtained fails the step at once (A3 plan decision 9): it is never retried as a site error.
      const signed = await signer.sign({ route, method, body: bytes, query });
      const headers = { ...signed.headers };
      let body;
      if (upload) { body = new FormData(); body.append('artifact', new Blob([bytes], { type: 'application/zip' }), upload); }
      else if (method === 'POST' && bytes.length > 0) { body = bytes; headers['Content-Type'] = 'application/json'; }
      let response;
      try {
        response = await fetchRequest(signed.url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(upload ? 300000 : 30000, Math.ceil(remaining)))) });
      } catch (error) {
        if (error instanceof OidcTokenError) throw error;
        if (!retry || ++attempt > 8) throw new Error(`the site could not be reached (${safe(route)})`);
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 10000, Math.max(0, end - now())));
        continue;
      }
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('API redirect refused'); }
      let data;
      try {
        const text = await response.text();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('too large');
        data = JSON.parse(text);
      } catch { throw new ApiRefusal(response.status, null, `invalid API response (HTTP ${response.status})`); }
      if (response.ok) return data;
      const code = data && typeof data === 'object' ? data.code : null;
      if (retry && response.status === 409 && busy.has(code)) {
        attempt++;
        const requested = Number(response.headers.get('Retry-After'));
        const backoff = Number.isFinite(requested) && requested >= 0 ? Math.max(100, requested * 1000) : Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 10000);
        await sleep(Math.min(backoff, Math.max(0, end - now())));
        continue;
      }
      // The site's refusals use the WordPress REST error envelope {code, message, data: {status, correlation_id, details}}
      // (spec §F): the details, such as a plain reason, are inside `data`.
      const details = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data.details : null;
      const detail = details && typeof details === 'object'
        ? Object.entries(details).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => `${safe(k)}=${safe(v)}`).join(', ') : '';
      throw new ApiRefusal(response.status, code, `the site refused ${method} ${safe(route)}: ${safe(code ?? `HTTP ${response.status}`)}${detail ? ` (${detail})` : ''}`);
    }
  };
}
