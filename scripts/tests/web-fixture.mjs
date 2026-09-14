import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const override = process.env.RPHUB_TEST_WEB_ROOT;
if (override !== undefined && !override.trim()) throw new Error('RPHUB_TEST_WEB_ROOT must name an explicit directory');
export const webFixtureRoot = override === undefined ? repository : path.resolve(override);

// Behavior tests compare the candidate against a "current upstream" oracle to
// prove the registered transforms replay the candidate exactly. That oracle must
// be the upstream the candidate was composed from, not a hardcoded release, or
// the gate can only ever accept one version. check-candidate binds it to the
// verified build report; standalone runs default to the repository lock.
const fullCommit = /^[0-9a-f]{40}$/;
export const upstreamOracleRef = (() => {
  const bound = process.env.RPHUB_TEST_UPSTREAM_SHA;
  if (bound !== undefined) {
    if (!fullCommit.test(bound)) throw new Error('RPHUB_TEST_UPSTREAM_SHA must be a full 40-hex commit id');
    return bound;
  }
  const lock = JSON.parse(readFileSync(path.join(repository, 'upstream.lock.json'), 'utf8'));
  if (!fullCommit.test(lock.commit)) throw new Error('upstream.lock.json must pin a full 40-hex commit id');
  return lock.commit;
})();

export function readUpstreamSource(relative) {
  return execFileSync('git', ['show', `${upstreamOracleRef}:${relative}`], {
    cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r\n/g, '\n');
}

// An explicit candidate never falls back to checkout assets if a file is missing.
export function webFixturePath(relative) {
  const result = path.resolve(webFixtureRoot, relative);
  const child = path.relative(webFixtureRoot, result);
  if (!child || child === '..' || child.startsWith('..' + path.sep) || path.isAbsolute(child)) {
    throw new Error('Web fixture path escapes its selected root: ' + relative);
  }
  return result;
}
