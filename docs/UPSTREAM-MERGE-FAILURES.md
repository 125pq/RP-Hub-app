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

如果这次同标签改指向由定时工作流直接合并成功，默认修订号仍会推导为 `0`：当上游标签和当前 `package.json` 都是 `1.8.8` 时，`deriveRevision()` 返回 `0`，生成的仍是 `1.8.8`、`v1.8.8-android`。它不会自动变成 `1.8.8.1`。

由于 `v1.8.8-android` 已存在，工作流还会复用旧 Release 的 canonical APK 并跳过重复发布。这意味着“同标签改代码”不能依赖默认版本推导产生新 APK。此次实际发布显式传入了 `revision=1`，因此生成 `1.8.8.1`、`versionCode 1080801` 和 `v1.8.8.1-android`。

### 后续风险

- 当前是否已集成仍按提交 SHA 的 ancestry 判断；上游再次改写同一标签时，仍会被当成待合并代码。
- 上游若重构 Square 容器或其他补丁锚点，解析器会再次 fail closed，需要人工确认新结构。
- 若产品规则是“只有新 Release 标签才同步”，应另行把同步状态改为以已记录的 Release 标签为主；同标签 SHA 变化只告警、不合并。

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
