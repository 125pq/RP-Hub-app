# Upstream synchronization

RP-Hub Web comes from [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub), branch `main`. This repository keeps Android native code, offline assets, WebView layout fixes, performance patches, and a small set of calls into `window.platformAdapter`.

## Manual use

Run a real sync, complete verification, Android unit tests and `assembleRelease`, then create the sync commit:

```text
node scripts/upstream-sync/sync-upstream.mjs
```

Run the same merge, hook reapply, tests, and Android build without retaining the merge or creating a commit:

```text
node scripts/upstream-sync/sync-upstream.mjs --dry-run
```

Both commands require a clean working tree. A real Git conflict is reported and aborted; the scripts never select `ours` or `theirs` automatically.

## Patch categories

- `patch-android-hooks.mjs`: platform script order, Back/AppState lifecycle, and shared character/novel export calls.
- `patch-safe-area.mjs`: `viewport-fit`, safe-area stylesheet, and fixed WebView layout hooks.
- `patch-offline-assets.mjs`: verifies the local Vue, Markdown, Tailwind, fonts, and other runtime entrypoints.
- `patch-performance.mjs`: paragraph-aware streaming and offscreen iframe entry hooks.

Android and browser implementations remain in `assets/js/rphub-android-adapter.js` and `assets/js/platform-services.js`. Native SAF implementation remains under `android/app/src/main/java`.

## Failure handling

- Merge conflict: inspect the conflict list printed by `sync-upstream.mjs`; the merge has already been aborted.
- Missing sync anchor: update the matching file under `scripts/upstream-sync/patches/`. This normally means upstream substantially rewrote the surrounding function or HTML entrypoint.
- Adapter verification failure: run `node scripts/upstream-sync/verify.mjs` and inspect the named contract.
- Idempotence failure: run `node scripts/upstream-sync/tests/reapply-idempotence.mjs`; the second pass must report zero changed files.
- Offline dependency failure: update `patch-offline-assets.mjs`, the vendor preparation script, and `scripts/verify-dist.mjs` together.

The scheduled workflow requires the existing permanent release key through these GitHub Actions secrets: `RPHUB_RELEASE_KEYSTORE_BASE64`, `RPHUB_RELEASE_STORE_PASSWORD`, `RPHUB_RELEASE_KEY_ALIAS`, and `RPHUB_RELEASE_KEY_PASSWORD`. The keystore file is decoded only into the runner temporary directory and is never committed.
