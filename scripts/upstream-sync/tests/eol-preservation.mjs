import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dominantEol, editText, ensureBefore, projectRoot, rebuildWithOriginalEol, splitLinesKeepTerm } from '../lib.mjs';

// Verifies that text patch/write logic preserves each file's original EOL
// style (per-line, including mixed-EOL files) instead of rewriting the whole
// file to one style, and that re-running the patch stays idempotent.

// ---- unit tests: pure EOL helpers -----------------------------------------
{
  const lf = 'a\nb\nc\n';
  assert.equal(dominantEol(lf), '\n');
  assert.deepEqual(splitLinesKeepTerm(lf), [
    { text: 'a', term: '\n' },
    { text: 'b', term: '\n' },
    { text: 'c', term: '\n' }
  ]);
  assert.equal(rebuildWithOriginalEol(lf, 'x\na\nb\nc\n', dominantEol(lf)), 'x\na\nb\nc\n');

  const crlf = 'a\r\nb\r\nc\r\n';
  assert.equal(dominantEol(crlf), '\r\n');
  assert.deepEqual(splitLinesKeepTerm(crlf), [
    { text: 'a', term: '\r\n' },
    { text: 'b', term: '\r\n' },
    { text: 'c', term: '\r\n' }
  ]);
  assert.equal(rebuildWithOriginalEol(crlf, 'x\na\nb\nc\n', dominantEol(crlf)), 'x\r\na\r\nb\r\nc\r\n');

  // Mixed EOL: existing lines keep their own terminator; only the inserted
  // line uses the dominant EOL.
  const mixed = 'a\r\nb\nc\r\nd\n';
  assert.equal(
    rebuildWithOriginalEol(mixed, 'a\nb\nINS\nc\nd\n', dominantEol(mixed)),
    'a\r\nb\nINS\r\nc\r\nd\n'
  );

  // No trailing newline.
  const noTrail = 'a\nb';
  assert.equal(rebuildWithOriginalEol(noTrail, 'x\na\nb', dominantEol(noTrail)), 'x\na\nb');

  // Modifying an existing line must NOT desynchronize the EOL mapping: the
  // changed line takes the dominant term, but every following unchanged line
  // keeps its own original terminator.
  assert.equal(
    rebuildWithOriginalEol(mixed, 'a\nB\nc\nd\n', dominantEol(mixed)),
    'a\r\nB\r\nc\r\nd\n'
  );
  console.log('EOL helper unit tests: PASS');
}

// ---- integration: editText on LF and CRLF fixtures stays idempotent --------
const fixturesDir = path.join(projectRoot, 'scripts', 'upstream-sync', 'tests', '.tmp-eol-fixtures');
await mkdir(fixturesDir, { recursive: true });

const lfFixture = 'line1\nline2\nline3\n';
const crlfFixture = 'line1\r\nline2\r\nline3\r\n';
const mixedFixture = 'line1\r\nline2\nline3\r\n';
await writeFile(path.join(fixturesDir, 'lf.txt'), lfFixture, 'utf8');
await writeFile(path.join(fixturesDir, 'crlf.txt'), crlfFixture, 'utf8');
await writeFile(path.join(fixturesDir, 'mixed.txt'), mixedFixture, 'utf8');

// editText resolves paths relative to projectRoot.
const relBase = 'scripts/upstream-sync/tests/.tmp-eol-fixtures';
const anchor = 'line2\n';
const insertion = 'INSERTED\n';

for (const [name, expectedPrefix] of [
  ['lf.txt', 'line1\nINSERTED\nline2\nline3\n'],
  ['crlf.txt', 'line1\r\nINSERTED\r\nline2\r\nline3\r\n'],
  ['mixed.txt', 'line1\r\nINSERTED\r\nline2\nline3\r\n']
]) {
  const rel = `${relBase}/${name}`;
  const first = await editText(rel, 'eol-test', source => ensureBefore(source, anchor, insertion, 'insert'));
  assert.ok(first, `first patch must report a change for ${name}`);
  const afterFirst = await readFile(path.join(fixturesDir, name), 'utf8');
  assert.equal(afterFirst, expectedPrefix, `${name} must preserve original EOL after patch`);

  // Idempotent: a second editText must be a no-op (return null, no change).
  const second = await editText(rel, 'eol-test', source => ensureBefore(source, anchor, insertion, 'insert'));
  assert.equal(second, null, `second patch must be a no-op for ${name}`);
  const afterSecond = await readFile(path.join(fixturesDir, name), 'utf8');
  assert.equal(afterSecond, afterFirst, `${name} must not change on reapply`);
}

await rm(fixturesDir, { recursive: true, force: true });
console.log('editText LF/CRLF/mixed EOL preservation + idempotence: PASS');
