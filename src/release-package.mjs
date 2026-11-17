import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { dce } from '../shared/node/dce-lib.mjs';
import { canonical as canonicalExclusions, matches } from '../shared/node/exclusion-check.mjs';
import { ignored, validatePackage, zip, zipNamed } from './package.mjs';

/**
 * The build of a website release (spec §K.1 release mode, §G.1a, §I.2): no key, no site access. It detects the plugins and
 * themes under the mapped root path, leaves out what the mapping leaves out, applies the site's exclusion list with the shared
 * matcher (plus `.distignore` and `export-ignore` per component, as the per-component package does), runs the §I.2 validator
 * per component, and writes one `wp-release-zip/v1` with a `release-info.json` holding the manifest.
 *
 * Each component's `tree_sha256` is the DCE/1 `tree-index` hash of its packaged tree, as the site computes it after
 * extraction (TreeObservation over the managed index): every packaged file and every directory above one, sorted by path
 * bytes; a directory has size and sha256 null.
 */
/** A component slug (spec §I.2), and so the name of a parent theme a child theme's `Template` header can name. */
export const slugPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PROTECTED_SLUGS = ['deploy-agent', 'dagent-guard'];
const DROP_IN_NAMES = ['advanced-cache', 'db', 'db-error', 'install', 'maintenance', 'object-cache', 'php-error', 'fatal-error-handler',
  'sunrise', 'blog-deleted', 'blog-inactive', 'blog-suspended'];
