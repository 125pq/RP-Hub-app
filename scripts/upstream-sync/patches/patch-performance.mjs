import { editText, requireContains } from '../lib.mjs';
import { patchIndexScriptOverlay } from './index-script-overlay.mjs';

const category = 'performance-patches';

export async function applyPerformanceHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, patchIndexScriptOverlay));

  changes.push(await editText('assets/js/app.js', category, source => {
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.attach(container);', 'offscreen attach hook');
    requireContains(source, 'window.RPHubOffscreenIframeLifecycle?.detach();', 'offscreen cleanup hook');
    return source;
  }));

  changes.push(await editText('assets/js/runtime-services.js', category, source => {
    requireContains(source, 'const createStreamingBoundaryTracker = () => {', 'paragraph boundary tracker');
    requireContains(source, "flushPending('final');", 'streaming final flush');
    return source;
  }));
  return changes.filter(Boolean);
}
