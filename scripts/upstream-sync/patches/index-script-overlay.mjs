const scriptLine = (asset, indent = '        ') =>
  `${indent}document.write('<script src="assets/js/${asset}?v=' + new Date().getTime() + '"><\\/script>');`;

function findLoaderBlock(source) {
  const bodyStart = source.indexOf('</body>');
  const start = source.lastIndexOf('    <script>', bodyStart < 0 ? source.length : bodyStart);
  if (start < 0) throw new Error('Missing sync anchor: index.html script loader');
  const close = source.indexOf('    </script>', start + '    <script>'.length);
  if (close < 0) throw new Error('Missing sync anchor: index.html script loader end');
  const innerStart = start + '    <script>'.length;
  if (source[innerStart] !== '\n') throw new Error('index.html script loader EOL drifted');
  let inner = source.slice(innerStart + 1, close);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return {
    start,
    close,
    lines: inner.split('\n')
  };
}

function countLine(lines, line) {
  return lines.reduce((count, current) => count + (current === line ? 1 : 0), 0);
}

function ensureBefore(lines, anchor, insertion, label) {
  const insertionCount = countLine(lines, insertion);
  if (insertionCount > 1) throw new Error(`Duplicate hook detected: ${label}`);
  const anchorCount = countLine(lines, anchor);
  if (anchorCount !== 1) throw new Error(`Expected one script anchor for ${label}, found ${anchorCount}`);
  if (insertionCount === 1) return lines;
  lines.splice(lines.indexOf(anchor), 0, insertion);
  return lines;
}

function ensureAfter(lines, anchor, insertion, label) {
  const insertionCount = countLine(lines, insertion);
  if (insertionCount > 1) throw new Error(`Duplicate hook detected: ${label}`);
  const anchorCount = countLine(lines, anchor);
  if (anchorCount !== 1) throw new Error(`Expected one script anchor for ${label}, found ${anchorCount}`);
  if (insertionCount === 1) return lines;
  lines.splice(lines.indexOf(anchor) + 1, 0, insertion);
  return lines;
}

function normalizeHistoricalIndent(lines, asset) {
  const canonical = scriptLine(asset, '');
  const indented = scriptLine(asset);
  const canonicalCount = countLine(lines, canonical);
  const indentedCount = countLine(lines, indented);
  if (canonicalCount + indentedCount !== 1) {
    throw new Error(`Expected one script anchor for ${asset}, found ${canonicalCount + indentedCount}`);
  }
  if (indentedCount === 1) lines[lines.indexOf(indented)] = canonical;
  return lines;
}

function assertScriptOrder(lines) {
  const assets = [
    'built-in-content.js',
    'performance-benchmark.js',
    'scroll-performance-diagnosis.js',
    'core-utils.js',
    'data-services.js',
    'offscreen-iframe-lifecycle.js',
    'runtime-services.js',
    'ui-components.js',
    'platform-services.js',
    'rphub-android-adapter.js',
    'safe-area.js',
    'chat-import-streaming.js',
    'rphub-backup.js',
    'app.js'
  ];
  const indexes = assets.map(asset => {
    const exact = ['built-in-content.js', 'performance-benchmark.js', 'scroll-performance-diagnosis.js', 'core-utils.js'].includes(asset)
      ? scriptLine(asset, '')
      : scriptLine(asset);
    const index = lines.indexOf(exact);
    if (index < 0) throw new Error(`Missing sync anchor: index.html ${asset} loader`);
    if (countLine(lines, exact) !== 1) throw new Error(`Duplicate hook detected: index.html ${asset} loader`);
    return index;
  });
  const versionLines = lines.filter(line => /assets\/js\/(?:presence|update-check)\.js\?v=/.test(line));
  if (versionLines.length !== 1) throw new Error(`Expected one upstream update loader, found ${versionLines.length}`);
  const versionIndex = lines.indexOf(versionLines[0]);
  if (!(indexes[6] < versionIndex && versionIndex < indexes[7])) {
    throw new Error('index.html upstream update loader drifted out of runtime order');
  }
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i - 1] >= indexes[i]) throw new Error(`index.html script order drifted near ${assets[i]}`);
  }
}

export function patchIndexScriptOverlay(source) {
  const loader = findLoaderBlock(source);
  let lines = loader.lines;
  for (const asset of ['built-in-content.js', 'core-utils.js']) {
    lines = normalizeHistoricalIndent(lines, asset);
  }

  const core = scriptLine('core-utils.js', '');
  const data = scriptLine('data-services.js');
  const app = scriptLine('app.js');
  lines = ensureBefore(lines, core, scriptLine('performance-benchmark.js', ''), 'performance benchmark entry');
  lines = ensureBefore(lines, core, scriptLine('scroll-performance-diagnosis.js', ''), 'scroll diagnosis entry');
  lines = ensureAfter(lines, data, scriptLine('offscreen-iframe-lifecycle.js'), 'offscreen iframe entry');
  for (const asset of [
    'platform-services.js',
    'rphub-android-adapter.js',
    'safe-area.js',
    'chat-import-streaming.js',
    'rphub-backup.js'
  ]) {
    lines = ensureBefore(lines, app, scriptLine(asset), `${asset} entry`);
  }
  assertScriptOrder(lines);

  const replacement = `    <script>\n${lines.join('\n')}\n    </script>`;
  const current = source.slice(loader.start, loader.close + '    </script>'.length);
  return current === replacement
    ? source
    : `${source.slice(0, loader.start)}${replacement}${source.slice(loader.close + '    </script>'.length)}`;
}

export { scriptLine };
