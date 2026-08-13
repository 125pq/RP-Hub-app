# Streaming Flush Optimization（Commit 9）

## RESULT

**PASS**

段落感知发布策略在正确性、可见延迟、Regex-heavy、Mixed 64 KiB 和新增 RP 段落场景上均取得实质收益。正式矩阵中 Mixed 32 KiB 的 `renderMarkdown` 累计时间由 403.8 ms 上升到 461.5 ms，随后 5 次定向复测中位数仍为 473.3 ms；这是已记录的少见 workload 回退。用户在实际使用中确认当前流式体验满意，并明确要求不再为该 micro metric 调整 80 ms/350 ms 策略，因此它作为已接受限制保留，不阻止收口。

## Strategy

原实现由 `assets/js/runtime-services.js` 的 `readStreamingResponse()` 使用 60 ms repeating interval，把 pending content/reasoning 周期性传给 `appendAssistantText()`。每次回调仍会进入完整的 Vue template、`processRegex`、`marked.parse`、DOMPurify 和 `v-html` 路径。

新实现不降低网络读取频率，也不更改最终 renderer：

```text
network delta
  -> pending content/reasoning buffer
  -> safe paragraph boundary: 尽快 publish（相邻 publish 至少间隔 80 ms）
  -> no boundary: 350 ms max-latency publish
  -> normal end / abort / error: force flush remaining pending text
```

边界检测器只扫描新增 delta 并保留少量 carry state，复杂度为 O(delta)，不从消息开头重复扫描。它识别 LF/CRLF 空行、跨 chunk 的三反引号或三波浪线 fenced block、`<think>`/`</think>` 和 `<cot>`/`</cot>`。fence、think、cot 内部空行不作为强段落边界；关闭 think/cot 后可立即发布。它不解析任意 HTML。

调度器只有一个 one-shot timer。`flushPromise` 串行化回调，避免重叠 flush；完成、取消和错误路径都会清除旧 timer。content 和 native reasoning 分别跟踪边界，但在同一 delta 中发布。最终 `message.content` 不做换行、空格、Markdown、HTML、Unicode 或 emoji 规范化。

## Timeout selection

在 vivo V2505A / Android 16 / WebView 150 上，用 Mixed 32/64、Regex-heavy 32/64、RP paragraph-heavy 32/64 和 Plain 8 做 250/350/500 ms 筛选；每组 1 warm-up + 2 recorded。段落丰富场景主要由自然边界和 80 ms 合并窗口决定，因此三个候选的可见延迟接近。

| 候选 | Plain 8 flush | Plain 8 staleness median/p95/max | Regex 64 flush | Regex 64 staleness median/p95/max | 结论 |
|---:|---:|---:|---:|---:|---|
| 250 ms | 6 | 134.7 / 253.7 / 270.3 ms | 6 | 163.3 / 286.9 / 306.7 ms | 无段落文本刷新更多，性能收益较小 |
| **350 ms** | **5** | **183.9 / 356.3 / 371.3 ms** | **5** | **214.1 / 380.3 / 400.9 ms** | 性能与等待时间的折中，选为 production |
| 500 ms | 3 | 266.0 / 493.6 / 520.7 ms | 3 | 297.3 / 529.6 / 570.0 ms | p95/max 过高，明显更容易出现“憋字” |

RP 64 KiB 在 350 ms 候选下的 staleness 为 44.6 / 74.1 / 84.3 ms，说明自然段落仍会及时出现，而不是等待 fallback。

## Benchmark Before / After

设备：vivo V2505A，Android 16 / API 36，WebView 150.0.7871.183。正式 After 为 1 warm-up + 5 recorded，20-message history，共 6 types × 4 sizes = 120 recorded runs，120/120 最终输出逐字节一致。下表均为 5 次中位数；箭头为 Before → After。`Renderer` 是 `renderMarkdown` 累计时间，`M/P` 是 `marked.parse` / `DOMPurify.sanitize` 调用数，staleness 是 network delta 到 stable DOM 的 median/p95/max。

