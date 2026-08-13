import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const websocketUrl = args.get('--websocket');
const outputPath = args.get('--output');
const action = args.get('--action') || 'snapshot';
const navigate = args.get('--navigate') === 'yes';
const normalMode = action === 'normal-smoke';
if (!websocketUrl) throw new Error('Missing --websocket');
if (!outputPath) throw new Error('Missing --output');

const socket = new WebSocket(websocketUrl);
let nextId = 0;
const pending = new Map();
const eventHandlers = new Map();

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  for (const handler of eventHandlers.get(message.method) || []) handler(message.params || {});
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const on = (method, handler) => {
  if (!eventHandlers.has(method)) eventHandlers.set(method, []);
  eventHandlers.get(method).push(handler);
};

const evaluate = async expression => {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, generatePreview: false });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || JSON.stringify(response.exceptionDetails));
  return response.result?.value;
};

const waitUntil = async (expression, timeoutMs = 45000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
};

await command('Page.enable');
await command('Runtime.enable');
if (normalMode) await command('Page.navigate', { url: 'https://localhost/' });
else if (navigate) await command('Page.navigate', { url: 'https://localhost/?rph_perf=1' });
await waitUntil(normalMode
  ? 'window.__RPH_PERF__?.enabled === false && window.__RPH_SCROLL_PERF__?.enabled === false'
  : 'window.__RPH_SCROLL_PERF__?.enabled === true');
await waitUntil('document.readyState === "complete"');
await new Promise(resolve => setTimeout(resolve, navigate ? 4000 : 500));

const traceSummary = events => {
  const buckets = {
    Scripting: new Set(['FunctionCall', 'EvaluateScript', 'RunMicrotasks', 'V8.Execute']),
    Style: new Set(['UpdateLayoutTree', 'RecalculateStyles']),
    Layout: new Set(['Layout']),
    PrePaint: new Set(['PrePaint']),
    Paint: new Set(['Paint', 'PaintImage']),
    Raster: new Set(['RasterTask']),
    Composite: new Set(['CompositeLayers', 'DrawFrame'])
  };
  const result = {};
  for (const [bucket, names] of Object.entries(buckets)) {
    const matches = events.filter(event => event.ph === 'X' && names.has(event.name) && Number.isFinite(event.dur));
    result[bucket] = {
      events: matches.length,
      summedDurationMs: Math.round(matches.reduce((sum, event) => sum + event.dur / 1000, 0) * 1000) / 1000,
      maxEventMs: matches.length ? Math.round(Math.max(...matches.map(event => event.dur / 1000)) * 1000) / 1000 : 0
    };
  }
  return {
    metric: 'Summed CDP trace event durations; categories may overlap across threads.',
    eventCount: events.length,
    categories: result
  };
};

let result;
if (action === 'select-target') {
  result = await evaluate('window.__RPH_SCROLL_PERF__.selectTargetCharacter("黎明之契")');
} else if (action === 'snapshot') {
  result = await evaluate('window.__RPH_SCROLL_PERF__.snapshot()');
} else if (action === 'load-earlier') {
  result = await evaluate('window.__RPH_SCROLL_PERF__.loadEarlier(10)');
} else if (action === 'bottom') {
  result = await evaluate('window.__RPH_SCROLL_PERF__.scrollToBottom()');
} else if (action === 'placeholders') {
  result = await evaluate('window.__RPH_SCROLL_PERF__.replaceIframesWithPlaceholders()');
} else if (action === 'idle-overhead') {
  result = await evaluate('window.__RPH_PERF__.measureIdleOverhead(2000)');
} else if (action === 'iframe-runtime-status') {
  result = await evaluate(`(() => {
    const container = document.querySelector('[data-rph-chat-container]') || document.querySelector('[data-chat-index]')?.parentElement;
    const viewport = container?.getBoundingClientRect();
    const totals = { visible: { iframe: 0, animations: 0, runningAnimations: 0, activeMedia: 0 }, offscreen: { iframe: 0, animations: 0, runningAnimations: 0, activeMedia: 0 }, unreadable: 0 };
    document.querySelectorAll('iframe.executable-html-frame').forEach(iframe => {
      const rect = iframe.getBoundingClientRect();
      const visible = viewport && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
      const bucket = visible ? totals.visible : totals.offscreen;
      bucket.iframe++;
      try {
        const doc = iframe.contentDocument;
        const animations = doc?.getAnimations?.({ subtree: true }) || [];
        bucket.animations += animations.length;
        bucket.runningAnimations += animations.filter(animation => animation.playState === 'running').length;
        bucket.activeMedia += [...(doc?.querySelectorAll('audio,video') || [])].filter(media => !media.paused && !media.ended).length;
      } catch (_) {
        totals.unreadable++;
      }
    });
    return totals;
  })()`);
} else if (action === 'normal-smoke') {
  const main = await evaluate(`(() => ({
    perfEnabled: window.__RPH_PERF__?.enabled,
    scrollPerfEnabled: window.__RPH_SCROLL_PERF__?.enabled,
    perfMarkerFrozen: Object.isFrozen(window.__RPH_PERF__),
    scrollMarkerFrozen: Object.isFrozen(window.__RPH_SCROLL_PERF__),
    appMounted: document.querySelector('#app')?.childElementCount > 0,
    remoteRuntimeScripts: [...document.scripts].filter(script => /^https?:/.test(script.src) && !script.src.startsWith(location.origin)).length,
    safeAreaTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
    safeAreaBottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim()
  }))()`);
  const probe = async url => {
    await command('Page.navigate', { url });
    await waitUntil('document.readyState === "complete"');
    await new Promise(resolve => setTimeout(resolve, 1000));
    return evaluate(`(() => ({
      url: location.pathname,
      bodyElements: document.body?.querySelectorAll('*').length || 0,
      scripts: document.scripts.length,
      remoteRuntimeScripts: [...document.scripts].filter(script => /^https?:/.test(script.src) && !script.src.startsWith(location.origin)).length
    }))()`);
  };
  const character = await probe('https://localhost/character/index.html');
  const novel = await probe('https://localhost/novel/index.html');
  await command('Page.navigate', { url: 'https://localhost/' });
  result = { main, character, novel };
} else if (action === 'trace-scroll') {
  const traceEvents = [];
  let completeTrace;
  const traceComplete = new Promise(resolve => { completeTrace = resolve; });
  on('Tracing.dataCollected', params => traceEvents.push(...(params.value || [])));
  on('Tracing.tracingComplete', completeTrace);
  await command('Tracing.start', {
    categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.layers',
    transferMode: 'ReportEvents',
    options: 'sampling-frequency=10000'
  });
  const scroll = await evaluate('window.__RPH_SCROLL_PERF__.runScroll({ durationMs: 1800, pauseMs: 400 })');
  await command('Tracing.end');
  await Promise.race([
    traceComplete,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for Tracing.tracingComplete')), 30000))
  ]);
  result = { scroll, trace: traceSummary(traceEvents) };
} else {
  throw new Error(`Unknown action: ${action}`);
}

await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`Android scroll diagnosis ${action}: PASS`);
console.log(`Output: ${path.resolve(outputPath)}`);
if (result?.stoppedForSafety || result?.scroll?.stoppedForSafety) console.log('STOPPED FOR DEVICE SAFETY');
socket.close();
