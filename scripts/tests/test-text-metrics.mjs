import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { patchTextMetrics } from '../upstream-sync/patches/patch-text-metrics.mjs';
const maps = [];
class ObservedMap extends Map {
  constructor() { super(); maps.push(this); }
}
const context = vm.createContext({ window: {}, Map: ObservedMap });
vm.runInContext(readFileSync('assets/js/text-metrics.js', 'utf8'), context);
const app = readFileSync('assets/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const binding = app.match(/^        const getTimelineCharCount = .*;$/m)?.[0];
assert.ok(binding);
const count = vm.runInContext(binding + '\ngetTimelineCharCount;', context);
const cache = maps[0];
const check = text => assert.equal(count(text), Array.from(String(text || '')).length);
for (const value of [null, undefined, false, 0, NaN, 42, true, '', 'abc', '中文', '😀', '👩‍💻', 'e\u0301', '\ud800', '\udc00', '\ud800x\udc00', 'a\r\nb']) check(value);
// Exercise deterministic random UTF-16, including unpaired and paired surrogates.
let seed = 193;
for (let row = 0; row < 300; row++) {
  let value = '';
  for (let i = 0; i < 200; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += String.fromCharCode(seed & 65535); }
  check(value);
}
for (let i = 0; i < 1000; i++) check('entry-' + i);
assert.ok(cache.size <= 600);
for (let i = 0; i < 40; i++) check('😀'.repeat(20000) + i);
assert.ok([...cache.keys()].reduce((total, key) => total + key.length, 0) <= 512 * 1024);
const before = [...cache.entries()];
const huge = '😀中'.repeat(200000);
check(huge);
assert.deepEqual([...cache.entries()], before, 'oversized text must not evict or enter the cache');
// Cache hit must avoid another iteration; no full character array may be constructed.
context.input = 'cached';
count(context.input);
vm.runInContext("Array.from = () => { throw new Error('full array allocation'); };", context);
assert.equal(count('😀新'), 2);
vm.runInContext("String.prototype[Symbol.iterator] = () => { throw new Error('cache miss'); };", context);
assert.equal(count(context.input), 6);
for (const ref of ['4aef0bb', '900aa83']) {
  const source = execFileSync('git', ['show', `${ref}:assets/js/app.js`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  const patched = patchTextMetrics(source);
  assert.equal(patchTextMetrics(patched), patched);
  assert.ok(patched.includes(binding));
  assert.throws(() => patchTextMetrics(source + '\n' + binding), /duplicated/);
  assert.throws(() => patchTextMetrics(source.replace('const getTimelineCharCount =', 'const renamedCount =')), /missing/);
}
console.log('Text metrics: upstream Unicode parity, cache limits, oversized bypass and upstream replay PASS');
