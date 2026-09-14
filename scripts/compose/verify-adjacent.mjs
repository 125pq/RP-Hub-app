// npm run verify:adjacent -- --tag <stable upstream tag>
//
// Replays an adjacent stable upstream through the isolated composition and
// behavior gate without moving the repository lock or dist. Writes a JSON report
// under .work/compose/adjacent-report.json and exits non-zero on failure.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { runAdjacentReplay } from './adjacent-replay.mjs';

const args = process.argv.slice(2);
let tag = null;
let browser = null;
let androidApk = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--tag') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--tag requires a stable release tag');
    tag = value;
    index += 1;
  } else if (arg === '--browser') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--browser requires an executable path');
    browser = value;
    index += 1;
  } else if (arg === '--android-apk') {
    androidApk = true;
  } else throw new Error(`Unknown option: ${arg}`);
}
if (tag === null) throw new Error('Expected --tag <stable upstream release tag>');

const report = await runAdjacentReplay({ tag, browser, androidApk });
const reportPath = path.join(repositoryRoot, '.work/compose/adjacent-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Adjacent replay report: ${reportPath}`);
if (report.status !== 'passed') {
  console.error(`Adjacent replay FAILED for ${tag} (${report.commit || 'unresolved'})`);
  if (report.error) console.error(report.error);
  process.exitCode = 1;
} else {
  console.log(`Adjacent replay PASS: ${tag} ${report.commit} -> ${report.outputSha256}`);
  console.log(`Behavior gate: ${report.tests.length} suites passed against ${report.upstreamCommit}`);
  console.log(`Capabilities: ${report.capabilities.join(', ')}`);
}
