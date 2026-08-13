# Scroll Performance Diagnosis

## RESULT

**PASS**

真实“黎明之契”聊天在不生成、不发送、不修改正文的状态下复现了滚动掉帧，并完成 initial、两档正常历史扩展、returned-bottom、同高 iframe placeholder A/B 和 CDP trace。主因是已挂载 executable iframe 的 browsing context 与卡片渲染运行时；更早历史只增不减，使该成本继续放大。Regex/Markdown 重新解析、Vue/DOM 重绘、媒体和网络均不是这次普通滚动的直接原因。

本提交只增加默认关闭的 measurement/instrumentation/report，不包含 production optimization。

## Real-world environment

- 设备：vivo V2505A，Android 16 / API 36。
- Android System WebView：150.0.7871.183。
- 基线提交：`4c7a4daf10b95233958e6e4244bf85af1db1c098`（Commit 9）。
- 测量 APK：Commit 9 + Commit 10 working tree；SHA-256 `E0AD2999227684BE0023C248044B6102071CCB2AE6072506E878D20B3CE620DE`。
- 最终回归 APK：`debug_apk/RP-Hub-0.1.0-debug.apk`；SHA-256 `8314AD5CB588E8842AF3B9D90808CE97587BD6E7CAB7658F5DA8307B9810732B`。测量 APK 与最终回归 APK 分开记录。
- 电池温度：正式 trace 约 39.5–41.7°C；thermal status 1–3，从未达到停止线 4。
- Stage 1 后 thermal 到 3；曾熄屏等待，但未回到 0–2。Stage 1/2/returned-bottom/placeholder 因而在 thermal 3 下完成，并在比较中明确保留该限制。
- 所有 trace 的 `streamingActive=false`；未调用模型 API，未读取或保存 API key/model。
- 固定动作：当前位置向上 3 个 viewport，1800 ms；停留 400 ms；再以 1800 ms 返回。每个状态最多一次，可中止；未瞬跳到顶部、未无限加载。
- `rAF` 是 **rAF frame-delay estimate**，不是 SurfaceFlinger 精确 FPS。

## Baseline state

目标角色匹配成功，只记录元数据，不记录聊天正文、角色 prompt、世界书或图片内容。

| State | History | Mounted/displayed | DOM rows | iframe | Visible | Offscreen | Parent DOM | Chat DOM | Child iframe DOM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Initial | 354 | 20 | 20 | 12 | 1 | 11 | 1661 | 1427 | 10804 |
| History stage 1 | 354 | 30 | 30 | 17 | 1 | 16 | 2379 | 2135 | 10854 |
| History stage 2 | 354 | 40 | 40 | 22 | 0 | 22 | 3107 | 2858 | 16176 |
| Back at bottom | 354 | 40 | 40 | 22 | 1 | 21 | 3107 | 2858 | 21261 |

Stage 2 的 snapshot 位于加载后保留的 anchor，采样瞬间没有 iframe 与 viewport 相交；回到底部后为 1 visible / 21 offscreen。child DOM 会随着 iframe 内部应用延迟初始化继续增长，因此 Stage 2→bottom 的增长不是新增 mounted message。

元素数量：`img` 为 27→42→56→56；`audio=0`、`video=0`、`canvas=0`，active media 始终为 0。`performance.memory.usedJSHeapSize` 在正式阶段粗粒度地报告约 386 MB，没有足够分辨率支持 retained-heap 结论。

## Mounted-history scaling

`chatHistory.length` 始终为 354；`displayedChatMessages.length`、实际 `[data-chat-index]` row 和 render limit 同步从 20→30→40。滚回底部后仍为 40，旧 message/iframe 没有回收。

