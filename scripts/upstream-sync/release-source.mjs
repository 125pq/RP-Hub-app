import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const UPSTREAM_API = 'https://api.github.com/repos/STA1N156/RP-Hub';
const UPSTREAM_REPOSITORY = 'STA1N156/RP-Hub';

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RP-Hub-upstream-sync',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readJson(response, description) {
  if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}`);
  return response.json();
}

export function validateStableRelease(release) {
  if (!release || typeof release !== 'object') throw new Error('GitHub returned invalid release metadata');
  if (release.draft) throw new Error('GitHub latest release unexpectedly points to a draft');
  if (release.prerelease) throw new Error('GitHub latest release unexpectedly points to a pre-release');
  const tagName = String(release.tag_name || '');
  const hasForbiddenCharacter = [...tagName].some(character => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || '~^:?*[\\'.includes(character);
  });
  if (!tagName || hasForbiddenCharacter || tagName.includes('..') || tagName.endsWith('.')) {
    throw new Error(`GitHub latest release has an unsafe tag name: ${JSON.stringify(tagName)}`);
  }
  return tagName;
}

function normalizeRelease(release, commit) {
  const tagName = validateStableRelease(release);
  const commitSha = String(commit?.sha || '');
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error(`GitHub returned an invalid commit SHA for upstream release ${tagName}`);
  }
  return {
    tagName,
    commitSha,
    releaseName: String(release.name || tagName),
    publishedAt: String(release.published_at || ''),
    url: String(release.html_url || '')
  };
}

async function resolveWithFetch(fetchImpl) {
  const options = { headers: githubHeaders() };
  const release = await readJson(
    await fetchImpl(`${UPSTREAM_API}/releases/latest`, options),
    'Latest stable upstream release lookup'
  );
  const tagName = validateStableRelease(release);
  const commit = await readJson(
    await fetchImpl(`${UPSTREAM_API}/commits/${encodeURIComponent(tagName)}`, options),
    `Commit lookup for upstream release ${tagName}`
  );
  return normalizeRelease(release, commit);
}

function githubCliPath() {
  if (process.env.GH_PATH) return process.env.GH_PATH;
  if (process.platform !== 'win32') return 'gh';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')
  ];
  return candidates.find(candidate => existsSync(candidate)) || 'gh.exe';
}

function ghApi(endpoint) {
  const output = execFileSync(githubCliPath(), ['api', endpoint], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output);
}

function resolveWithGitHubCli() {
  const release = ghApi(`repos/${UPSTREAM_REPOSITORY}/releases/latest`);
  const tagName = validateStableRelease(release);
  const commit = ghApi(`repos/${UPSTREAM_REPOSITORY}/commits/${encodeURIComponent(tagName)}`);
  return normalizeRelease(release, commit);
}

export async function resolveLatestStableRelease(fetchImpl = fetch) {
  try {
    return await resolveWithFetch(fetchImpl);
  } catch (fetchError) {
    try {
      const release = resolveWithGitHubCli();
      console.warn(`RELEASE_API_FALLBACK=GitHub CLI (${fetchError.message})`);
      return release;
    } catch (cliError) {
      throw new Error(`Unable to resolve the latest stable upstream release via HTTPS or GitHub CLI: ${fetchError.message}; ${cliError.message}`);
    }
  }
}
