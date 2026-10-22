# annie-lite · 安妮

语音优先的 macOS 桌面助手：离线唤醒词、豆包实时语音、Vidu 数字人、本地记忆与长任务执行。

[English](#english) · [中文](#中文)

---

## 中文

### 这是什么

安妮是一个常驻在 Mac 上的语音助手。说一声「你好安妮」唤醒她，然后直接说话：

- **听和说**交给火山引擎豆包实时语音（端到端语音对话，可随时打断）。
- **动手的事**（翻项目、读代码、查资料这类多步任务）派给后台的 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 执行，做完再用语音告诉你。
- **数字人画面**（可选）由 Vidu Live 驱动。

### 功能

- 离线唤醒词「你好安妮」：基于 sherpa-onnx 关键词检测，待机音频只在本机处理，命中前不上传。
- 实时语音对话：转写、语音回答、打断。
- 本机工具：在授权目录里浏览/搜索/读取文件，时间与计算、天气、网页搜索、提醒、剪贴板、系统状态等。
- 破坏性操作（跑命令、删除、移动、覆盖）默认先弹确认框。
- 长期记忆：一个 Obsidian 风格的知识库（默认 `~/Documents/annie-vault`），对话原文按天落到 `sources/`。
- 长任务面板：后台任务的进度与结果，做完语音播报。
- 可选的 Vidu 数字人画面。

### 运行要求

- **仅支持 macOS**（Apple Silicon 上开发和测试）。
- Node.js 20 及以上、npm。
- 豆包实时语音 API Key（必需）。
- Vidu API Key（可选，只有开启数字人才需要）。
- Pi 执行引擎（可选，长任务需要）：`npm i -g @earendil-works/pi-coding-agent`。

### 获取密钥

- **豆包**：在[火山引擎控制台](https://console.volcengine.com/speech/app)开通「端到端实时语音大模型」，在「API Key 管理」里创建 API Key。
- **Vidu**：在 [Vidu 开放平台](https://platform.vidu.cn) 创建 API Key（形如 `vda_...`）。

密钥在应用的「设置」里粘贴保存。它们通过 Electron `safeStorage` 加密（macOS 下由钥匙串保护），只存在本机的 `~/Library/Application Support/annie-lite`，不会写进代码仓库，也不会发往除对应服务商以外的任何地方。

### 开始使用

```bash
npm install
npm run dev          # 开发模式启动
npm test             # 单元测试（vitest）
npm run typecheck    # 类型检查
npm run build        # 类型检查 + 构建
npm run package:mac  # 打包成 release/mac-arm64/annie-lite.app
```

首次启动时 macOS 会请求**麦克风权限**，需要允许（系统设置 → 隐私与安全性 → 麦克风）。唤醒词检测完全在本机进行。

### 设置称呼

打开「设置」→「怎么称呼你」，填入你希望安妮怎么叫你（例如「小明」），点保存，下次唤醒生效。留空时安妮不叫名字，对话记录里你说的话标为「用户」。

### 目录结构

```
electron/   主进程：语音会话、工具、记忆、任务、设置与密钥
src/        渲染层：React 界面、音频采集与播放、粒子球
shared/     主进程与渲染层共用的 IPC 契约
resources/  应用图标与唤醒词模型
tests/      单元测试；tests/smoke 是连真实服务的手动脚本
```

### 许可证

[MIT](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，安全问题见 [SECURITY.md](SECURITY.md)。

---

## English

### What it is

Annie is a voice-first desktop assistant for macOS. Say the wake word 「你好安妮」 ("Hello Annie", Mandarin) and just talk:

- **Listening and speaking** are handled by Volcengine Doubao realtime speech (end-to-end voice dialogue with barge-in).
- **Real work** (multi-step tasks like reviewing a project, reading code, researching) is delegated to a background [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent, and the result is read back to you when done.
- **An optional talking avatar** is driven by Vidu Live.

The UI and voice persona are in Mandarin Chinese.

### Features

- Offline wake word via sherpa-onnx keyword spotting; standby audio never leaves your Mac before the wake word fires.
- Realtime voice conversation with transcripts, spoken replies and interruption.
- Local tools: browse/search/read files inside authorized folders, time and math, weather, web search, reminders, clipboard, system status.
- Destructive actions (running commands, delete, move, overwrite) ask for confirmation by default.
- Long-term memory in an Obsidian-style vault (default `~/Documents/annie-vault`); conversation transcripts are saved daily under `sources/`.
- Task panel for background jobs, with spoken results.
- Optional Vidu avatar.

### Requirements

- **macOS only** (developed and tested on Apple Silicon).
- Node.js 20+ and npm.
- A Doubao realtime speech API key (required).
- A Vidu API key (optional, only for the avatar).
- The Pi agent (optional, for long tasks): `npm i -g @earendil-works/pi-coding-agent`.

### Getting keys

- **Doubao**: enable the end-to-end realtime speech model in the [Volcengine console](https://console.volcengine.com/speech/app) and create an API key under "API Key 管理".
- **Vidu**: create an API key (`vda_...`) on the [Vidu platform](https://platform.vidu.cn).

Paste keys in the app's Settings. They are encrypted with Electron `safeStorage` (backed by the macOS Keychain) and stored only under `~/Library/Application Support/annie-lite`. They are never written to this repository and are only sent to the respective provider.

### Getting started

```bash
npm install
npm run dev          # run in development mode
npm test             # unit tests (vitest)
npm run typecheck    # type checking
npm run build        # typecheck + build
npm run package:mac  # package to release/mac-arm64/annie-lite.app
```

On first launch macOS asks for **microphone permission**; allow it (System Settings → Privacy & Security → Microphone). Wake-word detection runs entirely on-device.

### Your name

Open Settings → 「怎么称呼你」 ("What should I call you"), enter the name Annie should use for you, and save; it takes effect on the next wake-up. If left empty, Annie doesn't use a name and transcripts label you as 「用户」 ("user").

### License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); see [SECURITY.md](SECURITY.md) for reporting security issues.
