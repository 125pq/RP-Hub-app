// RP-Hub: streaming JSONL chat-record import.
// Local platform addition kept out of assets/js/app.js so the local footprint on the
// upstream entry file stays small. Loaded before app.js; it only exposes a factory:
//   window.RPHubChatImport.createChatImporter(deps) -> async (file) => void
// Storage and branch utilities are read lazily from window.RPHubStorage and
// window.RPHubStoryBranches (defined by data-services.js).
(function () {
    // Stream a File line-by-line without loading the whole file into memory.
    // Buffered parts are only joined when a newline completes a line, keeping large
    // multi-chunk lines O(n) instead of O(n^2) string concatenation.
    const readTextFileLines = async (file, onLine) => {
        if (typeof file?.stream === 'function') {
            const reader = file.stream().getReader();
            const decoder = new TextDecoder('utf-8');
            let parts = [];
            const emitLine = async (raw) => {
                const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
                if (line.trim()) await onLine(line);
            };
            const processChunk = async (chunkText) => {
                let searchFrom = 0;
                while (true) {
                    const newlineIndex = chunkText.indexOf('\n', searchFrom);
                    if (newlineIndex < 0) {
                        if (searchFrom < chunkText.length) parts.push(chunkText.slice(searchFrom));
                        return;
                    }
                    const line = parts.length
                        ? parts.join('') + chunkText.slice(searchFrom, newlineIndex)
                        : chunkText.slice(searchFrom, newlineIndex);
                    parts = [];
                    await emitLine(line);
                    searchFrom = newlineIndex + 1;
                }
            };
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await processChunk(decoder.decode(value, { stream: true }));
                }
                await processChunk(decoder.decode());
                if (parts.length) {
                    await emitLine(parts.join(''));
                    parts = [];
                }
            } finally {
                try { reader.releaseLock(); } catch (_) {}
            }
            return;
        }
        const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
            reader.readAsText(file);
        });
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) await onLine(line);
        }
    };

    const createChatImporter = (deps) => {
        const {
            currentCharacterIndex,
            currentCharacter,
            showToast,
            stopCurrentCharacterWork,
            getCurrentStoryBranchScopeId,
            setApplyingCharacterScopedData,
            storyBranches,
            activeStoryBranchId,
            selectedStoryBranchId,
            resetChatRenderWindow,
            chatHistory,
            prepareLoadedChatHistoryForDisplay,
            createInitialChatHistory,
            loadCharacterMemories,
            loadGlobalUiTemplateRuntimeForCharacter,
            clearStoryBranchTransientContext,
            finishApplyingCharacterScopedData,
            currentView,
            scrollChatToBottom,
            updateCurrentStoryBranchSummary,
            saveStoryBranchesForCharacter
        } = deps;

        return async function importCharacterChatJsonl(file) {
            if (currentCharacterIndex.value < 0) {
                showToast('请先选择一个角色才能导入聊天记录', 'warning');
                return;
            }
            const char = currentCharacter.value;
            if (!char?.uuid) throw new Error('当前角色缺少有效标识');

            const storage = window.RPHubStorage;
            const storyBranchesUtil = window.RPHubStoryBranches;
            const {
                setScopedStoredValue,
                getScopedStoredValue,
                deleteScopedStoredValue,
                cloneForStorage,
                getMainDb,
                initDB
            } = storage;
            const {
                STORY_BRANCH_CHAT_EXPORT_TYPE,
                STORY_BRANCH_CHAT_EXPORT_VERSION,
                STORY_BRANCH_MAIN_ID,
                normalizeStoryBranches,
                getStoryBranchScopeId
            } = storyBranchesUtil;

            let isBranchFormat = false;
            let importedBranches = null;
            let importedActiveId = STORY_BRANCH_MAIN_ID;
            const legacyMessages = [];
            const seenBranchIds = new Set();
            const writtenScopeIds = [];
            let totalMessages = 0;
            let firstLineSeen = false;
            let aborted = false;
            let failure = null;

            showToast('正在导入聊天记录...', 'info', 5000);

            await readTextFileLines(file, async (line) => {
                if (failure || aborted) return;
                if (!firstLineSeen) {
                    firstLineSeen = true;
                    let first;
                    try { first = JSON.parse(line); }
                    catch (error) { failure = new Error('文件中没有有效的聊天记录'); return; }
                    if (first?.type === STORY_BRANCH_CHAT_EXPORT_TYPE) {
                        isBranchFormat = true;
                        const manifest = first;
                        if (Number(manifest.version) !== STORY_BRANCH_CHAT_EXPORT_VERSION) {
                            failure = new Error(`不支持的分支聊天版本：${manifest.version}`);
                            return;
                        }
                        if (!Array.isArray(manifest.branches) || !manifest.branches.length) {
                            failure = new Error('文件中没有分支信息');
                            return;
                        }
                        importedBranches = normalizeStoryBranches(char, { branches: manifest.branches });
                        const importedIds = new Set(importedBranches.map(branch => branch.id));
                        importedActiveId = importedIds.has(String(manifest.activeBranchId))
                            ? String(manifest.activeBranchId)
                            : STORY_BRANCH_MAIN_ID;
                        if (!await stopCurrentCharacterWork()) { aborted = true; return; }
                        if (!getMainDb()) await initDB();
                        return;
                    }
                    legacyMessages.push(first);
                    return;
                }

                if (isBranchFormat) {
                    let record;
                    try { record = JSON.parse(line); }
                    catch (error) { failure = new Error('分支聊天数据不完整'); return; }
                    const branchId = String(record?.branchId || '').trim();
                    if (!branchId || !Array.isArray(record?.messages)) {
                        failure = new Error('分支聊天数据不完整');
                        return;
                    }
                    if (record.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
                        failure = new Error(`分支“${branchId}”包含无效消息`);
                        return;
                    }
                    if (!importedBranches.some(candidate => candidate.id === branchId)) {
                        failure = new Error('聊天记录中包含未知分支');
                        return;
                    }
                    if (seenBranchIds.has(branchId)) {
                        failure = new Error(`分支“${branchId}”重复`);
                        return;
                    }
                    const messages = record.messages;
                    totalMessages += messages.length;
                    seenBranchIds.add(branchId);
                    const scopeId = getStoryBranchScopeId(char.uuid, branchId);
                    await setScopedStoredValue('chat', scopeId, messages, { clone: false });
                    writtenScopeIds.push(scopeId);
                    // Yield to the event loop so the UI keeps painting during large imports.
                    await new Promise(resolve => setTimeout(resolve, 0));
                    return;
                }

                try {
                    legacyMessages.push(JSON.parse(line));
                } catch (error) {
                    failure = new Error('聊天记录包含无效 JSON');
                }
            });

            if (aborted) return;
            if (failure) {
                if (writtenScopeIds.length) {
                    await Promise.all(writtenScopeIds.map(scopeId => deleteScopedStoredValue('chat', scopeId)));
                }
                throw failure;
            }

            if (isBranchFormat) {
                importedBranches.forEach(branch => {
                    if (!seenBranchIds.has(branch.id)) throw new Error(`缺少分支“${branch.name}”的聊天记录`);
                });

                await setScopedStoredValue('branches', char.uuid, {
                    version: 1,
                    activeBranchId: importedActiveId,
                    branches: cloneForStorage(importedBranches)
                }, { clone: false });

                setApplyingCharacterScopedData(true);
                storyBranches.value = importedBranches;
                activeStoryBranchId.value = importedActiveId;
                selectedStoryBranchId.value = importedActiveId;
                resetChatRenderWindow();
                const activeMessages = await getScopedStoredValue('chat', getStoryBranchScopeId(char.uuid, importedActiveId)) || [];
                chatHistory.value = activeMessages.length
                    ? prepareLoadedChatHistoryForDisplay(activeMessages)
                    : createInitialChatHistory(char);
                await loadCharacterMemories(getStoryBranchScopeId(char.uuid, importedActiveId), ' during branch chat import');
                loadGlobalUiTemplateRuntimeForCharacter(char);
                clearStoryBranchTransientContext();
                finishApplyingCharacterScopedData();
                currentView.value = 'chat';
                await scrollChatToBottom();

                showToast(`成功导入 ${importedBranches.length} 个分支，共 ${totalMessages} 条聊天记录`, 'success');
                return;
            }

            if (!legacyMessages.length) throw new Error('文件中没有有效的聊天记录');
            if (legacyMessages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
                throw new Error('聊天记录包含无效消息');
            }
            if (!await stopCurrentCharacterWork()) return;
            const importedChat = cloneForStorage(legacyMessages);
            setApplyingCharacterScopedData(true);
            chatHistory.value = prepareLoadedChatHistoryForDisplay(importedChat);
            await setScopedStoredValue('chat', getCurrentStoryBranchScopeId(), importedChat, { clone: false });
            updateCurrentStoryBranchSummary();
            await saveStoryBranchesForCharacter(char);
            finishApplyingCharacterScopedData();
            showToast(`成功为 ${char.name} 导入 ${importedChat.length} 条聊天记录`, 'success');
        };
    };

    window.RPHubChatImport = Object.freeze({ createChatImporter });
})();
