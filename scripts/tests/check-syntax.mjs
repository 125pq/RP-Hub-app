import { spawnSync } from 'node:child_process';
import { webFixturePath } from './web-fixture.mjs';

const modules = [
  'assets/js/text-metrics.js',
  'assets/js/app-back-navigation.js',
  'assets/js/platform-services.js',
  'assets/js/rphub-android-adapter.js',
  'assets/js/rphub-backup.js',
  'assets/js/card-frame-renderer.js',
  'assets/js/core-utils.js',
  'assets/js/app.js',
];

let failed = false;
for (const relative of modules) {
  const result = spawnSync(process.execPath, ['--check', webFixturePath(relative)], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
if (failed) process.exit(1);
console.log('Syntax check: PASS');
