import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../lib.mjs';

const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');
const [workflow, gradle] = await Promise.all([
  read('.github/workflows/sync-upstream.yml'),
  read('android/app/build.gradle')
]);

assert.match(gradle, /RPHUB_VERSION_NAME/);
assert.match(gradle, /RPHUB_VERSION_CODE/);
assert.match(workflow, /npm audit --omit=dev/);
assert.match(workflow, /apksigner[\s\S]*verify --verbose --print-certs/);
assert.match(workflow, /manifest application-id[\s\S]*io\.github\.pq125\.rphub/);
assert.match(workflow, /manifest debuggable[\s\S]*= "false"/);
assert.match(workflow, /sha256sum/);
assert.match(workflow, /gh release view[\s\S]*skipping duplicate publication/);
assert.match(workflow, /gh release create[\s\S]*--latest/);
assert.match(workflow, /APK SHA-256/);

console.log('Automated signed Android Release workflow contract: PASS');
