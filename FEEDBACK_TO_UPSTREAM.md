# FEEDBACK_TO_UPSTREAM — dualsub-self

本文件记录构建过程中遇到的疑问 / 决策 / 非阻塞性顾虑。所有问题都已按"最安全、可逆的默认"继续处理并标注 **[待确认]**。

---

## 1. [待确认] 跨域翻译请求的 host 权限（关键架构决策）

**问题**：brief 里的 manifest 草稿只有 `permissions: ["storage"]` + YouTube 的 `host_permissions`。
但翻译要直连用户自填的任意 `apiBaseUrl`（OpenAI 兼容网关），这是**跨域请求**。

在 MV3 里，content script 的 `fetch` 只有在扩展拥有目标 origin 的 `host_permissions` 时才能绕过页面 CORS。
用户的 base_url 是任意的、运行时才知道，无法在 manifest 里静态枚举。

**默认做法（已采用）**：在 `manifest.json` 的 `host_permissions` 增加 `"<all_urls>"`，使 isolated.js 可直接 fetch 用户的任意端点。
- 优点：零额外 UI、零额外脚本、load-unpacked 即可用，最贴近 brief "isolated.js 调翻译 API" 的描述。
- 代价：扩展申请了"读取所有网站数据"权限。已在 README 安全说明里明确告知用户：扩展只会把请求发往**你自己填写的端点**，不会发往其它站点。

**备选方案（未采用，更克制但更复杂）**：
- (a) 用 `optional_host_permissions: ["<all_urls>"]` + popup 里点"测试连接/保存"时 `chrome.permissions.request()` 动态申请。更克制，但增加交互复杂度，且用户体验上多一次授权弹窗。
- (b) 加 background service worker 做 fetch。MV3 service worker 同样受 host_permissions 约束，并不能绕过，故无实质收益，反而多一层 RPC。

如果上游希望走 (a) 最小权限路线，我可以改；当前默认选 `<all_urls>` 是为了"开箱即用"。

---

## 2. [待确认] m.youtube.com 移动端

brief 要求 web + m.youtube.com 都做。manifest 已 match 两个域名，main.js 里对 `m.youtube.com` 用 `c=MWEB`。
但移动端 YouTube 的播放器对象结构（`#movie_player` / `getAudioTrack`）我无法在容器内验证，可能与桌面端有差异。
**默认**：按桌面端同一套逻辑跑，移动端作为"尽力支持"。端到端验证需上游在真实 m.youtube.com 上做。

---

## 3. 翻译并发与限流

预取下一个 clip 时未做全局并发上限/重试退避（仅单个 clip 串行翻译，clip 之间按播放进度触发，天然不会同时打很多）。
若用户的网关有严格 RPM 限制，可能偶发 429。当前对非 200 做了错误处理并保留原文兜底，不会崩。
**默认**：不加复杂限流，保持代码可读。

---

# 第二轮（5 类修复）决策与待确认

## 4. [已做] 颜色配置读取链路（修复 1）

按 brief：popup 改为**直接从 `chrome.storage.local` 按当前 tab origin 读配置**回显，不再依赖内容脚本的 `get-state`。颜色框初始化与 readForm 都用 `Core.normalizeColor` 兜底（非法/空值回落默认色，绝不存 `#000000` 空值）。保存时 popup 自己写一份 storage（冗余）+ `set-config` 通知内容脚本即时生效，两边 key 统一 `"dualsub:"+origin`。轨道清单仍向内容脚本要（拿不到只填 auto）。

## 5. [已做] resegment 词级去重叠的语言适配（修复 2）

`resegmentCues` 的滚动重叠去重按**空格分词**做词级比对。对英文等好用；中日韩无空格语言 ASR 重叠少见，按整条事件处理不拆词。
**[待确认]**：若上游有大量 CJK ASR 重叠的实例，可改成基于字符 n-gram 的重叠检测，但会更重、误伤风险更高，当前未做。

## 6. [待确认] clip 默认时长从 60s 缩到 30s、批大小从 20 降到 10

- clipSeconds 默认 30（按 cue 边界就近切，不切碎句子）；batchLines 默认 10。
- 这是性能/token 的权衡默认值。缩短 clip + 首句优先 + 并发让首句更快出，但 clip 变多意味着 system prompt 固定开销的批次数变多。我按"首句延迟是主诉求"优先了响应速度。若上游更在意总 token，可把 clipSeconds 调回 ~45–60、batchLines 调到 12。这些都是配置项，端到端实测后好调。

## 7. [待确认] 并发上限固定为 3、退避 maxFails=4