旧五类 fixture 使用 Commit 8 固定 baseline。RP fixture 的 Before 使用 3739587 的 60 ms runtime，仅回填相同 fixture 与不写入 API/model 的隔离修正后测得；没有替换旧 fixture。

| Scenario | Flush | Renderer ms | M/P calls | Long tasks | rAF >33 ms | After staleness ms | Final byte→stable ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plain 2K | 28→5 | 55.8→14.0 | 28/28→5/5 | 0→0 | 0→0 | 186.4/356.6/374.0 | 30.1→42.9 |
| Plain 8K | 29→5 | 83.6→14.3 | 29/29→5/5 | 0→0 | 0→0 | 184.0/353.6/372.3 | 30.8→45.0 |
| Plain 32K | 31→5 | 120.4→36.2 | 31/31→5/5 | 0→0 | 0→1 | 192.7/361.4/378.4 | 36.0→72.0 |
| Plain 64K | 38→5 | 213.7→55.9 | 38/38→5/5 | 0→0 | 3→2 | 194.4/363.9/383.5 | 44.2→84.4 |
| Markdown 2K | 29→5 | 96.7→22.7 | 29/29→5/5 | 0→0 | 0→0 | 187.7/358.9/374.2 | 37.1→52.8 |
| Markdown 8K | 32→5 | 142.1→27.2 | 32/32→5/5 | 0→0 | 0→0 | 189.8/358.5/378.7 | 40.7→57.1 |
| Markdown 32K | 40→5 | 244.9→51.4 | 40/40→5/5 | 0→1 | 7→3 | 196.2/370.1/390.7 | 57.2→87.0 |
| Markdown 64K | 46→5 | 321.4→73.7 | 46/46→5/5 | 0→2 | 14→4 | 201.9/375.0/395.2 | 46.2→97.7 |
| CoT 2K | 28→9 | 82.0→31.9 | 43/43→17/17 | 0→0 | 0→0 | 96.3/180.7/211.5 | 32.5→43.0 |
| CoT 8K | 30→23 | 160.1→137.9 | 60/60→46/46 | 0→0 | 0→0 | 48.1/79.2/93.4 | 36.6→45.9 |
| CoT 32K | 34→24 | 332.9→262.0 | 68/68→48/48 | 0→0 | 0→1 | 50.6/81.4/90.1 | 50.2→44.6 |
| CoT 64K | 40→26 | 549.3→395.8 | 80/80→52/52 | 0→0 | 3→3 | 53.6/86.2/104.0 | 51.9→58.7 |
| Regex 2K | 28→5 | 76.7→20.2 | 28/28→5/5 | 0→0 | 0→0 | 186.6/352.9/372.5 | 37.3→50.4 |
| Regex 8K | 35→5 | 214.3→50.8 | 35/35→5/5 | 0→0 | 0→2 | 195.5/363.1/384.0 | 44.1→69.7 |
| Regex 32K | 49→5 | 528.9→107.4 | 49/49→5/5 | 0→3 | 14→5 | 208.7/379.8/413.5 | 75.4→91.5 |
| **Regex 64K** | **89→5** | **1781.6→184.5** | **89/89→5/5** | **46→6** | **73→8** | **225.9/400.9/436.4** | **128.2→170.0** |
| Mixed 2K | 29→8 | 102.0→35.8 | 41/41→15/15 | 0→0 | 0→0 | 113.2/214.0/228.8 | 35.6→50.8 |
| Mixed 8K | 34→26 | 229.1→188.0 | 67/67→51/51 | 0→0 | 0→0 | 48.6/78.0/92.6 | 45.4→45.9 |
| **Mixed 32K** | **42→34** | **403.8→461.5** | **84/84→68/68** | **0→0** | **7→12** | **49.3/91.3/106.7** | **50.4→45.9** |
| **Mixed 64K** | **55→36** | **627.0→510.4** | **110/110→72/72** | **3→2** | **25→15** | **48.0/83.8/102.2** | **66.9→61.1** |
| RP paragraph 8K | 30→22 | 88.5→66.4 | 30/30→22/22 | 0→0 | 0→0 | 46.0/77.5/88.5 | 48.8→36.9 |
| RP paragraph 32K | 35→25 | 178.8→145.5 | 35/35→25/25 | 0→0 | 0→1 | 46.0/78.1/92.5 | 57.1→59.7 |
| **RP paragraph 64K** | **43→28** | **298.2→223.5** | **43/43→28/28** | **0→0** | **4→2** | **44.5/78.4/101.6** | **41.4→41.9** |

