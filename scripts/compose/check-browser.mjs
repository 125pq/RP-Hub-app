import assert from 'node:assert/strict';
import { testCardFrameRenderer } from '../tests/card-frame-renderer.browser.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--run-dir' || args[2] !== '--browser') {
  throw new Error('Expected --run-dir <candidate> --browser <Edge/Chrome executable>');
}
// Reuse the artifact gate before serving any candidate bytes.
const run = path.resolve(args[1]);
const gate = spawnSync(process.execPath, ['scripts/compose/check-candidate.mjs', '--run-dir', run], {
  cwd: repositoryRoot, encoding: 'utf8', timeout: 180000,
});
if (gate.status !== 0) throw new Error(gate.stderr || 'Candidate behavior gate failed');
const dist = path.join(run, 'dist');
const build = JSON.parse(await readFile(path.join(run, 'report.json')));
const browserRun = await mkdtemp(path.join(run, 'browser-'));
const report = { status: 'failed', outputSha256: build.outputSha256, pages: [],
  runnerSha256: hash(await readFile(new URL(import.meta.url))),
  limitations: 'Fresh browser storage, offline startup only; not native bridge or existing user-data acceptance.' };
const published = new Set(build.comparison.map(entry => entry.file));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const file = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'index.html';
    if (!published.has(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(path.join(dist, file)));
  } catch { response.writeHead(500); response.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, socket;
const pending = new Map();
let sequence = 0;
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let page;
try {
  browser = spawn(path.resolve(args[3]), ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${path.join(browserRun, 'profile')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  browser.on('error', error => { launchError = error; });
  browser.stderr.resume();
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Browser exited ${browser.exitCode}`);
    try { port = Number((await readFile(path.join(browserRun, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
  assert.ok(port, 'Browser debugging endpoint was not ready');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  assert.ok(target, 'Browser has no page target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback?.reject(new Error(JSON.stringify(message.error)));
      else callback?.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const local = request.url.startsWith(origin + '/') || /^(data|blob):/.test(request.url);
      if (!local) page?.blockedExternal.push(request.url);
      send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
        .catch(error => page?.exceptions.push(String(error)));
    } else if (message.method === 'Runtime.exceptionThrown') {
      page?.exceptions.push(message.params.exceptionDetails);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      page?.consoleErrors.push(message.params.args.map(arg => arg.description || arg.value));
    } else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      page?.httpErrors.push(message.params.response.url);
    }
  });
  report.browser = await send('Browser.getVersion');
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  for (const entry of ['index.html', 'character/index.html', 'novel/index.html']) {
    page = { entry, exceptions: [], consoleErrors: [], httpErrors: [], blockedExternal: [] };
    report.pages.push(page);
    await send('Page.navigate', { url: `${origin}/${entry}` });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await send('Runtime.evaluate', { expression: `JSON.stringify({url:location.href, title:document.title, ready:document.readyState, mounted:!!document.querySelector('#app[data-v-app]'), entranceFinished:[...document.querySelectorAll('.entry-transition')].every(e=>{const s=getComputedStyle(e);return s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0}), text:document.querySelector('#app')?.innerText?.slice(0,600), scripts:[...document.scripts].filter(s=>s.src).map(s=>s.src)})`, returnByValue: true });
      page.state = JSON.parse(state.result.value);
      if (page.state.url === `${origin}/${entry}` && page.state.ready === 'complete' && page.state.mounted && page.state.entranceFinished && page.state.text?.trim()) break;
      await delay(100);
    }
    assert.ok(page.state.mounted && page.state.text?.trim(), `${entry}: Vue did not mount visible content`);
    assert.equal(page.state.url, `${origin}/${entry}`, 'Expected entrypoint was not loaded');
    assert.equal(page.state.ready, 'complete', `${entry}: document did not finish loading`);
    assert.ok(page.state.entranceFinished, `${entry}: entrance overlay did not finish`);
    // Let async storage initialization and initial iframe work settle as well.
    await delay(500);
    assert.deepEqual(page.exceptions, [], `${entry}: uncaught startup exception`);
    assert.deepEqual(page.consoleErrors, [], `${entry}: startup console error`);
    assert.deepEqual(page.httpErrors.filter(url => !url.endsWith('/favicon.ico')), [], `${entry}: failed resources`);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    page.screenshot = entry.replaceAll('/', '-') + '.png';
    await writeFile(path.join(browserRun, page.screenshot), Buffer.from(screenshot.data, 'base64'));
    console.log(`Browser startup PASS: ${entry}`);
    if (entry === 'index.html') {
      const frameCheck = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `(${testCardFrameRenderer.toString()})()` });
      assert.ok(!frameCheck.exceptionDetails, JSON.stringify(frameCheck.exceptionDetails));
      report.cardFrame = frameCheck.result.value;
      console.log(report.cardFrame);
      // Real IndexedDB transactions, cross-chunk UTF-8 and crash/failure retention.
      // This browser has a fresh disposable profile, never the user's app data.
      const check = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `(${async function () {
          const store = window.RPHubRecoveryStore;
          const ensure = (condition, message) => { if (!condition) throw new Error(message); };
          const stream = text => (async function* () { yield text; })();
          const content = '🙂中文'.repeat(100000);
          await store.save(stream(content), 'first.jsonl');
          await store.withLatest(async (meta, chunks) => {
            const decoder = new TextDecoder();
            let text = '', count = 0;
            for await (const chunk of chunks) {
              ensure(chunk.length <= 256 * 1024, 'unbounded chunk');
              text += decoder.decode(chunk, { stream: true }); count++;
            }
            text += decoder.decode();
            ensure(text === content && count > 1, 'UTF-8 roundtrip mismatch');
          });
          await store.save(stream('latest'), 'second.jsonl');
          try {
            await store.save((async function* () { yield 'x'.repeat(300000); throw new Error('injected failure'); })(), 'broken.jsonl');
            throw new Error('failed stream was accepted');
          } catch (error) { ensure(error.message === 'injected failure', error.message); }
          const originalDelete = IDBObjectStore.prototype.delete;
          IDBObjectStore.prototype.delete = function (key) {
            if (this.name === 'chunks' && key instanceof IDBKeyRange) {
              IDBObjectStore.prototype.delete = originalDelete;
              throw new Error('injected promotion abort');
            }
            return originalDelete.call(this, key);
          };
          try {
            await store.save(stream('uncommitted'), 'aborted.jsonl');
            throw new Error('aborted promotion was accepted');
          } catch (error) { ensure(error.message === 'injected promotion abort', error.message); }
          finally { IDBObjectStore.prototype.delete = originalDelete; }
          await store.withLatest(async (meta, chunks) => {
            ensure(meta.filename === 'second.jsonl', 'previous recovery was lost');
            let text = '';
            for await (const chunk of chunks) text += new TextDecoder().decode(chunk);
            ensure(text === 'latest', 'previous recovery changed');
          });
          const open = indexedDB.open('RPHubImportRecovery');
          const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
          try {
            const request = db.transaction('chunks').objectStore('chunks').count();
            const count = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
            ensure(count === 1, 'old or failed snapshots accumulated');
          } finally { db.close(); }
          await store.clear();
          return 'PASS: UTF-8, bounded chunks, last-only retention, failed-save preservation, atomic promotion abort';
        }.toString()})()` });
      assert.ok(!check.exceptionDetails, JSON.stringify(check.exceptionDetails));
      report.recoveryStore = check.result.value;
      console.log(report.recoveryStore);
    }
  }
  const actual = [];
  for (const file of await filesIn(dist)) actual.push({ file, sha256: hash(await readFile(path.join(dist, file))) });
  assert.equal(hash(JSON.stringify(actual)), build.outputSha256, 'Candidate changed during browser checks');
  report.status = 'passed';
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await send('Browser.close').catch(() => {});
    socket.close();
  }
  for (const callback of pending.values()) callback.reject(new Error('Browser check ended'));
  pending.clear();
  if (browser && browser.exitCode === null) browser.kill();
  server.closeAllConnections();
  server.close();
  await writeFile(path.join(browserRun, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser report: ${path.join(browserRun, 'report.json')}`);
}