- `translateCues` 并发上限硬编码 3（isolated.js 传入）；`makeBackoff` 默认连续失败 4 次后停。
- 未做成用户可配项（避免 popup 过载、也因为合理默认足够）。若上游想暴露成高级设置可加。

## 8. 持久缓存键与配额

- 缓存 key = `videoId|轨道code|targetLang|model|clipStartMs`，存在单个 storage key `dualsub:cache` 下，LRU 上限 800 条。
- **[待确认]**：800 条 + 每条若干句译文，估算远小于 chrome.storage.local 的 ~5MB/10MB 配额；但极端长视频大量观看历史下未做精确字节核算。若上游担心，可改为按字节估算裁剪或下调上限。`chrome.storage.local.set` 失败（配额满）已 try/catch 吞掉，不影响翻译主流程。

---

# 第三轮（低配机运行占用优化 + 打磨）决策与待确认

## 9. [已做] 单一节流渲染循环替代双触发

原来 `timeupdate` 监听 + `setInterval(250)` 同时跑，每次都线性扫 cue + 无条件 prefetch。改为单个 250ms 节流循环：cue 未变化提前 return（idle 零 DOM/查找），预取拆到独立 ~1.5s 低频循环。
**[待确认]**：渲染节拍固定 250ms（人眼对字幕切换 ≤250ms 延迟基本无感）。若上游要求更跟手可调到 ~120ms，但低配机占用会上升。未做成可配项。

## 10. [已做] 二分查找当前 cue + cue→clip 映射表

`Core.findCueIndexAt`（O(log n) 二分 + 上次命中下标 hint，连续播放多为 O(1)）；`Core.cueClipIndexMap` 建全局 cue→clip 反查表。渲染不再线性扫 clip 内 cues。均有离线单测。

## 11. [已做] 完整生命周期管理 / 空闲零开销

所有 timer id（render/prefetch/seek 防抖）与 listener 引用登记在 `state`，`teardownRuntime(full)` 统一清理。暂停 / 播放结束 / 标签页隐藏（visibilitychange）时停循环；禁用扩展时 full teardown（含移除渲染器）。切 video / SPA 换视频时 `bindVideo` 先 teardown 旧绑定再重绑，杜绝累积泄漏。
**说明**：未用 MutationObserver 监听播放器 DOM（brief 列为"若有/若需要"）。当前重挂逻辑放在渲染 tick 里用 `renderer.isConnected`（O(1)）检测，避免再引入一个 observer 增加开销与泄漏面。若上游发现某些播放器布局变化渲染 tick 捕捉不到，可再加一个**节流且只观察播放器子树**的 observer。

## 12. [已做] seek 防抖 / 加载态 / 全屏重定位

- seek：`seeking` 置标志、`seeked` 后 `SEEK_SETTLE_MS=350ms` 停稳才翻目标 clip 并刷新；拖动中不渲染不预取。
- 加载态：新增 `showLoading` 配置（默认开），译文未到且原文在显时显示半透明斜体"翻译中…"，译文到平滑替换。
- 全屏/影院：渲染器为播放器子节点随容器走；被重建踢出 DOM 时渲染 tick 以 `isConnected` 检测重挂。
**[待确认]**：全屏/影院重定位**仅容器内逻辑验证**，真实 YouTube DOM 行为需端到端确认（见 result.json needs_upstream_e2e）。

## 13. [已做] prompt 进一步瘦身 + batch 默认 10→14

`DEFAULT_SYSTEM_PROMPT` 填充后从 ~509(最初基线) 压到 ~190 字符（约 −63%），保留三条硬约束。`batchLines` 默认 10→14（落在 brief 建议的 12–15 区间），摊薄固定开销。
**[待确认]**：14 行/批是瘦身 prompt 后的折中默认。若实测某些模型在 14 行时对齐变差，可回调到 12；README 已说明可调。contextTail 已复查：仅跨句边界带 1 句、clip 首批不带（沿用 v2，未改）。

## 14. [已做] 请求超时（AbortController）

`translateBatch` 加 `timeoutMs`（默认 20s，isolated.js 传 20000）。超时按失败抛错 → 调用方兜底显原文 + 退避。`timeoutMs<=0` 关闭。429/5xx 仍走 v2 已有的 HTTP 非 200 抛错 + `makeBackoff` 指数退避路径，未额外区分（统一退避足够，避免过度工程）。
**[待确认]**：是否需要把 429 与普通 5xx 分开处理（如读 `Retry-After` 头）。当前未做，统一指数退避。
