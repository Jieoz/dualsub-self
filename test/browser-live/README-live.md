# 真机验证 harness（真 Chromium + 真 ASR 轨 + 真模型）

与 `test/browser-replay` 的区别：那套用 fixture 轨 + stub 翻译，验状态机分支；
这套**不 stub 任何模型调用**，按真实速率播放，每 0.5s 采样"屏幕上到底有没有中文"。

存在的理由：v0.7.8 发布时 247 条离线门禁全绿，真机第一次跑覆盖率只有 59% ——
`oversized source unit before translation: 14 words (cap 12)` 反复退避重试。
断句层与翻译层的词数上限不一致，只有真实运行链路能暴露。

## 准备轨

```bash
YTDLP=~/.local/share/uv/tools/yt-dlp/bin/yt-dlp
$YTDLP --write-auto-subs --sub-langs "en-orig,en" --sub-format json3 \
       --skip-download -o t1 "https://www.youtube.com/watch?v=<VIDEO_ID>"
mv t1.en.json3 test/browser-live/t1.json3
```

需要带词级时间的 ASR 轨（`segs[].tOffsetMs` 存在）。歌曲/人工字幕轨没有 token 时序，
走不到语义恢复路径。

## 跑

```bash
python3 -m http.server 8899   # 仓库根，供 Chromium 取 core.js/isolated.js/轨

DUALSUB_CDP_URL=http://<chromium>:9222 \
DUALSUB_REPLAY_HOST=<本机对 Chromium 可见的 IP> \
DUALSUB_LIVE_TRACKS=test/browser-live/t1.json3,test/browser-live/t2.json3 \
DUALSUB_LIVE_MINUTES=5 \
DS_BASE=<api-base> DS_MODEL=gpt-5.4-mini DS_KEY=<key> \
node test/browser-live/run.js
```

判定门槛：跳过前 15s 冷启动后，**屏幕有原文时**同步有译文的覆盖率 ≥90%、
最长「有原文却无译文」空窗 ≤12s、真实 API 失败 0、JS 错误 0。
墙钟中文覆盖率仅作诊断：演讲停顿时原文和译文都为空，不能把静默诬告成漏译。

## 口径要点

- **凭据经 CDP 注入页面上下文**，不进 URL（不留在历史/日志）。
- **必须绕脚本缓存**：URL 带 `cb` 参数，`core.js?v=<cb>`。改了产品代码不加这个会跑旧代码
  （曾据此误判"修复无效"）。
- **AbortError 不算失败**：区间换入会主动废弃旧断句的在途请求，那是设计行为。
- **导出 SRT 未全译是预期**：只播 N 分钟时后段本就没翻，fail-closed 正确拒绝导出。
- 页面必须先把 URL 的 `?v=` 改成对应 videoId 再发 manifest —— 产品会校验二者绑定。
