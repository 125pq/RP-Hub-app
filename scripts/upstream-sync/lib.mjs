import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Files maintained locally (not synced from upstream). The EOL churn guards
// skip these entirely: their line endings are ours to manage and never conflict
// with an upstream merge, so whole-file EOL/whitespace churn here is not a
// merge risk. Keep this list in sync with the upstream/local boundary.
export const LOCAL_FILES = new Set(['README.md']);

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

// Myers O(ND) diff over line texts. Returns an ordered list of operations:
// { type: 'equal', aIndex, bIndex } | { type: 'delete', aIndex } | { type: 'insert', bIndex }.
function diffLineTexts(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map();
  const trace = [];
  v.set(1, 0);
  for (let d = 0; d <= max; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
        x = v.get(k + 1) ?? -1;
      } else {
        x = (v.get(k - 1) ?? -1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrackDiff(trace, a, b, d);
    }
  }
  return [];
}

function backtrackDiff(trace, a, b, d) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let dd = d; dd > 0; dd -= 1) {
    const v = trace[dd];
    const k = x - y;
    let prevK;
    if (k === -dd || (k !== dd && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) ?? -1;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', aIndex: x - 1, bIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: 'insert', bIndex: y - 1 });
      y -= 1;
    } else {
      ops.push({ type: 'delete', aIndex: x - 1 });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', aIndex: x - 1, bIndex: y - 1 });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    ops.push({ type: 'delete', aIndex: x - 1 });
    x -= 1;
  }
  while (y > 0) {
    ops.push({ type: 'insert', bIndex: y - 1 });
    y -= 1;
  }
  ops.reverse();
  return ops;
}

// Rebuild `afterNormalized` (LF-only) writing back the original EOL of each
// line that already existed in `original`; lines introduced by the patch use
// `dominantTerm`. This preserves mixed-EOL files line-by-line instead of
// rewriting the whole file to one style. Matching is position-based (via a
// line diff) so that a patch which *modifies* an existing line does not
// desynchronize the EOL mapping and rewrite every following line.
export function rebuildWithOriginalEol(original, afterNormalized, dominantTerm) {
  const origLines = splitLinesKeepTerm(original);
  const origTexts = origLines.map(line => line.text);
  const outLines = afterNormalized.split('\n');
  // The trailing empty element split() produces for a file ending in "\n".
  if (outLines.length > 0 && outLines[outLines.length - 1] === '' && afterNormalized.endsWith('\n')) {
    outLines.pop();
  }
  const ops = diffLineTexts(origTexts, outLines);
  const parts = [];
  // Terminators of deleted lines, paired in order with the inserted lines of
  // the same contiguous change block. A *replaced* line therefore inherits the
  // EOL of the line it replaced instead of always taking the dominant term.
  const deletedTerms = [];
  for (const op of ops) {
    if (op.type === 'equal') {
      deletedTerms.length = 0; // a change block ended
      parts.push(outLines[op.bIndex] + origLines[op.aIndex].term);
    } else if (op.type === 'delete') {
      deletedTerms.push(origLines[op.aIndex].term);
    } else if (op.type === 'insert') {
      const term = deletedTerms.length > 0 ? deletedTerms.shift() : dominantTerm;
      parts.push(outLines[op.bIndex] + term);
    }
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
