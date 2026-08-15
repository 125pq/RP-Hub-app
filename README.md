# Roleplay Hub APP

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D.svg?logo=vue.js)](https://vuejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![DaisyUI](https://img.shields.io/badge/DaisyUI-5A0EF8?logo=daisyui&logoColor=white)](https://daisyui.com/)
[![Android Release](https://img.shields.io/badge/Android-1.8.3.6-3DDC84?logo=android&logoColor=white)](https://github.com/125pq/RP-Hub-app/releases/tag/v1.8.3.6-android)

> **一款纯前端运行的本地角色扮演（Roleplay）对话和角色卡生成工具。**

**【免责与授权声明】**  
本项目基于 **[CC BY-NC 4.0（知识共享-署名-非商业性使用 4.0 国际许可协议）](./LICENSE)** 开源。**明确禁止任何形式的商业化使用（包括但不限于：作为收费服务提供、打包在付费产品中售卖、在产品内植入广告盈利等）。** 任何使用者必须遵守该协议，尊重原作者的署名权。对于违反协议的商业行为，保留追究法律责任的权利。

---

## 核心特性 (Features)

Roleplay Hub 致力于提供流畅、私密且功能强大的本地化AI Roleplay体验。

- 角色卡、世界书、正则脚本和多用户资料管理
- 总结记忆与向量记忆，可按角色和剧情分支独立保存
- 剧情分支创建、切换、回档、重命名和完整导入导出
- UI 模板变量分析与对话状态展示
- 自动生图、单张重新生成和多套内置画师风格
- 角色卡生成、万相广场与“墨韵 · 造梦”在线工具
- Android / Capacitor 原生封装，支持安全区、系统返回、Share、外部 Browser 与系统下载
- 通过 Android Storage Access Framework（SAF）导入导出文件，无需广泛存储权限
- paragraph-aware 流式渲染与离屏复杂角色卡动画暂停，改善长回复和长聊天滚动性能

## 快速开始 (Quick Start)

### Android 正式版

当前正式版本：**RP-Hub Android 1.8.3.6**

- Package ID：`io.github.pq125.rphub`
- Version code：`1080306`
- 下载：[RP-Hub-1.8.3.6-release.apk](https://github.com/125pq/RP-Hub-app/releases/download/v1.8.3.6-android/RP-Hub-1.8.3.6-release.apk)
- SHA-256：`647f50a447dcde987a4dfe26e0b65593f2a5851c771655865d9d51a95447c148`

APK 使用项目的长期 release key 签名。安装前可使用 Android SDK `apksigner verify` 校验签名，并核对上方 SHA-256。

> 已知问题：当前 Android 启动器图标仍为默认 Capacitor 图标，少量 UX polish 将在后续版本处理。

### Web 版

#### 1. 下载与运行
1. 点击项目主页绿色的 `Code` 按钮，选择 `Download ZIP`。
2. 将下载的 ZIP 压缩包解压到您的本地任意文件夹中。
3. 安装 Node.js 后，在项目目录执行：

```bash
npm ci
npm run build:web
```

4. 使用本地静态服务器打开生成的 `dist/` 目录（推荐 Chrome / Edge / Firefox）。

不建议直接用 `file://` 打开源码入口；本地静态服务器可以避免浏览器的跨域和文件读取限制。

#### 2. 初始化设置
1. 打开应用后，点击侧边栏（或顶部菜单）的**设置 (Settings)** 选项。
2. 选择自定义配置，填入您自己的或第三方提供的 API 节点 (`API URL`)。
3. 填入对应的 `API Key`，并输入或选择您想使用的 `模型名称 (Model)`。
4. 在**角色管理**界面，导入您的角色卡文件（或点击新建角色并手动填写设定）。
5. 回到对话界面，开始属于您的 Roleplay 旅程

---

## 目录结构 (Directory Structure)

```text
RP-Hub-app/
├── android/                       # Capacitor Android 原生工程
│   └── app/src/main/java/io/github/pq125/rphub/
│       ├── MainActivity.java      # 插件注册、WebView 下载监听、冷启动更新检查
│       ├── NativeFilePlugin.java  # SAF 导入导出 / 分块写入
│       ├── NativeClipboardPlugin.java # 安全输入框剪贴板
│       └── AppUpdateManager.java  # 更新检查、下载、校验、安装
├── index.html                     # 主界面与脚本加载入口
├── character/                     # 角色卡生成工具
│   └── index.html
├── novel/                         # 墨韵 · 造梦
│   └── index.html
├── assets/
│   ├── css/
│   │   ├── styles.css             # 全局样式
│   │   └── safe-area.css          # Android/WebView 安全区布局
│   └── js/
│       ├── app.js                 # 主业务入口与页面状态
│       ├── built-in-content.js    # 默认预设、模式提示词、画师串与更新公告
│       ├── core-utils.js          # 通用工具、角色卡处理与统一文件保存
│       ├── data-services.js       # 存储、记忆、上下文、分支与 UI 状态
│       ├── runtime-services.js    # API 请求、消息渲染与运行状态
│       ├── ui-components.js       # 选择器、侧边栏、弹窗与页面组件
│       ├── platform-services.js   # 平台 facade（浏览器与原生统一入口）
│       ├── rphub-android-adapter.js # Android 原生能力适配层
│       ├── safe-area.js           # 安全区变量与 viewport 同步
│       └── offscreen-iframe-lifecycle.js # 离屏复杂 UI 生命周期优化
├── scripts/                       # Web/Android 构建、测试与产物验证脚本
│   └── upstream-sync/             # 上游同步、Hook 重放、版本推导与验证
├── .github/workflows/             # 每日同步 / 测试 / 发布 / Gitee 镜像流水线
├── package.json                   # 固定依赖及可重复构建命令
└── README.md                      # 项目说明
```

### 代码组织说明

页面会按照入口中定义的顺序加载 JavaScript 文件，请不要随意调整依赖顺序。

- 修改默认预设、各模式提示词、生图画师串或工具说明时，统一编辑 `built-in-content.js`。
- 更新公告固定放在 `built-in-content.js` 最底部，方便查找和替换。
- 可复用界面统一放在 `ui-components.js`，业务数据处理放在 `data-services.js`。
- 修改后至少运行 `npm run test:performance`、`npm run test:platform`、`npm run build:web` 和 `npm run verify:dist`。
- Android debug 构建使用 `npm run android:debug`；配置本地永久签名信息后，正式 APK 使用 `npm run android:release` 构建。

### 常用验证命令

```bash
npm ci
npm run test:performance
npm run test:platform
npm run build:web
npm run verify:dist
npm audit --omit=dev
```

---

## 协议与许可 (License)

本项目严格遵守以下开源协议：

**[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)**

* **您可以**：自由地共享（在任何媒介以任何形式复制、发行本作品）与演绎（修改、转换或以本作品为基础进行创作）。
* **您必须**：
  * **署名 (Attribution)**：给出适当的署名，提供指向本许可协议的链接，同时标明是否对原始作品作了修改。
  * **非商业性使用 (NonCommercial)**：**您不得将本作品或演绎作品用于任何商业目的。** 禁止任何形式的售卖、付费订阅集成或利用本项目进行广告牟利。
* 若要获取本项目的商业授权，请直接联系项目原作者。

详细许可条款请参见根目录下的 [`LICENSE`](./LICENSE) 文件。
