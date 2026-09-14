// npm run verify:full-sync -- --tag <stable upstream tag> [--revision <n>]
//
// Replays the whole compose-sync sequence (pin + version metadata + compose +
// verify, plus dry-run and failure restoration) for an adjacent stable upstream
// inside a disposable clone. The source lock and dist are never touched.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot } from '../web/paths.mjs';
import { runFullSyncReplay } from './full-sync-replay.mjs';

const args = process.argv.slice(2);
let tag = null;
let revision = 0;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--tag') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--tag requires a stable release tag');
    tag = value;
    index += 1;
  } else if (arg === '--revision') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--revision requires a number');
    revision = Number(value);
    index += 1;
  } else throw new Error(`Unknown option: ${arg}`);
}
if (tag === null) throw new Error('Expected --tag <stable upstream release tag>');

const report = await runFullSyncReplay({ tag, revision });
const reportPath = path.join(repositoryRoot, '.work/compose/full-sync-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Full-sync replay report: ${reportPath}`);
if (report.status !== 'passed') {
  console.error(`Full-sync replay FAILED for ${tag} (${report.commit || 'unresolved'})`);
  if (report.error) console.error(report.error);
  process.exitCode = 1;
} else {
  console.log(`Full-sync replay PASS: ${tag} ${report.commit} -> version ${report.checks[0]?.version}`);
  console.log(`Checks: ${report.checks.map(check => check.name).join(', ')}`);
  console.log(`Source preserved: lock=${report.sourceLockUnchanged} dist=${report.sourceDistUnchanged}`);
}
