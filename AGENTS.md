# RP-Hub-app 协作约定

## 1. 项目性质（先读这一条）

这是 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 的 Android/Capacitor 封装分支。
**核心约束：尽量减少与上游的 diff。**

- 上游文件（`index.html`、`assets/`、`character/`、`novel/`）**不要直接手改**，
  改动必须走 `scripts/upstream-sync/patches/` 里的补丁钩子。
- **绝不**对整个文件做换行符归一化或空白重排。这会把 2 行逻辑改动放大成上千行 diff，
  并让上游合并变成冲突。`scripts/upstream-sync/tests/eol-churn-guard.mjs` 会拦这类改动。
- 上游文件与本地文件的边界见 `docs/UPSTREAM-VS-LOCAL.md`。
- 待办改进项见 `docs/IMPROVEMENT-BACKLOG.md`。

## 2. 常用命令

```bash
npm run build:web          # 构建 dist/
npm run verify:dist        # 校验构建产物
npm run test:syntax        # node --check 语法检查
npm run test:platform      # 平台适配层测试
npm run test:upstream-sync # 补丁与上游同步全套测试（最重要）
npm run test:performance   # 性能相关测试
npm run test:backup        # 备份导入导出往返测试
```

改了补丁或上游文件，**必须**跑 `npm run test:upstream-sync`。

## 3. 多模型委派工作流

### 前置条件

子代理能力由全局 feature flag 控制，已在 `~/.codex/config.toml` 开启：

```toml
[features]
multi_agent = true
multi_agent_v2 = true
```

**改动后必须重启 Codex 才生效。** 若在会话中发现无法派发子代理，先确认这两项仍为
`true` 且已重启。开启前的配置备份在 `~/.codex/config.toml.backup-before-multiagent-20260818`。

两个角色定义在仓库的 `.codex/config.toml` 里，指向 `~/.codex/agents/`：

- `worker` —— 干活的。读代码、搜索、写代码、修 Bug、跑测试。可读写、可执行命令。
- `reviewer` —— 把关的。只读。判断 correctness、regression、security、需求完成度、测试覆盖。

**两个角色文件都不写死模型名。** 主 Agent 在派发时指定当前 API 实际可用的模型：
Worker 用最便宜够用的，Reviewer 用最强推理的。换 API、换主模型都不需要改配置。

### 主 Agent 的职责边界

主 Agent 负责规划、拆分、关键决策、最终把关，**不负责大量阅读**。

1. 分析需求，拆成边界清晰的子任务，判定每个子任务的风险等级。
2. 优先派给 `worker`。派发时给出：明确的验收标准、要动的文件范围、要跑的检查命令。
3. 只读 Worker 返回的 `SUMMARY` / `KEY_DIFF` / `CHECKS`。
   **不要重新通读 Worker 已经处理过的文件**，那等于白花两遍 Token。
4. 按下面的风险分级决定是否叫 `reviewer`。
5. 循环最多 2 轮。第 2 轮仍未过，主 Agent 自己接管，不再往下传。

### 风险分级与是否 Review

**低风险 —— Worker 改完 build/test 全通过即可结束，不叫 Reviewer：**

- 文档、注释、字符串文案
- 单文件局部 Bug 修复，且已有测试覆盖
- 新增测试用例
- 版本号、CHANGELOG 之类的元数据同步

**中高风险 —— 必须叫 Reviewer：**

- 任何触及上游文件或 `scripts/upstream-sync/` 的改动
- Android 原生层（`android/app/src/main/java/`）
- 备份 / 导入导出 / 数据格式（`rphub-backup.js`、schema 相关）
- 发布流水线与签名（`.github/workflows/`、`scripts/android/`）
- 跨模块改动，或触及共享状态、错误处理、权限
- 涉及 EOL / 空白的任何操作

### 升级与终止规则

```
Worker 返回 NEEDS_DECISION  -> 主 Agent 立即决策，把决定写清后重新派发。不进 Review。
Worker 返回 BLOCKED         -> 主 Agent 接管诊断。不重试同一路径。
Reviewer 返回 PASS          -> 结束。
Reviewer 返回 REVISE        -> 把 REVISE 原文交回同一个 Worker，进入第 2 轮。
Reviewer 返回 ESCALATE      -> 主 Agent 直接接管，跳过剩余循环。
第 2 轮后仍非 PASS          -> 主 Agent 接管。禁止第 3 轮。
同一方案连续失败 2 次        -> 停止微调，换根本不同的思路，或回来问人。
```

循环上限是硬的。两个模型来回互推是这套流程唯一真正的失败模式。

### Token 分配原则

Worker 多干活、多读、多试；Reviewer 只看证据不重读；主 Agent 只做规划与判决。
如果发现主 Agent 在大段读文件，说明委派没做对。

## 4. 安全边界

- 不提交签名密钥。`.gitignore` 已覆盖 `*.keystore`、`*.jks`、`keystore.properties`。
- 不要 `git push`、建 tag / Release、`reset --hard`、`clean -f`，除非明确要求。
- 发 Android release 必须走 `sync-upstream.yml` 的 `workflow_dispatch`，不要本地手动 `gh release create`，否则 Gitee 更新源不会同步。
- 不要改 `.gitattributes` 的 `whitespace=cr-at-eol` 设置。
- 提交信息用 Conventional Commits（`fix(android):`、`chore(sync):` 等），与现有历史一致。
