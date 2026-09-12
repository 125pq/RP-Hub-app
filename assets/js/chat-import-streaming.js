// RP-Hub: streaming JSONL chat-record import.
// Local platform addition kept out of assets/js/app.js so the local footprint on the
// upstream entry file stays small. Loaded before app.js; it only exposes a factory:
//   window.RPHubChatImport.createChatImporter(deps) -> async (file) => void
// Storage and branch utilities are read lazily from window.RPHubStorage and
// window.RPHubStoryBranches (defined by data-services.js).
(function () {
    // Streaming line reads are provided by the shared assets/js/rphub-io.js
    // module (阶段 2). The chat importer keeps its own policy of skipping blank
    // (whitespace-only) lines, which the generic reader does not impose.
    const readChatLines = async (file, onLine) => {
        const io = window.RPHubIO;
        if (!io?.readTextFileLines) throw new Error('RPHubIO 未加载，无法流式读取文件。');
        await io.readTextFileLines(file, async (line) => {
            if (line.trim()) await onLine(line);
        });
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
            let totalMessages = 0;
            let firstLineSeen = false;
            let failure = null;

            showToast('正在导入聊天记录...', 'info', 5000);

            await readChatLines(file, async (line) => {
                if (failure) return;
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

            if (failure) throw failure;

            // Validate the entire file before asking for recovery or touching storage.
            if (isBranchFormat) {
                importedBranches.forEach(branch => {
                    if (!seenBranchIds.has(branch.id)) throw new Error(`缺少分支“${branch.name}”的聊天记录`);
                });
            } else {
                if (!legacyMessages.length) throw new Error('文件中没有有效的聊天记录');
                if (legacyMessages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) {
                    throw new Error('聊天记录包含无效消息');
                }
            }
            if (currentCharacter.value?.uuid !== char.uuid) throw new Error('当前角色已切换，请重新导入。');
            if (!await stopCurrentCharacterWork()) return;
            const backup = window.RPHubBackup;
            if (!backup?.createRecoveryBackup) throw new Error('恢复备份接口不可用，已中止导入。');
            const recovery = await backup.createRecoveryBackup();
            if (!recovery) {
                showToast('未保存恢复备份，已取消聊天导入。', 'info');
                return;
            }
            if (currentCharacter.value?.uuid !== char.uuid) throw new Error('当前角色已切换，已中止导入。');
            if (!getMainDb()) await initDB();
            const writeWithRecovery = async (write) => {
                try {
                    await write();
                } catch (error) {
                    const failure = new Error(`聊天导入中断，部分本地数据可能已被覆盖。请导入恢复备份 ${recovery.filename} 以恢复导入前的数据。原始错误：${error?.message || String(error)}`);
                    failure.partialWrite = true;
                    failure.recovery = recovery;
                    throw failure;
                }
            };

            if (isBranchFormat) {
                await writeWithRecovery(async () => {
                    let header = true;
                    await readChatLines(file, async (line) => {
                        if (header) { header = false; return; }
                        const record = JSON.parse(line);
                        const scopeId = getStoryBranchScopeId(char.uuid, String(record.branchId).trim());
                        await setScopedStoredValue('chat', scopeId, record.messages, { clone: false });
                        await new Promise(resolve => setTimeout(resolve, 0));
                    });
                    await setScopedStoredValue('branches', char.uuid, {
                        version: 1,
                        activeBranchId: importedActiveId,
                        branches: cloneForStorage(importedBranches)
                    }, { clone: false });
                });

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

            // 解析出的消息是全新的普通 JSON 对象,不经过响应式代理,无需再
            // cloneForStorage 复制一整份;prepare 同一数组后直接存储该引用
            // (IndexedDB 写入时自行结构化克隆),去掉一次全量重复驻留(阶段 2)。
            setApplyingCharacterScopedData(true);
            chatHistory.value = prepareLoadedChatHistoryForDisplay(legacyMessages);
            try {
                await writeWithRecovery(async () => {
                    await setScopedStoredValue('chat', getCurrentStoryBranchScopeId(), legacyMessages, { clone: false });
                    updateCurrentStoryBranchSummary();
                    await saveStoryBranchesForCharacter(char);
                });
            } finally {
                finishApplyingCharacterScopedData();
            }
            showToast(`成功为 ${char.name} 导入 ${legacyMessages.length} 条聊天记录`, 'success');
        };
    };

    window.RPHubChatImport = Object.freeze({ createChatImporter });
})();
