# 上游自动同步说明

RP-Hub Web 的上游仓库是 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub)。同步目标是 GitHub 标记的**最新正式 Release**，不会直接跟随 `main`，也会忽略 Draft 和 Pre-release。

Release 页面显示的 ZIP/TAR 压缩包只是 GitHub 提供的下载形式。同步脚本实际读取 Release 对应的 Git tag，并通过 Git 合并 tag 指向的提交，不下载或解压压缩包。

本仓库在上游 Web 的基础上独立维护 Android 原生代码、离线资源、WebView 布局适配、性能优化，以及少量调用 `window.platformAdapter` 的必要 Hook。自动同步不会把 Capacitor 或 Android 原生实现重新写回上游业务文件。

## 手动同步

执行一次正式同步，包括查询最新正式 Release、拉取并合并对应 tag、重新应用 Hook、完整验证、Android 单元测试、`assembleRelease` 和创建同步提交：

```text
node scripts/upstream-sync/sync-upstream.mjs
```

执行完整演练，但不保留 merge 结果、不创建提交：

```text
node scripts/upstream-sync/sync-upstream.mjs --dry-run
```

两种命令都要求工作树干净。如果 Git 检测到真实冲突，脚本会列出冲突文件、执行 `git merge --abort` 并返回失败，不会自动选择 `ours` 或 `theirs` 覆盖冲突。

如果上游没有发布新的正式 Release，脚本不会同步 `main` 上尚未发布的提交，也不会创建空提交。切换同步策略不会回滚以前已经合入的提交；后续正式 Release 包含这些提交后，Git 会自然识别已有历史。

Android 自动发布使用上游三段式版本号。例如上游 `1.8.3` 会生成：

- `versionName`：`1.8.3`
- `versionCode`：`10803`
- Android tag：`v1.8.3-android`
- APK：`RP-Hub-1.8.3-release.apk`

非三段式正式 tag 会令任务明确失败，避免发布版本号不确定的 APK。

## 补丁分类

- `patch-android-hooks.mjs`：平台脚本加载顺序、Back/AppState 生命周期，以及角色卡和小说的公共导出调用。
- `patch-safe-area.mjs`：`viewport-fit`、safe-area 样式表和 WebView 固定布局 Hook。
- `patch-offline-assets.mjs`：检查本地 Vue、Markdown、Tailwind、字体等离线运行资源入口。
- `patch-performance.mjs`：段落感知流式输出和离屏 iframe 性能 Hook。

浏览器通用接口位于 `assets/js/platform-services.js`，Android Web Adapter 位于 `assets/js/rphub-android-adapter.js`。原生 SAF 实现继续位于 `android/app/src/main/java`，不由 Web Hook 补丁维护。

## 验证方式

单独检查 Adapter、调用点、脚本顺序和 Android 实现隔离：

```text
node scripts/upstream-sync/verify.mjs
```

验证补丁幂等性：

```text
node scripts/upstream-sync/tests/reapply-idempotence.mjs
```

幂等测试会连续执行两次 Hook 重打，第二次必须报告 `REAPPLY_CHANGED_FILES=0`，且所有受管文件内容保持不变。

## 同步失败时如何处理

- 出现 merge conflict：查看 `sync-upstream.mjs` 输出的冲突文件列表。脚本已经中止 merge，需要人工比较上游新实现和本地 Hook。
- 提示缺少同步锚点：修改 `scripts/upstream-sync/patches/` 下对应类别的补丁。通常表示上游重写了相关函数或 HTML 入口。
- Adapter 验证失败：运行 `node scripts/upstream-sync/verify.mjs`，根据输出的接口或文件名检查调用点。
- 幂等验证失败：运行 `node scripts/upstream-sync/tests/reapply-idempotence.mjs`，检查哪个补丁重复插入了脚本、监听器或初始化代码。
- 离线依赖验证失败：需要同步检查 `patch-offline-assets.mjs`、vendor 准备脚本和 `scripts/verify-dist.mjs`，不能只改其中一处。
- Android 构建失败：先确认 JDK 21、Android SDK 35 和永久 release key 配置；不要通过生成临时 key 或修改正式签名逻辑绕过失败。

## GitHub Actions

`.github/workflows/sync-upstream.yml` 支持手动触发，并每天定时检查一次上游最新正式 Release。工作流只在 tag 合并、Hook、验证、Web 测试、Android 单元测试和 `assembleRelease` 全部成功后提交并推送；没有新 Release 或代码变化时不会创建空提交，也不会监听自身的 push 再次触发。

构建成功后，工作流还会验证 production 包名、版本号、`debuggable=false` 和 APK 签名，计算 SHA-256，并创建正式 GitHub Release。Release 标题为 `RP-Hub Android <版本>`，上传对应版本 APK，正文包含功能摘要和最终 SHA-256。若 `v<版本>-android` 已经存在，发布步骤会正常跳过，不会覆盖或重复上传现有 Release。

云端构建使用现有永久 release key，需要在 GitHub Actions 中配置以下 Secrets：

- `RPHUB_RELEASE_KEYSTORE_BASE64`
- `RPHUB_RELEASE_STORE_PASSWORD`
- `RPHUB_RELEASE_KEY_ALIAS`
- `RPHUB_RELEASE_KEY_PASSWORD`

keystore 只会解码到 GitHub Runner 的临时目录，不会写入仓库或构建产物目录。

可以使用仓库提供的 PowerShell 脚本读取现有 `keystore.properties` 并配置四项 Secrets。先执行只检查、不上传的演练：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-github-release-secrets.ps1 -WhatIf
```

确认仓库、配置文件和永久 keystore 路径正确后正式上传：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-github-release-secrets.ps1
```

脚本通过标准输入向 GitHub CLI 传递 Secret，不会打印密码或 keystore 的 Base64 内容；结束时只检查四个 Secret 名称是否存在。
