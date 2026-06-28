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
