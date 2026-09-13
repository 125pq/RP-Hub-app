# Android 更新流程架构分析报告

> **历史快照，非当前架构说明。** 本报告基于 2026-08-27 的代码快照，其中引用的行号、
> 脚本路径与构建流程此后可能已变化（例如 `scripts/web/update-check.js` 的更新检查注入、
> 默认构建入口 `build:web` 已切换为组合构建）。核对当前行为时请以仓库现状与
> `docs/LONG-TERM-ANDROID-ARCHITECTURE-PLAN.md`、`docs/architecture/` 为准，不要把本文
> 当作运行时契约。

> 只读分析产物（2026-08-27）。本次分析未修改任何文件、未运行构建/安装/测试命令，
> 所有结论均有代码证据（文件 + 行号）；无法从代码确认的事项统一标记为 UNCONFIRMED。

核心发现：这其实是**两条相互独立、永不相交的更新链路**——真正的 APK 更新几乎全在
native 层完成，JS 只做触发和结果展示；另有一条 Web 内容版本检查只影响浏览器弹窗。

## A. 完整调用链

### 链路 1 —— 真正的 APK 更新（几乎全在 native）

用户触发有两处入口：

1. **冷启动自动检查**：`MainActivity.onCreate` → `AttributionDialog.showIfNeeded(..., appUpdateManager::checkOnColdStart)`（`MainActivity.java:79-82`）→ `checkOnColdStart` 延迟 1200ms 调 `checkQuietly`（`AppUpdateManager.java:143-146`，debuggable 构建跳过），结果走 native `AlertDialog`，JS 完全不参与。
2. **手动检查**：本地控制中心「检查更新」按钮（`rphub-backup.js:1018-1037`）→ `adapter.invokeNative('AppUpdate','checkNow')`（`rphub-backup.js:1027`）。

之后的链路在 native 内部完成：

```text
AppUpdatePlugin.checkNow
  → AppUpdateManager.checkNow (CheckCallback)
  → fetchLatestRelease
      · 先读 GitHub: https://api.github.com/repos/125pq/RP-Hub-app/releases/latest  (AppUpdateManager.java:45)
      · 再读 Gitee manifest: https://gitee.com/pq125pq/rp-hub-app/raw/android-latest/android-update.json (46-47)
      · 两边一致 → GitHub 元数据 + Gitee 下载回退；不一致 → 只用 GitHub
  → AppUpdateRelease.parseAndroidTag / normalizeSha256 / shaFromDigestOrNotes 解析 tag 与 SHA-256
  → runCheck: release.versionCode <= installedVersionCode() → 已最新，否则弹更新对话框
  → startDownload → downloadAndVerifyFromParts
      · HttpURLConnection（非 DownloadManager！非 OkHttp）分块下载到 getCacheDir()/updates/<apk>.part（353, 402-455）
      · 双源 + ConnectionGate 源切换；<150KB/s 触发慢源切换
      · SHA-256 校验 → verifyApkIdentity（包名 + versionCode + 签名 sameSigners 一致性）→ renameTo 正式文件
  → requestInstallPermission: canRequestPackageInstalls() 不满足 → Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES (requestCode 19082)，由 MainActivity.onActivityResult 回传
  → launchInstaller:
      Uri uri = FileProvider.getUriForFile(activity, pkg + ".fileprovider", apk)
      Intent ACTION_VIEW, type=application/vnd.android.package-archive,
      加 FLAG_GRANT_READ_URI_PERMISSION + ClipData → activity.startActivity → 系统包安装器
```

### 链路 2 —— Web 内容版本检查（不更新 APK）

`update-check.js`（上游文件）每 20s 轮询 `${rphub-update-api}/v1/version`，当前版本取自
硬编码的 `window.RPHubLatestUpdate.id`（如 `10197`，`built-in-content.js:609-622`）。
发现新版本时 dispatch `rphub:update-available` → `ui-components.js:712` 弹「刷新页面更新」
模态。**该 dispatch 在 native 下被 `patch-android-hooks.mjs:64-72` 注入的 guard 抑制**
（`update-check.js:29-34`），因为 WebView 刷新无法更新已安装的 APK。

### 供给侧（发布流程）

