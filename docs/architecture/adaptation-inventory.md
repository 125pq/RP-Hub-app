# 阶段 0 差异台账与能力矩阵

编制日期：2026-09-10｜对应阶段：阶段 0｜状态：进行中（同 baseline.md）

本台账区分**已知事实**（直接核实，标注证据）与**待验证事项**。`app.js` 与上游 1.9.3 的 diff 达 ~413 行，是最大本地改造面；`styles.css` 7 行、`update-check.js` 12 行。证据来源优先使用本次实跑命令，其次引用方案书与代码路径。

## A. 上游共同文件差异（overlay manifest 8 项 + app.js 特例，共 9 路径）

overlay manifest 共 **8 个文件**（`scripts/upstream-sync/overlay-transformers.mjs:13-37`），`app.js` 走 auto-resolver 特例（`patch-app-conflict.mjs` 的 SHA-256 比对 + `resolveBlock` 表，`resolveAppConflictBlob:209`），合计 **9 个可自动解析路径**。`styles.css` 与 `update-check.js` 有重放钩子但**不在 manifest** → 冲突需人工。

| 文件 | 补丁钩子（所在 patches/*.mjs） | 适配族 | auto-resolver 覆盖 | 数据影响 | 已验证入口 |
| --- | --- | --- | --- | --- | --- |
| `index.html` | `patchOfflineIndex` + `patchSafeAreaIndex` + `patchSquareHostSafeArea` + `patchIndexScriptOverlay` | 离线资源 / 安全区 / 广场镜像 | overlay transformer | 无 | merge-regressions / preview-merge |
| `novel/index.html` | `patchOfflineNovel` + `patchSafeAreaNovel` + `patchAndroidNovel` + `patchBackupNovel` | 离线 / 安全区 / 安卓钩子 / 备份 | overlay transformer | 无 | 同上 |
| `character/index.html` | `patchSafeAreaCharacter` + `patchOfflineCharacter` + `patchAndroidCharacter` + `patchBackupCharacter` | 安全区 / 离线 / 安卓 / 备份 | overlay transformer | localforage（角色页） | 同上 |
| `assets/js/core-utils.js` | `patchCoreUtilsOverlay` | 工具 | overlay transformer | 文件 IO（saveGeneratedFile 定义） | merge-regressions |
| `assets/js/data-services.js` | `patchDataServicesOverlay`（buildExecutableHtmlDocument 等） | 数据服务 / 旧共享 processor | overlay transformer | indexedDB | merge-regressions（含禁止再绑定断言） |
| `assets/js/runtime-services.js` | `patchRuntimeServicesOverlay` | 运行时 / 诊断清理 | overlay transformer | 无 | merge-regressions |
| `assets/js/ui-components.js` | `patchUiComponentsOverlay`（SidebarHeader/Footer/EmbeddedView/ModalOverlay） | UI 组件 | overlay transformer | 无 | merge-regressions |
| `assets/js/api-utils.js` | `patchApiUtilsOverlay`（shared/endpoint-only transport 校验） | API / SSE | overlay transformer | 网络 | merge-regressions / streaming-flush |
| `assets/js/app.js` | `resolveAppConflictBlob`（validateStages:109 / resolveBlock:152 / validateResolved:166） | 平台适配 / 性能缓存 / 导出 | **SHA-256 特例**（非纯 overlay） | indexedDB/localStorage/文件 IO | merge-regressions（assertNoSharedProcessMainContentBinding） |

## B. 本地自有扩展模块（不在 overlay 内，纯本地新增）

以下模块非上游文件，由本项目维护。标注「加载入口」即是否被 index.html `<script>` 引入或动态 import。

| 模块 | 作用 | 加载入口 | 数据影响 |
| --- | --- | --- | --- |
| `assets/js/platform-services.js` | 平台 facade 与浏览器实现 | 已核实（index.html document.write） | 文件 / 返回键 / 分享 |
| `assets/js/rphub-android-adapter.js` | Android 平台实现与桥接 | 已核实（index.html） | 原生桥 |
| `assets/js/chat-import-streaming.js` | 聊天流式读取/解析/导入委托 | 已核实（index.html） | 聊天 IO |
| `assets/js/rphub-backup.js` | 备份/恢复/刷写桥/流式记录 | 已核实（index.html） | 备份 IO |
| `assets/js/offscreen-iframe-lifecycle.js` | 离屏 iframe 生命周期 | 已核实（index.html） | iframe 状态 |
| `assets/js/rphub-io.js` | 共享流式 UTF-8 行读取（`LineReader`/`readTextFileLines`），阶段 2 新增，供 backup 与 chat 导入共用 | 已核实（index.html reapply 注入，位于 chat/backup 之前） | 无（IO 原语，不含业务语义） |
| `assets/js/safe-area.js` | 安全区（+89 行，本地新增，`git diff 4aef0bb..HEAD`） | 已核实（index.html） | 布局/安全区 |
| `assets/js/scroll-performance-diagnosis.js` | 滚动性能诊断（+375 行，本地新增） | 待核实（index.html script 列表未见，疑动态/诊断注入） | 诊断 |
| `assets/js/update-check.js` | 更新检查（与上游差 12 行，有 reapply 钩子但不在 manifest → 人工） | 已核实（index.html） | 更新源 |
| `assets/js/presence.js` | 在线状态 | 已核实**存在于上游 1.9.3**（`git cat-file` 成功），非本地新增 | 网络/presence |

上游共同 JS 但有本地差异者一并登记：`app.js`(413)、`safe-area.js`(89)、`scroll-performance-diagnosis.js`(375，纯新增）、`styles.css`(7，不在 manifest)、`update-check.js`(12，不在 manifest)。

### B.1 补丁钩子清单（scripts/upstream-sync/patches/*.mjs，13 个）

`index-script-overlay`、`patch-android-hooks`（patchAndroidNovel/App/Character）、`patch-api-utils`、`patch-app-conflict`（app.js 特例）、`patch-backup`（含 patchSquareMirrorApp 广场镜像）、`patch-chat-layout`（styles.css）、`patch-core-utils`、`patch-data-services`、`patch-offline-assets`、`patch-performance`（runtime-services 诊断清理）、`patch-safe-area`、`patch-sidebar-rendering`（styles.css）、`patch-ui-components`。

### B.2 构建脚本（scripts/web/*.mjs，4 个）

`prepare-vendor`（从锁定依赖生成 assets/vendor）、`build-css`（Tailwind，根目录输入）、`build-web`（构建/复制到 dist）、`verify-dist`（source/dist 清单、哈希、requiredFiles 校验）。

### B.3 测试脚本

- `scripts/tests/`（9 个，平台/安全区/原生/更新/性能）：platform-services、safe-area-layout、safe-area-insets、android-build-scripts、android-download-bridge、android-update-flow、native-theme、offscreen-iframe-lifecycle、streaming-flush。
- `scripts/upstream-sync/tests/`（15 个，同步/备份/EOL）：release-source、prepare-android-release、android-release-workflow、auto-resolver、merge-regressions、preview-merge、chat-layout-patch、mirror-square、eol-preservation、eol-churn-guard(+behavior)、eol-baseline-guard、reapply-idempotence、backup-roundtrip、backup-v5-compat、backup-patch。

## C. 能力矩阵

标注：**[已证实]**=有实现且本次有检查证据；**[拟议]**=方案提出未落地；**[待测]**=有实现但缺行为/设备证据。**未找到的能力不虚构，直接标「未找到」。**

| 能力 | 状态 | 验证证据 | 数据连续性依赖 |
| --- | --- | --- | --- |
| 原生分块导出（beginSave/appendChunk/finishSave/cancelSave） | 已证实 | NativeFilePlugin（android/…/NativeFilePlugin.java）+ test:platform「file chunks, cancellation」PASS | 文件 IO |
| 非原生流式文件落地（File System Access API） | 已证实（能力探测+FSA 真流式/取消/失败传播，见 file-save-contract.md） | `supportsStreamingFileSave` + core-utils `tryStreamViaFileSystemAccess` + test-save-generated-file.mjs 五场景 PASS | 文件 IO |
| 浏览器文件下载 | 已证实 | android-download-bridge PASS；聚合 fallback 保留（见 contract §7） | — |
| 聊天 JSONL 流式导入（分支/legacy） | 已证实（阶段 2：共用 `rphub-io.js` 流式行读取；分支逐条写、legacy 去掉全量 clone；损坏/截断回滚） | test-chat-import-streaming.mjs（真实 `createChatImporter` 调用路径 + 逐字节分块）PASS | 聊天数据 |
| 聊天 JSONL 流式导出 | 已证实（导出侧经 FSA/原生真流式；旧浏览器聚合见 file-save-contract §7；**端到端峰值内存实测待设备**） | app.js 生成器 + backup-roundtrip + saveGeneratedFile FSA 路径 PASS | 聊天数据 |
| 共享流式行读取组件 | 已证实（阶段 2 新增，backup/chat 单一实现） | test-rphub-io.mjs（UTF-8 逐字节、CRLF、空行策略、FileReader 回退、无私有副本）PASS | 无 |
| 备份导入/导出（v5 兼容） | 已证实 | backup-v5-compat 三项 PASS | 备份格式 |
| 取消导出 | 已证实（桥层取消 + FSA AbortError→cancelled，见 test-save-generated-file 场景 3；P1 修复后 exportBackup 取消显式 `cancelled:true`、不再返回成功对象） | test-platform cancellation + save-generated-file FSA-cancel + backup-roundtrip 用例 9 PASS | — |
| 取消恢复备份→导入中断（不覆盖现有数据） | 已证实（P1 修复，createRecoveryBackup 取消→null，importBackup 拒绝且现有数据不被覆盖） | backup-roundtrip 用例 8 PASS（负向） | 用户数据 |
| iframe 刷写失败可观察（不落脏快照） | 已证实（P2 修复，flushEmbeddedFrame ok:false/发送失败/超时→reject，不再当成功） | test-backup-bridge.mjs 用例 6/7/8 PASS（负向） | 备份一致性 |
| 返回键处理 | 已证实 | rphub-android-adapter.js + test:platform | 路由/面板状态 |
| 安全区 | 已证实 | safe-area-layout / safe-area-insets 双 PASS | 布局 |
| 广场镜像（square host） | 已证实 | mirror-square PASS + patchSquareMirrorApp | 广场数据 |
| 离屏 iframe 生命周期 | 已证实 | offscreen-iframe-lifecycle PASS（ACTIVE/NEAR/OFFSCREEN + cleanup） | iframe 状态 |
| 保存前刷写（backup flush） | 已证实 | backup-patch PASS + test-backup-bridge.mjs（注册/注销/全刷/失败聚合/iframe ack/缺失兜底）PASS | 备份一致性 |
| 性能计数快路径（countOnly 与正常路径一致性） | **待测** | 实现存在（app.js），无 countOnly↔正常计数等价断言 | 统计正确性 |
| 渲染缓存（filteredContentCache / timelineCharCountCache 缓存正确性/失效） | **待测** | 实现存在，无缓存陈旧/失效行为断言 | 渲染正确性 |
| UI 模板（UI 更新块） | 已证实（存在性）/ 行为**待测** | merge-regressions `'findUiTemplateUpdateBlock'` needle PASS | 渲染 |
| `processMainContent` 正文解析（生产路径） | 已证实 | app.js 内联走生产（merge-regressions needles PASS） | 渲染语义 |
| `processMainContent` 旧共享缓存（data-services） | 已证实为**遗留**；仅测试调用 | merge-regressions:102 `assertNoSharedProcessMainContentBinding` 禁止 app 再绑定 | 清理前需核动态调用 |
| 跨页面导入（论坛/工坊/小说/角色） | 已证实（备份 + character/novel 适配） | backup-roundtrip + character/novel overlay PASS | 各页数据 |
| 存储与 WebView origin 实际值 | **待测** | 本阶段未从最终配置 + 设备确认 | 用户数据（高风险） |

## D. 样本定义与阈值方案（骨架占位，后续阶段填充）

> 全部为「待后续阶段填充」。生成方式统一：合成/脱敏数据 + 记录随机种子（`<TBD>` 占位）。不提交真实私密数据。

- **大文件**：小 <1MB / 中 ~10MB / 大 ≥50MB；超长单记录、截断、损坏。测量：峰值内存（含原生桥）、总耗时、吞吐、在途块数、取消完成时间。
- **长聊天**：多会话/多分支/长单条/持续流式。测量：首屏、切换/跳转响应、流式刷新延迟、主线程长任务、滚动卡顿、计数/过滤一致性。
- **复杂 UI**：代码围栏、半标签、UI 更新块、图片、交互 iframe。测量：可见内容更新、iframe 存活、输入状态、内存趋势。
- **安卓流程**：保存/取消/权限失败、分享、返回键、键盘、安全区、前后台。测量：错误反馈、面板顺序、监听清理、数据刷写。
- **预算冻结**：参考设备、Android/WebView 版本、构建模式、样本规模、可重复步骤。≥5 次取中位数/范围，样本不足不报 p95；预算先于优化结果确定。

## E. 待核实事项汇总（不阻塞本阶段，随阶段 1 推进）

1. dist 陈旧 → 阶段 1 前置 `build:web` 重建 + verify。
2. 存储清单「待核实」条目（见 baseline §3）→ 需读 DB / 设备。
3. WebView origin 实际值 → 最终配置 + 设备确认。
4. countOnly / 渲染缓存行为等价断言缺失 → 建议阶段 4/5 补真实行为测试。
5. `1.8.8` tag 远端/本地分歧原因。
6. 阶段 2 仅迁移「聊天 JSONL」一个格式并抽出共享行读取组件；备份 V5、角色 JSON/PNG 等仍按既有实现，逐项迁移与内存实测见 `docs/architecture/large-file-io-contract.md`。
