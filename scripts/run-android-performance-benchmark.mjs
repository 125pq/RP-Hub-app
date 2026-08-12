import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const websocketUrl = args.get('--websocket');
const outputPath = args.get('--output');
const mode = args.get('--mode') || 'suite';
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
  : mode === 'overhead'
    ? '(async () => { const runs = []; for (let i = 0; i < 5; i++) runs.push(await window.__RPH_PERF__.measureIdleOverhead(2000)); return { runs }; })()'
  : `(async () => {
      const main = await window.__RPH_PERF__.runSuite({
        warmupRuns: 1,
        recordedRuns: 5,
        historyCounts: [20],
        commit: "50e2d54"
      });
      const history = await window.__RPH_PERF__.runSuite({
        warmupRuns: 1,
        recordedRuns: 5,
        historyCounts: [100],
        types: ["mixed"],
        commit: "50e2d54"
      });
      return {
        ...main,
        fixtureContract: {
          ...main.fixtureContract,
          historyMatrix: "all types with 20-message history; mixed with 100-message history"
        },
        summaries: { ...main.summaries, ...history.summaries },
        rawRuns: [...main.rawRuns, ...history.rawRuns]
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
} else if (result.rawRuns) {
  console.log(`Recorded runs: ${result.rawRuns.length}`);
  console.log(`Summary groups: ${result.summaries ? Object.keys(result.summaries).length : 1}`);
} else {
  console.log(`Result groups: ${Object.keys(result).length}`);
}
socket.close();
