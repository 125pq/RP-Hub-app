import { editText, ensureAfter, ensureBefore, replaceOnce, requireContains } from '../lib.mjs';
import { patchIndexScriptOverlay } from './index-script-overlay.mjs';

const category = 'backup-hooks';

function patchBackupSafeArea(source) {
  const replacement = 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))';
  if (source.includes(replacement)) return source;
  source = replaceOnce(
    source,
    'bottom:calc(env(safe-area-inset-bottom,0px) + 12px)',
    `bottom:calc(${replacement} + 12px)`,
    'backup panel safe-area fallback'
  );
  requireContains(source, replacement, 'backup panel safe-area fallback');
  return source;
}

export function patchBackupTheme(source) {
  const marker = "'NativeTheme',";
  const nativeThemeCall = `        try {
            const nativeThemeCall = window.platformAdapter?.invokeNative?.(
                'NativeTheme',
                'setMode',
                { mode: prefs.themeMode === 'system' ? 'system' : 'light' }
            );
            Promise.resolve(nativeThemeCall).catch(() => {});
        } catch (_) { /* unsupported browser/native bridge */ }`;
  if (!source.includes(marker)) {
    source = replaceOnce(
      source,
      `        // MainActivity enables algorithmic darkening. A dark color-scheme hint
        // tells WebView the page already owns dark colors and suppresses that
        // pass; the inverse hint therefore maps the local preference to the
        // desired final appearance.
        root.style.colorScheme = dark ? 'light' : 'dark';`,
      nativeThemeCall,
      'backup native theme synchronization'
    );
  }
  const staleColorScheme = "        root.style.colorScheme = dark ? 'dark' : 'light';\n";
  const staleColorSchemeCount = source.split(staleColorScheme).length - 1;
  if (staleColorSchemeCount > 1) {
    throw new Error(`Duplicate stale backup color-scheme hints: ${staleColorSchemeCount}`);
  }
  if (staleColorSchemeCount === 1) {
    source = source.replace(staleColorScheme, '');
  }
  requireContains(source, marker, 'backup native theme synchronization');
  if (source.includes('root.style.colorScheme')) {
    throw new Error('Stale backup color-scheme hint remained after native theme patch');
  }
  return source;
}

export function patchBackupNovel(source) {
  if (!source.includes("flushData.type !== 'RPHUB_BACKUP_FLUSH'")) {
    source = ensureBefore(
      source,
      `                const saveData = async () => {`,
      `                const flushNovelData = async () => {\n                    await saveData();\n                };\n                window.addEventListener('message', (flushEvent) => {\n                    const flushData = flushEvent?.data || {};\n                    if (flushData.type !== 'RPHUB_BACKUP_FLUSH') return;\n                    const requestId = flushData.requestId;\n                    (async () => {\n                        try {\n                            await flushNovelData();\n                            window.parent?.postMessage({ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: true }, '*');\n                        } catch (_) {\n                            window.parent?.postMessage({ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: false }, '*');\n                        }\n                    })();\n                });\n\n`,
      'novel backup flush'
    );
  }
  requireContains(source, "flushData.type !== 'RPHUB_BACKUP_FLUSH'", 'novel backup flush handler');
  return source;
}

const squareStatePattern = /        \/\/ Square State\n        const isSquareLoading = ref\(true\);\n        const squareUrl = ref\('https:\/\/(?:rphforum\.zeabur\.app|rp\.zhaoyangxx\.ccwu\.cc)\/'\);\n/g;

// Keep the upstream square view state, but resolve its host from the local
// control-center preference and react to changes while the iframe is visible.
export function patchSquareMirrorApp(source) {
  const marker = '// Wanxiang Square mirror preference hook.';
  const alreadyPatched = source.includes(marker);
  if (!alreadyPatched) {
    const matches = source.match(squareStatePattern) || [];
    if (matches.length !== 1) {
      throw new Error(`Expected one square state anchor for mirror preference, found ${matches.length}`);
    }
    const replacement = `        // Square State
        // Wanxiang Square mirror preference hook.
        const SQUARE_URLS = Object.freeze({
            original: 'https://rphforum.zeabur.app/',
            mirror: 'https://rp.zhaoyangxx.ccwu.cc/'
        });
        const getSquareUrl = (cacheBust = false) => {
            const mirrorEnabled = window.RPHubBackup?.getMirrorSquarePreference?.() !== false;
            const baseUrl = mirrorEnabled ? SQUARE_URLS.mirror : SQUARE_URLS.original;
            return cacheBust ? \`\${baseUrl}?t=\${Date.now()}\` : baseUrl;
        };
        const isSquareLoading = ref(true);
        const squareUrl = ref(getSquareUrl());
        const stopSquareMirrorChange = window.RPHubBackup?.onMirrorSquareChange?.(() => {
            if (currentView.value !== 'square') return;
            isSquareLoading.value = true;
            squareUrl.value = getSquareUrl(true);
        }) || (() => {});
`;
    source = source.replace(squareStatePattern, replacement);
  }

  const squareWatchPattern = /                squareUrl\.value = `https:\/\/(?:rphforum\.zeabur\.app|rp\.zhaoyangxx\.ccwu\.cc)\/\?t=\$\{Date\.now\(\)\}`;/;
  const squareWatchMatches = source.match(squareWatchPattern) || [];
  if (!alreadyPatched && squareWatchMatches.length !== 1) {
    throw new Error(`Expected one square watch URL anchor for mirror preference, found ${squareWatchMatches.length}`);
  }
  if (squareWatchMatches.length === 1) {
    source = source.replace(squareWatchPattern, '                squareUrl.value = getSquareUrl(true);');
  }

  if (alreadyPatched && source.includes('squareUrl.value = `https://')) {
    throw new Error('Stale square watch URL remained after mirror preference patch');
  }

  if (!source.includes('stopSquareMirrorChange();')) {
    source = ensureAfter(
      source,
      '        onBeforeUnmount(() => {\n',
      '            // Release the cross-module preference listener.\n            stopSquareMirrorChange();\n',
      'square mirror preference cleanup'
    );
  }

  requireContains(source, marker, 'square mirror preference hook');
  requireContains(source, 'const squareUrl = ref(getSquareUrl());', 'square mirror initial URL');
  requireContains(source, 'squareUrl.value = getSquareUrl(true);', 'square mirror live refresh');
  requireContains(source, 'stopSquareMirrorChange();', 'square mirror preference cleanup');
  return source;
}

