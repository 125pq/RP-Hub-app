import { countOccurrences, editText, ensureBefore, requireContains } from '../lib.mjs';

const category = 'performance-patches';

export async function applyPerformanceHooks() {
  const changes = [];
  changes.push(await editText('index.html', category, source => {
    const appScript = `        document.write('<script src="assets/js/app.js?v=' + new Date().getTime() + '"><\\/script>');`;
    for (const [script, label] of [
      ['performance-benchmark.js', 'performance benchmark entry'],
      ['scroll-performance-diagnosis.js', 'scroll diagnosis entry'],
      ['offscreen-iframe-lifecycle.js', 'offscreen iframe entry']
    ]) {
      const occurrences = countOccurrences(source, `assets/js/${script}`);
      if (occurrences === 1) continue;
      if (occurrences > 1) throw new Error(`Duplicate hook detected: ${label}`);
      source = ensureBefore(
        source,
        appScript,
        `        document.write('<script src="assets/js/${script}?v=' + new Date().getTime() + '"><\\/script>');\n`,
        label
      );
    }
    return source;
  }));

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
