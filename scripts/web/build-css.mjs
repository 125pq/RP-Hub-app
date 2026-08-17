import { spawnSync } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const inputPath = path.join(projectRoot, 'assets', 'css', 'tailwind.input.css');
const outputDirectory = path.join(projectRoot, 'assets', 'generated');
const cliPath = path.join(projectRoot, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

const builds = [
  ['tailwind.main.config.cjs', 'main.css'],
  ['tailwind.character.config.cjs', 'character.css'],
  ['tailwind.novel.config.cjs', 'novel.css'],
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [configName, outputName] of builds) {
  const outputPath = path.join(outputDirectory, outputName);
  const result = spawnSync(process.execPath, [
    cliPath,
    '--config', path.join(projectRoot, configName),
    '--input', inputPath,
    '--output', outputPath,
    '--minify',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Tailwind build failed for ${configName} (exit ${result.status ?? 'unknown'})`);
  }

  const outputStat = await stat(outputPath);
  if (!outputStat.isFile() || outputStat.size === 0) {
    throw new Error(`Tailwind produced an empty output: ${outputName}`);
  }

  console.log(`Generated assets/generated/${outputName} (${outputStat.size} bytes)`);
}
