import { createHash } from 'node:crypto';
import { countOccurrences, ensureBefore } from '../lib.mjs';

const hook = `        const handlePlatformBackButton = async () => window.RPHubAppNavigation.handleBack({
            globalConfirmModal, showConfirmModal, showStoryBranchNameEditor, showStoryBranchModal,
            showContextViewerModal, showCharacterExportModal, showExportModal, showActiveToolEditor,
            showWorldInfoEditor, showRegexEditor, showUiTemplateEditor, showPresetEditor,
            showCharacterEditor, showAddCharacterMenu, showModelSelector, showNoMemoryNeededModal,
            showUserSetupModal, showAutoImageGenModal, showChatModelSelector, showProfileDropdown,
            showApiProviderSelector, showTokenUsageTimeFilter, showDescriptionPanel,
            settingsHelpTopic, showWorldInfoSettings, showMemorySettings, showActiveToolSettings,
            showUiTemplateSettings, handleCancel, isMobileSidebarOpen, closeMobileMenu,
            setMobileSidebarOpen
        });

`;

export function patchAppNavigation(source) {
  // Migrate the first extracted binding, which still referenced a retired upstream panel.
  const oldHook = hook.replace('showApiProviderSelector, showTokenUsageTimeFilter', 'showApiProviderSelector, showInstructionPanel, showTokenUsageTimeFilter');
  if (countOccurrences(source, oldHook) === 1) source = source.replace(oldHook, hook);
  const startMarker = '        const closeBooleanPanel =';
  if (source.includes(startMarker)) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf('        const initializePlatformAdapters =', start);
    const old = source.slice(start, end);
    if (countOccurrences(source, startMarker) !== 1 || end < 0
      || createHash('sha256').update(old).digest('hex') !== 'ce8857557fa1b47354604cabc545343c49807e09b30d6eb5930fb1770f005111') {
      throw new Error('App back navigation legacy implementation drifted');
    }
    source = source.slice(0, start) + hook + source.slice(end);
  } else {
    const anchor = source.includes('        const initializePlatformAdapters =') ? '        const initializePlatformAdapters =' : '        const confirmCharacterExport = (type) => {';
    source = ensureBefore(source, anchor, hook, 'app navigation binding');
  }
  if (countOccurrences(source, 'const handlePlatformBackButton =') !== 1) {
    throw new Error('App back navigation binding is ambiguous');
  }
  return source;
}
