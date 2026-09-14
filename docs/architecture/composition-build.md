# 阶段三：原版上游并行组合构建

日期：2026-09-12。起点：`codex/long-term-android-plan`，`29f0b30e59445b92e72a7cba2d9a1bcbf1aa6757`。

状态：原版输入已可重建完整 app，候选构建已无整文件覆盖；阶段三已接通默认本地构建入口与本地同步命令；正式自动同步与 APK 发布入口仍未切换。用户明确要求本轮不使用子代理，真机验收由用户负责。

## 首个切片背景（后续进度见文末）

目标继续是完整承接上游功能、保留数据和安卓适配，同时逐步降低维护成本。本轮没有修改上游 HTML/JS/CSS，没有新增业务函数副本，也没有优化运行时行为。根目录相对上游的 diff **没有减少**；先建立一个能验证后续差异迁移是否丢功能的组合构建入口。

候选输入锁定 `STA1N156/RP-Hub` 的 `1.9.3`，完整提交为 `4aef0bb46c9b3370faba174a20435e5989799727`。`upstream.lock.json` 只约束这个新入口；旧同步流程目前仍按原方式管理上游版本，不得把二者都称为整个项目的唯一来源。候选构建不访问网络，不追踪 latest；本地须已有对应 Git 对象和 tag。锁文件中的仓库身份是登记信息，本轮没有新增远程来源认证机制。

## 已实现的路径

```text
锁文件 + 本地 Git 对象
  → 每次创建 .work/compose/run-*/upstream 原版快照
  → source 中应用既有变换、复制登记的自有模块
  → 独立准备 vendor、扫描 source 生成 CSS、复制到该 run 的 dist
  → 候选目录校验 + 当前根目录源码及正式 dist 全量比较
  → report.json（成功或失败均记录，不自动提升产物）
```

快照逐文件从 Git blob 读取，无 checkout 换行转换，构建结束后检查原版字节未变。这里的“只读”是构建职责和结束校验，不是操作系统权限锁定。

各 run 使用不同目录；新构建不会删除或覆盖先前候选或正式 `dist`。失败目录保留排查。原版与生成文件不提交 Git；清理时先核实具体 run 路径。

| 来源 | 数量 | 本轮处理 |
| --- | ---: | --- |
| 可重建变换 | 11 | 8 个 manifest 文件、样式、更新检查以及完整 app 组合；检查重放幂等 |
| 自有文件 | 14 | recipe 明确列出，沿用根目录唯一实现；碰到上游同名文件立即拒绝 |
| 过渡整文件覆盖 | 0 | app 从原版与登记的业务接入重建，不再读取本地 app 作为覆盖输入 |
| 其余发布文件 | 4 | 原版直通 |
| 非网页上游文件 | 4 | README 与 presence-server 明确排除发布，仍保留在原版快照和来源报告 |

整文件覆盖现已移除。仍需检查上游接口变化，不能把大量上游业务实现复制为巨型补丁，也不能跳过同版本产物比较。下文早期验证结果及续作段落记录的是各提交当时状态。

`scripts/web/paths.mjs` 集中网页发布根目录和排除项，组合 recipe 必须与之相符。现有发布目录内的新增资源会进入物化和复制；新顶层目录先报“未分类”，要求明确归属。未登记的本地发布资源也会拒绝，不会静默漏掉。

## 使用

安装锁定 npm 依赖，并准备本地上游 tag 后：

```powershell
npm run build:web
npm run verify:dist
npm run build:candidate
npm run test:compose
```

`build:candidate` 输出具体候选路径和来源报告路径。候选构建不会运行 Capacitor，不写 Android 工程，不连接手机。

底层构建脚本支持 `--source-root`；复制和校验另支持 `--output-dir`。默认值保持原先根目录/`dist` 行为，自定义路径限制在 `.work/compose/` 内。vendor 依赖与 Tailwind 配置仍来自本仓库，但 CSS 输入、扫描工作目录和生成位置来自指定 source。测试通过只存在于候选 HTML 的 class 验证这一点。

报告包含：上游锁、配方摘要、本地扩展提交、工作区状态、依赖锁摘要、构建输入摘要、逐文件来源、输入/输出摘要、基线比较及失败原因。允许消费工作区中的本地扩展修改，具体字节由摘要记录，因此 HEAD 字段本身不表示所有输入已提交。

## 本轮验收结果

