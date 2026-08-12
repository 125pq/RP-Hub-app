# RP-Hub Android 流式渲染性能基线

## 结论

受控真机数据确认：RP-Hub 会在 assistant response 增长期间反复处理完整文本前缀，内容越长、Markdown/正则越复杂，单次 UI flush 和累计 renderer 工作越高。旧审计 Finding 1 为 **CONFIRMED**。

前缀缓存条目随流式 flush 增长也已确认，但本轮端点 heap 采样粒度不足以把 retained heap 可靠归因到具体 `Map`，因此旧审计 Finding 4 为 **PARTIALLY CONFIRMED**：cache growth confirmed，memory impact not quantified。

本 commit 只增加测量工具和基线，未改变 60 ms flush、Markdown 行为、缓存策略、Vue 架构、iframe 生命周期、动画、IndexedDB schema 或 Novel streaming。

## Environment

| 项目 | 值 |
| --- | --- |
| 稳定源基线 | `50e2d54` (`android: add native file export and backup bridge`) |
| 性能分支 | `perf/streaming` |
| 设备 | vivo V2505A |
| Android | 16 / API 36 |
| Android System WebView | 150.0.7871.183 |
| APK | 0.1.0，versionCode 1，targetSdk 35 |
| 测量 APK SHA-256 | `3e9903081d739e939211c3b2ba7581aa43e7b0f87370b1a769d5ca1839c9fd0f` |
| 最终交付 APK SHA-256 | `387a26f23929d46d9665e11d0ba7a7d46419194d8a17d9cae7653640f059e22e` |
| 日期 | 2026-08-13 |
| 状态 | warm app；Vue、IndexedDB、聊天页已初始化 |
| 温度 | 开始 40.6°C / Thermal 2；结束 38.9°C / Thermal 2 |
| 样本 | 每个 scenario 1 次 warm-up + 5 次 recorded |

测量开始时设备仍是 Android `Thermal Status 2 (Moderate)`，不是完全冷态，因此本基线适合优化前后在相近条件下对比，不应当解释为设备理论峰值。此前约 478 ms 的 cold launch 观察不混入 streaming 数据。

vivo 在正式矩阵开始时拒绝了一次覆盖安装，因此统计数据来自上一版测量 APK；该 APK 与最终 APK 的受控 synthetic streaming 路径相同。03:56:03 安装的预交付 APK 已移除未再使用的真实卡压力入口并通过普通模式启动检查；此后最终源码又补全了 benchmark-active persistence guard 和关联设置快照。最终交付 APK 已在本地重新构建通过，但按用户要求未再安装或操作设备。

测量 APK 的 persistence guard 当时只覆盖聊天写入，测试结束后重启 App 发现 synthetic model/API 占位配置曾落入 `settings`。用户自行重新填写 API 配置；按用户要求未继续操作设备数据。最终源码把 `saveData()`、memory settings 写入也纳入 active guard，并显式快照/恢复关联的 `qualityModel` 与 `apiProviderKeys`。这是基准工具自身发现并修正的数据隔离缺陷，不影响上述计时样本，但测量 APK 不应再用于用户数据环境。

## Benchmark architecture

- 仅当 URL 显式包含 `?rph_perf=1` 时加载完整 instrumentation；普通模式下 `window.__RPH_PERF__` 仅为冻结的 disabled 标记。
- fixture 固定为 2/8/32/64 KiB（精确 2048/8192/32768/65536 UTF-8 bytes），每次内容、Unicode 字符、分片顺序和节奏相同。
- 每个响应固定 144 个 network-like delta，每 10 ms 到达；仍由真实 `readStreamingResponse()` 以现有 60 ms interval 聚合 UI flush。网络到达与 UI flush 分开记录。
- 合成响应在 `requestChatCompletion()` 的 perf-only seam 注入，不发出模型 API 请求。
- UI 路径保持为 `sendMessage → requestChatCompletion → readStreamingResponse → appendAssistantText → Vue reactive update → nextTick/rAF → v-html`。
- 计时覆盖 `parseCot`、`processRegex`、`marked.parse`、`DOMPurify.sanitize`、`renderMarkdown`、`messageUsesWideLayout`、`getTimelineSteps`、`appendAssistantText` 和每次 flush 到 DOM stable 的延迟。
- 使用 `PerformanceObserver(longtask)` 和 rAF interval。rAF 数据是 **frame-delay estimate**，不是 SurfaceFlinger 精确 FPS。
- benchmark active 时阻止聊天、设置和 memory settings 写入；运行结束恢复内存中的原状态。fixture 不含真实角色卡、聊天、API key、Memory、图片或世界书。
- 原始设备 JSON 和 trace 位于 gitignored 的 `benchmark-results/raw/`、`benchmark-results/traces/`；仓库只保留小型 summary。

