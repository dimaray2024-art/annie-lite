# 手动 smoke

这些脚本连真实的豆包服务，不进 `vitest`。只在改动语音协议相关代码时手动跑。

## 准备

需要一个真实 API Key，和一段真实提问的 16k 单声道 PCM：

```bash
say -v Tingting "下载文件夹里有什么" -o /tmp/q.aiff
ffmpeg -y -i /tmp/q.aiff -ar 16000 -ac 1 -f s16le /tmp/q.pcm
```

## doubao-tool-repro.mjs

证明「播报会吃掉工具那一轮的回复」。改 provider 或工具回传路径后跑一遍：

```bash
KEEP_UPLINK=1 VARIANT=plain    DOUBAO_KEY=... node doubao-tool-repro.mjs   # 模型接话
KEEP_UPLINK=1 VARIANT=announce DOUBAO_KEY=... node doubao-tool-repro.mjs   # 模型不接话
```

`KEEP_UPLINK=1` 不能省。上行一停，工具回传后模型同样不接话——这一条单独也是坑。

## doubao-inject-probe.mjs

证明 `conversation.item.create` 单独发不会让模型开口（user / tool 两种 role 都试）：

```bash
MODE=user DOUBAO_KEY=... node doubao-inject-probe.mjs
```

结论：这个接口只在「回答一个待处理的工具调用」时才生成下一轮。

## kws-scan.mjs

拿真实待机录音离线调唤醒词。先在 app 里录一段，再扫：

```bash
ANNIE_DUMP_WAKE=/tmp/wake.f32 npm run dev            # 录（待机音频原样追加，16k f32）
node tests/smoke/kws-scan.mjs /tmp/wake.f32          # 用生成的关键词文件扫
USE_MODEL_KEYWORDS=1 node tests/smoke/kws-scan.mjs /tmp/wake.f32   # 用仓库里那份扫
```

可调：`KW_TOKENS` / `KW_SCORE` / `KW_THRESHOLD` / `NUM_TRAILING_BLANKS` / `SRC_RATE`。

**调参必须写进 `resources/models/wake-word/keywords.txt`。** sherpa 用每行末尾的
`:score` 和 `#threshold` 覆盖 config 里的 `keywordsScore` / `keywordsThreshold`，
改代码里那两个值没有任何效果（实测把一个阈值从 0.25 调到 0.01，命中数一个没变）。

脚本会打印「说话段」个数和命中覆盖率——只看命中数会误判：命中 1 次可能是
说了 1 次，也可能是说了 20 次里的 1 次。

## 一条已经踩过的坑

1. **不要在上行加静音门控。** 用户不说话时停发，工具回传后模型永远不接话。
   官方 demo 有一个 `while True` 补静音帧就是干这个的。
2. **不要在工具执行前插播报。** `speech_text_buffer` 会被合成成一整轮独立
   response，这一轮里回传的工具结果再也不会让模型开口。费时间的活走两段式：
   工具立刻返回受理，模型先说话，结果跑完单独播报。
