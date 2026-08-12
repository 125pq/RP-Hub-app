import { cp, mkdir, rm, stat } from 'node:fs/promises';
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

const publishExclusions = new Set([
  'assets/css/tailwind.input.css',
]);

function shouldPublish(sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath).split(path.sep).join('/');
  return !publishExclusions.has(relativePath);
}

async function assertSourceExists(relativePath) {
  const sourcePath = path.join(projectRoot, relativePath);

  try {
    await stat(sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Required publish source is missing: ${relativePath}`);
    }
    throw error;
  }
}

for (const relativePath of publishAllowlist) {
  await assertSourceExists(relativePath);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const relativePath of publishAllowlist) {
  await cp(
    path.join(projectRoot, relativePath),
    path.join(outputDirectory, relativePath),
    { recursive: true, filter: shouldPublish },
  );
}

console.log('RP-Hub web build complete');
console.log('Output: dist/');
console.log('Entrypoints:');
console.log('- dist/index.html');
console.log('- dist/character/index.html');
console.log('- dist/novel/index.html');
