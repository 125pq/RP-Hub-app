import { countOccurrences } from '../lib.mjs';

export function patchAppOffscreen(source) {
  const pairs = [
    ['        watch(chatContainer, (container) => {\n            generatedImageObserver?.disconnect();\n', '            window.RPHubOffscreenIframeLifecycle?.attach(container);\n'],
    ['            generatedImageObserver?.disconnect();\n            generatedImageTasks.clear();', '            window.RPHubOffscreenIframeLifecycle?.detach();\n']
  ];
  for (const [index, [anchor, hook]] of pairs.entries()) {
    const after = index === 0 ? anchor + hook : hook + anchor;
    if (countOccurrences(source, anchor) !== 1 || countOccurrences(source, hook) > 1) throw new Error('Offscreen app lifecycle anchor missing or ambiguous');
    if (!source.includes(hook)) source = source.replace(anchor, after);
    if (!source.includes(after)) throw new Error('Offscreen app lifecycle hook moved away from its anchor');
  }
  return source;
}