### Mixed 32 KiB confirmation

第二轮只测 Mixed 32 KiB，1 warm-up + 5 recorded，电池 39.3°C、thermal status 0：flush 42→26、总耗时 2572.1→2116.9 ms、`rAF >33 ms` 7→5、staleness 44.9/78.4/91.3 ms，但 `renderMarkdown` 仍为 473.3 ms，高于 403.8 ms baseline。因此它更像累计 renderer 成本的可复现回退，而不是单次全矩阵噪声；保留为 PARTIAL。

### Final sanity gate

收口前在同一台 vivo V2505A 上各执行 1 次小规模 sanity；WebView 150.0.7871.183，起止 thermal status 0→1，电池温度约 36.1→36.6°C。4/4 最终输出逐字节一致。

| Scenario | Flush | `renderMarkdown` ms | marked/DOMPurify calls | Long tasks | rAF >33 ms |
|---|---:|---:|---:|---:|---:|
| Plain 8K | 5 | 16.6 | 5 / 5 | 0 | 1 |
| Mixed 64K | 28 | 290.8 | 56 / 56 | 0 | 7 |
| Regex-heavy 64K | 5 | 135.6 | 5 / 5 | 6 | 6 |
| RP paragraph 64K | 27 | 214.4 | 27 / 27 | 0 | 4 |

这是一次 sanity，不替代正式 120-sample matrix，也不用于重新选择参数。

## Flush and renderer reduction

- Mixed 64K：flush -34.5%，`renderMarkdown` -18.6%，marked/DOMPurify calls -34.5%。
- Regex-heavy 64K：flush -94.4%，`renderMarkdown` -89.6%，marked/DOMPurify calls -94.4%。
- RP paragraph-heavy 64K：flush -34.9%，`renderMarkdown` -25.1%，marked/DOMPurify calls -34.9%。
- RP 段落 fixture 未达到理想的 40–50% flush reduction；没有人为改变 fixture，按实测报告。

## Responsiveness

- Mixed 64K：long tasks 3→2，`rAF >33 ms` 25→15。
- Regex-heavy 64K：long tasks 46→6，`rAF >33 ms` 73→8。
- RP paragraph-heavy 64K：long tasks 0→0，`rAF >33 ms` 4→2。
- 350 ms fallback 的无段落场景会在 renderer 工作后出现约 374–436 ms 的 max staleness；它没有达到 1–2 秒，但短回复 final-byte latency 普遍比 60 ms baseline 高。这是本策略的明确 UX 代价。

## Cache side effect

没有修改 cache policy。仅因 intermediate publish 变少：

- Mixed 64K：`parseCotCache` stream prefix delta 55→36，`renderedCache` 110→72。
- Regex-heavy 64K：89→5，89→5。
- RP paragraph-heavy 64K：43→28，43→28。

## Correctness

