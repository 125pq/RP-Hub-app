import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { overlayManifest, transformOverlayBlob } from '../upstream-sync/overlay-transformers.mjs';
import { dominantEol, rebuildWithOriginalEol } from '../upstream-sync/lib.mjs';
import { patchChatLayoutCss } from '../upstream-sync/patches/patch-chat-layout.mjs';
import { patchSidebarRenderingCss } from '../upstream-sync/patches/patch-sidebar-rendering.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

export function safeRelative(file) {
  if (!file || file.includes('\\') || file.includes(':') || file.startsWith('/')
    || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe recipe/Git path: ${file}`);
  }
  return file;
}

export async function filesIn(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unsupported filesystem entry: ${file}`);
  }
  return files.sort();
}

export async function write(root, file, bytes) {
  safeRelative(file);
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}

export function transform(file, bytes) {
  const source = bytes.toString('utf8');
  if (overlayManifest.includes(file)) return Buffer.from(transformOverlayBlob(file, source));
  if (file === 'assets/css/styles.css') {
    const changed = patchSidebarRenderingCss(patchChatLayoutCss(source.replace(/\r\n/g, '\n')));
    return Buffer.from(rebuildWithOriginalEol(source, changed, dominantEol(source)));
  }
  return bytes;
}

export const transformedFiles = [...overlayManifest, 'assets/css/styles.css'];

export function classifyUpstream(file, recipe) {
  safeRelative(file);
  const root = file.split('/')[0];
  if (recipe.publishRoots.includes(root)) return 'publish';
  if (recipe.excludedUpstreamRoots.includes(root)) return 'excluded';
  throw new Error(`Unclassified upstream path: ${file}; register its publish or exclusion policy`);
}

export function assertLegacy(entry, upstream, local) {
  if (hash(upstream) !== entry.upstreamSha256 || hash(local) !== entry.localSha256) {
    throw new Error(`Legacy override drift: ${entry.file}; review or migrate this adaptation before composing`);
  }
}

export function compareBytes(file, actual, expected, allowedEol = []) {
  if (actual.equals(expected)) return 'exact';
  if (allowedEol.includes(file)
    && actual.toString('utf8').replace(/\r\n/g, '\n') === expected.toString('utf8').replace(/\r\n/g, '\n')) {
    return 'eol-only';
  }
  throw new Error(`Unexplained composition difference: ${file}`);
}

// Read only regular files, including every parent, to keep local inputs in the repository.
export async function readLocal(root, file) {
  safeRelative(file);
  let current = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Local input must be a regular repository file: ${file}`);
    }
  }
  return readFile(current);
}
