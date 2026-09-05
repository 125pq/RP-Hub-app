# 上游合并失败记录

本文档记录自动同步无法安全完成、需要人工介入的上游合并。目标不是只保存报错文本，而是沉淀可复用的原因、修复方式、回归测试和发布影响。

## 记录规则

每次人工处理合并失败后，在本文档顶部新增一条记录，至少包含：

- 日期、上游 Release 标签、旧/新提交 SHA；
- 冲突文件和工作流的首个有效错误；
- Git 冲突原因与自动解析器失败原因；
- 人工取舍、补丁钩子或解析器改动；
- 新增的回归测试和完整验证结果；
- 对 Android 版本号、Release、GitHub/Gitee 更新源的影响；
- 仍然存在的风险以及下次应首先检查的位置。

不要通过放宽 proof、跳过锚点校验或扩大 EOL allowance 来换取表面通过。无法证明本地功能被完整保留时，解析器应继续 fail closed。

## 2026-09-05：上游 `1.9.1`（`9c06119`）应用入口冲突

### 现场

- 失败工作流为 `33951149392`；本地父提交为 `8829214408fe7fcc53a5b960e4e7512dc787d9e0`，共同上游基线为 `b409ca6a62857849a3003e072dc2979e00695728`，新目标为 `9c0611964a39ff8cca8831d97ecf18b04abb1990`（上游 `1.9.1`）。
- Git 内容冲突为 `assets/js/app.js`、`assets/js/core-utils.js` 和 `assets/js/data-services.js`；首个有效错误为 `Path is not in the auto-resolver manifest: assets/js/app.js`。
- 失败后的 issue 报告步骤又因仓库禁用 Issues 返回错误；这是次生告警失败，不是同步、构建或发布失败的根因。
- 失败发生在 prepare-only 合并阶段，依赖安装、测试、Android 构建、提交、GitHub Release 和 Gitee 镜像步骤均未执行。
- 第二门禁失败工作流为 `33964536295`：三个冲突均已自动解析，resolver、重应用幂等和 adapter proof 全部通过；随后 `Verify adapter and upstream hooks` 在 `merge-regressions.mjs:138` 首次失败，旧测试向 1.9.1 的 `parseUiTemplateUpdates` 传入了 `路径=值`，触发 `JSON变量块格式错误`。后续构建与发布仍全部跳过，Issues 禁用报错仍只是次生失败。

### 根因

- 既有 resolver 只登记了可从旧上游 blob 纯重放的 HTML、core-utils 和 data-services overlay；`app.js` 的本地 Android 返回键、Square 镜像、备份桥、离屏 iframe 和性能钩子此前依赖 Git 自动合并，因此遇到内容重叠时按设计 fail closed。
- `app.js` 有两个真实冲突块：上游重新加入了支持 `preventTruncation` 的内联 `processMainContent`，而本地已将该处理器移到 data-services 的共享缓存；上游同时移除了记忆导入导出 UI 和 handler，并移除了 handler 使用的 `hasVectorEmbedding` 导入。
- 直接选 ours 会留下无 UI 入口且引用已删除 helper 的记忆 handler，并丢失上游防截断语义；直接选 theirs 则会与本地导入的共享 `processMainContent` 重名，并丢失本地缓存路径。
- 第二门禁不是 resolver 或运行时代码回归：1.9.1 有意保留 `parseUiTemplateUpdates` 名称并将其输入改为原始 JSON（含 fenced JSON 和多模板数组）；既有回归测试仅按导出函数名把它误判为 1.8.9 的简化 `路径=值` 合约。

### 处理

- 新增 `patch-app-conflict.mjs` 专用解析器，只接受已经审查的两个冲突形态、完整 1/2/3 stage、普通 UTF-8 `100644` 文件和恰好两个冲突块；冲突双方去除边界空白后的 SHA-256 摘要必须与真实 workflow/隔离 fixture 完全一致，块内任何新增语句、锚点漂移、重复 marker 或本地关键钩子缺失都会拒绝整次解析。
- 正文处理保留 data-services 的共享缓存，并在 app wrapper 中先执行上游 `preventTruncation` 的不完整 `image###` 清理，再调用缓存实现。
- 记忆导入导出 handler 随上游删除：上游 `index.html` 已移除对应按钮，且 `hasVectorEmbedding` 已删除；保留该块只会制造不可达代码和运行时引用错误。其他 Android 文件导出、完整备份和用户选择保存位置路径保持不变。
- 输出按新的 upstream blob 重建 EOL，而不是继承 Git 冲突 marker 的 checkout 换行；真实合并的 EOL baseline 保持零新增噪声，没有扩大 allowance。
- 第二门禁只修正测试契约，不改生产 parser：用真实解析结果辨识 1.8.9 `路径=值` 与 1.9.1 JSON 合约，并分别验证合法输入和对应的 SyntaxError；无法匹配任一完整已审查行为时继续 fail closed，不依赖源码字符串断言。