| State | History | Mounted | iframe | Visible iframe | Offscreen iframe | rAF >33 ms | >50 ms | Long tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Initial | 354 | 20 | 12 | 1 | 11 | 16 | 5 | 8 |
| History stage 1 | 354 | 30 | 17 | 1 | 16 | 19 | 6 | 17 |
| History stage 2 | 354 | 40 | 22 | 0 | 22 | 32 | 17 | 16 |
| Back at bottom | 354 | 40 | 22 | 1 | 21 | 21 | 15 | 17 |

Stage 2 的 rAF median/p95/max 为 33.2/99.7/133.0 ms；returned-bottom 仍为 16.6/66.6/116.4 ms。已经扩展的 history 即使回到最新位置也继续付出成本。

当前没有 `content-visibility`：20/30/40 个 message outer row 的 computed value 全为 `visible`。现有 scroll reveal observer 在 initial 观察 20 个 target；加载的旧消息因 `skipReveal` 不新增 observer target，但 initial 已 reveal 的 20 个元素仍长期被 observe，代码没有 `unobserve()`。这不是主要瓶颈，但属于可见的长期观察成本。

## Regex/Markdown activity during scroll

纯滚动期间 existing perf seams 没有记录到任何 renderer call；DOM MutationObserver 也只有 0/4/2/0 条记录，且没有 child-list 重建证据。4 条/2 条是属性级背景变化代理，不是精确 Vue component patch count。

| State | processRegex | marked.parse | DOMPurify.sanitize | renderMarkdown | parseCot | messageUsesWideLayout | getTimelineSteps |
|---|---:|---:|---:|---:|---:|---:|---:|
| Initial | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| History stage 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| History stage 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Back at bottom | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

结论：**Regex CPU itself is NOT the direct scroll bottleneck. Markdown reparsing is not the main scroll bottleneck.** 这里的成本是 regex-generated executable UI 已经渲染后的 runtime/rendering complexity。

## iframe activity

对我们自己的 executable iframe height helper 做了 perf-only 定点 instrumentation；没有全局重写 `requestAnimationFrame`、timer 或 observer。纯滚动期间 visible/offscreen 两组的 ResizeObserver callback、helper rAF、height measurement request、height update、timer callback 全为 0。普通滚动没有触发 iframe 高度重算。

另一方面，Web Animations API 直接读取显示：expanded/returned-bottom 状态的 1 个 visible iframe 中有 20 个 running animations，而 21 个 offscreen iframe 中有 **324 个 running animations**。这些离屏卡片并未因离开 viewport 停止 CSS animation/rendering work。

| Visibility | iframe count | ResizeObserver/s | helper rAF/s | height updates/s | running CSS animations | active media |
|---|---:|---:|---:|---:|---:|---:|
| Visible | 1 | 0 | 0 | 0 | 20 | 0 |
| Offscreen | 21 | 0 | 0 | 0 | 324 | 0 |

初始 1 visible / 11 offscreen 时分别已有 20 / 174 个 running animations。通用 card 自己的 JS rAF/timer callback 数未做全局 monkey-patch，记为 **NOT AVAILABLE**；但 active CSS animations、trace scaling 和 placeholder A/B 已证明离屏 browsing contexts 仍产生实际渲染成本。

## Rendering trace

下表是 CDP trace event duration 的跨线程求和；类别可能重叠，适合 A/B 比较，不等同 wall time。

| State | Scripting ms | Recalculate Style ms | Layout ms | Pre-Paint ms | Paint ms | Long tasks total/max ms |
|---|---:|---:|---:|---:|---:|---:|
| Initial | 92.1 | 2229.8 | 137.2 | 245.2 | 295.0 | 429 / 58 |
| History stage 1 | 72.1 | 1111.6 | 155.5 | 304.1 | 351.5 | 1142 / 80 |
| History stage 2 | 99.7 | 2163.1 | 153.8 | 291.5 | 321.6 | 1471 / 134 |
| Back at bottom | 95.9 | 1683.0 | 178.5 | 367.5 | 266.6 | 1406 / 99 |