- `message.content`：正式 120/120 byte-identical；RP legacy Before/After 15/15 各自匹配 fixture。
- Plain / Markdown / Regex / Mixed / CoT：完整 2/8/32/64 KiB synthetic matrix 通过。
- Code fence：覆盖跨 network chunk 的 fence token、fence 内空行和结束后恢复段落边界。
- `<think>` / `<cot>`：覆盖跨 chunk tag、内部空行、关闭 tag publish；没有改变现有显示/隐藏 renderer。
- Final flush：无换行、普通段落中、单字符尾部都强制发布。
- Abort / error：golden unit tests 确认先发布已接收 pending，再保持原异常语义。
- Timer：覆盖 no duplicate/overlap、结束后无 stale timer、content/native reasoning。
- 最终 sanitized HTML 未另建跨版本 hash golden；最终 renderer 路径与 DOMPurify 配置未改，`message.content` 做了严格字节比较。这是本轮证据边界。

## Real API

**NOT EXECUTED（0 次）**。没有读取、替换或保存用户 API key/model，也没有操作“黎明之契”。真实 API 正常流和真实 UI 停止生成未自动消耗额度；停止生成的 pending 保留由 transport golden test 覆盖。

## Web regression

- `npm ci`：PASS，按 lockfile 安装 204 packages。
- `npm run test:performance`：PASS，24/24 fixtures；stream boundary/abort/error/timer tests PASS。
- `npm run build:web`：PASS。
- `npm run verify:dist`：PASS，source 38/38，remote application runtime dependencies = 0。
- `npm audit --omit=dev`：PASS，production vulnerabilities = 0。
- `npm run test:platform`：PASS。

## Android regression

- `npm run android:debug`：PASS；未修改 `android/` 业务代码或 MainActivity。
- 最终 APK：`debug_apk/RP-Hub-0.1.0-debug.apk`，SHA-256 `3ED91B281C067333E263D906AB4B17A38909A3E194B09A21AEBDDFE9698E6B59`。
- 真机安装：PASS；MainActivity resumed，普通模式 `perfEnabled=false`。
- Main chat、Character iframe、Novel iframe：加载通过。
- safe-area：当前导航模式 computed top 40 px / bottom 18 px；控件可见。
- keyboard：打开后 visual viewport 仍包含输入框，effective safe-bottom 为 0；Back 先关闭 IME，关闭后 inset 恢复，无 ghost padding。
- Back：Settings 返回 Main chat。
- native file export：通过系统 DocumentsUI 写入 29-byte sanity 文件并逐字节读回；临时文件随后已删除。
- 真实 API normal stream / UI stop generation：未执行，原因见 Real API；synthetic streaming 和 abort golden 已通过。
- 50 MB export benchmark：按要求未重跑。
- 正式 After benchmark 起止约 Thermal 2 / 37.9°C→Thermal 2 / 37.0°C；定向复测 thermal status 0，未到 Thermal 4。

## Files changed

- `assets/js/runtime-services.js`：paragraph-aware O(delta) boundary tracker、单 timer scheduler、final/abort/error flush。
- `assets/js/performance-benchmark.js`：RP fixture、flush reason、display staleness、call/cache delta、timeout override；移除 synthetic API/model 赋值。
- `scripts/test-streaming-flush.mjs`：stream scheduler golden tests。
- `scripts/test-performance-benchmark.mjs`：24-scenario fixture contract。
- `scripts/run-android-performance-benchmark.mjs`：候选、RP legacy、Mixed 32 confirmation modes。
- `package.json`：把 stream golden tests 纳入 `test:performance`。
- `docs/STREAMING_FLUSH_OPTIMIZATION.md`：本报告。

未修改 `app.js`、`index.html`、Character、Novel、IndexedDB、DOMPurify 配置、cache policy 或 Android native 业务层。

## Git

- Branch：`perf/streaming`
- 实际起始 HEAD：`af47f60`（任务文本中的 `3739587` 已不是当时仓库 HEAD；其后已有两个 Android export filename commits）
- Commit：本报告随 `perf: make streaming flush paragraph-aware` 一并提交；实际 SHA 由提交完成后记录
- Push：未执行
- Working tree：提交完成后要求 clean

## Deferred

1. executable iframe lifecycle / “黎明之契” renderer crash
2. explicit prefix-cache policy
3. Vue helper repeated reevaluation
4. Novel streaming

这些项目本轮均未实施。
