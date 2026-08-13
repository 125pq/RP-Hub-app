# Offscreen Executable Iframe Optimization

## RESULT

**PASS — Stage A only**

Commit 10 confirmed that executable message iframes were the dominant source of long-chat scroll jank. This change keeps every iframe, browsing context, document, local JavaScript state and rendered height intact, but pauses CSS animations after a frame moves beyond a 1.5-chat-viewport preload margin. Frames resume in `NEAR`, before becoming `ACTIVE` in the viewport.

Stage B iframe unload was not implemented. Stage A reduced the fixed real-chat rAF p95 to 16.7 ms, rAF intervals over 33 ms by 90.5%, intervals over 50 ms by 93.3%, and Long Tasks by 94.1%. Those are the user-visible scheduling/jank metrics that decide whether the higher-risk state-destroying path is necessary.

## Scope and lifecycle

- Target: only `iframe.executable-html-frame` descendants of the Main chat container.
- Excluded: Character, Novel, Square/external embeds, and arbitrary page iframes.
- States: `ACTIVE` (intersects chat viewport), `NEAR` (within 1.5 current chat viewport heights), `OFFSCREEN` (farther away).
- `OFFSCREEN`: add a child-document class whose temporary rule sets only `animation-play-state: paused !important` on elements and pseudo-elements.
- `NEAR`/`ACTIVE`: remove the class. CSS transitions, timers, rAF, media and network are untouched.
- Registry: per-frame metadata is a `WeakMap`; the iterable set is pruned immediately by the chat `MutationObserver`. Removal unobserves both intersection observers, removes the load listener, resumes the child document, and deletes metadata.
- App/container lifecycle: attaching a new container first detaches the old lifecycle. `visibilitychange`, `pageshow` and resize refresh current geometry; app unmount performs full cleanup.

The observer preload margin is calculated from `chatContainer.clientHeight`, not a device-specific pixel constant. Two observers provide ACTIVE and NEAR boundary notifications; geometry is coalesced into one animation frame.

## Real-world environment and fixed state

- Device: vivo V2505A, Android 16 / API 36.
- Android System WebView: 150.0.7871.183 (same device as Commit 10 baseline).
- Baseline: Commit 10 returned-bottom trace at `37e48042e7384850d493b172d43710cffcc5375e`.
- Stage A measurement APK SHA-256: `E0CF561D378E51ADE7CCC72BEDFF0AF317BA077C14BEE30BE81A538963D8685A`.
- Final regression APK SHA-256: `EC1AD9F704E88099BF2E1DA81F3E0BB44BBB3CBE7A421881300345968031798F`.
- Real authorized chat: “黎明之契”; 354 history, 40 mounted, 22 executable iframes, returned-bottom.
- Fixed action: scroll up 3 viewports over 1800 ms, pause 400 ms, return over 1800 ms.
- Stage A trace completed at thermal status 3, battery 41.1°C. No status reached 4; no repeated >1000 ms gap, renderer hang or WebView crash occurred.
- Streaming was false; no API/model call was made and no chat content was recorded.

## Baseline vs Stage A

Trace durations are summed CDP events and categories can overlap. rAF is a frame-delay estimate, not SurfaceFlinger FPS.

| Metric | Baseline | Pause-only | Unload (not tested) |
|---|---:|---:|---:|
| rAF median ms | 16.6 | 16.6 | — |
| rAF p95 ms | 66.6 | 16.7 | — |
| rAF max ms | 116.4 | 83.1 | — |
| >33 ms | 21 | 2 | — |
| >50 ms | 15 | 1 | — |
| Long tasks | 17 | 1 | — |
| Style ms | 1683.0 | 1761.2 | — |
| Layout ms | 178.5 | 47.0 | — |
| PrePaint ms | 367.5 | 190.6 | — |
| Paint ms | 266.6 | 439.0 | — |
| PrePaint + Paint ms | 634.2 | 629.6 | — |
| Running offscreen animations | 324 | 0 | — |
| Paused offscreen animations | 0 | 340 | — |

Reductions: rAF p95 -74.9%, >33 ms -90.5%, >50 ms -93.3%, Long Tasks -94.1%, and Layout -73.7%. The non-traced continuity run was slightly better again: p95 16.7 ms, >33 ms 1, >50 ms 0, Long Tasks 0.