### 验证

- `node scripts/upstream-sync/tests/auto-resolver.mjs`：真实 `b409ca6 → 8829214 → 9c06119` 三冲突 fixture 通过，并验证额外冲突块、ours/theirs 任一侧注入额外语句都会 fail closed。
- 真实隔离 worktree 合并得到与 workflow 一致的三个冲突；解析后无未合并路径，连续两次重应用均为 `REAPPLY_CHANGED_FILES=0`，`node --check assets/js/app.js` 和 `git diff --check` 通过。
- `node scripts/upstream-sync/tests/eol-baseline-guard.mjs`：以 `MERGE_HEAD=9c06119` 为基线通过；未增加 `app.js` 或其他文件的 EOL allowance。
- 完整 `npm run test:upstream-sync`、`npm run test:platform` 和 `npm run test:performance` 均通过；Web 构建及 Android/发布链仍由审查后的正式 workflow 执行并核验。
- 第二门禁修复后，当前 1.8.9 工作树真实执行 `路径=值` 成功/失败路径通过；`807d8a6 + 9c06119` 隔离合并结果真实执行 JSON、fenced JSON、多模板数组和 malformed JSON 路径也通过。

### 版本与发布影响

- 修复补丁本身不改版本号、不创建同步 merge commit，也不发布 Release；失败的 `33951149392` 没有生成 APK 或更新 GitHub/Gitee 发布面。
- 第二门禁失败的 `33964536295` 同样未进入构建、提交或发布步骤；本次测试修复也不改变版本元数据。
- 审查通过后应由既有 workflow 重新合并 `1.9.1`、计算 Android 修订号并完成发布，随后分别核对远程 `main`、Release target/APK/SHA、`android-latest` 和 Gitee 镜像。

### 后续风险

- 该 app resolver 有意绑定两个已审查冲突形态；上游再次移动正文处理、改变记忆设置返回结构或产生第三个 app 冲突块时会再次 fail closed，应先读首个有效错误并更新专用补丁，不能退回整文件 ours/theirs。
- 本次隔离验证覆盖合并语义、语法、EOL 和钩子幂等；Android 实机 UI、APK 和发布面必须等正式 workflow 成功后单独验证。

## 2026-08-29：上游 `1.8.9`（`b409ca6`）核心工具与数据服务冲突

### 现场

- 本地合并父提交为 `60035299239d168b5c8d2bbff9c22562145e7c8d`，共同上游基线为 `0562644622384ae645b2be959aeec0968a11d436`，新的上游目标为 `b409ca6a62857849a3003e072dc2979e00695728`（上游 `1.8.9`）。
- Git 内容冲突为 `assets/js/core-utils.js` 和 `assets/js/data-services.js`；补丁接线前 resolver 的首个有效错误为 `Path is not in the auto-resolver manifest: assets/js/core-utils.js`。
- 首轮修复后的工作流 `33233300924` 已通过真实双冲突 resolver，但在发布前门禁停于 `data-services.js contract: missing ["createDetailedJsonSyntaxError"]`；构建、提交、Release 和镜像步骤均未执行。
- 修正 parser 契约后的干净后合并演练继续发现 EOL 基线仍固定要求 `core-utils.js: 80`、`data-services.js: 512` 行历史噪声，而 1.8.9 resolver 的实际结果均为 `0`；该演练未提交或发布任何内容。

### 根因

- 本地核心工具的 parse-COT 性能包装、缓存清理导出和 Android 文件保存桥接，以及数据服务的 iframe 性能埋点、离线 jQuery 和流式 `processMainContent`，原本由重应用钩子直接写入，但没有作为纯 overlay 注册到 resolver manifest。
- 因而 resolver 无法证明 `transform(stage1) === stage2`，此前若采用整文件取一侧会丢失本地功能或上游 `thinking`/变量解析更新；这类冲突必须继续 fail closed。
- 上游 `1.8.9` 有意用 `parseUiTemplateUpdates` 的简化 `路径=值` 格式替换旧 JSON 解析器；旧的 `merge-regressions.mjs` 仍硬性要求已被上游移除的 `createDetailedJsonSyntaxError`，导致 resolver 正确完成后出现测试误报。
- EOL 基线表原本不区分待合并上游 SHA；两个新 overlay 在 1.8.9 后消除了历史换行噪声，固定旧 allowance 因此把改善误报成回归。

