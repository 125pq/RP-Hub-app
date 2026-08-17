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

// Dominant newline of a text (used for lines a patch inserts).
export function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf >= lf ? '\r\n' : '\n';
}

// Split text into lines while remembering each line's own terminator.
// Returns [{ text, term }]; the final line may have term === '' when the file
// does not end with a newline.
export function splitLinesKeepTerm(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      let contentEnd = i;
      let term = '\n';
      if (i > 0 && text[i - 1] === '\r') {
        contentEnd = i - 1;
        term = '\r\n';
      }
      lines.push({ text: text.slice(start, contentEnd), term });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), term: '' });
  return lines;
}

// Rebuild `afterNormalized` (LF-only) writing back the original EOL of each
// line that already existed in `original`; lines introduced by the patch use
// `dominantTerm`. This preserves mixed-EOL files line-by-line instead of
// rewriting the whole file to one style.
export function rebuildWithOriginalEol(original, afterNormalized, dominantTerm) {
  const origLines = splitLinesKeepTerm(original);
  const origTexts = origLines.map(line => line.text);
  const outLines = afterNormalized.split('\n');
  const parts = [];
  let origIdx = 0;
  for (let i = 0; i < outLines.length; i += 1) {
    const lineText = outLines[i];
    const isLast = i === outLines.length - 1;
    // The trailing empty element split() produces for a file ending in "\n".
    if (isLast && lineText === '' && afterNormalized.endsWith('\n')) break;
    let term;
    if (origIdx < origTexts.length && lineText === origTexts[origIdx]) {
      term = origLines[origIdx].term;
      origIdx += 1;
    } else {
      term = dominantTerm;
    }
    parts.push(lineText + term);
  }
  return parts.join('');
}

export async function editText(relativePath, category, transform) {
  const absolutePath = path.join(projectRoot, relativePath);
  const before = await readFile(absolutePath, 'utf8');
  // Patches match/insert with LF literals. Normalize to LF before the transform
  // so anchors are EOL-agnostic, then rebuild the file preserving each original
  // line's EOL so a mixed-EOL file is not rewritten to a single style.
  const normalized = before.replace(/\r\n/g, '\n');
  const afterNormalized = transform(normalized);
  if (afterNormalized === normalized) return null;
  const after = rebuildWithOriginalEol(before, afterNormalized, dominantEol(before));
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