## Scenario matrix

| 维度 | 矩阵 |
| --- | --- |
| Final size | 2、8、32、64 KiB，均按 UTF-8 精确生成 |
| Plain | 连续中英文纯文本 |
| Markdown | headings、bold、italic、lists、blockquote、inline code、code fence、table、details |
| CoT | RP-Hub 真实 `<think>...</think>` 格式 |
| Regex-heavy | 三条合成 display regex，触发标签、scene 与编号替换 |
| Mixed realistic | 普通 RP 文本 + Markdown + `<cot>` + 少量格式化 |
| History | 全类型 20-message window；另测 mixed + 100-message history，仍只挂载 20 条 |
| 执行顺序 | 固定交错：32→2→64→8、8→64→2→32、64→32→8→2、2→8→32→64、32→64→2→8 |

HTML executable card 没有混入普通 Markdown 基线。用户随后明确授权用“黎明之契”检查真实卡 UI；该一次性压力观察见下文，未变成可重复 harness，也未提交任何卡内容。

## Main baseline

以下均为 20-message 可见窗口、n=5 的 recorded median。由于只有 5 个样本，表中的 “P95” 实际接近该组最大端，不能视为高精度分位数。

| Scenario | Size | Flushes | Total ms | Flush median ms | Flush P95 ms | Long tasks | rAF >33 ms | Renderer total ms | Final byte→stable DOM ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain | 2 KiB | 28 | 1701.7 | 12.0 | 15.4 | 0 | 0 | 55.8 | 30.1 |
| Plain | 8 KiB | 29 | 1791.3 | 13.7 | 16.8 | 0 | 0 | 83.6 | 30.8 |
| Plain | 32 KiB | 31 | 1901.9 | 11.0 | 19.9 | 0 | 0 | 120.4 | 36.0 |
| Plain | 64 KiB | 38 | 2337.1 | 15.6 | 25.6 | 0 | 3 | 213.7 | 44.2 |
| Markdown | 2 KiB | 29 | 1788.0 | 14.3 | 18.5 | 0 | 0 | 96.7 | 37.1 |
| Markdown | 8 KiB | 32 | 1979.1 | 15.4 | 21.5 | 0 | 0 | 142.1 | 40.7 |
| Markdown | 32 KiB | 40 | 2495.7 | 19.0 | 28.3 | 0 | 7 | 244.9 | 57.2 |
| Markdown | 64 KiB | 46 | 2805.9 | 18.7 | 34.2 | 0 | 14 | 321.4 | 46.2 |
| CoT | 2 KiB | 28 | 1725.8 | 13.8 | 16.6 | 0 | 0 | 82.0 | 32.5 |
| CoT | 8 KiB | 30 | 1836.5 | 16.3 | 21.0 | 0 | 0 | 160.1 | 36.6 |
| CoT | 32 KiB | 34 | 2098.3 | 21.6 | 32.1 | 0 | 0 | 332.9 | 50.2 |
| CoT | 64 KiB | 40 | 2416.8 | 24.0 | 39.5 | 0 | 3 | 549.3 | 51.9 |
| Regex-heavy | 2 KiB | 28 | 1715.6 | 13.8 | 19.0 | 0 | 0 | 76.7 | 37.3 |
| Regex-heavy | 8 KiB | 35 | 2153.2 | 16.3 | 24.7 | 0 | 0 | 214.3 | 44.1 |
| Regex-heavy | 32 KiB | 49 | 3024.2 | 18.1 | 37.1 | 0 | 14 | 528.9 | 75.4 |
| Regex-heavy | 64 KiB | 89 | 8065.2 | 30.2 | 45.1 | 46 | 73 | 1781.6 | 128.2 |
| Mixed | 2 KiB | 29 | 1772.1 | 14.2 | 18.7 | 0 | 0 | 102.0 | 35.6 |
| Mixed | 8 KiB | 34 | 2102.3 | 18.3 | 25.4 | 0 | 0 | 229.1 | 45.4 |
| Mixed | 32 KiB | 42 | 2572.1 | 19.8 | 34.6 | 0 | 7 | 403.8 | 50.4 |
| Mixed | 64 KiB | 55 | 3504.8 | 21.6 | 31.2 | 3 | 25 | 627.0 | 66.9 |

“Renderer total” 是 `renderMarkdown` wrapper 的累计耗时，包含 cache hits；不能与 `marked + DOMPurify` 简单相加后再次解释为总主线程时间。

## 100-message history

