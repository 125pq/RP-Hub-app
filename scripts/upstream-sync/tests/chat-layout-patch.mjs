import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchChatLayoutCss } from '../patches/patch-chat-layout.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = relativePath => readFile(path.join(projectRoot, relativePath), 'utf8');

// --- patch unit checks ------------------------------------------------------
const upstreamSnippet = `            .centered-message-shell {
                width: 50vw;
                max-width: 50vw !important;
            }`;

const patched = patchChatLayoutCss(upstreamSnippet);
assert.ok(patched.includes('width: min(56rem, 72%);'), 'patch must restore min(56rem, 72%) width');
assert.ok(patched.includes('max-width: min(56rem, 72%) !important;'), 'patch must restore min(56rem, 72%) max-width');
assert.ok(!patched.includes('50vw'), 'patch must remove the 50vw rule');
assert.equal(patchChatLayoutCss(patched), patched, 'patch must be idempotent');
assert.throws(
  () => patchChatLayoutCss(upstreamSnippet.replace('50vw', '48vw')),
  /centered-message-shell width/,
  'patch must fail on drifted upstream snippet'
);

// --- applied state in the working tree --------------------------------------
const css = await read('assets/css/styles.css');
assert.ok(css.includes('width: min(56rem, 72%);'), 'styles.css must contain the restored width');
assert.ok(css.includes('max-width: min(56rem, 72%) !important;'), 'styles.css must contain the restored max-width');
assert.ok(!css.includes('width: 50vw;'), 'styles.css must not retain the 50vw width');

console.log('Chat layout patch: PASS');
