import { editText, ensureAfter, ensureBefore, requireContains } from '../lib.mjs';

const category = 'backup-hooks';

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

  // --- index.html: load rphub-backup.js before app.js -----------------------
  changes.push(await editText('index.html', category, source => {
    source = ensureBefore(
      source,
      `        document.write('<script src="assets/js/app.js?v=' + new Date().getTime() + '"><\\/script>');`,
      `        document.write('<script src="assets/js/rphub-backup.js?v=' + new Date().getTime() + '"><\\/script>');\n`,
      'rphub-backup script load'
    );
    requireContains(source, 'assets/js/rphub-backup.js', 'index rphub-backup script');
    return source;
  }));

  // --- app.js: register flush bridges ---------------------------------------
  changes.push(await editText('assets/js/app.js', category, source => {
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
  changes.push(await editText('novel/index.html', category, source => {
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
  }));

  return changes.filter(Boolean);
}
