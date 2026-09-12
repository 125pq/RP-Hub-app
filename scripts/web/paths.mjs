import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync } from 'node:fs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const publishRoots = Object.freeze(['index.html', 'LICENSE', 'assets', 'character', 'novel']);
export const publishExclusions = new Set(['assets/css/tailwind.input.css']);

// Explicit paths keep the existing CLI defaults while allowing isolated builds.
export function webPaths({ output = false } = {}) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--source-root', '--output-dir'].includes(key) || !args.length || options[key]) {
      throw new Error('Expected unique --source-root / --output-dir path arguments');
    }
    options[key] = args.shift();
  }
  if (!output && options['--output-dir']) throw new Error('--output-dir is only supported by build-web and verify-dist');
  const sourceRoot = path.resolve(options['--source-root'] || repositoryRoot);
  const outputDirectory = path.resolve(options['--output-dir'] || path.join(repositoryRoot, 'dist'));
  // These CLIs remove generated directories. Keep all custom paths inside the
  // disposable composition workspace and reject junctions/symlinks first.
  for (const [kind, target] of [['source', sourceRoot], ...(output ? [['output', outputDirectory]] : [])]) {
    const relative = path.relative(repositoryRoot, target);
    const candidatePrefix = path.join('.work', 'compose') + path.sep;
    const defaultPath = kind === 'source' ? relative === '' : relative === 'dist';
    if (!defaultPath && !relative.startsWith(candidatePrefix)) {
      throw new Error(`Custom ${kind} must be inside .work/compose: ${target}`);
    }
    let current = repositoryRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(`Build path must not contain a symlink/junction: ${current}`);
      }
    }
  }
  if (output) {
    const relative = path.relative(sourceRoot, outputDirectory);
    const reverse = path.relative(outputDirectory, sourceRoot);
    if (!relative || !reverse || (reverse !== '..' && !reverse.startsWith('..' + path.sep) && !path.isAbsolute(reverse))) {
      throw new Error('Output must not equal or contain the source directory');
    }
    if (relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      && ['assets', 'character', 'novel'].includes(relative.split(path.sep)[0])) {
      throw new Error('Output must not overlap published sources');
    }
  }
  return { sourceRoot, outputDirectory };
}