- `build:web` 与 `verify:dist`：原入口正常，46 个文件；基线 manifest SHA-256 为 `b1cbf1d91e91d1f1aaed123cc0c8c3b79609a59a8695b0ec6019e03f24070877`。
- 新入口与基线：45 个文件逐字节一致；`index.html` 去除 CRLF/LF 区别后内容相等。候选沿用变换器的 EOL 保留结果，没有为了凑字节一致格式化上游文件。只有这个登记文件允许 EOL 比较差异，其他差异拒绝。
- 两次全新构建产物摘要一致：`6282b06c30af2ba80781cd5d1cc441f3e4ced7025520b427f7c1a88f022cabee`（组合报告自己的摘要算法，不等同于 verify-dist manifest 算法）。
- `test:compose`：过渡覆盖的上游/本地漂移拒绝、未分类上游目录拒绝、缺失样式锚点拒绝、实际内容差异拒绝、输出路径保护、候选 CSS 扫描、独立目录验证失败、正式产物和根 assets 未被候选构建修改。
- `test:upstream-sync`：通过，含真实历史合并 fixture、EOL 检查、重放两次零修改和备份兼容测试。
- 本轮按用户“不用子代理”要求在主线程复核来源分类、旧入口兼容、路径边界、失败行为和测试证据；不声称独立代理审查。
- 真机、运行时性能与新版本迁移验收未执行，由用户负责真机部分。字节比较不等于设备功能验收。

## 尚未完成与下一步

1. 新入口目前必须对照同版本根目录源码和 `dist`，依赖旧路径提供基线；尚不能单独替代自动同步。真实未来版本变化仍须经过现有流程审查，不能仅改锁文件就宣布兼容。
2. 更新检查的整文件覆盖已消除，详见下方续接记录；后续集中处理 app 的实际接入边界。
3. 对 `app.js` 按具体边界迁移，每次完成一个功能族并比较产物。优先梳理平台接入和导出委托；缓存/计数等性能逻辑必须保留正确性验证，不能为缩小 diff 删除现有能力。
4. 将关键行为测试接到最终候选目录，补资源引用完整性和真实相邻版本验证。现有 verify-dist 的资源清单/哈希检查不是所有动态引用的完整证明。
5. 上述证据齐全后再讨论阶段六的正式入口切换及根目录定制文件退役。本轮不删除 resolver 或放宽同步门禁。

回退本轮只涉及构建脚本、锁文件和文档；旧命令持续可用，无数据库迁移，无需用户恢复数据。未推送或发布。原有未跟踪 `docs/ANDROID-UPDATE-FLOW.md` 不纳入提交。

## 续接：消除更新检查整文件覆盖（2026-09-12）

起点 `3880d1c`。`patchAndroidUpdateCheck` 从原来的文件编辑回调抽出，旧 reapply 和候选构建共用一个实现。未修改生产 `update-check.js`，未把它新增到旧 auto-resolver manifest；当前正式 Git 冲突覆盖范围不变。

候选构建不再从本地整文件生成更新检查，recipe 移除该文件的双摘要覆盖。更新通知接入必须是唯一的原始块或完整的已应用块；重复、混合、半应用、事件名漂移均拒绝。无关上游增量在纯变换中保留；最终候选仍执行同版本基线比较，不据此宣称独立支持新版本自动同步。

`test:compose` 额外执行生成后的完整更新脚本（模拟 Vue 生命周期、网络响应和平台能力）：浏览器及无 adapter 环境各通知一次，Android 不发网页更新通知，重复轮询不重复通知，卸载清理监听和计时器。生成字节、幂等、缺失/重复/部分变换负例及上游附加内容保留均通过。两次候选摘要与首个切片一致。同步全套检查通过，重放零修改。

本轮无需新增真机验收：原生代码和运行时产物未变化。后续候选接入 APK 打包或调整运行时行为时再由用户验收。本轮按用户要求主线程复核，无子代理；未推送或发布。

## 返回键逻辑迁出（2026-09-12）

从 `app.js` 迁出返回键面板关闭策略到自有 `app-back-navigation.js`，保留事件发生时读取状态的 11 行绑定，净减少上游 app 中 66 行本地代码。优先级、不可关闭弹窗、Escape 派发和侧栏回退保持旧行为。加载入口通过 index overlay 重放。

`patchAndroidApp` 现在可对真实纯上游 1.9.3 补齐返回键绑定、注册和清理。旧内联代码迁移须匹配已审查摘要；缺失或重复锚点拒绝处理。原有初始化和清理锚点在纯上游存在多个同名调用，已加生命周期上下文定位。

测试直接执行当前 app 绑定和新模块，与提交 `6d66da9` 的旧实现逐一比较单面板、两面板同时打开、不可关闭面板、下拉框和侧栏状态；另覆盖真实上游重放幂等与漂移拒绝。历史合并产物比较保留，只在比较前应用这次明确的迁移。

仍有 app 整文件覆盖债务，尚未切换正式构建或自动同步架构；此次仅减少返回键这部分的上游侵入。按用户要求不使用子代理，由主线程审查。真机返回手势尚未复测，适合下次 debug 包一起验证弹窗关闭、下拉框关闭、侧栏关闭和无面板时打开侧栏。

## 时间线计数迁出（2026-09-12）

将分支已有的 `timelineCharCountCache` 迁至 `text-metrics.js`，上游 app 仅留一行绑定，净减少 11 行。计数仍等同上游 `Array.from(String(text || '')).length`，使用迭代计数避免完整字符数组。缓存保留 600 条上限，另限制键文本总长为 512 Ki UTF-16 单元；超大单条不缓存。此为引用文本量上限，不是 JS 堆峰值承诺。

