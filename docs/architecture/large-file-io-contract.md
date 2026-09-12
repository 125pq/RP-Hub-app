# 阶段 2 大文件 IO 契约与能力表

版本：v1｜编制日期：2026-09-12｜对应阶段：阶段 2（抽离大文件 IO，保留格式与存储契约）

本文件同时作为阶段 2 的交付物与阶段报告。遵循与 `baseline.md` 相同的原则：**已知事实**（有代码/测试证据）、**待验证事项**（未测即写「待测」）严格区分，不虚构内存或性能数字。上游稳定版本为 tag `1.9.3` = `4aef0bb46c9b3370faba174a20435e5989799727`。

本轮按方案 §6「一次只迁移一个格式/入口」完成三个切片：
- **切片 1**：聊天 JSONL 格式（导出在 app.js、导入在 chat-import-streaming.js）+ **可复用流式行读取组件**。
- **切片 2**：备份 V5 格式的导出 IO 边界收拢（`saveSnapshotStream`）与**导入失败处理**（区分「校验失败、未写入」与「恢复写入中断、可能部分覆盖」，后者指向恢复备份）；并补大样本往返/异常/失败注入证据。
- **切片 3**：角色卡 JSON 导出（`character/index.html`，由补丁注入）改为 `RPHubIO.jsonTextChunks` 流式序列化，不再先构造完整字符串；新增字节级等价的 JSON 流写入组件。

角色 PNG、app.js 内上游角色 JSON 导出、跨页面导入等格式的逐项迁移仍列为后续子任务。

## 1. 本轮范围与实际文件

| 文件 | 变化 | 归属 |
| --- | --- | --- |
| `assets/js/rphub-io.js` | **新增**：可复用流式 UTF-8 行读取（`LineReader` / `readTextFileLines`） | 本地扩展（IO 原语） |
| `scripts/upstream-sync/patches/index-script-overlay.mjs` | 在 `chat-import-streaming.js` 之前注入 `rphub-io.js`（锚定聊天加载器） | 构建/接入 |
| `index.html` | 由 reapply 重新生成，仅新增 1 行 script（EOL 噪声为 0） | 上游文件（经补丁） |
| `assets/js/rphub-backup.js` | 删除私有 `SnapshotLineReader` / 重复读取器，改为委托 `RPHubIO` | 本地扩展 |
| `assets/js/chat-import-streaming.js` | 删除私有行读取器；去掉 legacy 导入的全量 `cloneForStorage`；补分支导入失败回滚 | 本地扩展 |
| `scripts/web/verify-dist.mjs` | requiredFiles 增加 `assets/js/rphub-io.js` | 构建校验 |
| `scripts/tests/test-rphub-io.mjs`、`scripts/tests/test-chat-import-streaming.mjs` | **新增**测试 | 测试 |
| `package.json` | `test:platform` 接入上述两个测试 | 元数据 |

## 2. 可复用 IO 组件

`window.RPHubIO`（`assets/js/rphub-io.js`，在 index 加载顺序中位于两个消费者之前）：

- `new LineReader(onLine)`：`push(decodedText)` / `finish()`。按 `\n` 组行，剥离尾部 `\r`，只在行未完成时缓存 pending 片段；跨块 UTF-8 多字节与 emoji 不会切半。**不**内置空行过滤（空白行照常回调），由消费者决定策略。
- `readTextFileLines(file, onLine)`：优先 `file.stream()` 逐块读取 + `TextDecoder(..., { stream:true })`；无 Blob.stream 时回退 `FileReader` 整读（既有行为，文档明示）。

消费方语义保持：
- 备份：直接回调每行；
- 聊天导入：本地 `readChatLines` 包装，保留原「跳过纯空白行」策略。

## 3. 各格式能力表（本阶段盘点）

标注：**[已证实]**=有实现且本轮有检查证据；**[待测]**=有实现但缺设备/大样本证据；**[未迁移]**=本轮未动，保留既有实现。

