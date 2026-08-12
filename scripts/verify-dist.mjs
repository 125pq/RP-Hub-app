import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectRoot, 'dist');

const publishAllowlist = [
  'index.html',
  'LICENSE',
  'assets',
  'character',
  'novel',
];

const requiredFiles = [
  'index.html',
  'character/index.html',
  'novel/index.html',
  'LICENSE',
  'assets/css/styles.css',
  'assets/js/built-in-content.js',
  'assets/js/core-utils.js',
  'assets/js/data-services.js',
  'assets/js/runtime-services.js',
  'assets/js/ui-components.js',
  'assets/js/app.js',
];

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
        files.push(toPosixPath(path.join(relativePath, nestedPath)));
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
console.log(`Remote runtime dependencies: ${remoteRuntimeDependencies.size}`);

if (remoteRuntimeDependencies.size > 0) {
  console.warn('WARN: remote runtime dependencies detected');
  console.warn('These will be localized in Commit 2/3.');
  for (const dependency of [...remoteRuntimeDependencies].sort()) {
    console.warn(`- ${dependency}`);
  }
}