已验证真实 1.9.3 上游/旧本地实现重放、幂等、Unicode 与异常代理项一致性、缓存总量和超大文本旁路；同步全套、性能测试、构建与候选构建通过。主线程审查完成，未做真机测试。app 整文件覆盖仍待其他适配迁移完成后移除。

## 返回键真机回退修复（2026-09-12）

用户真机验收发现所有界面返回都最小化。设备日志确认 `ReferenceError: showInstructionPanel is not defined`：上游已删除该状态，旧内联代码在执行到临时面板分支时才读取它，迁移后构造参数对象提前读取，扩大成每次返回都失败。此前对照测试人为创建全部旧状态，掩盖了缺失绑定，因此仅凭该测试通过不能证明真机行为完整。

修复从绑定和模块删除失效状态，保留其他面板优先级，并兼容首版错误绑定的重放升级。测试先检查当前 app 声明，再构造状态；加入旧失效名称的负例。旧实现行为对照明确排除已删除面板，不再伪造其存在。

修复验证：同步全套和候选构建通过；修复 debug APK 已安装。ADB 返回事件后 Activity 仍为前台，当前进程日志收到 backButton 且未再出现失效状态异常。具体各弹窗手势仍需用户验收。

## 聊天导出流迁出（2026-09-12）

将本地楼层/消息计数与逐消息 JSONL 序列化迁到 `chat-export-streaming.js`，app 保留两处模块调用，净减少 30 行。角色选择、分支读取、数据库兼容回退及成功/取消/失败提示仍留在上游流程中。现有逐消息 clone 与流式保存语义不变；没有增加新的性能策略，也不声称全局一致性快照或单大字段恒定内存。

新增纯变换可从真实上游 1.9.3 重建这一整个导出函数，也能升级旧内联实现；仅替换局部接入，不存储整个上游函数。旧内联块迁移须匹配摘要，锚点缺失/重复/漂移时拒绝，重放幂等。

测试执行当前 app 导出函数和自有模块，对照迁移前实现，覆盖当前/其他角色、全部分支、旧索引回退、空记录、缺失角色、取消和失败，以及 10000 条消息输出字节一致性。同步全套、平台测试、网页构建、两次候选构建通过（48 个文件逐字节一致，index 仅已登记 EOL 差异）。主线程审查通过，未做新一轮真机导出测试。整份 app 的过渡覆盖尚未移除。

## 普通文件导出接入重建（2026-09-12）

新增 `patchAppFileExport`，为 downloadJsonFile、角色 JSON/PNG 和批量 confirmExport 登记局部保存边界替换。数据组装、未知字段、PNG 元数据生成及成功提示仍保留上游流程，保存统一使用现有 saveGeneratedFile。纯上游 1.9.3 重建出的四个函数与当前代码相同，当前版本重放零改动；未产生新的网页源码差异或运行时行为变化。

测试实际执行 app 导出函数，检查保存尚未完成时不提前报成功，以及成功/取消/失败、预设排序、正则/世界书/UI 模板字段映射、角色 JSON 字段和 PNG 字节。边界缺失、重复和保存逻辑漂移拒绝；函数之外的上游增量保留。该变换复用于日常重放，供后续移除 app 整文件覆盖使用。

## 导入与生命周期接入重建（2026-09-12）

新增纯变换重建聊天 JSONL 分派和现有 importer 工厂、离屏 iframe attach/detach；把备份注册闭包抽为共享 patchBackupApp，日常重放与纯上游输入共用。当前源码重放零改动，未改变运行时文件。导入替换前检查真实 1.9.3 原始 JSONL 分支摘要，上游导入语义发生变化时要求审查模块兼容性，不能静默覆盖。

验证覆盖原版重建、当前幂等、无关上游增量保留、失效/重复边界拒绝、当前 app 的导入错误反馈及备份刷新调用顺序。平台测试通过。串联已登记 app 变换后，对照当前文件（仅比较时规范化换行）的残余差异为 42 行增加/15 行删除，主要为文风过滤缓存、countOnly 调用、初始化代码位置和历史空行；尚未据此删除整文件覆盖。

## 完整 app 重建与覆盖移除（2026-09-12）

`compose/app-transform.mjs` 串联已有业务接入，recipe 的 legacyOverrides 已清空。所有候选网页源码由锁定上游和登记自有文件生成；根目录 app 仅参与对照，不再作为构建覆盖输入。正式构建与同步尚未切换，旧分支仍保留适配后的上游文件。

文风过滤的上游算法完整保留，缓存策略迁至 text-filter-cache.js；日志和 collect 调用直接执行算法，避免缓存命中漏收集片段。计数快捷路径可重建；初始化接入的插入顺序与当前代码一致；仅清除五个有明确上下文的历史空行，不进行全局格式化。app 本轮净减少 21 行。

