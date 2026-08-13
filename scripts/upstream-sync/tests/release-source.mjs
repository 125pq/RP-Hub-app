import assert from 'node:assert/strict';
import { resolveLatestStableRelease, validateStableRelease } from '../release-source.mjs';

assert.equal(validateStableRelease({ tag_name: '1.8.3', draft: false, prerelease: false }), '1.8.3');
assert.throws(() => validateStableRelease({ tag_name: '1.8.4-rc.1', draft: false, prerelease: true }), /pre-release/);
assert.throws(() => validateStableRelease({ tag_name: 'bad..tag', draft: false, prerelease: false }), /unsafe tag/);

const responses = new Map([
  ['https://api.github.com/repos/STA1N156/RP-Hub/releases/latest', {
    tag_name: '1.8.3',
    name: '1.8.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-13T11:29:55Z',
    html_url: 'https://github.com/STA1N156/RP-Hub/releases/tag/1.8.3'
  }],
  ['https://api.github.com/repos/STA1N156/RP-Hub/commits/1.8.3', {
    sha: '2a864be65460b94086925f553ed8257038cb5634'
  }]
]);
const fakeFetch = async url => ({
  ok: responses.has(url),
  status: responses.has(url) ? 200 : 404,
  json: async () => responses.get(url)
});
const release = await resolveLatestStableRelease(fakeFetch);
assert.deepEqual(release, {
  tagName: '1.8.3',
  commitSha: '2a864be65460b94086925f553ed8257038cb5634',
  releaseName: '1.8.3',
  publishedAt: '2026-08-13T11:29:55Z',
  url: 'https://github.com/STA1N156/RP-Hub/releases/tag/1.8.3'
});

console.log('Latest stable upstream release resolution: PASS');
