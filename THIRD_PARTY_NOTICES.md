# Third-party notices / 第三方声明

The MIT license in [LICENSE](LICENSE) covers the source code of annie-lite. The following bundled or referenced components are under their own terms.

本仓库代码以 MIT 授权；以下随仓库分发或依赖的组件遵循各自的许可。

## Wake-word model / 唤醒词模型

`resources/models/wake-word/` (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`)

- Upstream: **sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01** by the k2-fsa / Next-gen Kaldi project.
  - Download: <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2>
  - Docs: <https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html>
  - Model card: <https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01>
- Files are unmodified copies of the upstream `*-epoch-99-avg-1-chunk-16-left-64.int8.onnx` files and `tokens.txt` (verified by SHA-256), renamed.
- License: **Apache License 2.0** (as stated on the upstream model card). <https://www.apache.org/licenses/LICENSE-2.0>
- The model was trained on the [WenetSpeech](https://wenet-e2e.github.io/WenetSpeech/) corpus, which is distributed for non-commercial purposes under CC BY 4.0. If you plan commercial use, review the dataset and model terms yourself.
- `keywords.txt` (the 「你好安妮」 keyword definition) was written for this project and is covered by the MIT license.

## npm dependencies / npm 依赖

Installed by `npm install`, not included in this repository. Main runtime dependencies:

| Package | License |
| --- | --- |
| [sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 |
| [ws](https://github.com/websockets/ws) | MIT |
| [zod](https://github.com/colinhacks/zod) | MIT |
| [aliyun-rtc-sdk](https://www.npmjs.com/package/aliyun-rtc-sdk) | No license declared (proprietary Alibaba Cloud SDK). Not vendored here; installed from npm and used under Alibaba Cloud's terms. |

Build-time: Electron, React, three.js, Vite, electron-vite, electron-builder, TypeScript and vitest (MIT). See `package-lock.json` for the full list.

## External services / 外部服务

annie-lite talks to Volcengine Doubao realtime speech, Vidu, Alibaba Cloud RTC, Open-Meteo and DuckDuckGo. Using them is subject to each provider's terms; you need your own accounts and keys.

## App icon / 应用图标

`resources/icon/annie-app-icon.png` was provided by the project author and is distributed with this project. Its origin is not independently documented; contact the maintainer if you believe it infringes your rights.
