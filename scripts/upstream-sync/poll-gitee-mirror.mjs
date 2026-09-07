import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY_URL = 'https://gitee.com/pq125pq/rp-hub-app.git';
const DEFAULT_MANIFEST_URL = 'https://gitee.com/pq125pq/rp-hub-app/raw/android-latest/android-update.json';
const MIRROR_REF = 'refs/heads/android-latest';

const describeError = error => String(error?.stderr || error?.message || error || 'unknown error')
  .trim()
  .split(/\r?\n/)
  .slice(-2)
  .join(' | ');

async function lookupRemoteSha() {
  const { stdout } = await execFileAsync('git', ['ls-remote', DEFAULT_REPOSITORY_URL, MIRROR_REF]);
  const match = String(stdout).split(/\r?\n/).find(line => line.trim().endsWith(`\t${MIRROR_REF}`));
  return match ? match.trim().split(/\s+/)[0] : '';
}

async function verifyManifest() {
  await execFileAsync('curl', [
    '--silent', '--show-error', '--fail', '--location', '--head',
    '--connect-timeout', '15', '--max-time', '30',
    DEFAULT_MANIFEST_URL
  ]);
}

export async function pollGiteeMirror({
  expectedSha,
  attempts = 30,
  delayMs = 10_000,
  lookup = lookupRemoteSha,
  verify = verifyManifest,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  logger = console
}) {
  if (!/^[0-9a-f]{40}$/i.test(String(expectedSha || ''))) {
    throw new Error(`Invalid expected Gitee mirror SHA: ${expectedSha || '<empty>'}`);
  }
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('Gitee mirror polling attempts and delay must be non-negative integers with at least one attempt');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let remoteSha = '';
    try {
      remoteSha = String(await lookup()).trim();
    } catch (error) {
      const nextAction = attempt < attempts ? 'retrying' : 'no attempts remain';
      logger.warn(`Gitee mirror ref check ${attempt}/${attempts} failed; ${nextAction}: ${describeError(error)}`);
    }

    if (remoteSha === expectedSha) {
      try {
        await verify();
        logger.log(`GITEE_MIRROR_POLL=PASS (${expectedSha})`);
        return;
      } catch (error) {
        const nextAction = attempt < attempts ? 'retrying' : 'no attempts remain';
        logger.warn(`Gitee mirror manifest check ${attempt}/${attempts} failed; ${nextAction}: ${describeError(error)}`);
      }
    }

    if (attempt < attempts) await wait(delayMs);
  }

  throw new Error(`Gitee mirror did not reach android-latest commit ${expectedSha} after ${attempts} attempts`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  pollGiteeMirror({ expectedSha: process.argv[2] }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
