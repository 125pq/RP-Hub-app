import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const outputDirectory = path.join(projectRoot, 'dist');

const publishAllowlist = [
  'index.html',
  'LICENSE',
  'assets',
  'character',
  'novel',
];

const publishExclusions = new Set([
  'assets/css/tailwind.input.css',
]);

const requiredFiles = [
  'index.html',
  'character/index.html',
  'novel/index.html',
  'LICENSE',
  'assets/css/styles.css',
  'assets/css/safe-area.css',
  'assets/generated/main.css',
  'assets/generated/character.css',
  'assets/generated/novel.css',
  'assets/js/built-in-content.js',
  'assets/js/core-utils.js',
  'assets/js/data-services.js',
  'assets/js/offscreen-iframe-lifecycle.js',
  'assets/js/runtime-services.js',
  'assets/js/ui-components.js',
  'assets/js/platform-services.js',
  'assets/js/rphub-android-adapter.js',
  'assets/js/safe-area.js',
  'assets/js/chat-import-streaming.js',
  'assets/js/rphub-backup.js',
  'assets/js/app.js',
  'assets/vendor/vue/vue.global.prod.js',
  'assets/vendor/marked/marked.min.js',
  'assets/vendor/dompurify/purify.min.js',
  'assets/vendor/sortablejs/Sortable.min.js',
  'assets/vendor/tailwind-preview/tailwind-runtime.min.js',
  'assets/vendor/localforage/localforage.min.js',
  'assets/vendor/jquery/jquery.min.js',
  'assets/vendor/fonts/fonts.css',
];

const expectedVendorFiles = [
  'assets/vendor/dompurify/purify.min.js',
  'assets/vendor/fonts/fonts.css',
  'assets/vendor/fonts/lora-latin-wght-italic.woff2',
  'assets/vendor/fonts/lora-latin-wght-normal.woff2',
  'assets/vendor/fonts/ma-shan-zheng-chinese-simplified-400-normal.woff2',
  'assets/vendor/fonts/ma-shan-zheng-latin-400-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-chinese-simplified-300-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-chinese-simplified-400-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-chinese-simplified-600-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-chinese-simplified-700-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-latin-300-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-latin-400-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-latin-600-normal.woff2',
  'assets/vendor/fonts/noto-serif-sc-latin-700-normal.woff2',
  'assets/vendor/jquery/jquery.min.js',
  'assets/vendor/localforage/localforage.min.js',
  'assets/vendor/marked/marked.min.js',
  'assets/vendor/sortablejs/Sortable.min.js',
  'assets/vendor/tailwind-preview/tailwind-runtime.min.js',
  'assets/vendor/vue/vue.global.prod.js',
];

const expectedGeneratedFiles = [
  'assets/generated/character.css',
  'assets/generated/main.css',
  'assets/generated/novel.css',
];

const globalBundleChecks = [
  ['assets/vendor/vue/vue.global.prod.js', /var Vue=function/],
  ['assets/vendor/marked/marked.min.js', /g\["marked"\]=f\(\)/],
  ['assets/vendor/dompurify/purify.min.js', /DOMPurify/],
  ['assets/vendor/sortablejs/Sortable.min.js', /\.Sortable=e\(\)/],
  ['assets/vendor/localforage/localforage.min.js', /local[Ff]orage/],
  ['assets/vendor/jquery/jquery.min.js', /\.jQuery/],
  ['assets/vendor/tailwind-preview/tailwind-runtime.min.js', /window\.createTailwindcss=/],
];