历史数组为 100 条但只挂载当前 20 条时，mixed baseline 相对 20-message 环境只出现小幅上升；这支持当前 render window 确实隔离了大部分历史 DOM 成本。

| Size | Total ms | Flush median ms | Flush P95 ms | Long tasks | rAF >33 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2 KiB | 1895.9 | 14.9 | 21.0 | 0 | 0 |
| 8 KiB | 2151.1 | 17.8 | 26.7 | 0 | 1 |
| 32 KiB | 2839.3 | 19.8 | 33.7 | 0 | 6 |
| 64 KiB | 3710.7 | 22.5 | 32.3 | 4 | 30 |

“100-message history 并向上加载更多”没有作为正式可重复数据提交。真实复杂卡尝试展开 UI 时触发 renderer crash，因此没有继续重复破坏性测试。

## Scaling

以 mixed 的累计 `renderMarkdown` 为主观察量：

- 2→8 KiB：文本 4×，renderer 102.0→229.1 ms，约 2.25×。
- 8→32 KiB：文本 4×，renderer 229.1→403.8 ms，约 1.76×。
- 32→64 KiB：文本 2×，renderer 403.8→627.0 ms，约 1.55×。

这不是严格的复杂度证明。固定 144 个网络分片并不产生固定 flush 数：当主线程变慢时，timer/delta 会进一步合并，64 KiB mixed 实际为 55 flush。这种反馈使简单 O(n²) 拟合不可靠。

内容复杂度影响显著。Regex-heavy 32→64 KiB 时总时长从 3024.2 增至 8065.2 ms（2.67×），renderer 从 528.9 增至 1781.6 ms（3.37×），并出现中位 46 个 long task。当前最差的可重复 scenario 是 **64 KiB Regex-heavy**。

## Function profile

以下为 mixed / 20-message 的 recorded median，格式为 `calls / total ms`。

| Function | 2 KiB | 8 KiB | 32 KiB | 64 KiB |
| --- | ---: | ---: | ---: | ---: |
| `parseCot` | 10288 / 12.7 | 11908 / 16.1 | 14500 / 15.0 | 18712 / 13.7 |
| `processRegex` | 28 / 0.7 | 34 / 0.8 | 42 / 0.8 | 55 / 0.8 |
| `marked.parse` | 41 / 17.6 | 67 / 54.4 | 84 / 125.0 | 110 / 191.1 |
| `DOMPurify.sanitize` | 41 / 71.7 | 67 / 150.8 | 84 / 234.7 | 110 / 358.5 |
| `renderMarkdown` | 670 / 102.0 | 775 / 229.1 | 943 / 403.8 | 1216 / 627.0 |
| `messageUsesWideLayout` | 3195 / 40.4 | 3695 / 45.9 | 4495 / 34.0 | 5795 / 21.5 |
| `getTimelineSteps` | 31 / 0.7 | 36 / 1.4 | 44 / 2.3 | 57 / 2.7 |
| `appendAssistantText` | 28 / 18.1 | 33 / 20.7 | 41 / 23.0 | 54 / 18.0 |

大量 `parseCot`、`renderMarkdown` 和 layout helper 调用是 Vue 模板重新求值的广度；多数为 cache hits，因此“调用次数”与“真正 parse/sanitize 次数”必须分开看。Mixed 64 KiB 中 `renderMarkdown` 调用中位数为 1216，但 `marked.parse`/`DOMPurify.sanitize` 各为 110。

## Cache growth

Mixed scenario 在测量开始前清空 renderer 与 CoT cache；20 条固定历史在正式首 delta 前会产生 19 个基础条目。下表同时给出 stream 自身新增条目和完成后的近似字符保有量：

| Size | `parseCotCache` prefix delta | `renderedCache` prefix delta | Final parse entries | Final render entries | Approx parse key/value chars | Approx render key/value chars |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 KiB | 42 | 84 | 61 | 103 | 313,930 / 286,142 | 287,698 / 527,187 |
| 64 KiB | 55 | 110 | 74 | 129 | 1,015,380 / 925,802 | 927,730 / 1,705,449 |

Mixed 的 `<cot>` 使 `messageUsesWideLayout` 在 frame detection 前短路，所以该场景 `frameDetectionCache` 没有 stream delta；Plain/Markdown/Regex 场景的 frame cache 则随前缀增长（例如 64 KiB Regex-heavy 最终 108 条）。

`performance.memory` 在 WebView 150 可读取，但其数值以粗粒度阶梯更新；本轮 mixed 多次端点值均约 139 MB，无法据此可靠区分 GC 或把 retained bytes 归因到各缓存。结论仅为：**cache growth confirmed; retained memory impact not quantified**。后续需要 DevTools heap snapshot / retaining path。

