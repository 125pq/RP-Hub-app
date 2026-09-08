import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { projectRoot } from '../upstream-sync/lib.mjs';
import { patchApiUtilsOverlay } from '../upstream-sync/patches/patch-api-utils.mjs';

const stable192 = 'a83d907497106e401f0988b29b653422159e4c7f';
const upstreamApiSource = execFileSync('git', ['cat-file', 'blob', `${stable192}:assets/js/api-utils.js`], {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
const apiSource = patchApiUtilsOverlay(upstreamApiSource.replace(/\r\n/g, '\n'));
const flushes = [];
let nextResponse = null;

const windowObject = {
  RPHubUtils: {
    extractApiErrorMessage(data) {
      return data?.error?.message || '';
    },
    formatApiErrorMessage(status, detail) {
      return `${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    },
    getApiUsagePayload: () => null,
  },
  RPHubCardUtils: {
    extractNativeReasoning: value => value?.reasoning || '',
    isNativeReasoningPart: () => false,
  },
};

vm.runInContext(apiSource, vm.createContext({
  window: windowObject,
  TextDecoder,
  AbortController,
  performance,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    const response = nextResponse;
    nextResponse = null;
    if (!response) throw new Error('Missing synthetic test response');
    return response;
  },
  console,
}), { filename: 'generated-1.9.2-api-utils.js' });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeEvent = event => {
  if (event.raw) return new TextEncoder().encode(event.raw);
  const delta = {};
  if (event.content !== undefined) delta.content = event.content;
  if (event.reasoning !== undefined) delta.reasoning = event.reasoning;
  return new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
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
  const response = makeResponse(events, terminalError);
  nextResponse = response;
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
  const result = await run([{ content: '第一段。\n' }, { content: '\n尾段。' }]);
  await result.promise;
  assert.equal(result.content, '第一段。\n\n尾段。');
  assert.deepEqual(flushes.map(item => item.content), ['第一段。\n\n尾段。']);
}

{
  const result = await run([{ content: '甲。\r\n' }, { content: '\r\n乙。' }]);
  await result.promise;
  assert.equal(result.content, '甲。\r\n\r\n乙。');
  assert.deepEqual(flushes.map(item => item.content), ['甲。\r\n\r\n乙。']);
}

{
  const result = await run([
    { content: '第一段。\n\n' },
    { content: '第二段。\n\n', delayAfter: 100 },
    { content: '尾段。' },
  ]);
  await result.promise;
  assert.equal(result.content, '第一段。\n\n第二段。\n\n尾段。');
  assert.deepEqual(flushes.map(item => item.content), ['第一段。\n\n', '第二段。\n\n', '尾段。']);
}

{
  const result = await run([
    { content: '``' },
    { content: '`js\n' },
    { content: 'const a = 1;\n\nconst b = 2;\n' },
    { content: '``' },
    { content: '`' },
  ]);
  await result.promise;
  assert.equal(result.content, '```js\nconst a = 1;\n\nconst b = 2;\n```');
  assert.equal(flushes.length, 1);
}

for (const tag of ['think', 'cot']) {
  const result = await run([
    { content: `<${tag.slice(0, 2)}` },
    { content: `${tag.slice(2)}>分析甲。\n\n分析乙。` },
    { content: `</${tag.slice(0, 2)}` },
    { content: `${tag.slice(2)}>` },
  ]);
  await result.promise;
  assert.equal(result.content, `<${tag}>分析甲。\n\n分析乙。</${tag}>`);
  assert.equal(flushes.length, 1);
}

{
  const result = await run([{ content: '长段开头', delayAfter: 370 }, { content: '继续' }]);
  await result.promise;
  assert.equal(result.content, '长段开头继续');
  assert.deepEqual(flushes.map(item => item.content), ['长段开头', '继续']);
}

for (const [name, error] of [
  ['abort', new DOMException('Aborted', 'AbortError')],
  ['error', new Error('network failed')],
]) {
  const result = await run([{ content: '已收到但尚未发布' }], error);
  await assert.rejects(result.promise, candidate => candidate.name === error.name && candidate.message === error.message);
  assert.equal(result.content, '已收到但尚未发布');
  assert.equal(flushes.length, 1, `${name} flushes pending content`);
}

{
  const result = await run([{ reasoning: '原生推理' }, { content: '正文' }]);
  await result.promise;
  assert.equal(result.reasoning, '原生推理');
  assert.equal(result.content, '正文');
  assert.deepEqual(flushes, [{ content: '正文', reasoning: '原生推理' }]);
  const countAfterCompletion = flushes.length;
  await wait(30);
  assert.equal(flushes.length, countAfterCompletion, 'completion clears stale timers');
}

console.log('Generated stable 1.9.2 API paragraph-aware streaming flush: PASS');
console.log('Covered without benchmark hooks: LF/CRLF paragraph, burst coalescing, final, max latency, split fence, think, cot, abort, error, reasoning, timer cleanup');