const blockedRemotePattern = /https?:\/\/(?:cdn\.tailwindcss\.com|cdn\.jsdelivr\.net\/npm\/(?:@tailwindcss\/browser|tailwindcss|daisyui|vue|marked|dompurify|sortablejs|localforage|jquery)|unpkg\.com\/(?:@tailwindcss\/browser|tailwindcss|daisyui|vue|marked|dompurify|sortablejs|localforage|jquery)|cdnjs\.cloudflare\.com\/ajax\/libs\/(?:tailwindcss|daisyui|vue|marked|dompurify|sortablejs|localforage|jquery)|ajax\.googleapis\.com\/ajax\/libs\/jquery|code\.jquery\.com\/jquery|fonts\.googleapis\.com|fonts\.gstatic\.com)[^"'\s<]*/gi;

const entryDocuments = new Set([
  'index.html',
  'character/index.html',
  'novel/index.html',
]);

const forbiddenPathSegments = new Set([
  '.git',
  'node_modules',
  'scripts',
  'android',
  'tests',
  'docs',
  'keystore',
]);

const forbiddenFileNames = new Set([
  'keystore.properties',
  'performance_audit.md',
  '.ds_store',
  'thumbs.db',
]);

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

async function listFiles(directory, relativeDirectory = '') {
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(directory, relativePath));
    } else if (entry.isFile()) {
      files.push(toPosixPath(relativePath));
    } else {
      throw new Error(`Unsupported filesystem entry in dist: ${toPosixPath(relativePath)}`);
    }
  }

  return files;
}