// Adds the minimal hooks needed for the local backup module:
//  - index.html: load rphub-backup.js before app.js.
//  - app.js: register main-app flush + character/novel iframe flush bridges on
//    the RPHubBackupBridge (created by rphub-backup.js).
//  - character/index.html: flush handler so the parent can force a save.
//  - novel/index.html: flush handler so the parent can force a save.
//
// All edits are idempotent (guard on the insertion marker) and fail loudly if an
// anchor cannot be found exactly once.

export async function applyBackupHooks() {
  const changes = [];

  changes.push(await editText('assets/js/rphub-backup.js', category, source => (
    patchBackupTheme(patchBackupSafeArea(source))
  )));

  // --- index.html: load rphub-backup.js before app.js -----------------------
  changes.push(await editText('index.html', category, patchIndexScriptOverlay));

  // --- app.js: register flush bridges ---------------------------------------
  changes.push(await editText('assets/js/app.js', category, source => {
    source = patchSquareMirrorApp(source);
    if (!source.includes('// Backup flush bridges (local full-backup export/restore).')) {
      source = ensureBefore(
        source,
        '        onBeforeUnmount(() => {',
        `        // Backup flush bridges (local full-backup export/restore).
        // Register the main-app writer flush; the character/novel iframe flushes
        // are driven through RPHubBackupBridge.flushEmbeddedFrame (defined in
        // rphub-backup.js, which loads before app.js).
        if (window.RPHubBackupBridge) {
            window.RPHubBackupBridge
                .register('main-app', async () => {
                    if (_memorySettingsSaveTimer) {
                        clearTimeout(_memorySettingsSaveTimer);
                        _memorySettingsSaveTimer = null;
                    }
                    await saveData({ saveMemories: true, saveCharacters: true });
                    await flushPendingChatHistorySave();
                    await saveStoryBranchesForCharacter();
                    await saveTokenUsageHistoryNow();
                })
                .register('character-frame', () => window.RPHubBackupBridge.flushEmbeddedFrame('character'))
                .register('novel-frame', () => window.RPHubBackupBridge.flushEmbeddedFrame('novel'));
        }

`,
        'app backup flush registration'
      );
    }
    requireContains(source, '// Backup flush bridges (local full-backup export/restore).', 'app backup registration');
    return source;
  }));

  // --- character/index.html: flush handler -----------------------------------
  changes.push(await editText('character/index.html', category, source => {
    if (!source.includes("flushData.type !== 'RPHUB_BACKUP_FLUSH'")) {
      source = ensureAfter(
        source,
        `                    debouncedSave(newVal);
                }, { deep: true });`,
        `\n\n                // Flush any pending debounced writes on demand (used by the main-app
                // backup bridge before taking a snapshot).
                const flushWorkshopData = async () => {
                    const json = JSON.stringify(characters.value);
                    await localforage.setItem('ai_chargen_characters', json);
                    const { customModels, ...persistentOptions } = options;
                    localStorage.setItem('ai_chargen_options', JSON.stringify(persistentOptions));
                    localStorage.setItem('ai_chargen_active_index', currentCharacterIndex.value);
                };
                window.addEventListener('message', (flushEvent) => {
                    const flushData = flushEvent?.data || {};
                    if (flushData.type !== 'RPHUB_BACKUP_FLUSH') return;
                    const requestId = flushData.requestId;
                    (async () => {
                        try {
                            await flushWorkshopData();
                            window.parent?.postMessage({ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: true }, '*');
                        } catch (_) {
                            window.parent?.postMessage({ type: 'RPHUB_BACKUP_FLUSHED', requestId, ok: false }, '*');
                        }
                    })();
                });`,
        'character backup flush'
      );
    }
    requireContains(source, "flushData.type !== 'RPHUB_BACKUP_FLUSH'", 'character backup flush handler');
    return source;
  }));

  // --- novel/index.html: flush handler ---------------------------------------
  changes.push(await editText('novel/index.html', category, patchBackupNovel));

  return changes.filter(Boolean);
}
