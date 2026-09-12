import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { webPaths, publishRoots as publishAllowlist, publishExclusions } from './paths.mjs';
import path from 'node:path';

const { sourceRoot: projectRoot, outputDirectory } = webPaths({ output: true });

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
console.log('Output:', outputDirectory);
console.log('Entrypoints:');
for (const entry of ['index.html', 'character/index.html', 'novel/index.html']) {
  console.log('-', path.join(outputDirectory, entry));
}
