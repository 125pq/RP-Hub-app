(function (global) {
    'use strict';

    // Read app state at the time of the back event; never capture a stale sidebar flag.
    async function handleBack(state) {
        const {
            globalConfirmModal, showConfirmModal, showStoryBranchNameEditor, showStoryBranchModal,
            showContextViewerModal, showCharacterExportModal, showExportModal, showActiveToolEditor,
            showWorldInfoEditor, showRegexEditor, showUiTemplateEditor, showPresetEditor,
            showCharacterEditor, showAddCharacterMenu, showModelSelector, showNoMemoryNeededModal,
            showUserSetupModal, showAutoImageGenModal, showChatModelSelector, showProfileDropdown,
            showApiProviderSelector, showTokenUsageTimeFilter, showDescriptionPanel,
            settingsHelpTopic, showWorldInfoSettings, showMemorySettings, showActiveToolSettings,
            showUiTemplateSettings, handleCancel, isMobileSidebarOpen, closeMobileMenu,
            setMobileSidebarOpen
        } = state;
        const document = global.document;
        const KeyboardEvent = global.KeyboardEvent;
        const closeBooleanPanel = (panel) => {
            if (!panel.value) return false;
            panel.value = false;
            return true;
        };

        const handlePlatformBackButton = async () => {
            if (globalConfirmModal.value.show) {
                if (typeof globalConfirmModal.value.onCancel === 'function') {
                    globalConfirmModal.value.onCancel();
                } else {
                    globalConfirmModal.value.show = false;
                }
                return true;
            }
            if (showConfirmModal.value) {
                handleCancel();
                return true;
            }

            const modalPanels = [
                showStoryBranchNameEditor,
                showStoryBranchModal,
                showContextViewerModal,
                showCharacterExportModal,
                showExportModal,
                showActiveToolEditor,
                showWorldInfoEditor,
                showRegexEditor,
                showUiTemplateEditor,
                showPresetEditor,
                showCharacterEditor,
                showAddCharacterMenu,
                showModelSelector,
                showNoMemoryNeededModal
            ];
            if (modalPanels.some(closeBooleanPanel)) return true;

            // The setup and auto-image dialogs intentionally have no dismiss action.
            if (showUserSetupModal.value || showAutoImageGenModal.value) return true;

            if (document.querySelector('[role="listbox"]')) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                return true;
            }

            const transientPanels = [
                showChatModelSelector,
                showProfileDropdown,
                showApiProviderSelector,
                showTokenUsageTimeFilter,
                showDescriptionPanel
            ];
            if (transientPanels.some(closeBooleanPanel)) return true;
            if (settingsHelpTopic.value) {
                settingsHelpTopic.value = '';
                return true;
            }

            if (isMobileSidebarOpen) {
                closeMobileMenu();
                return true;
            }

            const settingsPanels = [
                showWorldInfoSettings,
                showMemorySettings,
                showActiveToolSettings,
                showUiTemplateSettings
            ];
            if (settingsPanels.some(closeBooleanPanel)) return true;

            // back fallback: open the sidebar instead of switching view / minimizing
            setMobileSidebarOpen(true);
            return true;
        };

        return handlePlatformBackButton();
    }

    global.RPHubAppNavigation = Object.freeze({ handleBack });
})(window);
