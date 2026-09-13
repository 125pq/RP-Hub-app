import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from '../web/paths.mjs';

export function pinUpstream(root, tag, commit, { dryRun = false } = {}) {
  assert.match(tag, /^v?\d+\.\d+\.\d+$/, 'Expected a stable upstream tag');
  assert.match(commit, /^[0-9a-f]{40}$/, 'Expected the resolved upstream commit');
  const resolved = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(resolved, commit, 'Fetched upstream tag differs from the selected release');
  const file = path.join(root, 'upstream.lock.json');
  const source = readFileSync(file, 'utf8');
  const previous = JSON.parse(source);
  assert.equal(previous.schemaVersion, 1);
  assert.equal(previous.repository, 'https://github.com/STA1N156/RP-Hub.git');
  const next = { ...previous, tag, commit };
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = (JSON.stringify(next, null, 2) + '\n').replaceAll('\n', eol);
  if (!dryRun && text !== source) writeFileSync(file, text);
  return next;
}

export function assertVersionMatchesLock(version, lock) {
  const match = String(version).match(/^(\d+\.\d+\.\d+)(?:\.([1-9]\d?))?$/);
  assert.ok(match && match[1] === lock.tag.replace(/^v/, ''),
    `Package version ${version} does not match locked upstream ${lock.tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Expected <upstream tag> <resolved commit>');
  const lock = pinUpstream(repositoryRoot, ...args);
  console.log(`Composition upstream pinned: ${lock.tag} ${lock.commit}`);
}
