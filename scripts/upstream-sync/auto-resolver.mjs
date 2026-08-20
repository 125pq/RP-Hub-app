import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './lib.mjs';
import { overlayManifest, transformOverlayBlob } from './overlay-transformers.mjs';

const manifest = new Set(overlayManifest);

function gitBuffer(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitText(cwd, args) {
  return gitBuffer(cwd, args).toString('utf8').trim();
}

function parseUnmergedRecords(buffer) {
  const records = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error(`Malformed unmerged record: ${record}`);
    const [mode, objectId, stage] = record.slice(0, tab).split(' ');
    if (!/^\d{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/.test(objectId) || !/^[123]$/.test(stage)) {
      throw new Error(`Malformed unmerged stage record for ${record.slice(tab + 1)}`);
    }
    records.push({ mode, objectId, stage: Number(stage), relativePath: record.slice(tab + 1) });
  }
  return records;
}

function assertSafeRelativePath(relativePath, cwd = projectRoot) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Unsafe conflict path: ${relativePath || '(empty)'}`);
  const resolved = path.resolve(cwd, relativePath);
  const root = `${path.resolve(cwd)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`Unsafe conflict path: ${relativePath}`);
  return resolved;
}

function readTextBlob(cwd, record) {
  const type = gitText(cwd, ['cat-file', '-t', record.objectId]);
  if (type !== 'blob') throw new Error(`Conflict stage ${record.stage} for ${record.relativePath} is ${type}, not a blob`);
  const bytes = gitBuffer(cwd, ['cat-file', 'blob', record.objectId]);
  if (bytes.includes(0)) throw new Error(`Binary conflict rejected for ${record.relativePath}`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Non-UTF-8 conflict rejected for ${record.relativePath}`);
  }
  return { bytes, text };
}

function collectStages(cwd) {
  const records = parseUnmergedRecords(gitBuffer(cwd, ['ls-files', '-u', '--stage', '-z']));
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.relativePath)) grouped.set(record.relativePath, []);
    grouped.get(record.relativePath).push(record);
  }
  return grouped;
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function validateStages(cwd, grouped) {
  if (grouped.size === 0) throw new Error('No unmerged paths found');
  const plans = [];
  for (const [relativePath, records] of grouped) {
    if (!manifest.has(relativePath)) {
      throw new Error(`Path is not in the auto-resolver manifest: ${relativePath}`);
    }
    assertSafeRelativePath(relativePath, cwd);
    const byStage = new Map(records.map(record => [record.stage, record]));
    if (records.length !== 3 || [1, 2, 3].some(stage => !byStage.has(stage))) {
      throw new Error(`Conflict stage shape rejected for ${relativePath}; expected exactly stages 1/2/3`);
    }
    const modes = new Set(records.map(record => record.mode));
    if (modes.size !== 1 || !modes.has('100644')) {
      throw new Error(`Mode conflict rejected for ${relativePath}`);
    }
    const stageText = new Map();
    for (const stage of [1, 2, 3]) stageText.set(stage, readTextBlob(cwd, byStage.get(stage)).text);
    const transformedLocal = transformOverlayBlob(relativePath, stageText.get(1));
    if (normalizeEol(transformedLocal) !== normalizeEol(stageText.get(2))) {
      throw new Error(`Registered transformer proof failed for ${relativePath}: transform(stage1) != stage2`);
    }
    const transformedUpstream = transformOverlayBlob(relativePath, stageText.get(3));
    plans.push({ relativePath, absolutePath: assertSafeRelativePath(relativePath, cwd), transformedUpstream });
  }
  return plans;
}

// Resolve only conflicts whose local side is demonstrably produced by the
// registered pure overlay hook. All validation happens before any write/add.
export async function resolveAutoConflicts({ cwd = projectRoot } = {}) {
  const grouped = collectStages(cwd);
  const plans = validateStages(cwd, grouped);
  for (const plan of plans) {
    await writeFile(plan.absolutePath, plan.transformedUpstream, 'utf8');
  }
  for (const plan of plans) {
    gitBuffer(cwd, ['add', '--', plan.relativePath]);
  }
  const remaining = gitText(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (remaining) throw new Error(`Auto-resolver left unmerged paths:\n${remaining}`);
  return plans.map(plan => plan.relativePath);
}

export { manifest as autoResolverManifest, normalizeEol, parseUnmergedRecords, validateStages };