`.github/workflows/sync-upstream.yml`（workflow_dispatch / 每日 cron / upstream-release 触发）：
合并上游 → `prepare-android-release.mjs` 计算 versionCode/tag → 签名构建 APK →
`gh release create` → 把 APK 切成 ≤4MB 分片并生成 `android-update.json`（schemaVersion:1，
`sync-upstream.yml:311`），**force-push 到 GitHub `android-latest` 分支** → 调 Gitee
`remote_mirror/pull` 把分支镜像到 Gitee → 设备侧读到的正是这个 Gitee raw manifest。
这正是 AGENTS.md 禁止本地 `gh release create` 的原因——本地发布会跳过 Gitee 镜像，
设备永远收不到更新。

## B. 关键文件与函数

| 层 | 文件 | 关键点 |
|---|---|---|
| JS 入口 | `assets/js/rphub-backup.js:1018-1037` | 唯一 JS→native 更新桥接（本地文件） |
| JS web 检查 | `assets/js/update-check.js`（上游，本地 patch 注入 native guard） | 只影响浏览器弹窗 |
| 桥 | `android/.../AppUpdatePlugin.java`（35 行） | 仅暴露 `checkNow`，resolve `{status,message}` |
| 核心 | `android/.../AppUpdateManager.java`（735 行） | 检查/下载/校验/安装全部 |
| 模型 | `android/.../AppUpdateRelease.java`（84 行） | tag 正则、SHA-256 解析 |
| 装配 | `MainActivity.java` | registerPlugin × 4、冷启动、DownloadManager 接收器（**与 APK 无关，是 WebView 内容下载**） |
| 清单 | `AndroidManifest.xml`、`res/xml/file_paths.xml` | FileProvider、`INTERNET` + `REQUEST_INSTALL_PACKAGES` |
| 发布 | `.github/workflows/sync-upstream.yml:276-353` | Gitee 镜像与 manifest 生成 |

## C. 三层边界

- **Web ↔ Bridge**：契约极小——JS 只调 `AppUpdate.checkNow`，拿回 `{status, message}`
  （错误码 `update_unavailable` / `update_cancelled`）。**URL、版本号、文件路径一概不过桥。**
  native 侧无任何 `notifyListeners` / `triggerJSEvent`（grep 结果为 0），是纯
  request/response，没有 native→JS 事件通道。
- **Bridge ↔ Android**：`AppUpdatePlugin.checkNow` 只是薄壳，全部工作在
  `AppUpdateManager` 的单线程 Executor（`Executors.newSingleThreadExecutor()`，L57）中。
- **Android ↔ 外部**：只允许访问 `gitee.com` / `github.com` / `api.github.com` /
  `*.githubusercontent.com` 的 HTTPS（`isAllowedDownloadUrl`，648-673）。
- 易混淆点：`MainActivity` 里的 `DownloadManager` + `ACTION_DOWNLOAD_COMPLETE` 接收器
  服务于**万相广场卡片等内容下载**（经 `android/app/src/main/assets/rphub-download-bridge.js`
  注入），**不是 APK 更新通道**。二者完全独立，不要合并理解。

## D. 测试覆盖

- **覆盖良好（regex/存在性断言）**：
  - `scripts/tests/test-android-update-flow.mjs`：插件名、`checkNow`、ConnectionGate、
    JS 调用点 `invokeNative('AppUpdate','checkNow')`；
  - `scripts/upstream-sync/verify.mjs:55-58`：插件注册与 `data-action="check-update"`；
  - `scripts/upstream-sync/tests/android-release-workflow.mjs:88-97`：manifest 形状断言，
    并禁止 `ghfast.top` / `gh-proxy.com` / `ghproxy.net` 等公共代理域名；
  - `scripts/upstream-sync/tests/prepare-android-release.mjs`：构建侧 versionCode 公式；
  - EOL / patch 边界由 `eol-churn-guard`、`eol-preservation`、`reapply-idempotence` 守护。
- **native 单测**：`AppUpdateReleaseTest`（tag 解析）、`AppUpdateManagerConcurrencyTest`
  （settle-once）、`MainActivityTest`（DownloadManager 状态名映射）。
- **缺口**：脚本级断言全部只验证「字符串存在」，不执行任何 Java 逻辑（见风险排序）。

## E. 按严重程度排序的风险

