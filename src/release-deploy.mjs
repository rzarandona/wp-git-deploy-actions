import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { oidcSigner } from './oidc.mjs';
import { validateSchema } from './schema.mjs';
import { websiteClient } from './website-client.mjs';
import { websiteDispatch } from './website-dispatch.mjs';

/**
 * The website release deploy job (spec §K.1 release mode, §F.2 POST /releases, §F.3a; OIDC per §K.3).
 * It signs `release-request/v1` from release-info.json and the gate's mapping epoch and exclusion hash, with
 * `options.dry_run = (mode == preview)`; uploads the `wp-release-zip/v1`; polls with a fresh token per request; and writes
 * one summary with the site's plan. It exits non-zero unless the release ends SUCCEEDED.
 */
const schema = JSON.parse(readFileSync(new URL('../contracts/schemas/release-request-v1.schema.json', import.meta.url)));
const terminal = new Set(['SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'CANCELLED', 'EXPIRED']);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The workflow file path from GITHUB_WORKFLOW_REF (`{owner}/{repo}/.github/workflows/git-deploy.yml@refs/heads/main`). */
function workflowPath(env) {
  const ref = env.GITHUB_WORKFLOW_REF;
  const repository = env.GITHUB_REPOSITORY;
  if (typeof ref === 'string' && typeof repository === 'string' && ref.startsWith(`${repository}/`) && ref.includes('@')) {
    return ref.slice(repository.length + 1, ref.lastIndexOf('@'));
  }
  return env.GITHUB_WORKFLOW;
}

/**
 * The exact request body. Its `source` and `build` members come from the run's own context, which is what the OIDC token
 * claims: the site refuses any difference (CLAIMS_MISMATCH, §K.3).
 */
export function buildReleaseRequest({ releaseInfo, mappingEpoch, exclusionsSha256, environment, mode, dispatchRequestId, dispatchCommit, env = process.env }) {
  const binding = websiteDispatch({ dispatchRequestId, dispatchCommit, env });
  requireThat(mode === 'preview' || mode === 'apply', 'the release mode must be preview or apply');
  requireThat(releaseInfo?.schema === 'git-deploy-release-info/1', 'release-info.json is not a website release');
  requireThat(releaseInfo.exclusions_sha256 === exclusionsSha256, 'the build applied another exclusion list than the gate read');
  const epoch = typeof mappingEpoch === 'string' && /^[1-9][0-9]{0,15}$/.test(mappingEpoch) ? Number(mappingEpoch) : mappingEpoch;
  requireThat(Number.isSafeInteger(epoch) && epoch >= 1, 'invalid mapping epoch');
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_ACTOR']) {
    requireThat(typeof env[name] === 'string' && env[name] !== '', `${name} is not set; run this in GitHub Actions`);
  }
  requireThat(releaseInfo.commit_sha === env.GITHUB_SHA, 'release-info.json was built from another commit');
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireThat(/^[1-9][0-9]{0,6}$/.test(env.GITHUB_RUN_ATTEMPT), 'invalid GITHUB_RUN_ATTEMPT');
  const workflow = workflowPath(env);
  const request = {
    schema: 'release-request/v1',
    request_id: binding?.requestId ?? `gh-${env.GITHUB_RUN_ID}-${attempt}-site`,
    environment,
    mapping: { epoch, exclusions_sha256: exclusionsSha256 },
    artifact: { format: 'wp-release-zip/v1', sha256: releaseInfo.artifact?.sha256, size: releaseInfo.artifact?.size },
    manifest: { components: releaseInfo.manifest?.components },
    source: { provider: 'github', repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID, ref: env.GITHUB_REF, commit_sha: env.GITHUB_SHA, path: releaseInfo.root_path },
    build: { provider: 'github-actions', run_id: env.GITHUB_RUN_ID, run_attempt: attempt, ...(typeof workflow === 'string' && /^[\x20-\x7e]{1,255}$/.test(workflow) ? { workflow } : {}), actor: env.GITHUB_ACTOR },
    options: { dry_run: mode === 'preview' },
  };
  validateSchema(request, schema);
  const components = request.manifest.components;
  for (let i = 1; i < components.length; i++) {
    const [a, b] = [components[i - 1], components[i]];
    const order = a.type !== b.type ? (a.type === 'plugin' ? -1 : 1) : byBytes(a.slug, b.slug);
    requireThat(order < 0, 'the manifest must be sorted (plugins, then themes, by slug) with no duplicate');
  }
  const body = Buffer.from(JSON.stringify(request));
  requireThat(body.length <= 64 * 1024, 'the release request exceeds 64 KiB');
  return { request, body };
}

function safe(text) { return String(text ?? 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]'); }
function escape(text) { return safe(text).replace(/[&<>"'`*\[\]\\_|]/g, c => `&#${c.charCodeAt(0)};`); }

/** One job summary per release: the state and the plan the site computed (`release.plan`, release-plan/v1). */
export function releaseSummary(resource, { mode, commit } = {}) {
  const plan = resource?.release?.plan;
  const recovery = resource?.recovery ?? {};
  const state = resource?.state === 'ROLLED_BACK' ? `rolled back — ${recovery.application === 'operational' ? 'operational' : 'needs attention'}` : resource?.state;
  const lines = [`### Git Deploy website ${mode === 'preview' ? 'preview' : 'release'}`, '',
    `Deployment: ${escape(resource?.number ?? resource?.id)}`, '', `Result: ${escape(state)}`, '', `Commit: ${escape(commit)}`, ''];
  if (plan && typeof plan === 'object' && Array.isArray(plan.components)) {
    lines.push('| Component | Change | Version | Database effect | Kept on the site |', '|---|---|---|---|---|');
    for (const c of plan.components) {
      const version = c.action === 'update' ? `${escape(c.from_version ?? '?')} → ${escape(c.to_version ?? '?')}` : escape(c.to_version ?? c.from_version ?? '');
      lines.push(`| ${escape(c.type)} ${escape(c.slug)}${c.active ? ' (active)' : ''} | ${escape(c.action)} | ${version} | ${escape(c.database_effect ?? '')} | ${Array.isArray(c.preserved_paths) ? c.preserved_paths.length : 0} paths |`);
    }
    lines.push('');
    for (const r of Array.isArray(plan.refusals) ? plan.refusals : []) lines.push(`Refused: ${escape(r.type)} ${escape(r.slug)} — ${escape(r.code)}`, '');
    if (plan.unmanaged) lines.push(`Not managed by Git Deploy: ${escape(plan.unmanaged.plugins)} plugins, ${escape(plan.unmanaged.themes)} themes`, '');
    lines.push(`Release database effect (asserted): ${escape(plan.database_effect)}`, '', `Plan: ${escape(plan.consequential_sha256)}`, '');
  } else lines.push('The site reported no plan.', '');
  if (mode === 'preview' && resource?.state === 'SUCCEEDED') lines.push('This was a preview: nothing on the site changed. Review it and apply it in WordPress.', '');
  lines.push('Database and external side effects are never claimed to be reversed.', '');
  return lines.join('\n');
}

export async function deployRelease(options, ports = {}) {
  const { fetch: fetchRequest = globalThis.fetch, now = Date.now, sleep = delay, log = () => {}, summary = () => {}, env = process.env } = ports;
  const seconds = options.waitTimeout ?? 600;
  requireThat(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600, 'invalid wait timeout');
  requireThat(Buffer.isBuffer(options.artifact) && options.artifact.length > 0, 'the release archive is required');
  const sha256 = createHash('sha256').update(options.artifact).digest('hex');
  requireThat(options.releaseInfo?.artifact?.sha256 === sha256 && options.releaseInfo.artifact.size === options.artifact.length, 'the release archive does not match release-info.json');
  requireThat(typeof options.environment === 'string' && options.environment !== '', 'the site environment is required');
  const { request, body } = buildReleaseRequest({ releaseInfo: options.releaseInfo, mappingEpoch: options.mappingEpoch, exclusionsSha256: options.exclusionsSha256,
    environment: options.environment, mode: options.mode, dispatchRequestId: options.dispatchRequestId, dispatchCommit: options.dispatchCommit, env });
  const signer = oidcSigner({ siteUrl: options.siteUrl, credential: options.credential, allowInsecure: options.allowInsecure === true, env, fetch: fetchRequest, sleep, mask: ports.mask });
  const deadline = now() + seconds * 1000;
  const call = websiteClient(signer, { fetch: fetchRequest, now, sleep });
  let id; let resource; let after = 0;
  try {
    const agent = await call('/deploy-agent/v1/agent', { retry: true, end: deadline });
    requireThat(agent.environment === options.environment, 'the site environment changed since the gate read it');
    const limit = agent.limits?.compressed_artifact_bytes;
    requireThat(Number.isSafeInteger(limit) && options.artifact.length <= limit, 'the release archive exceeds the site\'s limit');
    requireThat(Number.isSafeInteger(agent.server_time) && Math.abs(Math.floor(now() / 1000) - agent.server_time) <= 60, 'the site clock differs from this runner\'s by more than 60 seconds');
    resource = await call('/deploy-agent/v1/releases', { method: 'POST', bytes: body, retry: true, end: deadline });
    id = resource.number ?? resource.id;
    requireThat(Number.isSafeInteger(id) && id > 0, 'invalid deployment number');
    log(`release ${id}: ${request.options.dry_run ? 'preview' : 'apply'} of ${request.manifest.components.length} components`);
    if (resource.artifact?.upload_required === true) {
      resource = await call(`/deploy-agent/v1/deployments/${id}/artifact`, { method: 'POST', bytes: options.artifact, upload: 'release.zip', retry: true, end: deadline });
    }
    while (!terminal.has(resource.state)) {
      resource = await call(`/deploy-agent/v1/deployments/${id}`, { query: { events_after: String(after) }, retry: true, end: deadline });
      for (const event of resource.events ?? []) {
        requireThat(Number.isSafeInteger(event.seq) && event.seq > after, 'invalid event sequence');
        after = event.seq; log(`event: ${safe(event.message)}`);
      }
      if (!terminal.has(resource.state)) await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
    summary(releaseSummary(resource, { mode: options.mode, commit: request.source.commit_sha }));
    requireThat(resource.state === 'SUCCEEDED', `the release ended ${safe(resource.state)}`);
    return resource;
  } catch (error) {
    const localFailure = !terminal.has(resource?.state);
    if (id && localFailure) {
      try {
        const cancelled = await call(`/deploy-agent/v1/deployments/${id}/cancel`, { method: 'POST', end: now() + 10000 });
        if ((cancelled.number ?? cancelled.id) === id) resource = cancelled;
      } catch { log('cancel: the site did not confirm cancellation; inspect the release in WordPress'); }
    }
    if (localFailure) summary(`### Git Deploy client stopped\n\nRequest: ${escape(request.request_id)}\n\nReason: ${escape(error.message)}\n\nLast observed state: ${escape(resource?.state)}\n\nCancellation is confirmed only if the last observed state is CANCELLED.\n`);
    throw error;
  }
}