### 处理

- 将已有 core-utils 逻辑提取为 `patch-core-utils.mjs`，将已有 data-services 逻辑提取为 `patch-data-services.mjs`，按原重应用顺序接入 `overlay-transformers.mjs`；`reapply-hooks.mjs` 新增 data-services 分组。
- 两个变换均要求关键插入 marker 恰好一次、旧实现 marker 不再存在，并保留 resolver 原有的三阶段、100644、UTF-8/二进制和 EOL proof；未直接手改上游文件。
- 使用真实 `0562644 → 6003529 → b409ca6` blob 建立两个冲突 stage，确认 resolver 输出为变换后的上游内容，并确认再次重应用为幂等；同时保留上游 `thinking` 支持和 `parseUiTemplateUpdates`。
- 将数据服务回归契约改为兼容同步前的完整旧 JSON 解析器和同步后的完整简化解析器；真实 1.8.9 resolver fixture 额外断言不会把已移除的旧 helper 重新注入上游结果。
- EOL guard 通过 ancestry 区分基线：1.8.9 之前继续锁定既有 `80/512` allowance，`b409ca6` 及其后继基线对这两个文件严格要求 `0`，不放宽其他文件。

### 验证

- `node scripts/upstream-sync/tests/auto-resolver.mjs`：通过，真实 `b409ca6` 两冲突 resolver + reapply proof 通过。
- 完整 `npm run test:upstream-sync`、`npm run test:platform`、`git diff --check` 作为本次修复门禁；正式 workflow 仍需在后续修复审查通过后重新 dispatch 并跟踪到发布完成。

### 版本与发布影响

- 不改 `package.json` 或任何版本号；失败的 `33233300924` 未执行构建、提交、Android Release 或 GitHub/Gitee 更新源步骤。
- 上游 `1.8.9` 的正式同步应在这些补丁通过审查后由既有 workflow 生成新版本/修订号；本次只修复同步能力和测试，不创建 merge commit。

### 后续风险

- 上游若重命名 core/data 的函数、jQuery 行、iframe 计时器或导出对象，严格 marker 会拒绝同步；下次应先检查首个 anchor/proof 错误，不能放宽 manifest 或改用整文件覆盖。
- 当前真实冲突 proof 使用仓库已有的 `0562644`、`6003529` 和 `b409ca6` 对象；设备 UI、Android 构建和发布链未在本次隔离修复中执行。

## 2026-08-26：上游 `1.8.8` 同标签改指向 `0562644`

### 现场

- 上游 Release 标签仍为 `1.8.8`，但目标从 `fc41d1a8e80ea560a3ae1ef994ef473d36df27a7` 改为 `0562644622384ae645b2be959aeec0968a11d436`。
- 新目标比旧目标多出 `a3c12ce`、`4ecc0c1`、`0562644` 三个提交，修改 `assets/css/styles.css`、`assets/js/app.js`、`assets/js/runtime-services.js`、`index.html`、`novel/index.html`，并新增 `assets/js/api-utils.js`。
- Git 在 `index.html` 和 `novel/index.html` 产生内容冲突。
- 自动解析器首先在 `index.html` 的历史重放证明处失败：`transform(stage1) != stage2`。

### 根因

Git 冲突来自上游和本地补丁同时修改页面入口附近的内容。自动解析器失败则是本地 `patchSquareHostSafeArea` 已经由重应用流程写入 `index.html`，却没有注册到 `overlay-transformers.mjs`；解析器因此无法从旧上游基线重建当前本地文件，也就不能证明自动选择是安全的。

`novel/index.html` 本身可以由已有 overlay 重建，但解析器在任何一个冲突文件 proof 失败时都会中止整次合并，避免只解决一部分冲突后继续发布。

### 处理

- 导出 `patchSquareHostSafeArea`，并按真实补丁顺序加入 `index.html` overlay。
- 使用 overlay 输出解决 `index.html` 和 `novel/index.html`，最终提交保留本地提交与 `0562644` 两个父提交。
- 更新历史 stage1/stage3 replay 期望。
- 增加 Square safe-area 标记恰好插入一次、二次执行幂等、锚点漂移时 fail closed 的行为测试。
- 在真实 `0562644` 合并基线上收紧 EOL guard；不为 `styles.css`、`app.js`、`index.html` 或 `novel/index.html` 增加噪声额度。

