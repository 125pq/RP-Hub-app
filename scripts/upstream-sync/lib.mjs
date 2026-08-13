import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function countOccurrences(source, needle) {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

export function requireContains(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Missing sync anchor: ${label}`);
}

export function ensureBefore(source, anchor, insertion, label) {
  const count = countOccurrences(source, insertion);
  if (count === 1) return source;
  if (count > 1) throw new Error(`Duplicate hook detected: ${label}`);
  const anchorCount = countOccurrences(source, anchor);
  if (anchorCount !== 1) throw new Error(`Expected one anchor for ${label}, found ${anchorCount}`);
  return source.replace(anchor, `${insertion}${anchor}`);
}

export function ensureAfter(source, anchor, insertion, label) {
  const count = countOccurrences(source, insertion);
  if (count === 1) return source;
  if (count > 1) throw new Error(`Duplicate hook detected: ${label}`);
  const anchorCount = countOccurrences(source, anchor);
  if (anchorCount !== 1) throw new Error(`Expected one anchor for ${label}, found ${anchorCount}`);
  return source.replace(anchor, `${anchor}${insertion}`);
}

export function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = countOccurrences(source, before);
  if (count !== 1) throw new Error(`Expected one replacement anchor for ${label}, found ${count}`);
  return source.replace(before, after);
}

export async function editText(relativePath, category, transform) {
  const absolutePath = path.join(projectRoot, relativePath);
  const before = await readFile(absolutePath, 'utf8');
  const after = transform(before);
  if (after === before) return null;
  await writeFile(absolutePath, after, 'utf8');
  return { category, file: relativePath };
}

export async function sha256File(relativePath) {
  const source = await readFile(path.join(projectRoot, relativePath));
  return createHash('sha256').update(source).digest('hex');
}

export function normalizeLines(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}
