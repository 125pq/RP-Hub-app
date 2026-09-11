# 平台能力契约（安卓本地化切片汇总)

版本：v1｜编制日期：2026-09-10｜对应阶段：阶段 1（收拢平台接口）

本文档固定安卓本地化能力的**平台层契约**与**应用层接入点**，对标 LONG-TERM-ANDROID-ARCHITECTURE-PLAN.md §4.1。原生文件保存单链路的完整契约见同目录 `file-save-contract.md`。这些能力是**既有实现**的本阶段登记与测试补强，非新功能。

## 分层原则

平台层（`platform-services.js` facade + `rphub-android-adapter.js`）只负责设备能力；应用层（app.js 等）业务决策。业务不直接触碰原生插件，差异收敛在 facade 之后。

| 切片 | 平台层契约 | 应用层接入 | 已验证行为 | 证据 |
| --- | --- | --- | --- | --- |
| **原生保存** | `NativeFile.beginSave/appendChunk/finishSave/cancelSave`；单次锁、chunk 顺序、写失败关闭清场 | `RPHubCardUtils.saveGeneratedFile`(薄接入，唯一入口） | 分块写、取消返回 cancelled、写失败 cancelSave 兜底、FSA 真流式/聚合 fallback | file-save-contract.md |
| **返回键** | `onBackButton(handler)->unregister fn`；未 handler 则 minimize | app.js `removePlatformBackListener`（由 patch-android-hooks 注入），面板优先级关闭 | handler 取消(不 minimize)、未处理→minimize、注销清理监听器 | test-platform 231-238 |
| **生命周期** | `onAppStateChange(handler)->unregister fn`;active/background | app.js visibility/后台检测 | active/background 转换、注销后不再触发 | test-platform 78-81, 243-247 |
| **保存前刷写** | `RPHubBackupBridge.register/unregister/flush/flushEmbeddedFrame` | app.js 注册 character-frame / novel-frame；patch-backup 注入 | 全注册者被调、单项失败聚合抛出（不静默）、iframe ack(`ok!==false`)即 resolve、iframe 失败/发送错/超时 reject（不带脏快照）、frame 缺失立即 resolve、注销幂等 | test-backup-bridge.mjs 1-8 |
| **更新检查** | 原生 AppUpdate 插件；settlement(AtomicBoolean)、源切换中断 | update-check.js `RPHubUpdateCheck.useUpdateCheck` | settlement 一次性、源切换中断正确结算 | test-android-update-flow |

## 关键语义（跨切片通用）

- **错误不伪装为取消**：原生写失败/刷写单项失败 → 明确抛错（保存）或聚合 Error（刷写）,**绝不**返回 `{cancelled:true}`。
- **取消不显示成功**：用户取消（文件选择器/更新）→ `cancelled:true` 或 `AbortError`，业务层早退不 toast 成功。
- **监听器不重复**：返回键/生命周期/iframe 消息监听均为单注册+注销清理；重复初始化由 patch 侧 legacyDeclarations 兜底。
- **不静默跳过**：能力不可用时返回 `{supported:false}` 或保持既有浏览器路径，不静默丢失数据。

## 与上游接入关系

app.js 的 `removePlatformBackListener` / 刷写桥注册 / 更新检查均通过 `patch-android-hooks.mjs` / `patch-backup.mjs` overlay 注入，不改上游文件源码；`platform-services.js`/`rphub-android-adapter.js`/`rphub-backup.js` 为本地扩展模块。

## 阶段 1 状态

| 切片 | 状态 | 备注 |
| --- | --- | --- |
| 原生文件保存 | **本阶段完成** | 契约 file-save-contract.md + FSA 流式增强 + 5 场景测试 |
| 返回键 | **本阶段登记** | 已有实现+测试，本阶段补充契约文档 |
| 生命周期 | **本阶段登记** | 已有实现+测试 |
| 保存前刷写 | **本阶段完成** | 原仅 patch 测试，本阶段新增 test-backup-bridge.mjs 5 场景 |
| 更新检查 | **本阶段登记** | 原生 settlement 已测(test-android-update-flow)；浏览器端行为**待测** |

## 剩余待办（本阶段外）

- 更新检查浏览器端（非原生）`useUpdateCheck` 路径行为测试。
- 真机 WebView 各切片设备表现（阶段 4)。