| 格式 / 入口 | 导出路径 | 导入路径 | 是否真流式 | 有界内存？ | 数据契约 |
| --- | --- | --- | --- | --- | --- |
| 整体备份 V5 JSONL（rphub-backup.js） | 异步生成器 → `saveGeneratedFile` | `file.stream()` 行读取，先校验后镜像恢复（两遍） | 导出：原生分块 / FSA 真流式；导入：逐行 | 导出/导入均为块级；**单个数组记录值本身就是一条 IndexedDB 记录，读取时整体驻留**（schema 固有，见 §5） | [已证实] backup-roundtrip + backup-v5-compat |
| 聊天分支 JSONL 导出（app.js） | 逐分支、逐消息生成器 → `saveGeneratedFile` | — | 是（原生/FSA） | 是（单条消息粒度）；每条消息有一次 `cloneForStorage` 瞬时副本 | [已证实] 生产流形状；行为见 merge-regressions |
| 聊天分支 JSONL 导入（chat-import-streaming.js） | — | 共享行读取，逐分支写库 | 是 | 是（逐分支写；不堆积整文件） | [已证实] test-chat-import-streaming（逐字节喂入） |
| 聊天 legacy JSONL 导入（chat-import-streaming.js） | — | 共享行读取，整段消息数组一次写库 | 是（读取/解析逐行） | 读取阶段逐行；**写入需要完整消息数组驻留（存储契约要求单条记录）** | [已证实] test-chat-import-streaming，且已去掉全量 clone |
| 角色卡 JSON 导出（character 页，补丁注入） | `RPHubIO.jsonTextChunks(data,{space:2})` → `saveGeneratedFile` | — | 是（原生分块 / FSA） | 是（不再先建整串） | [已证实] test-rphub-io（字节等价）+ test-save-generated-file（路径契约） |
| 角色卡 JSON / PNG 导出（app.js 上游函数） | `JSON.stringify` / PNG 字节 → `saveGeneratedFile` | — | 否（PNG 字节固有；JSON 先建整串） | 否（既有行为） | [未迁移] app.js 上游函数，阶段 3+ 评估 |
| 角色/小说/工坊/论坛导入 | 见各自页面 | 既有实现 | 视入口而定 | 视入口而定 | [未迁移] 阶段 2 后续子任务 |

## 4. 导出一致性与导入失败处理

- **导出一致性**：备份导出前先 `RPHubBackupBridge.flush()`，确保去抖写入落盘；聊天分支导出对当前角色先 `flushPendingChatHistorySave()`。导出流为拉取式生成器，由 `saveGeneratedFile` 消费者驱动，天然背压（不预聚合）。
- **取消**：原生选择器/FSA `AbortError` → `{cancelled:true}`，业务层不报成功。备份与聊天导出均已验证。
- **备份导入失败**：`restoreSnapshotFile` 在**完整校验通过后、首次写库前**通过 `onWriteStart` 标记。校验失败 → 不进入写阶段，原样抛错；写阶段异常 → 关闭数据库并抛出带 `partialWrite=true` 的错误，消息明确「部分本地数据可能已被覆盖」并给出恢复备份文件名（镜像恢复是分批写入、非单事务，不能谎称数据未被修改）。导入前强制生成恢复备份，取消恢复备份则整体中止。
- **聊天导入失败**：解析/校验失败 → 回滚已写入的分支聊天 scope（`deleteScopedStoredValue('chat', scopeId)`）。**本阶段补齐**：分支元数据写入失败或「截断导致声明分支缺失」时同样回滚，不再留下部分覆盖的半成品。
- **未知字段政策**：两种 JSONL 均不新增自有 schema；分支格式未知 `branchId` 报错，legacy 格式原样存储，保持上游语义。

## 5. 额外复制消除与内存说明

**已消除**：聊天 legacy 导入的 `cloneForStorage(legacyMessages)` 全量深拷贝。解析结果是全新普通 JSON 对象（无响应式代理、无函数/循环引用），`prepareLoadedChatHistoryForDisplay` 就地补齐字段后直接写入同一数组引用（IndexedDB 写入时自行结构化克隆）。测试断言 `cloneForStorage` 调用次数为 0，证明不再有一整份聊天副本同时驻留。

**已消除**：角色页整卡 JSON 导出的完整序列化字符串。改为 `RPHubIO.jsonTextChunks(data,{space:2})` 分块生成；标量编码仍委托原生 `JSON.stringify`，仅结构/缩进/`toJSON`/`undefined` 规则由流写入器复现，并有跨 fixture 的**逐字节等价**测试。原生 `appendTextStream` 与 FSA 直接消费该流。