## Where the gain came from

Pausing CSS animations directly removed all running animation clocks from the 21 far-offscreen child documents while keeping the visible card's 20 animations running. That was sufficient to eliminate almost all long frame delays and Long Tasks.

The summed Style category did **not** fall: 1683.0→1761.2 ms (+4.6%), and PrePaint+Paint was nearly flat (-0.7%). This means CSS animation playback was the main cause of missed frame deadlines in this path, but not the only source of aggregate iframe style/paint work. CDP duration variance and work in the visible/near card remain. The result does not justify claiming that all browsing-context cost is gone.

Despite missing the provisional “Style -50%” diagnostic target, Stage A met the decisive jank targets with wide margins. Stage B is gated on Stage A remaining visibly janky; the measured p95 16.7 ms and 2 intervals over 33 ms do not support unloading arbitrary iframe state. Therefore the safer pause-only lifecycle is the final production scope.

## Correctness and restore evidence

During the final fixed scroll:

- 22/22 iframe nodes retained the same `contentWindow` and the same child `document`.
- Removed iframe count: 0; maximum iframe height change: 0 px.
- Returned scrollTop delta: 0 px; scrollHeight delta: 0 px.
- Visible card transitioned `ACTIVE → NEAR → ACTIVE`; it was resumed throughout NEAR, before viewport entry.
- Final visible runtime: 1 iframe, 20 running / 0 paused animations.
- Final offscreen runtime: 21 iframes, 0 running / 340 paused animations.
- Child documents remained readable; no flash, iframe replacement, message rerender or DOM mutation was observed by the automated path.
- Scroll renderer calls remained zero for `processRegex`, `marked.parse`, `DOMPurify.sanitize`, `renderMarkdown`, `parseCot`, `messageUsesWideLayout` and `getTimelineSteps`.
- Network resource delta remained 0.

The implementation never destroys/recreates a child browsing context, so basic controls, inputs, accordions, tooltips, progress UI, jQuery/Tailwind runtime, dynamic height and arbitrary local JS heap remain in the same document. The test verifies identity/state continuity rather than attempting unsafe serialization.

Subjective rating is kept separate: the prior baseline was reported as noticeable jank. No independent human rating was fabricated for this run; automated Stage A frame-delay data corresponds to a smooth 60 Hz path.

## Production overhead

With no executable message iframe, the lifecycle has no observed targets and performs no per-frame work. It adds one chat-subtree MutationObserver shared by this lifecycle and reacts only when nodes are added/removed, the viewport is resized, or the page returns to foreground. Diagnostics counters exist only under `?rph_perf=1`.

## Streaming and regression

- Real-device streaming sanity: Plain 8K, Mixed 64K, Regex-heavy 64K and RP paragraph 64K all produced byte-identical output. Mixed/Regex retained the Commit 9 paragraph-aware scheduler behavior; no production streaming code changed.
- `npm run test:performance`: PASS (24/24 fixtures, offscreen lifecycle contract, paragraph/final/abort/error/timer golden tests).
- `npm run test:platform`: PASS.
- `npm run build:web`: PASS.
- `npm run verify:dist`: PASS (40/40 source matches, runtime CDN dependencies 0).
- `npm audit --omit=dev`: production vulnerabilities 0.
- `npm run android:debug`: `BUILD SUCCESSFUL`; final APK hash recorded above.
- Final APK normal-mode smoke: perf markers disabled/frozen, Main mounted, Character and Novel loaded, runtime remote scripts 0, safe-area top/bottom 40/18 px.
- Home→App resume: document returned visible and all 12 mounted executable frames remained registered; lifecycle observation did not become stale.
- Input/Back: the Main message textarea was found and accepted focus; this automated ADB run did not make the system IME report itself visible, so no stronger keyboard-display claim is made. Android Back left the app process healthy.
- File export is outside the changed source path; platform contract tests cover browser fallback, native chunk writing, cancellation and errors. This run did not create another DocumentsUI file. No user content or persistent app data was changed by the optimization benchmark.

## Commit decision

**PASS. Commit Stage A only.** Do not add iframe unload, message virtualization, reveal-observer cleanup, prefix caching, Vue derived view models or Novel streaming to this commit.
