import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/js/performance-benchmark.js', import.meta.url), 'utf8');
const scrollSource = await readFile(new URL('../assets/js/scroll-performance-diagnosis.js', import.meta.url), 'utf8');
const disabledWindow = { location: { search: '' } };
vm.runInContext(source, vm.createContext({ window: disabledWindow, URLSearchParams }), { filename: 'performance-benchmark-disabled.js' });
assert.equal(disabledWindow.__RPH_PERF__.enabled, false);
assert.equal(disabledWindow.__RPH_PERF__.active, false);
assert.equal(Object.isFrozen(disabledWindow.__RPH_PERF__), true);
vm.runInContext(scrollSource, vm.createContext({ window: disabledWindow, URLSearchParams }), { filename: 'scroll-performance-diagnosis-disabled.js' });
assert.equal(disabledWindow.__RPH_SCROLL_PERF__.enabled, false);
assert.equal(disabledWindow.__RPH_SCROLL_PERF__.active, false);
assert.equal(Object.isFrozen(disabledWindow.__RPH_SCROLL_PERF__), true);

const windowObject = { location: { search: '?rph_perf=1' } };
const context = vm.createContext({
  window: windowObject,
  URLSearchParams,
  TextEncoder,
  Response,
  ReadableStream,
  performance,
  navigator: { userAgent: 'node fixture contract test' },
  requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 0),
  setTimeout,
  PerformanceObserver: class PerformanceObserver {},
});

vm.runInContext(source, context, { filename: 'performance-benchmark.js' });
const benchmark = windowObject.__RPH_PERF__;
assert.equal(benchmark.enabled, true);
vm.runInContext(scrollSource, context, { filename: 'scroll-performance-diagnosis.js' });
assert.equal(windowObject.__RPH_SCROLL_PERF__.enabled, true);
assert.equal(windowObject.__RPH_SCROLL_PERF__.active, false);

for (const type of ['plain', 'markdown', 'cot', 'regex', 'mixed', 'rp-paragraph']) {
  for (const sizeKb of [2, 8, 32, 64]) {
    const first = benchmark.buildFixture(type, sizeKb);
    const second = benchmark.buildFixture(type, sizeKb);
    assert.equal(first.utf8Bytes, sizeKb * 1024, `${type}-${sizeKb}kb exact UTF-8 size`);
    assert.equal(first.content, second.content, `${type}-${sizeKb}kb deterministic content`);
    assert.equal(first.networkChunkCount, 144);
    assert.equal(first.networkChunkIntervalMs, 10);
    assert.equal(first.streamFlushIntervalMs, 60);
    assert.equal(first.streamMaxVisibleLatencyMs, 350);
    assert.equal(first.streamMinVisibleGapMs, 80);
  }
}

const cot = benchmark.buildFixture('cot', 2).content;
assert.match(cot, /<think>/);
assert.match(cot, /<\/think>/);
const markdown = benchmark.buildFixture('markdown', 2).content;
for (const marker of ['# ', '**', '*', '- ', '> ', '`', '```', '|', '<details>']) assert.ok(markdown.includes(marker));
const regex = benchmark.buildFixture('regex', 2).content;
for (const marker of ['【状态】', '[scene]', 'RPH-2048']) assert.ok(regex.includes(marker));
const paragraph = benchmark.buildFixture('rp-paragraph', 8).content;
assert.ok((paragraph.match(/\n\n/g) || []).length >= 3);

console.log('Performance fixture contract: PASS');
console.log('Scenarios: 24/24');
console.log('UTF-8 sizes: 2048, 8192, 32768, 65536 bytes');
console.log('Cadence: 144 network chunks at 10 ms; paragraph-aware UI with 350 ms max latency');
