# MyDualsub · 双语字幕（自带翻译 API）

在 **YouTube** 上叠加显示**双语字幕**（原文 + 译文两行）的 Manifest V3 浏览器扩展。

它仿照商业扩展 **Dualsub** 的架构，但有一个关键区别：

> **翻译不经过任何自建服务端 / API-Key 计费体系，而是直连你自己的 OpenAI 兼容翻译 API。**

如果你受够了某些扩展"每小时要去网站重新领 key"，这个项目就是为你做的——把翻译后端做成你自己填的三个变量（Base URL / Key / Model），密钥只存在你本地浏览器里。

---

## 支持站点

- `https://www.youtube.com/*`（桌面网页版）
- `https://m.youtube.com/*`（移动网页版，尽力支持）

> 目前只做 YouTube。架构上 main.js 负责站点适配，后续可扩展其它站点。

---

## 安装（加载已解压的扩展程序）

1. 下载 / clone 本仓库到本地。
2. 打开 Chrome / Edge，地址栏进入 `chrome://extensions`（Edge 为 `edge://extensions`）。
3. 打开右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本仓库根目录（含 `manifest.json` 的那一层）。
5. 扩展出现后，去 YouTube 打开任意带字幕的视频，点扩展图标进行配置。

> 图标用 `gen_icons.py`（PIL）生成，可自行替换 `icons/` 下的 PNG。

---

## 配置说明

点击扩展图标打开设置面板：

### 翻译 API（OpenAI 兼容）—— 核心三件套
- **API Base URL**：你的网关地址，如 `https://api.openai.com/v1` 或自建反代 `https://你的网关/v1`。
- **API Key**：`Bearer` 鉴权用的 key。
- **模型**：如 `gpt-4o-mini`、`claude-sonnet-4-6` 等（取决于你的网关支持哪些）。
- **测试连接**：用当前填写的三件套发一条最小翻译请求，显示成功/失败 + 示例译文，方便验证配置。

### 语言
- **源语言**：从当前视频可用的字幕轨道里选；`自动` = 优先用自动生成字幕（ASR），否则第一条。
- **译文语言**：如 `zh-Hans`（简体中文）、`ja`、`en` 等。

### 显示
字号、底部间距、原文颜色、译文颜色、描边、阴影、背景框、双语顺序（译文在上 / 原文在上）、是否显示原文行。

配置按站点 origin 存进 `chrome.storage.local`，保存后即时生效。

---

## 翻译质量：分批 + 上下文 + 行号对齐

本扩展**绝不逐句翻译**字幕碎片（实测会出现模型反问、把字幕当问题作答、半句翻译断裂等问题）。

正确做法（已验证质量好）：

1. 把一个时间窗口内的多句原文字幕**拼成一批**，带行号：
   ```
   1. so today we're gonna take a look at
   2. how transformers actually work under the hood
   ```
2. **一次性**发给你的 API 的 `/chat/completions`，system prompt 要求模型先在脑内恢复标点、把碎片理解成完整句子，但**输出严格每个输入行号对应一行译文**，行数、行号完全一致。
3. 按行号把译文对齐回各 cue 的时间轴；行数/行号不匹配时兜底（缺的留原文，不错位、不丢内容）。
4. 批与批之间带上一批末尾 1~2 句作为上下文，保证代词/主语/术语连贯。

**边播边翻**用 **clip 预取 + 缓存**：字幕按时间切成 clip（默认 60 秒），播放接近当前 clip 尾部时提前翻下一个 clip；已翻过的 clip 缓存住不重复请求。

---

## 架构说明

```
manifest.json   扩展声明（MV3）
main.js         world: MAIN —— 访问页面 #movie_player，抓字幕轨道
core.js         纯逻辑（解析/清洗/翻译/clip 切分），无浏览器依赖，可 Node 单测
isolated.js     world: ISOLATED —— 拉字幕、调翻译 API、渲染叠加层、读写 storage、与 popup 通信
popup.html/js   设置 UI
icons/          占位图标
test/           离线测试（node 直接跑）
```

- **双脚本 + 自建 RPC**：`main.js`（MAIN world，能访问 YouTube 播放器私有对象但不能用 `chrome.*`）与 `isolated.js`（ISOLATED world，能用 `chrome.storage`/`chrome.runtime`）通过一条固定随机字符串常量的 `CustomEvent` 通道通信，兼容 Firefox `cloneInto`。
- **轨道抓取**：main.js 每 3 秒轮询 `#movie_player`，读 `getVideoData().video_id` 与 `getAudioTrack().captionTracks`。**关键：必须等轨道 URL 带上 `pot` 签名参数后才算有效**，否则字幕请求 403；给 URL 设 `fmt=json3` + `c=WEB`（移动端 `MWEB`）。SPA 路由变化靠轮询 `location.search` 的 `v` 检测。
- **渲染**：`.dualsub-renderer` 挂到 `.html5-video-player`，监听 `<video>` 的 `timeupdate`，按 `currentTime*1000` 查当前 cue。样式用 CSS 变量控制。

---

## 安全说明（请务必阅读）

- 你的 **API Key 只存在你本地浏览器的 `chrome.storage.local`**，不会上传到任何第三方服务器。
- 翻译请求**只发往你自己填写的 API Base URL**，不发往其它任何端点。
- 为了让扩展能直连你填写的**任意** API 端点（地址运行时才知道），manifest 申请了 `<all_urls>` 的 `host_permissions`。这是实现"自带翻译 API"所必需的——但请知悉：技术上扩展因此具备访问任意站点的能力。**本扩展只在你触发翻译/测试时向你配置的端点发请求，源码开放可自行审计。** 如需更克制的权限模型，见 `FEEDBACK_TO_UPSTREAM.md` 中的备选方案。
- 不要把真实 key 提交进 git（`.gitignore` 已排除常见密钥文件）。

---

## 已知限制

- 移动端 `m.youtube.com` 的播放器对象结构未经真机验证，按桌面端同套逻辑尽力支持。
- 真实 YouTube 端到端效果（轨道抓取、`pot` 签名、渲染）需在浏览器中验证；本仓库已通过语法检查与离线逻辑测试。
- 未做翻译请求的全局限流/退避；若网关有严格 RPM 限制可能偶发 429（已做错误兜底，不会崩，失败 clip 仅显示原文）。
- 当前只支持 OpenAI 兼容的 `/chat/completions` 接口。

---

## 开发 / 自测

```bash
# 语法检查
node --check core.js && node --check main.js && node --check isolated.js && node --check popup.js

# 离线逻辑测试（解析 / 清洗 / 翻译对齐 / clip 切分）
node test/run-tests.js

# 重新生成图标
python3 gen_icons.py
```

## License

[MIT](./LICENSE)
