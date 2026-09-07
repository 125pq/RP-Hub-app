import { countOccurrences, editText, replaceOnce } from '../lib.mjs';
import { patchSidebarComponentTemplate } from './patch-sidebar-rendering.mjs';

function requireSingle(source, needle, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`Expected exactly one ${label}, found ${count}`);
}

function patchSidebarHeader(source) {
  return replaceOnce(
    source,
    '                <div class="h-16 flex items-center border-b border-gray-100/80 bg-white/70 backdrop-blur-xl transition-all duration-300"',
    '                <div class="safe-sidebar-header h-16 flex items-center border-b border-gray-100/80 bg-white/70 backdrop-blur-xl transition-all duration-300"',
    'safe sidebar header'
  );
}

function patchSidebarFooter(source) {
  return replaceOnce(
    source,
    '                <div class="p-3 border-t border-gray-100/80 bg-white/70 backdrop-blur-xl">',
    '                <div class="safe-sidebar-footer p-3 border-t border-gray-100/80 bg-white/70 backdrop-blur-xl">',
    'safe sidebar footer'
  );
}

function patchEmbeddedView(source) {
  source = replaceOnce(
    source,
    `        },
        emits: ['load', 'menu'],
        template: \``,
    `        },
        emits: ['load', 'menu'],
        methods: {
            handleLoad(event) {
                window.RPHubSafeArea?.syncFrame(event.currentTarget);
                this.$emit('load');
            }
        },
        template: \``,
    'EmbeddedViewContent load handler'
  );
  source = replaceOnce(
    source,
    `<button @click="$emit('menu')"
                class="md:hidden absolute left-0 top-1/2`,
    `<button @click="$emit('menu')" data-safe-area="embedded-menu"
                class="md:hidden absolute left-0 top-1/2`,
    'EmbeddedViewContent safe-area menu'
  );
  return replaceOnce(
    source,
    '<iframe :src="src" @load="$emit(\'load\')"',
    '<iframe :src="src" @load="handleLoad"',
    'EmbeddedViewContent safe iframe load'
  );
}

function patchModalOverlay(source) {
  return replaceOnce(
    source,
    '<div :class="[\'fixed inset-0 flex items-center justify-center\', overlayClass]"',
    '<div :class="[\'safe-modal-overlay fixed inset-0 flex items-center justify-center\', overlayClass]"',
    'safe modal overlay'
  );
}

export function patchUiComponentsOverlay(source) {
  source = patchSidebarComponentTemplate(source);
  source = patchSidebarHeader(source);
  source = patchSidebarFooter(source);
  source = patchEmbeddedView(source);
  source = patchModalOverlay(source);

  requireSingle(source, 'safe-sidebar-header', 'safe sidebar header');
  requireSingle(source, 'safe-sidebar-footer', 'safe sidebar footer');
  requireSingle(source, 'data-safe-area="embedded-menu"', 'embedded menu safe-area marker');
  requireSingle(source, '@load="handleLoad"', 'embedded iframe safe load handler');
  requireSingle(source, 'safe-modal-overlay', 'safe modal overlay');
  return source;
}

export async function applyUiComponentsHooks() {
  const change = await editText('assets/js/ui-components.js', 'ui-components-overlay', patchUiComponentsOverlay);
  return change ? [change] : [];
}
