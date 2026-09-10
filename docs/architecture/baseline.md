# 阶段 0 基线报告：可复现基线与检查证据

编制日期：2026-09-10｜对应阶段：阶段 0（建立可复现基线与差异台账）｜状态：进行中（本阶段未完成全部验收，见 §7）

本报告记录阶段 0 已核实的基线事实与检查证据。遵循三条原则：不虚构数据、不把拟议设计当事实、不动生产路径。差异明细见同目录 `adaptation-inventory.md`。

## 1. 基本信息（已核实）

| 项 | 值 | 核实方式 |
| --- | --- | --- |
| Git 根目录 | `C:\Users\1\Desktop\project\RP-Hub-app\RP-Hub-app` | 嵌套仓库根；外层同名目录非本仓库 |
| 执行分支 | `codex/long-term-android-plan` | `git status` |
| HEAD | `5b1fef44def24afd230637954d34db6ef4b234f3`（`docs(architecture): add phased Android evolution plan`） | `git rev-parse HEAD` |
| 上一稳定基线 | `3da39e9` `chore(sync): merge upstream RP-Hub release 1.9.3 (4aef0bb)` | `git log` |
| 上游稳定 tag | `1.9.3` | `git tag -l` |
| 上游完整 SHA | `4aef0bb46c9b3370faba174a20435e5989799727` | `git ls-remote upstream refs/tags/1.9.3`（在线核实，与本地 tag 一致） |
| 工作区状态 | **clean**（`nothing to commit, working tree clean`） | `git status`；编制时方案中提到的 `patch-android-hooks.mjs` 脏文件在本 HEAD 已不存在 |
| Node / npm | v24.14.0 / 11.9.0 | `node --version` / `npm --version` |
| 平台 | win32 | — |

注：阶段 0 开始时执行了 `git fetch upstream --tags`，其中 `1.8.8` tag 被远端拒绝（`would clobber existing tag`）。该 tag 与本阶段无关，未做处理（保持现状，不 clobber）。此现象仅说明本地与远端对该 tag 指向存在分歧，已记录待后续核实。

## 2. 构建产物状态（已核实）

| 项 | 事实 | 说明 |
| --- | --- | --- |
| `dist/` | 存在工作区，但 **未被 Git 跟踪**（`git ls-files dist` 报 `pathspec did not match`） | dist 为 `build:web` 生成的构建产物目录，非源码 |
| `verify:dist` | **失败**：`Source and dist content differ: assets/css/styles.css`（`scripts/web/verify-dist.mjs:261`） | 根因：dist 副本是旧构建，源文件已演进；属构建产物陈旧 |

**该失败已归因，不归因删除断言换绿。** 处理方式：记录为已知失败清单条目（§5），后续通过 `npm run build:web` 重建 dist 即可消除；本阶段不执行 `build:web`（会改写工作区产物，不属于只读核查范围，留待阶段 1 前置步骤）。

## 3. 存储身份清单（编制时快照，已核实项打勾）

> 依据 `docs/LONG-TERM-ANDROID-ARCHITECTURE-PLAN.md` §2.4 与 `capacitor.config.json`。以下清单非穷举，阶段 1 需扩展至全部页面与备份入口。

| 存储 | 名称 / 键 | 版本 | 状态 |
| --- | --- | --- | --- |
| Capacitor `appId` | `io.github.pq125.rphub` | — | 已核实（capacitor.config.json:2） |
| Capacitor `webDir` | `dist` | — | 已核实（capacitor.config.json:4） |
| 主 IndexedDB | `RPHubDB` / store `objectStore` | v1 | 待核实（依据方案书，未在本阶段直接读 DB） |
| 遗留 DB | `SillyTavernDB` | — | 待核实（遗留访问路径） |
| localStorage 前缀 | `rp_hub_` / `silly_tavern_` | — | 待核实 |
| 角色页 localforage | `AICharGen` / `characters` | — | 待核实 |
| WebView origin 实际值 | 涉及最终配置 + 设备 | — | **未在本阶段从最终配置与设备确认**（不得仅凭 appId 推断） |