## Frame responsiveness

- `PerformanceObserver.supportedEntryTypes` 包含 `longtask`，120 个 recorded run 均成功采集。
- 64 KiB Regex-heavy：long task count 中位 46，rAF interval >33.3 ms 中位 73，final-byte-to-stable-DOM 中位 128.2 ms。
- 64 KiB Mixed：long task count 中位 3，rAF >33.3 ms 中位 25。
- 64 KiB Plain：没有 long task，但仍有中位 3 个 rAF >33.3 ms interval。

## Real-card UI incident（非统计样本）

用户明确授权对“黎明之契”现有角色卡 UI/正则进行真机检查。第一次实现误用了新对话式压力路径，用户指出后立即停止且不采信。修正为打开现有会话并尝试 20→100 条挂载后，设备出现严重卡死，120 秒宿主采集超时。

随后立即强停 App。logcat 硬证据：

- Chromium WebView renderer process crash：`aw_browser_terminator ... Renderer process ... crash detected (code -1)`。
- `Choreographer: Skipped 60939 frames`。
- 同期反复出现该 App 的 `AudioTrack start/stop` 与 Chromium network stream 警告，说明卡内 UI/iframe 启动了媒体/网络活动，而不只是静态 Markdown。
- 没有观察到 Java `FATAL EXCEPTION`；故障边界是 WebView renderer，而非 MainActivity Java crash。
- 测试使电池温度升至 43.3–43.7°C、Thermal 4，故未重跑，不提供伪精确 median/p95。

该结果确认“复杂角色卡自带 UI/iframe 是独立的高影响真实瓶颈”，但因单次运行、热状态、外部媒体/网络行为和 renderer crash，它不能与受控 synthetic streaming 数字直接比较。仓库不包含卡正文、聊天、图片、API key，也不保留自动重现该破坏性场景的入口。

## Finding 1 verdict

**CONFIRMED — Growing streamed response reparses and replaces full rendered content.**

证据：

- 真实链路中每次 flush 都修改完整 `message.content`；`v-html` 对完整派生 HTML 更新。
- Mixed 2→64 KiB 的 `marked.parse`/`DOMPurify.sanitize` 次数从 41 增至 110，累计 renderer 从 102.0 增至 627.0 ms。
- Regex-heavy 64 KiB 达到 1781.6 ms renderer、46 个 long task、73 个 >33.3 ms rAF delay。
- 最终内容在全部 120 个 recorded run 中逐字节一致，说明数据来自相同行为路径而非降级输出。

## Finding 4 verdict

**PARTIALLY CONFIRMED — Stream-prefix render caches retain large duplicate strings and HTML.**

- 32 KiB Mixed 新增 42 个 `parseCotCache` prefix 和 84 个 `renderedCache` prefix。
- 64 KiB Mixed 新增 55 个 `parseCotCache` prefix 和 110 个 `renderedCache` prefix。
- 近似 key/value 字符数明确增长；但粗粒度 `performance.memory` 不能可靠量化 retained heap，因此 memory severity 尚未完成实测定级。

## Instrumentation overhead

OFF 与 ON-but-idle 各 2 秒、交替 5 组。前三组 rAF median 都是 11.1 ms；平均 interval 差分别约 +0.8%、-1.0%、+7.7%。后两组同时发生明显设备/页面热漂移（OFF 与 ON 都恶化），不能归因于 instrumentation。

结论：未观察到稳定、可重复的 >2–3% idle overhead，但当前 5 组短样本不足以宣称 0% 开销。普通模式不会安装计时 wrapper 的执行分支，也不会逐 chunk `console.log`。

## Next optimization recommendation（未实施）

1. **先隔离 executable card iframe 生命周期和媒体/网络自动启动。** 真实“黎明之契”事故的用户影响与风险最高，应先建立单 iframe、可见性和资源上限的安全 fixture，再设计修复。
2. **降低流式期间完整 Markdown/DOMPurify/full-HTML 更新频率或范围。** 64 KiB Regex-heavy 已出现大量 long task；必须用 golden streamed transcript 验证最终 HTML、CoT 和取消行为。
3. **停止缓存 in-progress prefixes，改为 final/stable render cache 或按字节预算的 LRU。** 先用 heap retaining path 量化收益。
4. **减少 Vue 模板 helper 的重复求值。** per-message derived view model 可针对上万次 cache-hit 调用，但属于高回归风险架构变更，应在后续独立 commit 实施。

以上均只是基于本次数据排序的后续建议，本 commit 未实施任何优化。