### 验证

- `npm run test:upstream-sync` 通过，EOL baseline 明确为 `0562644`。
- `npm run test:syntax`、`npm run test:platform`、`npm run test:performance` 通过。
- `npm run build:web`、`npm run verify:dist`、`git diff --check` 通过。
- Reviewer 最终结论为 `PASS`。

### 版本与发布影响

同标签改指向由定时工作流合并时，`merge` 模式现在会在同一基础版本上自动递增修订号：当前 `package.json` 为 `1.8.8` 时选择 `1`，为 `1.8.8.1` 时选择 `2`；新基础版本（例如上游 `1.8.9`）仍从 `0` 开始。`recover`/`noop` 保持当前修订号，workflow_dispatch 的显式 revision 始终优先，超过 `99` 直接 fail closed。

修复前，同标签 merge 仍可能命中已有 Android tag、复用旧 Release 的 canonical APK 并跳过重复发布。现在 merge 会先自动选择下一 revision；如果目标 tag 仍已存在或在发布时被并发创建，工作流会 fail closed。只有 recover 可以复用已有 APK，而且 Release 的 `targetCommitish` 必须与当前 `HEAD` 完全一致。此次实际发布显式传入了 `revision=1`，因此生成 `1.8.8.1`、`versionCode 1080801` 和 `v1.8.8.1-android`。

### 后续风险

- 当前是否已集成仍按提交 SHA 的 ancestry 判断；上游再次改写同一标签时，仍会被当成待合并代码。
- 上游若重构 Square 容器或其他补丁锚点，解析器会再次 fail closed，需要人工确认新结构。
- 若产品规则是“只有新 Release 标签才同步”，应另行把同步状态改为以已记录的 Release 标签为主；同标签 SHA 变化只告警、不合并。

## 2026-08-23：上游 `1.8.7` 标签目标刷新与缓存内容处理冲突

### 现场

- 上游 `1.8.7` 先以 `b029b2509abd2791d08b2884a9d66c2506f4087f` 进入提交 `a7f4807`，随后本地 `1.8.7` 标签指向 `4b68ac119d48c1ebce1294655a53f4755a0ed0ff`，再次由提交 `1c13c9a` 合入。
- 两次合并都是保留本地父提交和上游父提交的 merge commit；`4b68ac1` 实际包含 `assets/js/data-services.js`，但缺少本地 `processMainContentImpl`、`processMainContentCache` 及其本地处理逻辑，合并结果明确保留了这些缓存路径。
- 历史仓库未保留第一次失败运行的完整 stdout/stderr，因此不能还原一个未经证明的“首个错误”；可由 merge parent、文件差异和后续修复提交确认的是：同一 `1.8.7` 发布线被两个不同 SHA 先后处理，并需要人工确认缓存内容处理不能被上游快照删除。

### 根因

- 上游标签目标在两个快照间变化，且后一个快照重写了 `data-services.js` 的内容；如果只按上游文件整体取代，会把本地 `processMainContentImpl`、`processMainContentCache` 误判为可删除内容。
- 同期 `assets/js/runtime-services.js`、`assets/js/app.js`、`assets/js/built-in-content.js` 等文件也发生大范围变更，不能只依据文件存在与否自动取一侧结果。

### 处理

- 保留 `1c13c9a` 中本地缓存实现，并合入其余 `4b68ac1` 上游内容；随后 `cae4b0f` 仍为 `1.8.7`，真正升为 `1.8.7.1` 并发布对应 Android Release 的是 `38aa0e9`。
- 早先的 `a7f4807` 已生成 `v1.8.7-android`；后续同标签目标变化没有覆盖该旧构建，而是单独生成修订版，避免 Android 版本与更新元数据复用错误。
- `scripts/upstream-sync/tests/merge-regressions.mjs` 现在锁定 `processMainContentImpl`、`processMainContentCache`、未闭合 `image###` 处理及 app 对共享实现的引用；相关测试和性能测试均作为同步门禁运行。

### 验证

