# 原生文件保存链路契约（阶段 1 纵向切片）

版本：v1｜编制日期：2026-09-10｜对应阶段：阶段 1（收拢平台接口 · 文件保存链路）

本契约文档与实现同一任务完成（LONG-TERM-ANDROID-ARCHITECTURE-PLAN.md §4.1「接口文档与实现同一任务完成」）。规范保存链路的调用面、能力探测、错误/取消语义、生命周期与浏览器兼容路径。

## 1. 边界与单一调用面

业务层**唯一入口**:`window.RPHubCardUtils.saveGeneratedFile(data, filename, options)`(`assets/js/core-utils.js`)。平台差异被收拢在 platform facade 之后，上游业务不感知原生/浏览器分歧。调用点（app.js 等）只判 `result.cancelled` 决定是否显示成功，不接触原生插件。

分层：

```
业务 (app.js / rphub-backup.js / data-services.js)
  → RPHubCardUtils.saveGeneratedFile        (core-utils.js,薄接入器)
    → adapter.exportFile                     (platform-services.js,委托)
      ├─ AndroidAdapter                      (rphub-android-adapter.js,原生分块桥)
      │    → Capacitor NativeFile.beginSave / appendChunk / finishSave / cancelSave
      └─ BrowserAdapter.exportFile           (聚合 Blob → downloadBlob)
    → [非原生 + 流式] tryStreamViaFileSystemAccess  (core-utils.js,FSA 真流式,优先于聚合)
      └─ 失败回退聚合 downloadBlob
```

## 2. 三类实现路径与触发条件

| 路径 | 触发 | 流式? | 实现 |
| --- | --- | --- | --- |
| 原生分块桥 | `adapter.isNative()===true`（Android）且 任意 data（含流式） | 真分块（256KB UTF-8 文本 / 192KB base64 二进制，UTF-16 代理对不切半） | `rphub-android-adapter.js` → NativeFile 插件 |
| FSA 真流式 | 非原生，`data` 是 async iterator，且 `window.showSaveFilePicker` 存在 | 真流式（逐 chunk `writable.write`，TextEncoder 转 UTF-8） | `core-utils.tryStreamViaFileSystemAccess` |
| 聚合 fallback | 上两条都不满足 | 否（`parts.push` 聚合成单个 Blob） | `core-utils` → `downloadBlob`（`createObjectURL`+a 标签下载） |

`saveGeneratedFile` 的 dispatch 规则：原生优先（`:928` `!isChunkStream || adapter.isNative()`)；非原生的流式数据先 `tryStreamViaFileSystemAccess`(FSA)，返回 `null` 才聚合；非流式（string/Blob）数据非原生直接走聚合 downloadBlob。

## 3. 能力探测

新增 `adapter.supportsStreamingFileSave(): boolean`（挂在 frozen facade):
- `BrowserAdapter`:`typeof global.showSaveFilePicker === 'function'`（默认 web **false**，仅 Chromium 类 + 安全上下文为 true)。
- `AndroidAdapter`:`true`（原生分块桥天生流式，无需 FSA)。

用途：上层（如核心导出 UI）据此决定是否承诺「不聚合 / 有界内存」。当前实现不依赖该值做 dispatch(dispatch 直接探测 `showSaveFilePicker` 存在性），该探测供未来展示层与诊断使用。

## 4. 返回值契约

`saveGeneratedFile` 返回对象约定（所有分支一致）:

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `supported` | 平台是否支持本次保存 | `true`/`false`（仅当 `adapter.exportFile` 返回 `supported:false` 时上层抛「当前平台不支持文件保存」） |
| `cancelled` | 用户主动取消 | `true` → 调用方**必须**不显示成功 |
| `bytesWritten` | 已写字节数 | number（流式为 UTF-8 字节计长） |
| `chunkCount` | 原生分块数 | 仅原生路径返回 |

## 5. 错误与取消语义（按 PLAND §4.1 / §8)

- **错误不伪装为取消**：写出中途 `IOException`/权限失败 → 向上 `throw`，**绝不**包装成 `{cancelled:true}`。
- **不自动二次写入**:FSA 写失败不做静默聚合重发（避免重复写文件 / 数据不一致）。
- **尽力清理**:FSA 失败时 `writable.abort()` best-effort；原生失败时 `cancelSave` 兜底（已在 adapter `catch` 内，test-platform.mjs:284-288 覆盖）。
- **取消即取消**：用户在原生/ACTION_CREATE_DOCUMENT 或 FSA 选择器取消(`AbortError`)→ `{supported:true, cancelled:true}`，调用方早退不 toast 成功。
- **不重复保存**：原生侧 `saveReserved`/`session!=null` 锁，并发 `beginSave` 拒绝(`save_in_progress`)；FSA 每次新 `showSaveFilePicker`。

## 6. 生命周期

- **原生 SaveSession**:`beginSave` 创建 → `appendChunk` 严格按 `nextChunkIndex` 顺序（`chunk_out_of_order` 拒绝并关闭）→ `finishSave` flush+close+清场 / `cancelSave` close+清场（幂等，已清场返回 `cancelled:true`)。`handleOnDestroy` 兜底关闭流并 `shutdownNow`。
- **FSA Writable**:`createWritable` → 逐 chunk `write` → `close`（成功）或 `abort`（失败）。无后台会话，单次函数调用内完成。
- **监听器**：本链路不增加常驻监听器（导出是一次性操作）。

## 7. 浏览器兼容路径

| 环境 | 路径 | 内存特征 |
| --- | --- | --- |
| Android WebView（本项目实际运行环境） | 原生分块桥 | 有界（256KB/192KB 块） |
| 桌面 Chromium（开发/调试） | FSA 真流式 | 有界（不聚合） |
| 其他旧浏览器 / 无 FSA | 聚合 downloadBlob | **整段驻留**（既有行为，文档明示非回归） |

阶段 1 未改动旧浏览器的聚合行为——那是既有基线，消除它属阶段 2（大文件 IO 抽离）范围。本阶段仅承诺：支持 FSA 的桌面环境与原生 Android 不再整体聚合。

## 8. 验证证据

- `node scripts/tests/test-save-generated-file.mjs`:5 场景（原生 adapter 接管 / FSA 真流式顺序+UTF-8 计长 / FSA 取消→cancelled / 无 FSA 聚合 fallback / FSA 写失败→抛错+abort 不静默重发）PASS。
- `test-platform-services.mjs`：新增 `supportsStreamingFileSave`(web=false / android=true）断言；既有分块/取消/单例契约 PASS。
- `npm run test:platform`:PASS（含接入的 save-generated-file 测试）。

## 9. 已知限制 / 待后续阶段

- 旧浏览器聚合 fallback 仍整段驻留（阶段 2 范围）。
- 导出期间用户继续编辑的一致性策略（快照 vs 冻结）未在本切片定义（阶段 2)。
- `supportsStreamingFileSave` 探测已提供，但未接入任何 UI 提示（阶段 1 不做 UI 改造）。
