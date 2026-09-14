# 角色卡开场白 iframe 修复（2026-09-14）

## 根因

模拟器实际页面的 iframe 存在，但 `srcdoc` 被 DOMPurify 3.4.13 删除，文档为 `about:blank`。带完整 style/script 的 srcdoc 命中 SAFE_FOR_XML 的属性检查。用户提供的角色卡通过显示正则生成该 iframe；不是导入丢失，也不是离屏暂停。

## 实现

自有模块 `assets/js/card-frame-renderer.js` 在 runtime-services 之后加载，包装消息渲染器的局部 sanitizer 参数。合法 HTML iframe 的 srcdoc 使用每次调用独有的占位值通过外层清理，只有清理后仍存在的 iframe/srcdoc 才以 DOM 属性赋值恢复原文，再交回原来的消息渲染流程。保留源 sandbox，不新增权限；明确禁止 iframe 或 srcdoc 时不恢复。DOMPurify 全局配置和上游 runtime-services 均不修改。

普通 Markdown 沿用原路径；包含 srcdoc 的结果仍使用上游渲染缓存。角色卡原文件不入库。

## 验证

- `test:upstream-sync`、候选行为门禁、正式组合构建及产物校验通过，重放幂等。
- 实际 Edge 浏览器验证 style/script 保留、脚本初始化和按钮交互；外层 onload/onerror、javascript URL 继续被清理，FORBID_TAGS/FORBID_ATTR 仍生效，普通 Markdown 和缓存正常。该测试纳入 `check-browser.mjs`。
- debug APK 安装模拟器后 force-stop 冷启动，用户原有角色卡自动恢复：iframe 文档为 `about:srcdoc`，含 1 个脚本、1242 个可见文本字符，开场白可见。没有注入修复代码或改写存储。
- 此轮 APK 基于 1.9.3，SHA-256：`428dfc6b462162db1ee797fd955f100ba35f28e6653b0e0c065e218b79129ecd`。1.9.4 候选与正式发布仍需对应版本的验收。
