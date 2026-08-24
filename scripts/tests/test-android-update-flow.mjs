import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
const [manager, plugin, backup] = await Promise.all([
    read('android/app/src/main/java/io/github/pq125/rphub/AppUpdateManager.java'),
    read('android/app/src/main/java/io/github/pq125/rphub/AppUpdatePlugin.java'),
    read('assets/js/rphub-backup.js')
]);

assert.match(plugin, /@CapacitorPlugin\(name = "AppUpdate"\)/);
assert.match(plugin, /public void checkNow\(PluginCall call\)/);
assert.match(plugin, /call\.reject\("更新服务不可用"/);
assert.match(plugin, /manager\.checkNow\(/);
assert.match(manager, /AtomicReference<CheckRequest> activeCheck/);
assert.match(manager, /AtomicBoolean settled/);
assert.match(manager, /RejectedExecutionException/);
assert.match(manager, /private final Runnable coldStartCheck = this::checkQuietly/);
assert.match(manager, /request\.cancel\("更新检查已取消"\)/);
assert.match(manager, /request\.cancel\("更新检查服务已关闭"\)/);
assert.match(manager, /ConnectionGate connectionGate/);
assert.match(manager, /connectionGate\.install\(connection, generation\)/);
assert.match(manager, /connectionGate\.check\(generation\)/);
assert.match(manager, /connectionGate\.invalidate\(\)/);
assert.match(manager, /connection\.getResponseCode\(\)/);
assert.match(manager, /connection\.getInputStream\(\)/);
assert.match(manager, /connection\.disconnect\(\)/);
assert.match(backup, /data-action="check-update"/);
assert.match(backup, /invokeNative\?\.\('\s*AppUpdate', '\s*checkNow'\)/);

console.log('Android update check settlement and source-switch interruption contract: PASS');