async function listPublishedSourceFiles() {
  const files = [];

  for (const relativePath of publishAllowlist) {
    const sourcePath = path.join(projectRoot, relativePath);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.isDirectory()) {
      for (const nestedPath of await listFiles(sourcePath)) {
        const publishedPath = toPosixPath(path.join(relativePath, nestedPath));
        if (!publishExclusions.has(publishedPath)) files.push(publishedPath);
      }
    } else {
      files.push(toPosixPath(relativePath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function isForbidden(relativePath) {
  const segments = relativePath.split('/');
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  const fileName = normalizedSegments.at(-1);

  return normalizedSegments.some((segment) => forbiddenPathSegments.has(segment))
    || forbiddenFileNames.has(fileName)
    || /\.(?:keystore|jks|tmp|temp|bak|swp|log)$/i.test(fileName)
    || /^~/.test(fileName);
}

function findRemoteRuntimeDependencies(text) {
  const dependencies = [];
  const tagPattern = /<(script|link)\b[^>]*>/gi;

  for (const match of text.matchAll(tagPattern)) {
    const [tag, tagName] = match;
    const urlMatch = tag.match(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    if (!urlMatch) continue;

    if (tagName.toLowerCase() === 'link'
      && !/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(tag)) {
      continue;
    }

    dependencies.push(urlMatch[1]);
  }

  return dependencies;
}

function findExternalUrlLiterals(text) {
  return text.match(/https?:\/\/[^"'`\s<>{}\\]+/gi) || [];
}

try {
  const outputStat = await stat(outputDirectory);
  if (!outputStat.isDirectory()) throw new Error('dist exists but is not a directory');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('dist/ does not exist. Run npm run build:web first.');
  }
  throw error;
}

const distFiles = await listFiles(outputDirectory);
const distFileSet = new Set(distFiles);

const actualVendorFiles = distFiles.filter((relativePath) => relativePath.startsWith('assets/vendor/'));
if (actualVendorFiles.join('\n') !== expectedVendorFiles.join('\n')) {
  throw new Error('Vendor output differs from the exact Commit 2 allowlist.');
}

const actualGeneratedFiles = distFiles.filter((relativePath) => relativePath.startsWith('assets/generated/'));
if (actualGeneratedFiles.join('\n') !== expectedGeneratedFiles.join('\n')) {
  throw new Error('Generated CSS output differs from the exact Commit 3 allowlist.');
}

const missingRequiredFiles = requiredFiles.filter((relativePath) => !distFileSet.has(relativePath));
if (missingRequiredFiles.length > 0) {
  throw new Error(`Missing required dist files:\n- ${missingRequiredFiles.join('\n- ')}`);
}

const forbiddenFiles = distFiles.filter(isForbidden);
if (forbiddenFiles.length > 0) {
  throw new Error(`Forbidden files found in dist:\n- ${forbiddenFiles.join('\n- ')}`);
}

const sourceFiles = await listPublishedSourceFiles();
if (sourceFiles.join('\n') !== distFiles.join('\n')) {
  const sourceSet = new Set(sourceFiles);
  const missing = sourceFiles.filter((relativePath) => !distFileSet.has(relativePath));
  const unexpected = distFiles.filter((relativePath) => !sourceSet.has(relativePath));
  throw new Error([
    'Source and dist file lists differ.',
    missing.length ? `Missing from dist:\n- ${missing.join('\n- ')}` : '',
    unexpected.length ? `Unexpected in dist:\n- ${unexpected.join('\n- ')}` : '',
  ].filter(Boolean).join('\n'));
}

let totalBytes = 0;
const manifestEntries = [];
const remoteRuntimeDependencies = new Set();
const blockedRemoteDependencies = [];
const externalUrlLiterals = new Set();

for (const relativePath of distFiles) {
  const sourcePath = path.join(projectRoot, relativePath);
  const distPath = path.join(outputDirectory, relativePath);
  const [sourceHash, distHash, distStat] = await Promise.all([
    sha256(sourcePath),
    sha256(distPath),
    stat(distPath),
  ]);

  if (sourceHash !== distHash) {
    throw new Error(`Source and dist content differ: ${relativePath}`);
  }

  totalBytes += distStat.size;
  manifestEntries.push(`${relativePath}\t${distStat.size}\t${distHash}`);

  if (/\.(?:html|js|css)$/i.test(relativePath)) {
    const text = await readFile(distPath, 'utf8');
    for (const dependency of findRemoteRuntimeDependencies(text)) {
      remoteRuntimeDependencies.add(dependency);
    }

    if (!relativePath.startsWith('assets/vendor/')) {
      for (const url of findExternalUrlLiterals(text)) {
        if (!url.includes('www.w3.org/')) externalUrlLiterals.add(url);
      }
    }

    if (entryDocuments.has(relativePath)) {
      const documentHead = text.slice(0, text.toLowerCase().indexOf('</head>'));
      const forbiddenEntryDependencies = findRemoteRuntimeDependencies(documentHead)
        .filter((dependency) => dependency.includes('cdn.tailwindcss.com')
          || dependency.includes('/daisyui@'));
      if (forbiddenEntryDependencies.length > 0) {
        blockedRemoteDependencies.push(...forbiddenEntryDependencies.map(
          (dependency) => `${relativePath} entry document: ${dependency}`,
        ));
      }
    }

    for (const match of text.matchAll(blockedRemotePattern)) {
      blockedRemoteDependencies.push(`${relativePath}: ${match[0]}`);
    }
  }
}

if (blockedRemoteDependencies.length > 0) {
  throw new Error(`Remote dependencies that must be local were found:\n- ${blockedRemoteDependencies.join('\n- ')}`);
}

for (const [relativePath, expectedGlobalPattern] of globalBundleChecks) {
  const bundle = await readFile(path.join(outputDirectory, relativePath), 'utf8');
  if (!expectedGlobalPattern.test(bundle)) {
    throw new Error(`Browser bundle does not expose the expected global: ${relativePath}`);
  }
}

const manifestHash = createHash('sha256')
  .update(manifestEntries.join('\n'))
  .digest('hex');

console.log('RP-Hub dist verification passed');
console.log(`Files: ${distFiles.length}`);
console.log(`Bytes: ${totalBytes}`);
console.log(`Manifest SHA-256: ${manifestHash}`);
console.log(`Source matches: ${sourceFiles.length}/${sourceFiles.length}`);
console.log('Forbidden files: 0');
console.log(`Vendor files: ${actualVendorFiles.length}`);
console.log(`Generated CSS files: ${actualGeneratedFiles.length}`);
console.log(`Static global checks: ${globalBundleChecks.length}/${globalBundleChecks.length}`);
console.log('');
console.log('Runtime dependency audit');
console.log('PASS Vue');
console.log('PASS marked');
console.log('PASS DOMPurify');
console.log('PASS SortableJS');
console.log('PASS localforage');
console.log('PASS jQuery');
console.log('PASS Tailwind Main');
console.log('PASS Tailwind Character');
console.log('PASS Tailwind Novel');
console.log('PASS Character Preview runtime');
console.log(`Remote application runtime dependencies: ${remoteRuntimeDependencies.size}`);
console.log(`External product/service URL literals: ${externalUrlLiterals.size}`);