完整 app 文本重建相同。重建时导入工厂的 24 个换行从历史 LF 变为 CRLF，因此登记 app 的 EOL-only 比较例外；任何非换行差异仍拒绝。原版快照逐字节保留。两次候选构建输出一致，50 个产物中 48 个逐字节一致、index/app 两个仅 EOL 差异。同步全套、平台测试和缓存对照通过。主线程审查完成，尚未进行本次缓存迁移的真机验收。

下一步为阶段四：把关键行为测试直接接到候选 dist，补齐候选 APK 验收与新上游兼容检查。随后阶段六才切换正式流程；不把本轮结果等同于新版本自动同步已完成。

## 候选产物行为检查（2026-09-13）

阶段四新增 `npm run verify:candidate -- --run-dir .work/compose/run-<id>`，必须明确指定构建目录。先核对 verified-candidate 报告与 dist 的完整文件列表及 SHA，再将十组现有行为测试的网页输入切换到该 dist；完成后再次核对产物未变化。结果写入独立 behavior-report.json，记录产物 SHA、测试入口及读取助手/执行器 SHA，不修改原构建报告。单独运行原测试仍默认读取仓库文件。

覆盖 app 返回导航、过滤缓存、生命周期接入、角色导出、聊天导入导出、流式 IO、平台文件接口和备份往返。test:compose 已包含候选行为检查，同时通过损坏缓存模块、缺失目录、产物与构建报告不符三个负例证明不会回退读取仓库代码。两次全新构建仍为 48 个文件字节一致、2 个仅换行不同。

这些是 Node/VM 和模拟平台服务检查，尚不能证明整页挂载、脚本加载顺序或原生桥在真机可用；历史 Git fixture 仍是锁定版本的对照证据，不代表任意新版本兼容。正式构建/同步未切换。本轮未改变网页或 Android 运行时代码，无需新增真机验收；下一步检查候选完整入口与候选 APK，再推进正式流程切换。按用户要求主线程复核，不使用子代理。

## 候选整页离线启动（2026-09-13）

新增可选命令 `npm run verify:candidate:browser -- --run-dir .work/compose/run-<id> --browser "浏览器可执行文件绝对路径"`。需要本机 Chrome/Edge 和支持 WebSocket 的 Node（本次为 Node 24）；不自动下载浏览器，也不加入无需浏览器的常规测试。先通过候选哈希与十组行为检查，再使用独立临时配置和回环 HTTP 服务启动无头浏览器。测试只提供报告登记的候选文件，拦截页面的外部请求。

依次检查三个完整入口的实际 URL、文档加载完成、Vue 挂载、非空界面、开屏遮罩退出、启动异常和本地资源 HTTP 错误；保存 412×915 视口截图及独立 browser-*/report.json，关联产物哈希、执行器哈希和浏览器版本。结束后再次核对 dist 哈希并关闭测试浏览器及服务。

本地实测三个入口通过，并查看截图确认公告、角色编辑和小说页面实际显示。故意把副本 index 的 app 脚本地址改为不存在的路径，同时更新该副本的测试报告哈希：原十组行为检查仍通过，但整页检查因 Vue 未挂载返回失败，证明新增检查补上入口加载缺口。该负例仅位于忽略的临时目录。检查后无对应测试浏览器进程残留。

本轮不修改运行时代码或正式构建流程，主线程复核通过。验证范围是新浏览器存储下的离线启动，不涵盖已有用户数据、远程服务功能、复杂交互或 Android 原生桥。下一步仍是候选 APK 接入及验收，然后切换正式同步；不将浏览器启动通过等同于真机验收。

## 候选 debug APK 接入（2026-09-13）

`build-android-debug.ps1 -CandidateRun .work/compose/run-<id>` 显式选择候选；不传参数仍执行原有 android:sync。候选先运行哈希与行为门禁，在临时 Capacitor CLI 项目中指定候选 webDir 和现有 Android 工程，依赖从父仓库解析。同步后逐文件核对 Android public 目录，再使用原 Gradle debug 构建。根目录 dist 和 Capacitor 配置不被替换；生成的原生配置移除临时路由字段，保留仓库运行时配置。

候选 APK 保存至该候选的 android-debug 目录。verify-candidate-apk.ps1 检查包内全部候选网页文件的 SHA，拒绝缺失、变化、额外、重复或大小写不符的路径，仅允许 Capacitor 生成的两个 Cordova 文件额外存在。成功证明记录 APK SHA 和候选输出 SHA；失败重查会使旧成功记录失效。相应 ZIP 正反例已接入 Android 构建脚本测试。

本地实际构建通过，APK 19,552,600 字节，SHA-256 为 `393875264da38b552430ade46b0209efd12c93693344082ef2cce6bcdf963aba`，包内 50 个候选网页文件完全一致。已覆盖安装到连接的 Debug 应用并确认 Activity/界面可见，未操作用户正在编辑的数据；近期所查进程日志未见 Capacitor/AndroidRuntime 错误。这只证明安装和基础呈现，返回、长聊天、嵌入页面及文件操作仍待用户验收。

