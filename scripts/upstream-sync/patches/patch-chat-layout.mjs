import { editText, replaceOnce } from '../lib.mjs';

const category = 'webview-chat-layout';

// Upstream commit 66676034 changed the desktop/tablet message shell width from
// `min(56rem, 72%)` to a fixed `50vw`. Because `50vw` is viewport-relative, the
// message shell no longer follows the app-main width, so collapsing the sidebar
// frees horizontal space that the chat body never uses (most visible on tablets).
// Restore the earlier upstream behavior so the shell tracks its parent width
// while still capping at a comfortable 56rem reading width on large screens.
export function patchChatLayoutCss(source) {
  const before = `            .centered-message-shell {
                width: 50vw;
                max-width: 50vw !important;
            }`;
  const after = `            .centered-message-shell {
                width: min(56rem, 72%);
                max-width: min(56rem, 72%) !important;
            }`;
  return replaceOnce(source, before, after, 'centered-message-shell width');
}

export async function applyChatLayoutHooks() {
  const changes = [];
  const editResult = await editText('assets/css/styles.css', category, patchChatLayoutCss);
  if (editResult) {
    changes.push(editResult);
  }
  return changes;
}