主线程 renderer function 为 0，而 trace 中 Style/Layout/PrePaint/Paint 持续出现；Style 是已采集类别中最大的累计项。WebView 的本次 CDP trace 没有提供可靠 RasterTask、CompositeLayers、GPU 或 layer count，统一记为 **NOT AVAILABLE**，不能把 0 个 trace event 解释成 GPU 没有工作。

滚动期间 resource timing 增量为 0 request；没有 App API、iframe remote asset、media 或 fetch 活动。网络不是本次掉帧来源。

## Real iframe vs placeholder

同一 354 history / 40 mounted / returned-bottom 状态，把 22 个 executable iframe 仅在内存中替换为同高 `div`。outer chat DOM 保持 2858 nodes；scrollHeight 为 80764→80638 px，仅差 126 px（约 0.16%）。没有写 IndexedDB，reload 后真实 iframe 自然恢复。

| Mode | rAF median/p95/max ms | rAF >33 | >50 | Long tasks | Style ms | Layout ms | PrePaint + Paint ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Real iframe | 16.6 / 66.6 / 116.4 | 21 | 15 | 17 | 1683.0 | 178.5 | 634.2 |
| Same-height placeholder | 16.6 / 16.7 / 16.8 | 0 | 0 | 0 | 200.8 | 0 | 155.8 |

placeholder 使 rAF >33/>50 和 Long Task 全部归零，Style -88.1%，PrePaint+Paint -75.4%。图片 row、message count、outer layout height 和滚动动作保持不变，因此这是 executable iframe/browsing-context/card runtime 为主瓶颈的强因果证据。

主观体验与自动指标分开记录：用户对真实聊天报告为 `noticeable jank`；Stage 2 指标对应 `severe jank`；placeholder 自动指标对应 `smooth`。没有代替用户执行疯狂 scroll 或 stress-to-failure。

## Memory / DOM scaling

- Parent DOM：1661→2379→3107；chat DOM：1427→2135→2858。
- iframe：12→17→22；回到底部仍 22。
- 可读 child DOM：10804→10854→16176；随后 iframe 延迟初始化达到 21261。
- heavy CSS（returned-bottom）：345 个 animation-bearing elements、4767 transition-bearing elements、231 transform、80 fixed、340 shadow、100 filter、218 backdrop-filter；`will-change=0`、sticky=0。
- 22 个 iframe 全部 same-origin/readable，没有 detached iframe 的直接证据。heap snapshot 因设备 thermal 3 未继续采集；`performance.memory` 只作辅助，不能判断 GC/retained objects。

## Root cause ranking

1. **CONFIRMED — executable iframe browsing-context/card runtime**：同高 placeholder 消除全部 >33/>50 ms delay 和 Long Task，外层高度与 DOM 基本不变。
2. **CONFIRMED — offscreen iframe CSS animation/rendering work**：21 个离屏 iframe仍有 324 个 running animations；placeholder 后 Style/PrePaint/Paint 大幅下降。
3. **CONFIRMED — render window only grows**：mounted 20→30→40，返回底部不缩减；iframe 12→17→22 并保留。
4. **LIKELY — iframe 内 heavy CSS 扩大 style/paint pipeline**：大量 animation/transition/fixed/shadow/filter/backdrop-filter，Style 为已采集最大项；具体 GPU/layer/raster 数据不可用。
5. **POSSIBLE — long-lived reveal observer targets**：20 个 initial target reveal 后仍被 observe，但 placeholder A/B 表明它不是主要成本。
6. **RULED OUT — Regex/Markdown/Vue content rerender**：相关函数调用全 0，DOM mutation 接近 0。
7. **RULED OUT — media/network**：audio/video active=0，scroll resource requests=0。

## Answer to six key questions

### Q1 — processRegex 是否重新执行？

**NO**。所有真实 scroll trace 均为 0。

### Q2 — marked.parse / DOMPurify.sanitize 是否重新执行？

**NO**。所有真实 scroll trace 均为 0；`renderMarkdown`/`parseCot` 同样为 0。

