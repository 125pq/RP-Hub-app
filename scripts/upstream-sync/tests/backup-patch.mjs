import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countOccurrences } from '../lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');

const [index, app, character, novel] = await Promise.all([
  read('index.html'),
  read('assets/js/app.js'),
  read('character/index.html'),
  read('novel/index.html')
]);

// --- index.html loads rphub-backup.js exactly once, before app.js ----------
assert.equal(countOccurrences(index, 'assets/js/rphub-backup.js'), 1, 'rphub-backup.js must load exactly once');
const backupIdx = index.indexOf('assets/js/rphub-backup.js');
const appIdx = index.indexOf('assets/js/app.js');
assert.ok(backupIdx !== -1 && appIdx !== -1);
assert.ok(backupIdx < appIdx, 'rphub-backup.js must load before app.js');

// --- app.js registers the flush bridge + embedded-frame flush ---------------
assert.match(app, /RPHubBackupBridge[\s\S]*\.register\('main-app'[\s\S]*saveData[\s\S]*flushPendingChatHistorySave/);
assert.match(app, /\.register\('character-frame'[\s\S]*RPHubBackupBridge\.flushEmbeddedFrame\('character'\)/);
assert.match(app, /\.register\('novel-frame'[\s\S]*RPHubBackupBridge\.flushEmbeddedFrame\('novel'\)/);
// The iframe postMessage/ack plumbing lives in rphub-backup.js, not app.js.
assert.doesNotMatch(app, /flushEmbeddedFrame = /);

// --- character iframe flush handler ----------------------------------------
assert.match(character, /flushData\.type !== 'RPHUB_BACKUP_FLUSH'/);
assert.match(character, /localforage\.setItem\('ai_chargen_characters'/);
assert.match(character, /window\.parent\?\.postMessage\(\{ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: true \}, '\*'\)/);

// --- novel iframe flush handler --------------------------------------------
assert.match(novel, /flushData\.type !== 'RPHUB_BACKUP_FLUSH'/);
assert.match(novel, /const flushNovelData = async \(\) => /);
assert.match(novel, /window\.parent\?\.postMessage\(\{ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: true \}, '\*'\)/);

// --- rphub-backup.js is present and syntactically loadable ------------------
const backupSource = await read('assets/js/rphub-backup.js');
assert.match(backupSource, /SNAPSHOT_FORMAT\s*=\s*'rp-sync-jsonl-v1'/);
assert.match(backupSource, /SNAPSHOT_SCHEMA_VERSION\s*=\s*5/);
assert.match(backupSource, /window\.RPHubBackupBridge\s*=/);
assert.match(backupSource, /recordArrayStart/);
assert.match(backupSource, /recordArrayEnd/);
assert.match(backupSource, /saveGeneratedFile/);
assert.match(backupSource, /buildExportStream/);
assert.match(backupSource, /readTextFileLines/);
assert.match(backupSource, /flushEmbeddedFrame\(match\)/);
assert.match(backupSource, /location\.reload\(\)/);
assert.match(backupSource, /rp_hub_sync_/); // exclusion whitelist
// UI must be sidebar-hosted (safe-sidebar-footer), not a page-overlaying FAB.
assert.match(backupSource, /\.safe-sidebar-footer/);
assert.match(backupSource, /rphub-backup-button/);
assert.doesNotMatch(backupSource, /rphub-backup-fab/);
assert.doesNotMatch(backupSource, /position:\s*fixed; right:\s*16px; bottom:\s*84px/);

console.log('Backup hook + dist verification: PASS');