1. **P0 — 版本 tag 正则与比较缺功能测试**：`AppUpdateRelease.parseAndroidTag`
   （`^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?-android$`）与 `runCheck` 里的
   `release.versionCode <= installedVersionCode()`（`AppUpdateManager.java:199`）
   若漂移可直接导致更新永远不发或误判。脚本侧 grep 这些符号无任何测试引用；
   仅 `AppUpdateReleaseTest.java` 覆盖部分解析（需设备/单元测试环境运行）。
2. **P0 — Gitee manifest 发射器与解析器无 round-trip 测试**：workflow 在
   `sync-upstream.yml:311` 拼 JSON，`parseUpdateManifest`（281-306）校验
   `schemaVersion==1`、`sources` 形状、SHA-256；双方漂移 CI 无感。
3. **P1 — FileProvider 权威/路径无断言**：`${applicationId}.fileprovider`、
   `cache-path verified_app_updates → updates/`、`getCacheDir()/updates` 三处任一改名
   即安装即崩（FileUriExposedException / 权限拒绝），无测试拦截。
4. **P1 — APK 置放应用缓存目录**：系统可清缓存，大 APK 在安装前可能被系统回收
   （非正确性 bug，但属真实回归面）。
5. **P2 — 下载 URL 允许列表只有反代理负面测试**，无正/负 URL 表的功能测试。
6. **P2 — `docs/UPSTREAM-VS-LOCAL.md` 与 `docs/IMPROVEMENT-BACKLOG.md` 在 AGENTS.md
   被引用但磁盘上不存在**（UNCONFIRMED 是有意还是缺失）。
7. **P3 — 桥契约只断言存在性**：`status` 枚举 / `message` 若变化（如 resolve→reject
   反转），现有测试全绿。
8. **P3 — 双版本语义**：Web 端 `RPHubLatestUpdate.id=10197` 与 native versionCode
   `1080801` 是两套体系；native 下 Web 提示已被 guard 抑制，属语义冗余而非 bug。

## F. 最高风险问题的最小修复建议

若要消除 **P0（manifest 发射/解析漂移）**，最小且不碰上游文件的做法是：
**只新增测试，不改产品代码**——

- 新增一个 Node 脚本测试（如 `scripts/upstream-sync/tests/android-update-manifest-roundtrip.mjs`），
  构造与 `parseUpdateManifest` 相同契约的 fixture JSON，断言 `schemaVersion==1`、
  `tag`/`versionName`/`versionCode` 一致性、`apk.sources` 形状、`sha256` 64 位 hex、
  URL 全部命中 `gitee|github|githubusercontent` 允许列表；并校验
  `sync-upstream.yml` 生成片段的形状与解析契约一致。
- 或更贴近原生的做法：扩展 `AppUpdateReleaseTest.java` / 新增
  `AppUpdateManagerManifestTest.java`，基于 `android-update.json` fixture 做 manifest
  解析用例（`cd android && ./gradlew testDebugUnitTest` 运行，不写工作区源码）。

两者任选其一即可把该 P0 降到 P2 以下，且完全符合 AGENTS.md 的上游边界约束。
改完之后按 AGENTS.md 要求跑 `npm run test:upstream-sync`。

## G. 仍无法确认的事项

- `capacitor.config.json` 无 `server` 块，WebView 实际 origin 假定为 Capacitor 8 默认
  `https://localhost`（与下载桥硬编码一致），**UNCONFIRMED 设备端真实 scheme**。
- `capacitor.build.gradle` 文件未检索到，其变体化配置（若有）未读到。
- Web 端 `presence.js` 读取的 `rphub-presence-api` meta 在当前 `index.html` 不存在；
  `presence.js` 未挂到任何入口，判定为上游死代码，但**未与上游仓库逐一核对**。
- 安装 Intent、`RECEIVER_EXPORTED`（API 33+）、慢源切换阈值、unknown-apps 授权的
  **真实设备行为**仅由代码读得，未做运行时验证。
- `docs/UPSTREAM-VS-LOCAL.md` 的缺失是有意还是遗失，需与维护者确认。

---

*分析方法：5 个并行只读探索（Web 侧 / Android 原生侧 / Capacitor 桥 / 测试侧 /
发布管线）+ 汇总。证据均附文件路径与行号，推断均已标注 UNCONFIRMED。*