### Q3 — 加载更早消息后 mounted messages 是否只增不减？

**YES**。20→30→40，滚回底部仍为 40；DOM row 与 displayed 数一致。

### Q4 — Executable iframe 是否是主要滚动成本？

**YES**。同高 placeholder A/B 使 p95 66.6→16.7 ms，>33 ms 21→0，Long Task 17→0。

### Q5 — Offscreen iframe 是否仍持续工作？

**YES（明确限于渲染活动）**。21 个 offscreen iframe 中 324 个 CSS animations 处于 running；自己的 ResizeObserver/height helper 在纯滚动时为 0。通用 card JS timer/rAF 精确回调数 NOT AVAILABLE。

### Q6 — 最终瓶颈类型？

**Mixed，以 Style recalculation 为主，伴随 PrePaint/Paint/Layout；来源是 iframe/card runtime。** Scripting 不是主线程 renderer 重算，GPU/Composite/Raster 数字 NOT AVAILABLE，Memory/GC 也没有足够证据作为主因。

## Recommended next optimization

下一独立 production commit 最值得先做：**offscreen executable iframe lifecycle**。

建议保持 message outer height/scroll anchor，在足够远离 viewport 时暂停或卸载 iframe browsing context，并在接近 viewport 时按需恢复；同时暂停离屏 CSS animation/media/timer。先以 20/40 mounted 的真实卡回归 placeholder 等价性、恢复正确性和滚动 anchor，再考虑更大范围的 bidirectional message virtualization。

本提交不实施 destroy/suspend/lazy-create/pause，也不加入 virtual list。

## Regression

- `npm ci`：PASS，按 lockfile 安装 204 packages，install-time audit 为 0 vulnerabilities。
- `npm run test:performance`：PASS，24/24 fixtures；paragraph boundary/final/abort/error/timer golden PASS；perf-off scroll marker 为 frozen/disabled。
- `npm run test:platform`：PASS。
- `npm run build:web`：PASS。
- `npm run verify:dist`：PASS，39/39 source matches，remote application runtime dependencies = 0。
- `npm audit --omit=dev`：PASS，production vulnerabilities = 0。
- `npm run android:debug`：PASS，`BUILD SUCCESSFUL`；最终 APK SHA 见 Real-world environment。
- 最终 APK 真机覆盖安装：PASS。普通 URL 下 perf/scroll markers 均 disabled/frozen；Main mounted，Character/Novel 页面加载，remote runtime scripts=0，safe-area top/bottom=40/18 px。

## Safety / test limitations

- 没有删除或编辑消息、正则、角色卡、世界书、memory、API 或 model；没有打印正文。
- placeholder 仅当前内存，reload 后恢复；未保存 placeholder 或修改 `message.content`。
- 最多通过现有机制加载两批历史；Stage 2 明显恶化后停止继续增加。
- 未出现 renderer crash、无响应、重复 >1000 ms gap 或 Thermal >=4；没有触发安全停止。
- Trace 的 Raster/Composite/GPU/layer count NOT AVAILABLE；没有为了这些数字引入 DevTools Layers 或复杂 Vue devtools 依赖。
- perf OFF vs ON idle（40 mounted，thermal 3）：median/p95 都为 16.7/83.1 ms；mean 27.8→31.2 ms。顺序采样和热状态使小差值无法完全归因，但 instrumentation 没有改变 p95；正式因果结论主要来自相同 perf-on 条件下的 real/placeholder A/B。
- 普通模式真机 smoke：两个 perf marker 均 disabled/frozen；Main mounted，Character/Novel 页面均加载，remote runtime scripts=0，safe-area top/bottom=40/18 px。
- Back/native file-export path 未被本提交修改；platform contract tests 覆盖 browser fallback、native chunks、cancel/error，Commit 9 的真机 export/Back 证据继续适用。本轮未再次向 DocumentsUI 写入测试文件。