本轮主线程复核构建分支、候选边界和 APK 比对，保留工作区另有的 build-and-install.ps1 修改及其测试，不混入此提交。正式发布/同步入口未切换。后续验收通过后推进阶段六：让正式构建和同步采用组合产物，而不是长期维持两个入口。

## 去除旧源码构建依赖（2026-09-13）

用户已反馈候选包真机交互未发现问题，同时提出每次导入都手动保存 recovery 过于繁琐，后续单独调整导入保护方式。

新增 `npm run build:candidate:independent`。该模式只读取锁定上游、登记变换、自有文件和构建依赖，不读取根目录的上游文件或旧 dist；禁止整文件 legacy override。原候选命令保留严格对照，供迁移核对使用。报告明确标记 independent 和 not-compared，不把未执行的旧源码对照写成通过。独立模式仅发布登记输入，根目录未登记的修改不会自动进入产物。

test:compose 在隔离 Git 副本中移除全部非自有网页源码，并确认没有 dist，独立构建仍生成与对照构建相同的产物哈希，十组候选行为检查通过；原对照模式在该副本中按预期失败。复制注册自有文件的原始字节，避免 Git checkout 的 CRLF 转换伪造输入差异。主工作区和正式入口不变。

这使后续更新可以直接组合新上游，但现有锁仍为 1.9.3，尚未宣称新版本兼容或完成正式同步切换。

## 自动保留一份导入前备份（2026-09-13）

按用户反馈，聊天导入与整体备份导入不再要求另选 recovery 保存位置。新增自有 recovery-store.js，将 V5 恢复快照按不超过 256 KiB 的字节块保存在独立 IndexedDB；只保留最近一份完整快照。新快照完整写入后，在同一事务中切换元数据并删除旧快照。失败暂存块会清理，下次保存前也清理异常中断残留。Web Locks 串行化保存与导出，避免导出中途被替换。

恢复数据库不在整体备份/恢复的白名单中，因此不会递归备份自己，也不会被整体恢复覆盖。整体导入先完整校验文件，坏文件不替换原恢复快照；本地保存失败仍在写入业务数据前中止。用户需要恢复时，可在本地控制中心选择“导出恢复备份”，再按原 V5 格式导入。按用户后续要求不提供手动清理入口。

保留策略限制的是份数，不是强行截断单份大小。正常保留一份，替换期间最多需要新旧两份完整快照的存储空间；整体备份不会常驻内存，但原有单条超大 JSON 字段的序列化开销仍存在。清除应用数据/卸载会删除内部恢复快照，手动导出仍使用用户选择的位置。

验证：上游同步/幂等、平台、备份 V5 互通、大文件与独立组合构建检查通过；真实浏览器验证跨块 UTF-8、一份保留、失败流清理和最终提交事务中止时旧快照不丢失。备份策略测试确认导入不调用文件保存接口、无效输入不替换恢复、可选导出取消不误报成功。主线程完成复核，无子代理。

## 本地 dist 替换与来源凭据（2026-09-13）

新增 `node scripts/compose/publish-candidate.mjs --run-dir <候选目录>`，把已验证候选提升为本地 dist。它先执行候选行为检查、核对复制后的全部文件和当前输入，再将旧 dist 移入该候选的临时目录，最后替换输出和写入 `.work/compose/published.json` 来源凭据。替换或凭据提交失败时恢复旧输出；旧文件保留在该次隔离目录供排查。

`node scripts/compose/verify-published.mjs` 按来源凭据核对完整文件集合/哈希、行为检查对应的产物、上游锁、recipe、依赖锁、登记自有文件及构建输入，不再依靠根目录旧上游源码。自有文件已经改变时，旧候选会在替换 dist 前被拒绝。

test:compose 在没有旧网页源码的隔离副本中完成提升与校验，并模拟最终凭据写入失败验证旧 dist 恢复；新增本地输入变化的拒绝测试。主工作区 dist 保持原样。此命令尚未接到默认 build:web：旧同步流程尚未维护组合锁文件，必须与同步来源一起切换，避免新发布版本号配上旧锁定网页。主线程复核通过，无子代理。

## 工作流同步来源与锁绑定（2026-09-13）

版本准备步骤先获取本次上游标签（不强制覆盖同名标签），再调用 `scripts/compose/pin-upstream.mjs <tag> <resolved SHA>`。脚本验证标签实际指向同步阶段选中的提交，才更新 upstream.lock.json，并保留原换行格式。随后原有版本准备脚本更新 Android 元数据。提交不符时锁文件不变；工作流后续提交会一并包含更新后的锁。

组合产物提升/校验同时检查 package.json 的上游基础版本与锁一致，允许 1–99 的 Android 修订号，避免把旧候选提升为不同基础版本的 dist。构建锁支持上游带 v 前缀的稳定标签。隔离测试使用真实 1.9.2/1.9.3 标签验证更新、错误提交拒绝、dry-run 无写入和版本匹配；工作流检查验证执行顺序。

