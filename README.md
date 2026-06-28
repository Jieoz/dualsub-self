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
- **源语言**：从当前视频可用的字幕轨道里选；`自动` = 优先用自动生成字幕（ASR），否则第一条。**源语言不限英文**——取决于该视频提供哪些字幕轨道（日语、韩语、西语等都可，只要 YouTube 有对应轨道）。
- **译文语言**：任意填，如 `zh-Hans`（简体中文）、`ja`、`en`、`ko` 等，直接作为目标语言传给翻译模型。

### 显示
字号、底部间距、原文颜色、译文颜色、描边、阴影、背景框、双语顺序（译文在上 / 原文在上）、是否显示原文行。

配置按站点 origin 存进 `chrome.storage.local`，保存后即时生效。

> **配置读取说明**：设置面板**直接从 `chrome.storage.local` 读取并回显**当前站点已存的配置，**不依赖** YouTube 页是否已注入内容脚本。所以先开面板、在非播放页、刚装扩展时也能正确显示你之前存的颜色等设置，不会被还原成默认值。保存时面板既写一份 storage（冗余保证一致），也通知正在运行的内容脚本即时生效。颜色框始终兜底到合法颜色，绝不会把空值/`#000000` 误存进配置。

---

## 翻译质量：分批 + 上下文 + 行号对齐

本扩展**绝不逐句翻译**字幕碎片（实测会出现模型反问、把字幕当问题作答、半句翻译断裂等问题）。

正确做法（已验证质量好）：

1. 把一个时间窗口内的多句原文字幕**拼成一批**，带行号：
   ```
   1. so today we're gonna take a look at
   2. how transformers actually work under the hood
   ```
2. **一次性**发给你的 API 的 `/chat/completions`，system prompt 要求模型结合上下文理解碎片语义，但**输出严格每个输入行号对应一行译文**，行数、行号完全一致。
3. 按行号把译文对齐回各 cue 的时间轴；行数/行号不匹配时兜底（缺的留原文，不错位、不丢内容）。
4. **上下文按需带**：仅当某批的起点落在一句话中间（上一条原文没有句末标点）时，才前置上一条原文 1 句作上下文；clip 第一批不带。既省 token 又保代词/主语/术语连贯。

### 原文断句：ASR 语义重组

YouTube 自动字幕（ASR）的事件是按滚动时间片切的：一句话常被切进多个事件，相邻事件还会重叠（后一个含前一个的尾词）。直接每个事件当一条字幕会导致原文断句凌乱、出现 `work work under` 这类重复词。

解析后（`core.js` 的 `resegmentCues`）会做**语义重组**：

- 合并间隙很小（< 300ms）且上一句未自然结束（无句末标点）的连续碎片，时间轴取并集。
- 去掉相邻事件的**滚动重叠词**（按词比对，忽略大小写/标点），避免重复。
- 按句末标点 / 最大时长（~6s）/ 最大词数（~12）重新切句，让每条显示的原文是一个相对完整的语义单元。

### 边播边翻：首句优先 + 并发 + 缓存

- **首句优先**：进入一个 clip 时，先翻"当前播放位置附近的一小批（3–5 句）"立即显示，剩余句子后台补。进新片段不再要等满整批才看到译文。
- **批内并发**：clip 内多批用受控并发池（默认上限 3）替代串行等待，整体更快；上下文连贯仍靠按需的 contextTail 维持。
- **clip 按 cue 边界切**（默认目标 ~30s/clip）：绝不在句子中间断、clip 之间不重叠不重复，避免跨边界句子被翻两次。
- **更早预取**：进入某 clip 就启动下一个 clip 的预取；拖动进度条跳转时立即翻目标位置所在 clip。`onTick` 的预取做了节流，播放位置没明显移动不重复跑昂贵逻辑。

### Token 优化与持久缓存

- **持久缓存**：已翻好的 clip 按 `videoId + 轨道 code + 译文语言 + 模型 + clip 起始毫秒` 为 key 存进 `chrome.storage.local`。重看、拖回、刷新页面整段命中缓存，**零重复 API 调用**。缓存按 LRU 裁剪（默认上限 800 条）防止占满配额。
- **失败退避**：某 clip 翻译失败会做失败计数 + 指数退避，连续失败若干次（默认 4 次）后**停止自动重试**，不再反复烧 token；用户改配置 / 在面板重新保存即视为手动重试，自动恢复。
- **批大小默认 10 行**：在"固定开销（system prompt）占比"与"单批成本/对齐准确度"之间取平衡，仍保持"分批 + 上下文 + 行号对齐"不退化成逐句翻译。
- **精简 system prompt**：去冗余措辞，省每批必发的固定 token 开销，但保留三条硬约束（结合上下文、每行一译、行号行数一致）。

---

## 架构说明

```
manifest.json   扩展声明（MV3）
main.js         world: MAIN —— 访问页面 #movie_player，抓字幕轨道
core.js         纯逻辑（解析/清洗/语义重组/翻译编排/clip 切分/缓存 key/退避），无浏览器依赖，可 Node 单测
isolated.js     world: ISOLATED —— 拉字幕、调翻译 API、首句优先+并发+缓存、渲染叠加层、读写 storage、与 popup 通信
popup.html/js   设置 UI（直接从 storage 读配置回显，引入 core.js 复用默认配置/颜色校验）
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
- 真实 YouTube 端到端效果（轨道抓取、`pot` 签名、渲染、颜色生效、断句质量、首句延迟）需在浏览器中验证；本仓库已通过语法检查与离线逻辑测试。
- 翻译并发上限默认 3、并对失败 clip 做退避；若网关有极严格 RPM 限制仍可能偶发 429（已做错误兜底：失败 clip 仅显示原文不崩溃，连续失败会停止自动重试）。
- `resegmentCues` 的滚动重叠去重是**词级**比对，对英文等空格分词语言效果好；对中日韩等无空格语言，ASR 重叠本就少见，按整条事件处理。
- 持久缓存按 `videoId+轨道+语言+模型+clip起点` 为 key；切换模型/译文语言会按新 key 重翻（旧缓存自然不命中，并按 LRU 逐步淘汰）。
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
