import { createHash } from 'node:crypto';
import { countOccurrences, ensureBefore } from '../lib.mjs';

const startMarker = "            if (file.name.toLowerCase().endsWith('.jsonl')) {\n";
const endMarker = "            } else if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {";
const factory = "        const importCharacterChatJsonl = window.RPHubChatImport.createChatImporter({\n            currentCharacterIndex,\n            currentCharacter,\n            showToast,\n            stopCurrentCharacterWork,\n            getCurrentStoryBranchScopeId,\n            setApplyingCharacterScopedData: (value) => { _isApplyingCharacterScopedData = value; },\n            storyBranches,\n            activeStoryBranchId,\n            selectedStoryBranchId,\n            resetChatRenderWindow,\n            chatHistory,\n            prepareLoadedChatHistoryForDisplay,\n            createInitialChatHistory,\n            loadCharacterMemories,\n            loadGlobalUiTemplateRuntimeForCharacter,\n            clearStoryBranchTransientContext,\n            finishApplyingCharacterScopedData,\n            currentView,\n            scrollChatToBottom,\n            updateCurrentStoryBranchSummary,\n            saveStoryBranchesForCharacter\n        });\n\n";
const branch = "                importCharacterChatJsonl(file).catch(err => {\n                    _isApplyingCharacterScopedData = false;\n                    console.error('Chat import error:', err);\n                    showToast('聊天记录解析失败: ' + (err?.message || 'JSON 格式错误'), 'error');\n                });\n";
const returnAnchor = "        return {\n            switchProfile, createNewProfile, deleteProfile, userProfiles, activeProfileId, showProfileDropdown,";

export function patchAppChatImport(source) {
  if (countOccurrences(source, startMarker) !== 1 || countOccurrences(source, endMarker) !== 1) {
    throw new Error('Chat import file dispatch boundary missing or ambiguous');
  }
  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error('Chat import file dispatch order drifted');
  const old = source.slice(start, end);
  if (old !== branch) {
    if (createHash('sha256').update(old).digest('hex') !== 'd598eb8776c3bd82fed89e689aebd4d71702310cb6fed62d776ce36adf18a3e5') {
      throw new Error('Upstream JSONL importer changed; review module compatibility before replacing it');
    }
    source = source.slice(0, start) + branch + source.slice(end);
  }
  source = ensureBefore(source, returnAnchor, factory, 'chat import factory');
  if (countOccurrences(source, 'const importCharacterChatJsonl =') !== 1) throw new Error('Chat import factory is ambiguous');
  return source;
}
