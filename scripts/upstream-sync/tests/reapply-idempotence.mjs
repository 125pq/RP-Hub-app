import assert from 'node:assert/strict';
import { reapplyHooks } from '../reapply-hooks.mjs';
import { sha256File } from '../lib.mjs';

const files = [
  'index.html',
  'assets/js/app.js',
  'assets/js/core-utils.js',
  'assets/js/runtime-services.js',
  'assets/css/styles.css',
  'character/index.html',
  'novel/index.html'
];

const snapshot = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, await sha256File(file)])));
const before = await snapshot();
const first = await reapplyHooks();
const afterFirst = await snapshot();
const second = await reapplyHooks();
const afterSecond = await snapshot();

assert.deepEqual(afterSecond, afterFirst, 'Second reapply changed tracked hook files');
assert.equal(second.length, 0, 'Second reapply must report zero changed files');
if (first.length === 0) assert.deepEqual(afterFirst, before, 'No-op reapply unexpectedly changed content');
console.log('Upstream hook reapply idempotence: PASS');
console.log(`First pass changed files: ${first.length}`);
console.log('Second pass changed files: 0');
