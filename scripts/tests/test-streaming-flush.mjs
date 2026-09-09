import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { projectRoot } from '../upstream-sync/lib.mjs';
import { patchApiUtilsOverlay } from '../upstream-sync/patches/patch-api-utils.mjs';

const stableUpstream = '4aef0bb46c9b3370faba174a20435e5989799727';
const normalize = source => source.replace(/\r\n/g, '\n');
const upstreamApiSource = normalize(execFileSync('git', ['cat-file', 'blob', `${stableUpstream}:assets/js/api-utils.js`], {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}));
const currentApiSource = normalize(readFileSync(new URL('../../assets/js/api-utils.js', import.meta.url), 'utf8'));
assert.equal(patchApiUtilsOverlay(upstreamApiSource), upstreamApiSource, '1.9.3 API overlay is identity');
assert.match(currentApiSource, /const interval = setInterval\(flush, 60\);/, 'current API transport keeps the upstream 60 ms flush interval');
assert.match(currentApiSource, /toolCalls: toolSnapshot\(\)/, 'current API transport keeps upstream streamed tool calls');
assert.match(currentApiSource, /const requestChatCompletionOnce = async \(options, attempt\) =>/, 'current API transport keeps upstream retry transport');

const flushes = [];
let nextResponse = null;
const windowObject = {
  RPHubUtils: {
    extractApiErrorMessage: data => data?.error?.message || '',
    formatApiErrorMessage: (status, detail) => `${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    getApiUsagePayload: () => null,
  },
  RPHubCardUtils: {
    extractNativeReasoning: value => value?.reasoning || '',
    isNativeReasoningPart: () => false,
  },
};

vm.runInContext(currentApiSource, vm.createContext({
  window: windowObject,
  TextDecoder,
  AbortController,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    const response = nextResponse;
    nextResponse = null;
    if (!response) throw new Error('Missing synthetic test response');
    return response;
  },
  console,
}), { filename: 'stable-1.9.3-api-utils.js' });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeEvent = event => {
  const delta = {};
  if (event.content !== undefined) delta.content = event.content;
  if (event.reasoning !== undefined) delta.reasoning = event.reasoning;
  return new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: event.finishReason ?? null }] })}\n\n`);
};

const makeResponse = (events, terminalError = null) => new Response(new ReadableStream({
  async start(controller) {
    for (const event of events) {
      controller.enqueue(encodeEvent(event));
      if (event.delayAfter) await wait(event.delayAfter);
    }
    if (terminalError) {
      await wait(1);
      controller.error(terminalError);
      return;
    }
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const run = async (events, terminalError = null) => {
  flushes.length = 0;
  let content = '';
  let reasoning = '';
  nextResponse = makeResponse(events, terminalError);
  const promise = windowObject.RPHubApiClient.requestChatCompletion({
    url: 'https://synthetic.invalid/v1/chat/completions',
    apiKey: '',
    model: '',
    messages: [],
    temperature: 1,
    stream: true,
    onDelta: delta => {
      flushes.push({ ...delta });
      content += delta.content;
      reasoning += delta.reasoning;
    },
  });
  return { promise, get content() { return content; }, get reasoning() { return reasoning; } };
};

{
  const result = await run([{ content: '第一段。\n' }, { content: '\n尾段。', finishReason: 'stop' }]);
  const completed = await result.promise;
  assert.equal(completed.content, '第一段。\n\n尾段。');
  assert.equal(completed.finishReason, 'stop');
  assert.deepEqual(flushes.map(item => item.content), ['第一段。\n\n尾段。']);
}

{
  const result = await run([{ content: '固定周期前', delayAfter: 90 }, { content: '固定周期后' }]);
  await result.promise;
  assert.equal(result.content, '固定周期前固定周期后');
  assert.deepEqual(flushes.map(item => item.content), ['固定周期前', '固定周期后']);
}

for (const error of [new DOMException('Aborted', 'AbortError'), new Error('network failed')]) {
  const result = await run([{ content: '已收到但等待最终清空' }], error);
  await assert.rejects(result.promise, candidate => candidate.name === error.name && candidate.message === error.message);
  assert.equal(result.content, '已收到但等待最终清空');
  assert.equal(flushes.length, 1, `${error.name} preserves upstream finally flush`);
}

{
  const result = await run([{ reasoning: '原生推理' }, { content: '正文' }]);
  await result.promise;
  assert.equal(result.reasoning, '原生推理');
  assert.equal(result.content, '正文');
  assert.deepEqual(flushes, [{ content: '正文', reasoning: '原生推理' }]);
  const countAfterCompletion = flushes.length;
  await wait(80);
  assert.equal(flushes.length, countAfterCompletion, 'upstream interval is cleared after completion');
}

console.log('Stable upstream 1.9.3 streaming transport behavior: PASS');
console.log('Covered: identity overlay, 60 ms flush, tool calls, retry transport, final flush, finish reason, abort/error, reasoning, interval cleanup');
