import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { patchBackupTheme } from '../upstream-sync/patches/patch-backup.mjs';

const [backupSource, mainActivity, nativeTheme, androidManifest] = await Promise.all([
  readFile(new URL('../../assets/js/rphub-backup.js', import.meta.url), 'utf8'),
  readFile(new URL('../../android/app/src/main/java/io/github/pq125/rphub/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../../android/app/src/main/java/io/github/pq125/rphub/NativeThemePlugin.java', import.meta.url), 'utf8'),
  readFile(new URL('../../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
]);

assert.match(nativeTheme, /@CapacitorPlugin\(name = "NativeTheme"\)/);
assert.match(nativeTheme, /MODE_NIGHT_FOLLOW_SYSTEM/);
assert.match(nativeTheme, /MODE_NIGHT_NO/);
assert.match(nativeTheme, /MODE_NIGHT_YES/);
assert.match(nativeTheme, /getSharedPreferences\(PREFERENCES_NAME, Context\.MODE_PRIVATE\)[\s\S]*putString\(MODE_KEY, mode\)[\s\S]*\.commit\(\)/);
assert.match(nativeTheme, /activity\.runOnUiThread\(\(\) ->/);
const attachIndex = mainActivity.indexOf('protected void attachBaseContext(Context newBase)');
const restoreIndex = mainActivity.indexOf('NativeThemePlugin.restoreNightMode(this);');
const registerIndex = mainActivity.indexOf('registerPlugin(NativeThemePlugin.class);');
const superIndex = mainActivity.indexOf('super.onCreate(savedInstanceState);');
const attachRestoreIndex = mainActivity.indexOf('NativeThemePlugin.restoreNightMode(newBase);');
const attachSuperIndex = mainActivity.indexOf('super.attachBaseContext(newBase);');
assert.ok(attachIndex >= 0, 'MainActivity must override attachBaseContext');
assert.ok(attachIndex < attachRestoreIndex && attachRestoreIndex < attachSuperIndex, 'native night mode must be restored before base context attachment');
assert.equal(restoreIndex, -1, 'onCreate restoration is too late to affect the Activity base context');
assert.ok(registerIndex >= 0 && registerIndex < superIndex, 'NativeTheme plugin must be registered before Activity creation');
assert.match(mainActivity, /setAlgorithmicDarkeningAllowed\(webView\.getSettings\(\), true\)/);
assert.doesNotMatch(androidManifest, /android:configChanges="[^"]*\buiMode\b[^"]*"/);
assert.doesNotMatch(backupSource, /root\.style\.colorScheme/);

const legacyThemeBlock = `        // MainActivity enables algorithmic darkening. A dark color-scheme hint
        // tells WebView the page already owns dark colors and suppresses that
        // pass; the inverse hint therefore maps the local preference to the
        // desired final appearance.
        root.style.colorScheme = dark ? 'light' : 'dark';`;
const legacyPatched = patchBackupTheme(legacyThemeBlock);
assert.match(legacyPatched, /'NativeTheme',[\s\S]*'setMode'/);
assert.doesNotMatch(legacyPatched, /root\.style\.colorScheme/);
assert.equal(patchBackupTheme(legacyPatched), legacyPatched, 'theme patch must be idempotent');
const previouslyPatched = legacyPatched.replace('        try {', "        root.style.colorScheme = dark ? 'dark' : 'light';\n        try {");
assert.equal(patchBackupTheme(previouslyPatched), legacyPatched, 'theme patch must remove the stale same-direction hint');
assert.throws(
  () => patchBackupTheme("        root.style.colorScheme = dark ? 'light' : 'dark';"),
  /Expected one replacement anchor/,
  'theme patch must fail closed when the upstream anchor drifts'
);

function loadTheme({ savedThemeMode, systemDark, invokeNative }) {
  const calls = [];
  const classes = new Map();
  const root = {
    dataset: {},
    style: {},
    classList: { toggle(name, enabled) { classes.set(name, enabled); } }
  };
  const head = { appendChild() {} };
  const body = {};
  const document = {
    readyState: 'complete',
    documentElement: root,
    head,
    body,
    createElement() { return { id: '', textContent: '' }; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };
  const localStorage = {
    getItem(key) {
      return key === 'rp_hub_ui_preferences'
        ? JSON.stringify({ themeMode: savedThemeMode, mirrorSquare: true })
        : null;
    },
    setItem() {},
    key() { return null; },
    get length() { return 0; }
  };
  const window = {
    document,
    localStorage,
    matchMedia() {
      return { matches: systemDark, addEventListener() {}, removeEventListener() {} };
    },
    platformAdapter: {
      invokeNative(plugin, method, options) {
        calls.push({ plugin, method, options });
        return invokeNative?.(plugin, method, options);
      }
    }
  };
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    indexedDB: {},
    console,
    Promise,
    Map,
    Set,
    JSON,
    Date,
    Math,
    Uint8Array,
    ArrayBuffer,
    TextDecoder,
    TextEncoder,
    Blob,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(backupSource, context, { filename: 'rphub-backup.js' });
  return { calls, classes, root };
}

let result = loadTheme({ savedThemeMode: 'system', systemDark: true });
assert.equal(result.root.dataset.rphubTheme, 'dark');
assert.equal(result.root.style.colorScheme, undefined);
assert.equal(result.classes.get('rphub-night-mode'), true);
assert.deepEqual(JSON.parse(JSON.stringify(result.calls)), [
  { plugin: 'NativeTheme', method: 'setMode', options: { mode: 'system' } }
]);

result = loadTheme({
  savedThemeMode: 'off',
  systemDark: true,
  invokeNative: () => Promise.reject(new Error('unsupported'))
});
assert.equal(result.root.dataset.rphubTheme, 'light');
assert.equal(result.root.style.colorScheme, undefined);
assert.equal(result.classes.get('rphub-night-mode'), false);
assert.deepEqual(JSON.parse(JSON.stringify(result.calls)), [
  { plugin: 'NativeTheme', method: 'setMode', options: { mode: 'light' } }
]);
await Promise.resolve();

console.log('Android native night-mode persistence, startup restore, and Web theme synchronization: PASS');