const EFFECTS = ['none', 'backward_compatible', 'unknown', 'irreversible'];
const MAX_FILE = 128 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_ENTRIES = 20000;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** SourceBinding::validPath: "." or a relative path of safe characters with no empty, "." or ".." segment. */
export function validRootPath(path) {
  if (path === '.') return true;
  if (typeof path !== 'string' || path === '' || path.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every(s => s !== '' && s !== '.' && s !== '..');
}

/** The DCE/1 `tree-index` bytes and hash of a packaged component tree. `files`: [{name, bytes}] relative to the component. */
export function treeIndex(files) {
  const entries = new Map();
  for (const { name, bytes } of files) {
    entries.set(name, { type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    for (let at = name.lastIndexOf('/'); at > 0; at = name.lastIndexOf('/', at - 1)) {
      const parent = name.slice(0, at);
      if (entries.has(parent)) { requireThat(entries.get(parent).type === 'dir', 'a file collides with a directory'); break; }
      entries.set(parent, { type: 'dir' });
    }
  }
  const list = [...entries.keys()].sort(byBytes).map(path => {
    const entry = entries.get(path);
    return { t: 'map', v: [
      ['path', { t: 'bytes', v: Buffer.from(path, 'utf8').toString('hex') }],
      ['type', { t: 'string', v: entry.type }],
      ['size', entry.type === 'dir' ? { t: 'null' } : { t: 'int', v: entry.size }],
      ['sha256', entry.type === 'dir' ? { t: 'null' } : { t: 'bytes', v: entry.sha256 }],
    ] };
  });
  const bytes = dce('tree-index', { t: 'map', v: [['entries', { t: 'list', v: list }]] });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Parses and checks the gate's exclusion list: canonical text whose SHA-256 is the given hash. */
export function exclusionPatterns(text, sha256) {
  requireThat(typeof text === 'string' && /^[0-9a-f]{64}$/.test(sha256 ?? ''), 'the exclusion list and its hash are required');
  requireThat(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex') === sha256, 'the exclusion list does not match its hash');
  requireThat(text !== '' && text.endsWith('\n'), 'the exclusion list is not canonical');
  const patterns = text.slice(0, -1).split('\n');
  requireThat(canonicalExclusions(patterns) === text, 'the exclusion list is not canonical');
  return patterns;
}

function excluded(patterns, path, isDir) { return patterns.some(p => matches(p, path, isDir)); }

/** The packaged files of one component directory: the exclusion list, then `.distignore`, then `export-ignore`. */
function collect(directory, patterns, label) {
  const names = [];
  (function walk(dir, prefix) {
    for (const name of readdirSync(dir).sort(byBytes)) {
      const relativeName = prefix + name;
      const entry = join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        // Every path below a matching directory matches too, so the whole subtree is left out (ManagedIndex).
        if (!excluded(patterns, relativeName, true)) walk(entry, `${relativeName}/`);
      } else if (stat.isFile()) {
        if (!excluded(patterns, relativeName, false)) names.push(relativeName);
      } else {
        // A link or special file is refused unless the exclusion list leaves it out (a node_modules/.bin link, for example).
        requireThat(excluded(patterns, relativeName, false) || excluded(patterns, relativeName, true), `${label}/${relativeName} is a link or special file; it cannot be deployed`);
      }
    }
  })(directory, '');
  let distignore = [];
  try { distignore = readFileSync(join(directory, '.distignore'), 'utf8').split(/\r?\n/).map(x => x.trim()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let kept = names.filter(name => !ignored(name, distignore));
  let inGit = false;
  try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, stdio: 'pipe' }); inGit = true; } catch {}
  if (inGit && kept.length) {
    const attributes = execFileSync('git', ['check-attr', '-z', '--stdin', 'export-ignore'], { cwd: directory, input: kept.join('\0') + '\0', encoding: 'utf8' }).split('\0');
    const exported = new Set();
    for (let i = 0; i < attributes.length - 2; i += 3) if (attributes[i + 2] === 'set') exported.add(attributes[i]);
    kept = kept.filter(name => !exported.has(name));
  }
  return kept.sort(byBytes);
}

function header(bytes, name) { return new RegExp(`^[ \\t\\/*#@]*${name}\\s*:`, 'mi').test(bytes.toString('utf8')); }
/** A header value as WordPress reads it: the rest of the line, without a closing comment or PHP tag (_cleanup_header_comment). */
function headerValue(bytes, name) {
  const value = new RegExp(`^[ \\t\\/*#@]*${name}\\s*:\\s*([^\\r\\n]+)`, 'mi').exec(bytes.toString('utf8'))?.[1];
  return value === undefined ? undefined : value.replace(/\s*(?:\*\/|\?>).*/, '').trim() || undefined;
}

function databaseEffect(directory, fallback, label) {
  let text;
  try { text = readFileSync(join(directory, '.git-deploy.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  let effect;
  try { effect = JSON.parse(text)?.deploy?.database_effect; } catch { throw new Error(`${label}/.git-deploy.json is not valid JSON`); }
  if (effect === undefined) return fallback;
  requireThat(EFFECTS.includes(effect), `${label}/.git-deploy.json: deploy.database_effect must be one of ${EFFECTS.join(', ')}`);
  return effect;
}

function parseList(value, name) {
  if (Array.isArray(value)) return value;
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be a JSON list`); }
  requireThat(Array.isArray(parsed) && parsed.every(x => typeof x === 'string'), `${name} must be a JSON list of strings`);
  return parsed;
}

export function packageRelease(options, { validate = validatePackage, log = () => {}, now = Date.now } = {}) {
  const root = resolve(options.path ?? '.');
  const output = resolve(options.output);
  const rootPath = options.rootPath;
  requireThat(validRootPath(rootPath), 'invalid root path');
  const outRelative = relative(root, output);
  requireThat(outRelative.startsWith('..') || isAbsolute(outRelative), 'output must be outside the repository');
  const scope = parseList(options.scope, 'scope');
  requireThat(scope.length > 0 && scope.every(x => x === 'plugins' || x === 'themes'), 'invalid scope');
  const leftOut = new Set(parseList(options.excludedComponents ?? [], 'excluded components'));
  const patterns = exclusionPatterns(options.exclusions, options.exclusionsSha256);
  const fallbackEffect = options.databaseEffect ?? 'unknown';
  requireThat(EFFECTS.includes(fallbackEffect), 'invalid database effect');
  const base = rootPath === '.' ? root : join(root, ...rootPath.split('/'));
  requireThat(existsSync(base) && lstatSync(base).isDirectory() && !lstatSync(base).isSymbolicLink(), `the root path ${rootPath} is not a directory in this repository`);

  const components = [];
  const notes = [];
  for (const type of ['plugin', 'theme']) {
    if (!scope.includes(`${type}s`)) continue;
    const parent = join(base, `${type}s`);
    if (!existsSync(parent)) continue;
    const parentStat = lstatSync(parent);
    requireThat(parentStat.isDirectory() && !parentStat.isSymbolicLink(), `${rootPath}/${type}s is not a directory`);
    for (const slug of readdirSync(parent).sort(byBytes)) {
      const directory = join(parent, slug);
      const stat = lstatSync(directory);
      const label = `${type}s/${slug}`;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        requireThat(stat.isFile(), `${label} is a link or special file; it cannot be deployed`);
        notes.push(`${label}: a file, not a component directory (left out)`); continue;
      }
      const names = collect(directory, patterns, label);
      const files = names.map(name => {
        const size = lstatSync(join(directory, name)).size;
        requireThat(size <= MAX_FILE, `${label}/${name} exceeds the 128 MiB file limit`);
        return { name, bytes: readFileSync(join(directory, name)) };
      });
      let main;
      if (type === 'plugin') {
        const candidates = files.filter(x => !x.name.includes('/') && x.name.endsWith('.php') && header(x.bytes, 'Plugin Name'));
        if (candidates.length === 0) { notes.push(`${label}: no plugin header (not a component)`); continue; }
        main = candidates.find(x => x.name === `${slug}.php`) ?? (candidates.length === 1 ? candidates[0] : null);
        requireThat(main, `${label}: more than one file carries a Plugin Name header and none is ${slug}.php`);
      } else {
        main = files.find(x => x.name === 'style.css' && header(x.bytes, 'Theme Name'));
        if (!main) { notes.push(`${label}: no style.css with a Theme Name header (not a component)`); continue; }
      }
      requireThat(slugPattern.test(slug), `${label}: the directory name is not a valid slug (lowercase letters, digits, dot, underscore, hyphen)`);
      if (leftOut.has(`${type}:${slug}`)) { notes.push(`${label}: left out by the site mapping`); continue; }
      if (PROTECTED_SLUGS.includes(slug) || (type === 'plugin' && DROP_IN_NAMES.includes(slug))) { notes.push(`${label}: never deployed by Git Deploy (left out)`); continue; }
      const version = headerValue(main.bytes, 'Version');
      components.push({ type, slug, directory, files, main: main.name, label,
        version: version !== undefined && /^[\x20-\x7e]{1,64}$/.test(version) ? version : undefined,
        effect: databaseEffect(directory, fallbackEffect, label) });
    }
  }
  for (const note of notes) log(note);
  requireThat(components.length > 0, `no plugin or theme was found under ${rootPath} in the mapped scope`);
  requireThat(components.length <= 200, 'a release holds at most 200 components');
  components.sort((a, b) => a.type !== b.type ? (a.type === 'plugin' ? -1 : 1) : byBytes(a.slug, b.slug));

  // §I.2 per component, in CI: the accepted validator over each component's own tree.
  const parents = [...new Set([...(options.installedParents ?? []), ...components.filter(c => c.type === 'theme').map(c => c.slug)])];
  const scratch = mkdtempSync(join(options.scratch ?? tmpdir(), 'dagent-release-check-'));
  try {
    for (const component of components) {
      const bytes = zip(component.files, component.slug);
      const path = join(scratch, `${component.type}-${component.slug}.zip`);
      writeFileSync(path, bytes, { flag: 'wx' });
      try {
        validate(path, createHash('sha256').update(bytes).digest('hex'), { slug: component.slug, component: component.type,
          plugin_file: component.type === 'plugin' ? component.main : '', allow_server_config: false, protected_slugs: PROTECTED_SLUGS,
          target_root: '/srv/site/public/wp-content', site_php: options.sitePhp ?? '8.2', site_wordpress: options.siteWordpress ?? '6.6',
          installed_parents: parents });
      } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? '').trim().split('\n').pop();
        throw new Error(`${component.label} failed the archive rules${detail ? `: ${detail}` : ''}`);
      }
      // The runner's clock when the component was packed and passed the rules (a v2 build's "packed" line, E-10).
      component.packedAt = new Date(now()).toISOString();
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  const entries = [];
  for (const component of components) for (const file of component.files) entries.push({ name: `${component.type}s/${component.slug}/${file.name}`, bytes: file.bytes });
  entries.sort((a, b) => byBytes(a.name, b.name));
  requireThat(entries.length <= MAX_ENTRIES, 'the release exceeds 20,000 files');
  const archive = zipNamed(entries);
  requireThat(archive.length <= MAX_ARCHIVE, 'the release exceeds the 128 MiB archive limit');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const manifest = components.map(c => ({ type: c.type, slug: c.slug, tree_sha256: treeIndex(c.files).sha256,
    ...(c.version !== undefined ? { version: c.version } : {}), database_effect: c.effect }));
  const env = options.context ?? process.env;
  const info = { schema: 'git-deploy-release-info/1', artifact: { format: 'wp-release-zip/v1', file: 'release.zip', sha256, size: archive.length },
    root_path: rootPath, exclusions_sha256: options.exclusionsSha256, commit_sha: env.GITHUB_SHA ?? null, manifest: { components: manifest } };
  const artifactPath = join(output, 'release.zip');
  const infoPath = join(output, 'release-info.json');
  let wroteArtifact = false;
  try {
    writeFileSync(artifactPath, archive, { flag: 'wx' }); wroteArtifact = true;
    writeFileSync(infoPath, JSON.stringify(info, null, 2) + '\n', { flag: 'wx' });
  } catch (error) { if (wroteArtifact) unlinkSync(artifactPath); throw error; }
  const packed = components.map(c => ({ type: c.type, slug: c.slug, version: c.version, at: c.packedAt }));
  return { artifact: artifactPath, releaseInfo: infoPath, directory: output, sha256, size: archive.length, manifest, notes, packed };
}

