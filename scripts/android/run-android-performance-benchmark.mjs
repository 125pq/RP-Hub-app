import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const websocketUrl = args.get('--websocket');
const outputPath = args.get('--output');
const mode = args.get('--mode') || 'suite';
const commit = args.get('--commit') || null;
if (!websocketUrl) throw new Error('Missing --websocket');
if (!outputPath) throw new Error('Missing --output');

const socket = new WebSocket(websocketUrl);
let nextId = 0;
const pending = new Map();

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
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

await command('Page.enable');
await command('Runtime.enable');
await command('Page.navigate', { url: 'https://localhost/?rph_perf=1' });

const waitUntil = async (expression, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true });
    if (response.result?.value) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
};

await waitUntil('window.__RPH_PERF__?.enabled === true');
await new Promise(resolve => setTimeout(resolve, 5000));

const expression = mode === 'smoke'
  ? 'window.__RPH_PERF__.runOnce({ type: "mixed", sizeKb: 2, historyCount: 20 })'
  : mode === 'sanity'
    ? `(async () => {
        const cases = [
          ["plain", 8],
          ["mixed", 64],
          ["regex", 64],
          ["rp-paragraph", 64]
        ];
        const results = [];
        for (const [type, sizeKb] of cases) {
          const suite = await window.__RPH_PERF__.runSuite({
            warmupRuns: 0,
            recordedRuns: 1,
            historyCounts: [20],
            sizes: [sizeKb],
            types: [type],
            commit: ${JSON.stringify(commit)}
          });
          results.push(suite.rawRuns[0]);
        }
        return { mode: "sanity", results };
      })()`
  : mode === 'overhead'
    ? '(async () => { const runs = []; for (let i = 0; i < 5; i++) runs.push(await window.__RPH_PERF__.measureIdleOverhead(2000)); return { runs }; })()'
  : mode === 'rp-before'
    ? `window.__RPH_PERF__.runSuite({
        warmupRuns: 1,
        recordedRuns: 5,
        historyCounts: [20],
        sizes: [8, 32, 64],
        types: ["rp-paragraph"],
        commit: ${JSON.stringify(commit)}
      })`
  : mode === 'mixed32-confirm'
    ? `window.__RPH_PERF__.runSuite({
        warmupRuns: 1,
        recordedRuns: 5,
        historyCounts: [20],
        sizes: [32],
        types: ["mixed"],
        commit: ${JSON.stringify(commit)}
      })`
  : mode === 'candidates'
    ? `(async () => {
        const candidates = {};
        for (const streamMaxLatencyMs of [250, 350, 500]) {
          const core = await window.__RPH_PERF__.runSuite({
            warmupRuns: 1,
            recordedRuns: 2,
            historyCounts: [20],
            sizes: [32, 64],
            types: ["mixed", "regex", "rp-paragraph"],
            streamMaxLatencyMs,
            commit: ${JSON.stringify(commit)}
          });
          const shortPlain = await window.__RPH_PERF__.runSuite({
            warmupRuns: 1,
            recordedRuns: 2,
            historyCounts: [20],
            sizes: [8],
            types: ["plain"],
            streamMaxLatencyMs,
            commit: ${JSON.stringify(commit)}
          });
          candidates[streamMaxLatencyMs] = {
            fixtureContract: core.fixtureContract,
            summaries: { ...core.summaries, ...shortPlain.summaries },
            rawRuns: [...core.rawRuns, ...shortPlain.rawRuns]
          };
        }
        return { mode: "candidates", candidates };
      })()`
  : `(async () => {
      const main = await window.__RPH_PERF__.runSuite({
        warmupRuns: 1,
        recordedRuns: 5,
        historyCounts: [20],
        commit: ${JSON.stringify(commit)}
      });
      return {
        ...main,
        fixtureContract: {
          ...main.fixtureContract,
          historyMatrix: "all types with 20-message history"
        }
      };
    })()`;
const evaluation = await command('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  generatePreview: false
});
if (evaluation.exceptionDetails) throw new Error(JSON.stringify(evaluation.exceptionDetails));
const result = evaluation.result?.value;
if (!result) throw new Error('Benchmark returned no result');

await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`Android performance benchmark ${mode}: PASS`);
console.log(`Output: ${path.resolve(outputPath)}`);
if (mode === 'smoke') {
  console.log(`Scenario: ${result.scenario}`);
  console.log(`Flushes: ${result.flushCount}`);
  console.log(`Output match: ${result.outputMatches}`);
} else if (mode === 'candidates') {
  console.log(`Timeout candidates: ${Object.keys(result.candidates).join(', ')} ms`);
  console.log(`Recorded runs: ${Object.values(result.candidates).reduce((sum, item) => sum + item.rawRuns.length, 0)}`);
} else if (mode === 'sanity') {
  console.log(`Sanity cases: ${result.results.length}`);
  console.log(`All outputs match: ${result.results.every(run => run.outputMatches)}`);
} else if (result.rawRuns) {
  console.log(`Recorded runs: ${result.rawRuns.length}`);
  console.log(`Summary groups: ${result.summaries ? Object.keys(result.summaries).length : 1}`);
} else {
  console.log(`Result groups: ${Object.keys(result).length}`);
}
socket.close();
