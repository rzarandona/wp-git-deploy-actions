import { createHash } from 'node:crypto';
import { canonical as canonicalExclusions } from '../shared/node/exclusion-check.mjs';
import { oidcSigner } from './oidc.mjs';
import { websiteClient } from './website-client.mjs';
import { slugPattern, validRootPath } from './release-package.mjs';
import { websiteDispatch } from './website-dispatch.mjs';

/**
 * The website workflow's gate (spec §K.1 release mode, §F.2 GET /site; OIDC per §K.3). It reads the site's capabilities
 * (`GET /agent`, for the environment the release must name) and the site mapping (`GET /site`), and passes the mapping to
 * the key-free build as job outputs. The site's intake (§F.2 step 5b) stays authoritative; this only decides whether a run
 * builds at all and what it builds against.
 */
/** The most installed themes a site lists (InstalledThemes::MAX_LISTED). */
const MAX_INSTALLED_THEMES = 200;
function requireThat(condition, message) { if (!condition) throw new Error(message); }

/** Checks the `GET /site` document (SiteDocument::of) and returns what the build needs. */
export function readSiteDocument(site) {
  requireThat(site !== null, 'this site has no mapping yet: finish Import in WordPress first');
  requireThat(site && typeof site === 'object' && !Array.isArray(site), 'the site returned an invalid site document');
  requireThat(site.verified === true, 'the site mapping does not verify on the site; open Git Deploy in WordPress');
  requireThat(site.provider === 'github', 'the site mapping is not for GitHub');
  requireThat(typeof site.repository_id === 'string' && /^[0-9]{1,20}$/.test(site.repository_id), 'the site reported an invalid repository');
  requireThat(typeof site.branch === 'string' && site.branch !== '', 'the site reported an invalid branch');
  requireThat(validRootPath(site.root_path), 'the site reported an invalid root path');
  requireThat(Array.isArray(site.scope) && site.scope.length > 0 && site.scope.every(x => x === 'plugins' || x === 'themes') && new Set(site.scope).size === site.scope.length, 'the site reported an invalid scope');
  requireThat(Array.isArray(site.excluded_components) && site.excluded_components.every(x => typeof x === 'string' && /^(?:plugin|theme):/.test(x) && slugPattern.test(x.slice(x.indexOf(':') + 1))), 'the site reported invalid excluded components');
  requireThat(Number.isSafeInteger(site.epoch) && site.epoch >= 1, 'the site reported an invalid mapping epoch');
  requireThat(typeof site.automatic === 'boolean', 'the site reported an invalid automatic-deployment setting');
  requireThat(typeof site.review_state === 'string', 'the site reported an invalid review state');
  // A preview before the first release is applied (awaiting_apply until the plan is confirmed, then apply; §K.8a as
  // amended 20 October 2026); apply after it. A preview is never claimed once released, nor apply before any preview.
  const allowed = { pending_preview: ['preview'], awaiting_apply: ['preview', 'apply'], released: ['apply'] }[site.review_state] ?? [];
  requireThat(allowed.includes(site.mode), 'the site reported an inconsistent mode');
  requireThat(typeof site.exclusions === 'string' && typeof site.exclusions_sha256 === 'string' && /^[0-9a-f]{64}$/.test(site.exclusions_sha256), 'the site reported no exclusion list');
  requireThat(createHash('sha256').update(Buffer.from(site.exclusions, 'utf8')).digest('hex') === site.exclusions_sha256, 'the exclusion list does not match its hash');
  requireThat(site.exclusions !== '' && site.exclusions.endsWith('\n') && canonicalExclusions(site.exclusions.slice(0, -1).split('\n')) === site.exclusions, 'the exclusion list is not canonical');
  // The themes installed on the site, which a child theme in the repository may name as its parent although the repository
  // does not hold it (17 November 2026, run 44066374405). An older site does not list them: none.
  const installed = Object.hasOwn(site, 'installed_themes') ? site.installed_themes : [];
  requireThat(Array.isArray(installed) && installed.length <= MAX_INSTALLED_THEMES && installed.every(x => typeof x === 'string' && slugPattern.test(x))
    && new Set(installed).size === installed.length, 'the site reported invalid installed themes');
  return {
    mode: site.mode, root_path: site.root_path, scope: site.scope, excluded_components: site.excluded_components, exclusions: site.exclusions,
    exclusions_sha256: site.exclusions_sha256, mapping_epoch: site.epoch, automatic: site.automatic,
    repository_id: site.repository_id, branch: site.branch, installed_themes: installed,
  };
}

export async function websiteGate(options, ports = {}) {
  const { siteUrl, credential, allowInsecure = false, env = process.env } = options;
  const eventName = env.GITHUB_EVENT_NAME;
  requireThat(typeof eventName === 'string' && eventName !== '', 'the workflow event is unknown');
  requireThat(['push', 'workflow_dispatch'].includes(eventName), `the website workflow does not deploy on ${eventName}`);
  const binding = websiteDispatch({ ...options, env });
  const signer = oidcSigner({ siteUrl, credential, allowInsecure, env, ...ports });
  const call = websiteClient(signer, ports);
  const agent = await call('/deploy-agent/v1/agent', { retry: true });
  requireThat(typeof agent.environment === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(agent.environment), 'the site reported an invalid environment');
  const site = readSiteDocument(await call('/deploy-agent/v1/site', { retry: true }));
  // The site refuses these too (A3 plan decision 10); checking here explains the failure in the run.
  if (env.GITHUB_REPOSITORY_ID) requireThat(env.GITHUB_REPOSITORY_ID === site.repository_id, 'this repository is not the one the site is mapped to');
  if (env.GITHUB_REF) requireThat(env.GITHUB_REF === `refs/heads/${site.branch}`, `this run is not on the mapped branch (${site.branch})`);
  // The site's runtime (x.y or x.y.z), so the build checks "Requires PHP" and "Requires at least" against this site.
  // An older site that does not report it leaves the build's defaults.
  const platform = agent.platform ?? null;
  const version = (v) => typeof v === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/.test(v);
  requireThat(platform === null || (typeof platform === 'object' && version(platform.php) && version(platform.wordpress)), 'the site reported an invalid platform');
  const dispatch = eventName === 'workflow_dispatch';
  const proceed = dispatch || site.automatic;
  return {
    proceed, reason: dispatch ? 'dispatch' : site.automatic ? 'automatic' : 'automatic-off', environment: agent.environment,
    mode: site.mode, root_path: site.root_path, scope: site.scope, excluded_components: site.excluded_components,
    exclusions: site.exclusions, exclusions_sha256: site.exclusions_sha256, mapping_epoch: site.mapping_epoch,
    site_php: platform?.php ?? '', site_wordpress: platform?.wordpress ?? '', installed_parents: site.installed_themes,
    commit_sha: binding?.commit ?? env.GITHUB_SHA,
  };
}
