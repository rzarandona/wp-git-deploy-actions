import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build lines of the v2 website workflow (UI polish E-10). The site receives them at `POST /deploy-agent/v1/runs/progress`
 * (E-11, RunProgressBatch) and keeps them with the run.
 *
 * - The package action (input progress "true") records one `packed` event per packaged component, with the runner's clock,
 *   in progress.json beside release.zip, so the file travels to the deploy job in the same artifact. The build job runs the
 *   repository's own code, so it holds no secret and never contacts the site.
 * - The deploy job posts the file's events with its own OIDC sign-in before `POST /releases`: the only way build lines
 *   reach the site.
 *
 * An event id is the first 32 hex characters of SHA-256 over a stable string of the run and the component, so the same
 * line posted again is recognised by the site as one line.
 */
export const PROGRESS_FILE = 'progress.json';
export const PROGRESS_ROUTE = '/deploy-agent/v1/runs/progress';
/** The site's limits: 50 events per request, 64 KiB per body. */
export const MAX_EVENTS = 50;
const MAX_BYTES = 65536;
/** A release holds at most 200 components, so a build has at most 200 events. */
const MAX_FILE_EVENTS = 200;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const RUN_ATTEMPT = /^[1-9][0-9]{0,6}$/;
const RUN_ATTEMPT_MAX = 1_000_000;
const EVENT_ID = /^[0-9a-f]{16,64}$/;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const PACKED = { type: /^[a-z][a-z0-9-]{0,31}$/, slug: /^[a-z0-9][a-z0-9._-]{0,99}$/, version: /^[\x20-\x7e]{1,64}$/ };
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function safe(text) { return String(text ?? 'unknown').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 200); }
const exactKeys = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));

/** This job's run as the OIDC claims carry it (`run_id` a decimal string, `run_attempt` a number), or null outside Actions. */
export function runOf(env) {
  const runId = env.GITHUB_RUN_ID; const attempt = env.GITHUB_RUN_ATTEMPT;
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || typeof attempt !== 'string' || !RUN_ATTEMPT.test(attempt) || Number(attempt) > RUN_ATTEMPT_MAX) return null;
  return { run_id: runId, run_attempt: Number(attempt) };
}

/** The id of one `packed` event: the same run attempt and component always give the same id. */
export function packedEventId(run, { type, slug, version }) {
  const text = ['run-progress-event/1', run.run_id, String(run.run_attempt), 'packed', type, slug, version].join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/** An event as the site accepts it: exactly {id, at, kind: "packed", type, slug, version}, each within its pattern. */
export function validEvent(event) {
  return exactKeys(event, ['id', 'at', 'kind', 'type', 'slug', 'version']) && event.kind === 'packed'
    && typeof event.id === 'string' && EVENT_ID.test(event.id) && typeof event.at === 'string' && RFC3339.test(event.at)
    && Object.entries(PACKED).every(([name, pattern]) => typeof event[name] === 'string' && pattern.test(event[name]));
}

/**
 * One `packed` event per packaged component ({type, slug, version, at}). The site requires a version, so a component
 * without a Version header has no event.
 */
export function packedEvents(run, packed) {
  return packed.filter(component => component.version !== undefined).map(component => {
    const event = { id: packedEventId(run, component), at: component.at, kind: 'packed', type: component.type, slug: component.slug, version: component.version };
    requireThat(validEvent(event), `the packed event of ${safe(component.type)} ${safe(component.slug)} is not valid`);
    return event;
  });
}

/** Reads progress.json's text: {run_id, run_attempt, events}, every event valid. */
export function parseProgress(text) {
  let document;
  try { document = JSON.parse(text); } catch { throw new Error('progress.json is not JSON'); }
  requireThat(exactKeys(document, ['run_id', 'run_attempt', 'events']), 'progress.json is not a progress document');
  requireThat(typeof document.run_id === 'string' && RUN_ID.test(document.run_id), 'progress.json names no valid run');
  requireThat(Number.isSafeInteger(document.run_attempt) && document.run_attempt >= 1 && document.run_attempt <= RUN_ATTEMPT_MAX, 'progress.json names no valid run attempt');
  requireThat(Array.isArray(document.events) && document.events.length <= MAX_FILE_EVENTS && document.events.every(validEvent), 'progress.json holds an invalid event');
  return document;
}

/** The request bodies for a document's events, at most 50 events each, in order. */
export function progressBodies(document) {
  const bodies = [];
  for (let i = 0; i < document.events.length; i += MAX_EVENTS) {
    const body = Buffer.from(JSON.stringify({ run_id: document.run_id, run_attempt: document.run_attempt, events: document.events.slice(i, i + MAX_EVENTS) }));
    requireThat(body.length <= MAX_BYTES, 'a progress request would exceed 64 KiB');
    bodies.push(body);
  }
  return bodies;
}

/** The site's answer to one batch: {run_id, run_attempt, accepted, duplicates, dropped}. */
function counted(answer, totals) {
  requireThat(answer !== null && typeof answer === 'object' && ['accepted', 'duplicates', 'dropped'].every(name => Number.isSafeInteger(answer[name]) && answer[name] >= 0), 'the site gave an invalid answer');
  for (const name of ['accepted', 'duplicates', 'dropped']) totals[name] += answer[name];
}

/**
 * The package action's part: writes progress.json beside release.zip. It makes no request, never throws and logs one line.
 */
export function recordPackedProgress({ directory, packed, env = process.env }, ports = {}) {
  const log = ports.log ?? (() => {});
  const run = runOf(env);
  if (run === null) { log('progress: this is not a GitHub Actions run, so no build lines were recorded'); return null; }
  let document;
  try {
    document = { ...run, events: packedEvents(run, packed) };
    writeFileSync(join(directory, PROGRESS_FILE), JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  } catch (error) { log(`progress: no build lines were recorded (${safe(error?.message)})`); return null; }
  const count = document.events.length;
  const unversioned = packed.length - count;
  log(`progress: ${count} packed lines recorded for the deploy job${unversioned > 0 ? `; ${unversioned} without a version have no line` : ''}`);
  return document;
}

/**
 * The deploy job's part: posts progress.json's events with the job's own OIDC sign-in (`call`, the signed website client),
 * in batches of 50. A missing file is nothing to do. Any failure is one log line and the deploy goes on unchanged.
 */
export async function deliverProgress(path, call, { env = process.env, log = () => {}, end } = {}) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') log('progress: progress.json could not be read; the release goes on');
    return null;
  }
  try {
    const document = parseProgress(text);
    const run = runOf(env);
    // GitHub's "Re-run failed jobs" keeps the build job of an earlier attempt of this run, so its progress.json may name
    // that attempt. This job deploys exactly what that build packed, so the lines are sent under this job's attempt, the
    // one its sign-in names. Another run's lines, or a later attempt's, are never sent.
    requireThat(run !== null && run.run_id === document.run_id && document.run_attempt <= run.run_attempt, 'they belong to another run');
    const sent = { ...document, run_attempt: run.run_attempt };
    const totals = { accepted: 0, duplicates: 0, dropped: 0 };
    for (const bytes of progressBodies(sent)) counted(await call(PROGRESS_ROUTE, { method: 'POST', bytes, end }), totals);
    log(`progress: ${document.events.length} packed lines delivered (${totals.accepted} new, ${totals.duplicates} already there)`);
    return totals;
  } catch (error) {
    log(`progress: packed lines not delivered (${safe(error?.message)}); the release goes on`);
    return null;
  }
}