- Git 证据：`a7f4807`（`b029b25`）、`1c13c9a`（`4b68ac1`）、`cae4b0f` 和 `38aa0e9` 的父提交、文件差异及版本字段可复核上述处理顺序。
- `scripts/upstream-sync/tests/merge-regressions.mjs`：PASS。
- `npm run test:performance`：PASS，包含流式刷新场景。
- 当前同步门禁中与本条相关的 `merge-regressions` 和 resolver proof：PASS；EOL guard 修正为优先选择最近上游 Release 基线后，完整 `npm run test:upstream-sync` 也已通过。

### 版本与发布影响

- `a7f4807` 的 `package.json` 为 `1.8.7`，对应 `v1.8.7-android`；`cae4b0f` 的 `package.json` 仍为 `1.8.7`，随后 `38aa0e9` 才升为 `1.8.7.1` 并对应 `v1.8.7.1-android`。
- 这次目标刷新没有证据表明应发布全新的上游语义版本；实际影响通过 Android 修订号 `1` 表达，避免同标签构建覆盖或复用旧 APK。

### 后续风险

- 上游 Release 标签仍可能重新指向不完整文件树；同步前应同时记录 release tag、commit SHA、两个 merge parent 和关键缓存文件是否存在。
- 未保存原始失败日志会降低后续审计能力；工作流应保留首个 Git/解析器错误及冲突文件清单。
- 任何将缓存处理从 `data-services.js` 移回 `app.js` 的上游改动，都必须先通过回归测试确认，不应只按文本冲突位置取舍。

## 2026-08-22：上游 `1.8.6` runtime-services 流式处理冲突

### 现场

- 上游 `1.8.6` 提交为 `9b4c9674b70461e81e8ab9c601b716f99258a583`；提交 `2565916` 明确是以本地 `bed5042` 和该上游提交为两个父提交的 merge commit。
- `assets/js/runtime-services.js` 同时包含上游的 SSE choice 提取和本地的流式刷新调度，提交 `c5037dd` 的说明明确写有“Resolve the runtime-services.js streaming conflict while preserving the local paragraph-aware scheduler and adopting the upstream non-streaming choice extraction”。
- 历史仓库没有保留原始工作流 stderr；可确认的首个有效事实是 `runtime-services.js` 发生冲突并由人工合并提交解决，而不是假设一个未保存的命令输出。

### 根因

- 上游改动了响应解析和流式读取路径，本地同时维护了 `STREAM_RENDER_INTERVAL` 相关逻辑及段落感知刷新调度，两个版本在同一文件的同一运行链路中交叉修改。
- 若只接受任一侧，会丢失上游的 choice/error 处理或本地的段落边界、最大可见延迟和测试注入能力。

### 处理

- 在 `2565916`/`c5037dd` 中保留本地 `createStreamingBoundaryTracker`、段落边界和最大可见延迟调度，同时采用上游的 choice 提取和非流式响应行为。
- 后续 `scripts/upstream-sync/tests/test-streaming-flush.mjs` 及性能测试覆盖 LF/CRLF 段落、burst 合并、max latency、think/cot、abort 和错误路径，防止下一次上游合并只保留一侧逻辑。

### 验证

- Git 证据：`2565916` 是 `bed5042` + `9b4c967` 的 merge commit；`c5037dd` 的提交说明和 combined diff 均直接指向 `runtime-services.js` 冲突取舍。
- `npm run test:performance`：PASS，`Paragraph-aware streaming flush` 场景通过。
- 当前 `npm run test:upstream-sync` 的 merge regression、流式、reapply 和 EOL baseline guard 均已通过；原始 1.8.6 运行日志未保留。

### 版本与发布影响

- `2565916` 与 `c5037dd` 的 `package.json` 仍为 `1.8.5`，Git 历史中没有 `v1.8.6-android` 标签；因此该次记录是上游代码集成失败/人工冲突处理，不应虚构一个已发布的 1.8.6 Android 包。
- 流式逻辑修复随后随主线进入后续 1.8.7 Android 构建；发布前必须重新运行流式性能和 Android/Web 构建门禁。

### 后续风险

- 上游继续修改 `runtime-services.js` 时，优先检查 boundary tracker、`onDelta` 调度和非流式 choice 提取是否同时存在。
- 性能测试通过只证明当前 fixture；真实 WebView 网络、长文本和不同 SSE 分片节奏仍需在发布前抽样验证。

## 新记录模板

```markdown
## YYYY-MM-DD：上游 `<tag>` 合并失败

### 现场
- 旧/新 SHA：
- 冲突文件：
- 首个有效错误：

### 根因

### 处理

### 验证

### 版本与发布影响

### 后续风险
```