**仍存在、且属 schema 固有（不移除）**：
- 备份/聊天的「数组记录」在 IndexedDB 中是单个 value，读取与写入时整体物化；要消除必须改变存储 schema 或数据库布局，超出阶段 2 范围（方案 §6 停止/回退明确要求移出本阶段）。
- 聊天分支导出的 `JSON.stringify(cloneForStorage(messages[messageIndex]))` 为单条消息粒度瞬时副本（非全量驻留）。
- 备份导入的两遍读取（先校验、后恢复）增加的是**时间**而非峰值内存，属有意的安全设计。

## 6. 测量报告（状态）

| 指标 | 状态 | 说明 |
| --- | --- | --- |
| 共享行读取正确性 | **已测（Node）** | UTF-8 逐字节分块、CRLF、无尾换行、空行策略、FileReader 回退全部 PASS |
| legacy 导入额外全量副本 | **已消除（结构证明）** | test-chat-import-streaming 断言 `cloneForStorage` 0 次 |
| 损坏/截断/取消不静默丢数据 | **已测（Node，负向）** | 聊天损坏截断回滚、备份坏文件/截断/记录数不符拒绝、恢复写入中断反馈、取消不返回成功 |
| 备份大样本往返确定性 | **已测（Node）** | `backup-large-file.mjs`：552 条记录 / 5.08 MiB（含 30000 条消息的数组记录）导出→导入→再导出字节一致；导出生成器首个 yield 前 `indexedDB.open` 次数为 0（惰性，不整体物化） |
| 角色卡 JSON 流式序列化字节等价 | **已测（Node）** | `test-rphub-io.mjs`：simple/nested/unicode/numbers/undefined 省略/数组空位/toJSON/转义键/大样本 等 fixture 与 `JSON.stringify(value,null,space)` 逐字节相等（space=2/0/4/tab），大样本分多块且每块≈32 KiB；`character/index.html` 实际接入断言 |
| 峰值进程内存（含原生桥） | **待测** | 需参考设备 + 大样本，按方案 §7.3；本阶段不做设备测量，不以单测绿代替（Node 堆含 mock IDB，不代表 WebView） |
| 总耗时 / 吞吐 / 最大在途块数 | **待测** | 同上 |
| 聊天导入进度回调 | **未实现** | 现有导出有 `onProgress`，聊天导入无；如需 UI 进度另开子任务 |

## 7. 实际运行的检查与证据

- `npm run test:platform`：PASS（含 `test-rphub-io.mjs`、`test-chat-import-streaming.mjs`）。
- `npm run test:upstream-sync`：PASS（含 auto-resolver、EOL churn、EOL baseline `4aef0bb`、reapply idempotence `REAPPLY_CHANGED_FILES=0`）。
- `npm run test:backup`：PASS（backup-roundtrip、backup-v5-compat、`backup-large-file`、backup-patch、bridge）。
- `npm run test:performance`：PASS。
- `npm run build:web` + `npm run verify:dist`：PASS（46/46 source matches，`rphub-io.js` 在 dist 且 index 引用 1 次）。
- `index.html` 仅新增 1 行；`git diff --numstat` 与 `--ignore-space-at-eol` 相等（EOL 噪声 0）；reapply 两次 `REAPPLY_CHANGED_FILES=0`。

## 8. 未完成项与下一阶段入口

未完成验收（不标「阶段 2 已完成」的原因）：
- 已迁移/加固聊天 JSONL、备份 V5、角色页 JSON 三个格式；角色 PNG、app.js 内上游角色 JSON 导出、跨页面导入等仍按既有实现（未迁移）。
- 设备端峰值内存/耗时未测。
- 聊天导入进度回调未实现。
- 备份镜像恢复仍是分批写入（非单事务）：写入中断已诚实反馈并指向恢复备份，但未做到事务级自动回滚（需 staged/事务存储改造，按方案 §6 属移出本阶段的部分）。

阶段 3 入口条件：已有薄接入样例与差异台账（阶段 0）。本阶段新增 `rphub-io.js` 属本地扩展，不改变上游输入，可直接作为组合构建中的本地扩展模块登记。

## 9. 回退对象

- 代码：`assets/js/rphub-io.js`（新增）、`rphub-backup.js` / `chat-import-streaming.js` / `index.html` / `index-script-overlay.mjs` / `verify-dist.mjs` / `package.json` 的本轮改动；`docs` 与测试。
- 数据：**未改动任何存储 schema、数据库名/版本、localStorage key 或备份格式**；回退代码不需要恢复数据库。
- 上一稳定接入：阶段 1 的 `saveGeneratedFile` 契约与 `rphub-backup.js` 内联行读取（回退即恢复该内联实现与旧导出）。