当前锁没有改变，仍为 1.9.3。本轮只修改本地工作流代码，没有触发远端同步/发布。默认 build:web 和独立运行的旧 sync-upstream CLI 仍需在下一步一起衔接组合入口。主线程复核通过，无子代理。

## 默认构建与本地同步接通（2026-09-13）

`npm run build:web` 改为 `scripts/compose/build-dist.mjs`：先物化锁定上游 tag，再以 `--official` 模式在 `.work/compose/run-*` 组合候选，跑十组候选行为检查，原子提升为 `dist` 并写入来源凭据；任一步失败都不改动旧 `dist`。`npm run verify:dist` 改为按凭据核对 `dist` 的 `verify-published.mjs`。旧脚本保留为 `build:web:legacy` 与 `verify:dist:legacy`，仍可单独运行，不构成第二套发布路径。

注意影响范围：发布工作流 `sync-upstream.yml` 已经调用 `npm run build:web`，因此默认命令切换同样改变了发布构建的产物来源（发布 APK 现在也来自组合产物）。本轮**只切换了构建来源**；Git 合并式同步机制（`sync-upstream` 的 merge/auto-resolver/reapply、`sync-upstream.yml` 的合并步骤）尚未切换，自动同步入口与 Android release 打包入口仍未改。准确表述应是“构建来源已切换，Git 合并同步机制仍未切换”。

新增 `scripts/compose/ensure-lock-tag.mjs`：检查锁定 tag 是否已指向锁定提交，缺失时只从锁定仓库抓取该 tag 并校验提交，绝不查询 latest、不回写锁。`validate.yml` 在“Fetch upstream refs”之后、各测试之前增加一个专用步骤执行该脚本（组合构建需要本地 Git 对象）；`build:web` 内部也会再执行一次，CI 端的重复调用为幂等冗余。独立 `sync-upstream` CLI 在完整运行（包括 dry-run，不包括 `--prepare-only`）时，先抓取本次 release tag、`pinUpstream` 绑定锁、再应用 Android 版本元数据，随后才运行 `build:web`；“默认版本号配旧锁定网页”的约束因此成立。工作流的 pin/version 步骤保持不变，`--prepare-only` 路径不触发新逻辑。

验证：`test:compose` 新增默认入口断言，并在无旧网页源码的隔离副本中实跑 `build-dist.mjs`，产物哈希与既有一致；同步全套、平台测试、`build:web`、`verify:dist` 通过；正式 `dist` 由组合流程生成并有来源凭据。默认构建现依赖 `.git` 与本地锁定 tag，因此不再支持无 Git 的 ZIP 直接构建 Web 版（Web 产物仅供开发测试，正式交付为 APK）。Git 合并式同步仍保留，真实新版本迁移回放留待阶段四/六。主线程复核通过，无子代理。

## GLM-5.3 复审收口（2026-09-13）

独立只读复审（GLM-5.3）给出 PASS，并指出四项应修问题；本轮逐条处理：

1. **整文件覆盖禁令写反**：`build-candidate.mjs` 原仅禁止非 exclusive 模式使用 `legacyOverrides`，正式构建反而允许。改为**任何模式**发现 `recipe.legacyOverrides` 非空即拒绝（“Full-file legacy overrides are retired”），杜绝静默退回整文件补丁。当前列表为空，产物不变。
2. **dry-run 验证的是旧版本**：原实现 dry-run 跳过绑锁，却仍运行组合构建，验证的其实是旧锁定版本，且正常同步失败时新锁/版本元数据无回滚。新增 `scripts/upstream-sync/release-inputs.mjs`（`snapshotReleaseInputs`/`restoreReleaseInputs`，覆盖 `upstream.lock.json`、`package.json`、`package-lock.json`、`README.md`、`android/app/build.gradle`、`scripts/android/build-android-release.ps1`）；`sync-upstream` 统一走 `validateReleaseInputs`：先绑锁并应用版本再验证，**dry-run 成功即恢复**（真正只读且真正预览新版本），**任何失败也恢复**，正常成功则保留供提交。新增 `tests/release-inputs.mjs` 覆盖快照/恢复、缺失文件移除与接线断言。
3. **标签获取不应强制覆盖**：`ensure-lock-tag.mjs` 原对已有不符标签执行强制 fetch，会在校验前移动标签。改为：已有标签指向锁定提交则 no-op；**已存在但不符直接报错并拒绝覆盖**；仅标签缺失时才抓取并校验提交。
4. **文档低估切换范围**：补注——`sync-upstream.yml` 已调用 `npm run build:web`，默认命令切换同样改变了发布 APK 的产物来源；准确表述为“构建来源已切换，Git 合并同步机制仍未切换”。同时把 `docs/ANDROID-UPDATE-FLOW.md` 标为历史快照，指明行号/流程可能已变化。

