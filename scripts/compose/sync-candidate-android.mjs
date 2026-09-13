import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { filesIn, hash } from './compose-lib.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--run-dir') throw new Error('Expected --run-dir <candidate directory>');
const run = path.resolve(args[1]);
function execute(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${script} failed`);
}
execute('scripts/compose/check-candidate.mjs', ['--run-dir', run], repositoryRoot);
const report = JSON.parse(await readFile(path.join(run, 'report.json')));
const config = JSON.parse(await readFile(path.join(repositoryRoot, 'capacitor.config.json')));
assert.ok(!config.server?.url, 'Candidate APK must load its bundled files');
const stage = await mkdtemp(path.join(run, 'capacitor-'));
const android = path.join(repositoryRoot, 'android');
// A disposable CLI project selects the candidate without editing the real
// Capacitor config or the official dist. Dependencies resolve from the parent repo.
await writeFile(path.join(stage, 'package.json'), await readFile(path.join(repositoryRoot, 'package.json')));
await writeFile(path.join(stage, 'capacitor.config.json'), JSON.stringify({
  ...config, webDir: path.relative(stage, path.join(run, 'dist')),
  android: { ...config.android, path: path.relative(stage, android) },
}));
execute(path.join(repositoryRoot, 'node_modules/@capacitor/cli/bin/capacitor'), ['sync', 'android'], stage);
const publicRoot = path.join(android, 'app/src/main/assets/public');
const expected = new Map(report.comparison.map(({ file, sha256 }) => [file, sha256]));
const generated = new Set(['cordova.js', 'cordova_plugins.js']);
for (const file of await filesIn(publicRoot)) {
  if (expected.has(file)) {
    assert.equal(hash(await readFile(path.join(publicRoot, file))), expected.get(file), `Android copy differs: ${file}`);
    expected.delete(file);
  } else assert.ok(generated.has(file), `Unexpected Android web asset: ${file}`);
}
assert.equal(expected.size, 0, `Missing Android web assets: ${[...expected.keys()]}`);
// Routing paths belong to the temporary CLI project, not the runtime config.
await writeFile(path.join(android, 'app/src/main/assets/capacitor.config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`Candidate Android copy verified: ${report.comparison.length} files, ${report.outputSha256}`);