## 4. 检查命令基线（实际执行结果）

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test:syntax` | PASS | 5 个文件 `node --check` 全过 |
| `npm run test:platform` | PASS | PlatformAdapter browser fallback/Android bridge/file chunks/cancellation/singleton、safe-area、build-scripts、download-bridge、update-flow 全 PASS |
| `npm run test:upstream-sync` | PASS | merge-regressions、preview-merge、chat-layout、mirror-square、EOL 系列、reapply 幂等（`REAPPLY_CHANGED_FILES=0`）、`test:backup` 全 PASS |
| `npm run test:backup` | PASS（随 upstream-sync 连带） | v5 header、array record、mirror restore、streaming export、UTF-8/emoji chunk boundary、bad file rejection、validate-only、v5 cross-compat 全 PASS |
| `npm run test:performance` | PASS | offscreen-iframe-lifecycle（ACTIVE/NEAR/OFFSCREEN）、1.9.3 streaming transport（identity overlay、60ms flush、tool calls、retry、reasoning、abort）全 PASS |
| `npm run build:web` | **未执行** | 会重建 dist；留待阶段 1 前置，避免本阶段改写产物 |
| `npm run verify:dist` | **失败**（见 §2） | 构建产物陈旧，非源码缺陷 |

阶段 0 结论：源码层面所有现有自动化检查（语法/平台/上游同步/备份/性能）全部通过；唯一失败是 dist 产物与源不同步，属已知且可修复的构建产物陈旧问题，不影响基线可用性。

## 5. 当前失败清单（已知问题，不回退、不放宽断言）

1. `verify:dist` — `assets/css/styles.css` source/dist 不一致。归因为 dist 陈旧。处理：阶段 1 开始前执行 `build:web` 重建 + 复跑 verify。
2. （无其他失败。）

## 6. 样本定义与阈值方案（骨架，待后续阶段填充）

遵循方案 §7 最小场景矩阵。本节为占位骨架，不声称已完成测量。**本阶段未做任何设备/性能实测，状态标记为「待测」。**

- **样本数据政策**：不使用真实私密聊天/令牌/密钥；全部用合成或脱敏数据，记录生成方式与随机种子（种子占位：`<TBD-phase1>`）。
- **大文件样本**：小（<1MB）/ 中（~10MB）/ 大（≥50MB）三级，含超长单条记录、截断、损坏用例。阈值：峰值内存、总耗时、取消完成时间（待阶段 1/2 设备实测）。
- **长聊天样本**：多会话、多分支、长单条、持续流式输出。关注计数/过滤一致性、首屏、切换、跳转、编辑（待阶段 5）。
- **复杂 UI 样本**：代码围栏、半标签、UI 更新块、图片、交互 iframe（待阶段 5）。
- **安卓流程样本**：保存/取消/权限失败、分享、返回键、键盘、安全区、前后台（待阶段 1 起逐项）。
- **测量预算**：每关键样本 ≥5 次重复取中位数与范围；样本不足不报 p95。预算在观测优化结果之前确定（防事后调阈值）。

## 7. 未完成验收项（阶段 0 未标「已完成」的原因）

- 差异台账的**逐行级** diff 归因（`app.js` 与上游差 413 行，仅完成归类与机制登记，未逐行拆解到函数级语义）。
- 存储身份清单中标记「待核实」的条目（需实机或读 DB）。
- WebView origin 实际值未从最终配置 + 设备确认。
- 大文件/长聊天/安卓流程样本仅定义骨架，未生成实物与实测。
- `1.8.8` tag 远端/本地分歧未核因。

## 8. 回退对象与下一阶段入口

- **回退对象**：本阶段**未改动任何代码与生产路径**，仅新增 2 个文档（见本次提交）。回退 = 删除 `docs/architecture/` 两个文件即可；无数据库、无存储、无 schema 变更，不涉及用户数据。
- **下一阶段（阶段 1）入口条件**：选定「原生文件保存链路」作为首个低耦合纵向切片；入口前先 `build:web` 消除 dist 陈旧，并核实 `NativeFilePlugin` 的 `beginSave/appendChunk/finishSave/cancelSave` 契约与 `platform-services.js` facade 的实际接点。入口是否满足：**满足（只读基线与证据均已具备）**，但 dist 重建与存储清单「待核实」项建议随阶段 1 起始一并补齐。