CI 与健壮性：`validate.yml` 在构建之后新增 `npm run test:compose`（先修正该测试对未入库的根 `assets/generated/main.css` 的依赖，并在隔离克隆内自取 `1.9.2`/`1.9.3` 上游 tag，保证干净检出可跑）；`publish-candidate.mjs` 对提升用的 rename 增加仅针对瞬时占用错误（`EPERM`/`EACCES`/`EBUSY`/`ENOTEMPTY`）的有限退避重试，保留失败回滚、不吞异常、不重跑构建。

验证：`test:compose`（含标签不符拒绝、rename 重试接线、隔离克隆取 tag）与同步全套（含新 `release-inputs`）通过；`test:platform`、`test:performance`、`test:syntax`、`build:web`、`verify:dist` 全通过；`git diff --check` 干净。该记录为复审时状态；发布构建来源已切换，真实新版本迁移回放留待阶段四/六。

## 阶段三验收收口（2026-09-13）

阶段三的锁定原版输入、登记变换、自有模块复制、独立构建与同版本等价验证已完成；默认 build:web 同时完成了阶段六的一部分入口切换。移除标签获取残留的 --force，使用完整 refs/tags 引用；组合测试显式预留运行目录，避免并行测试新增目录导致误报。

本轮运行 build:web、verify:dist、test:compose、test:upstream-sync、test:platform；主线程审查，无子代理。网页产物仍为 51 文件，SHA-256 为 8c5291e14a9053fc819fe5b4b12cb83fd7c10dcf0ddbc2a5b0c7557c46f76e12，与之前自动恢复备份候选一致，无新增真机测试要求。

阶段四/六仍需真实相邻稳定版本迁移验收，以及从 Git 合并网页源码切换同步机制。当前 release-inputs 测试证明元数据快照恢复及调用接线，并不等同于完整 sync dry-run 的端到端验收；本轮未触发远端发布。

## 阶段四：隔离回放与发布级兼容门禁（2026-09-14）

**问题：** 行为门禁的五个套件此前把上游对照硬编码为 1.9.3 提交 `4aef0bb`（`git show 4aef0bb:assets/js/app.js`）。这让门禁结构上只能接受一个版本：回放相邻 1.9.4 时，即便组合完全正确（`composeApp(1.9.4 上游) === 1.9.4 候选`、幂等）也会因对照陈旧而失败。先修门禁，才能做真实相邻版本验收。

**隔离回放（`npm run verify:adjacent -- --tag <稳定版本>`）：** 在 `.work/compose/adjacent/<tag>-*/repo` 建一次性 clone，只在该 clone 内把 `upstream.lock.json` 重定向到目标稳定 tag（缺失时按需 fetch），复制 `scripts/` 与登记自有文件、链接 `node_modules`，依次运行 `build-candidate --independent` 与候选行为门禁。全程不动主仓锁、`dist/`、tag；`finally` 中重新核对主仓锁字节与 `dist` 摘要，一旦被改写即强制失败。报告写入 `.work/compose/adjacent-report.json`，含 `stage`（prepare/composition/behavior/browser/android-apk/verified）、`capabilities`、逐套件结果与 `sourceLockUnchanged`/`sourceDistUnchanged`。

**版本自适应对照：** `scripts/tests/web-fixture.mjs` 新增 `readUpstreamSource`，以 `RPHUB_TEST_UPSTREAM_SHA`（完整 40 位十六进制，非法即 fail-closed）为对照提交，缺省回退仓库锁；`check-candidate.mjs` 将候选自身上游提交（来自已验证的构建报告）注入每个行为套件，故对照始终等于候选来源。五个套件改用它，历史 legacy oracle（`4afa9a5`/`6d66da9`/`2780a81`）保持钉死。无 env 覆盖时对 1.9.3 逐字节等价。

**可选档位：** `--browser <路径>` 复用 `check-browser.mjs`，对候选跑三个整页离线启动（Vue 挂载、开屏退出、无启动异常/资源错误）并做恢复快照真实 IndexedDB 检查；`--android-apk` 经 `sync-candidate-android.mjs` 同步候选到 Android，再以 `build-android-debug.ps1 -CandidateRun` 打包并用 `verify-candidate-apk.ps1` 逐文件核对包内 `assets/public/*` 的 SHA、拒绝缺失/多余/重复项。必需档位为 `composition`+`behavior`；`browser`/`android-apk` 通过后才记入 `capabilities`，因此不会出现“未跑却报通过”。

**Windows 管道挂起修复：** Gradle 守护进程会继承构建子进程的 stdout 句柄，用管道捕获其输出永远等不到 EOF（表现为构建已完成却挂起）。Android 档改用 `runStreamedToFile`：输出重定向到日志文件，按**直接子进程**的 `exit` 事件收尾，与 `build-and-install.ps1` 的 `Invoke-Native` 同一契约；超时先置标志再 kill，避免误判成功。

**兼容失败门禁（`npm run test:compat`，已接入 `validate.yml`）：** 用 git plumbing（`read-tree`/`write-tree`/`commit-tree`/`hash-object` + `GIT_INDEX_FILE`，不改工作树）从锁定树合成不兼容上游，覆盖：缺失锚点、重复锚点、语义漂移、未登记的新上游路径——断言均在 `composition` 阶段 fail-closed 且诊断可读；另将被投毒的自有模块（`text-filter-cache.js`）断言 `behavior` 阶段隔离。每个用例都验证源仓锁与 `dist` 未被改写。

**证据：** 相邻 1.9.4（`d312bd4b2798dad3f30307afdbd704aac1f80f1a`）本机通过四档全门禁——组合、10/10 行为、整页浏览器（三入口）、候选 APK（包内 51 文件一致，APK SHA `43e86d7f…`）；候选产物 SHA `bc8bb7ec…`，dist 内嵌公告为 `RP-Hub 1.9.4`，确认来自新上游。`test:compat` 6 个 fail-closed 用例通过；`test:compose`、`test:platform`、`test:upstream-sync`、`test:performance` 全通过。**主仓锁仍为 1.9.3、tag 未动、`dist` 未变。** 两步分别经独立只读复审（GLM-5.3）PASS，可选加固已回。

**边界：** 隔离回放只证明该版本可组合且过门禁，不等于已切换锁、发布或完成真机验收；1.9.4 的锁升级、发布与真机验收均未执行，留待阶段六。

### GPT 复审修正（2026-09-14）

独立复审（GPT）在阶段四上给出三项必修，全部实证成立并已修：

1. **CI 缺 Git 身份会失败（P1）：** `test:compat` 的 `commit-tree` 依赖开发机全局 `user.name/email`，禁用全局配置后复现 `Author identity unknown`，干净 CI 必挂。改为在 `commit-tree` 的命令环境注入测试专用 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`，不读全局配置；以 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` 指向真空配置复跑通过。
2. **负例可能验证旧代码（P2）：** `test:compat` 只 clone 已提交 HEAD，未带入本批未提交的 `scripts/` 与登记自有文件，因此部分负例实际用的是上一提交的构建/行为脚本。改为在合成源与行为源 clone 后覆盖复制当前 `scripts/` 与 `recipe.localFiles`，与 `runAdjacentReplay` 的复制保持一致，“改完即测”确实测本次代码。
3. **“语义漂移”其实只测了空格（P3）：** 原用例在 `=` 后加空格，只是让锚点找不到，并非“锚点不变、语义变化”。换成两个真正的语义漂移：`api-utils.js` 的 `setInterval(flush, 60)→100`（函数声明锚点不变、60 ms 固定刷新契约改变）与 `app.js` 的 count-only 调用 `includeSystem: false→true`（调用点文本锚点不变、契约改变），断言命中各自的行为校验失败信息。

**另发现并修复（比 P3 更严重）：** 测试的 `git()` 辅助固定 `stdio[0]='ignore'`，导致 `hash-object --stdin` 从未收到合成内容，**每个合成文件都是空 blob**——此前 6 个负例其实是以空文件通过，属于“为错误的原因通过”。改为按需为 `hash-object` 打开 stdin 管道，并在写入后断言 blob 与预期内容 round-trip 一致，杜绝再次退化为空文件。修正后各负例诊断具体化（如 `Expected 1 stable 1.9.3 retry wrapper, found 0`），用例数 6→7。

**复验：** `test:compat` 7 用例通过（含全局 Git 配置被隔离、`GIT_CONFIG_GLOBAL` 指向真空文件两种环境）；`test:compose`、`test:platform`、`test:upstream-sync`、`test:performance` 全通过；1.9.4 隔离回放仍 PASS；主仓锁仍 1.9.3、tag 与 `dist` 未动。

二次独立复审（GLM-5.3）指出两处仍可能“空洞通过”，已修：

- **行为阶段用例可能为基础设施崩溃放行：** 原断言只看 `stage==='behavior'` 与 `behaviorStatus==='failed'`；若 `check-candidate` 在跑测试前崩溃，也会写出 `status:'failed'`、`tests:[]` 的报告。改为额外要求错误匹配 `/Adjacent behavior gate failed: /` 且存在被判失败的套件。实测：人为在测试循环前注入崩溃 → 断言拒绝（`tests:0`）；真实行为失败 → 通过。
- **源仓 `dist` 保留检查为空比较：** `dist/` 被 git 忽略，全新 clone 没有它，`digest` 两边都是 `null`。改为在每个源 clone 预置 `dist/index.html` 哨兵，使“回放不得改写源仓 dist”真正生效。另把 `scripts/` 覆盖复制改为先删后拷（避免工作树删除的文件残留在合成仓），并为合成源补 `node_modules` 链接。

**待提交提示：** `scripts/compose/adjacent-replay.mjs`、`verify-adjacent.mjs`、`scripts/compose/tests/` 仍为未跟踪；`validate.yml` 已引用 `test:compat`，故这批文件必须随本次提交一并纳入，否则 CI 会因脚本缺失而失败（fail-closed，但会阻塞）。
