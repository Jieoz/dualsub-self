/*
 * core.js — 纯逻辑模块（无浏览器 API 依赖，可在 Node 中单测）
 * =============================================================
 * 这里集中放"解析字幕 / 清洗时间轴 / 分批翻译并按行号对齐"等纯函数。
 * isolated.js 直接复用这些函数；test/ 下的离线测试也直接 require 本文件。
 *
 * 设计原则：本文件不碰 chrome.* / DOM / 真实网络。所有 I/O（fetch）都以
 * 参数形式注入，方便 mock 测试。
 */

(function (root, factory) {
  // UMD 风格导出：Node 走 module.exports；浏览器挂到 window.DualsubCore
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DualsubCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------
   * 1. 字幕解析
   * ------------------------------------------------------------- */

  /**
   * 解析 YouTube json3 字幕格式。
   * 输入形如 {events:[{tStartMs,dDurationMs,segs:[{utf8}]}]}。
   * 返回 cue 列表：{start,end,duration,content}（单位毫秒）。
   */
  function parseJson3(json) {
    const out = [];
    if (!json || !Array.isArray(json.events)) return out;
    for (const ev of json.events) {
      // 没有 segs 的事件（如纯窗口定义事件）跳过
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs
        .map((s) => (s && typeof s.utf8 === "string" ? s.utf8 : ""))
        .join("");
      const content = collapseWhitespace(text);
      if (!content) continue; // 空内容（常见的换行事件）丢弃
      const start = toInt(ev.tStartMs, 0);
      const duration = toInt(ev.dDurationMs, 0);
      out.push({
        start: start,
        end: start + duration,
        duration: duration,
        content: content,
      });
    }
    return out;
  }

  /**
   * 通用 WebVTT 解析器（备用：部分轨道只给 vtt）。
   * 返回同样的 cue 结构（毫秒）。
   */
  function parseVtt(text) {
    const out = [];
    if (typeof text !== "string") return out;
    // 按空行分块
    const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n");
    const timeRe =
      /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (!lines.length) continue;
      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (timeRe.test(lines[i])) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue; // 没有时间行（如 WEBVTT 头、NOTE）跳过
      const m = lines[timeLineIdx].match(timeRe);
      const start = vttClockToMs(m[1], m[2], m[3], m[4]);
      const end = vttClockToMs(m[5], m[6], m[7], m[8]);
      const content = collapseWhitespace(
        lines
          .slice(timeLineIdx + 1)
          .join(" ")
          .replace(/<[^>]+>/g, "") // 去掉 vtt 内联标签
      );
      if (!content) continue;
      out.push({ start: start, end: end, duration: Math.max(0, end - start), content: content });
    }
    return out;
  }

  function vttClockToMs(h, m, s, ms) {
    const hh = h ? parseInt(h, 10) : 0;
    const mm = parseInt(m, 10) || 0;
    const ss = parseInt(s, 10) || 0;
    // ms 可能是 1~3 位，右补 0 到 3 位
    const fff = parseInt((ms + "000").slice(0, 3), 10) || 0;
    return ((hh * 60 + mm) * 60 + ss) * 1000 + fff;
  }

  /* ---------------------------------------------------------------
   * 2. 时间轴清洗
   * ------------------------------------------------------------- */

  /**
   * 清洗 cue 列表：
   *  - trim 空白、过滤空内容
   *  - 按 start 排序
   *  - 去重叠：前一句 end 不超过后一句 start
   *  - 修正 end < start 的脏数据
   * 返回新数组，不修改入参。
   */
  function cleanupCues(cues) {
    let list = (cues || [])
      .map((c) => ({
        start: toInt(c.start, 0),
        end: toInt(c.end, 0),
        duration: toInt(c.duration, 0),
        content: collapseWhitespace(c.content || ""),
      }))
      .filter((c) => c.content.length > 0);

    // 修正 end：end 必须 >= start
    for (const c of list) {
      if (c.end < c.start) c.end = c.start + (c.duration > 0 ? c.duration : 0);
      if (c.end < c.start) c.end = c.start;
    }

    list.sort((a, b) => a.start - b.start || a.end - b.end);

    // 去重叠：把前一句的 end 压到不超过后一句的 start
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].end > list[i + 1].start) {
        list[i].end = list[i + 1].start;
      }
      if (list[i].end < list[i].start) list[i].end = list[i].start;
      list[i].duration = list[i].end - list[i].start;
    }
    if (list.length) {
      const last = list[list.length - 1];
      last.duration = Math.max(0, last.end - last.start);
    }
    return list;
  }

  /* ---------------------------------------------------------------
   * 2b. 原文语义重组（resegment）—— 修 ASR 断句
   * -------------------------------------------------------------
   * YouTube 自动字幕(ASR)的 event 是按滚动时间片切的：一句话常被切进
   * 多个 event，相邻 event 文字还会重叠（后一个含前一个的尾词）。
   * 直接每个 event 当一条 cue 会导致原文断句凌乱、出现 "work work under"
   * 这种重复词。这里把碎片重组成相对完整的语义单元：
   *  - 去相邻 cue 的滚动重叠词（按词比对，忽略大小写/标点）。
   *  - 间隙很小且上一句没说完（无句末标点）就合并，时间轴取并集。
   *  - 按句末标点 / 最大时长(~6s) / 最大词数(~12) 重新切句。
   * 纯函数，可离线单测。入参应已 cleanupCues（有序、无负时长）。
   */

  // 句末标点（中英文）：命中则认为一句自然结束，适合断句
  var SENTENCE_END_RE = /[.!?。！？…]+["'”’)\]]*$/;

  // 把一个词规整为比较用 token：转小写、去首尾标点
  function wordKey(w) {
    return String(w || "")
      .toLowerCase()
      .replace(/^[^0-9a-z一-鿿]+|[^0-9a-z一-鿿]+$/g, "");
  }

  /**
   * 去掉 next 开头与 prev 结尾重叠的词，返回 next 去重叠后的词数组。
   * 例：prev="...how transformers work" next="work under the hood"
   *     → next 去掉开头的 "work" → ["under","the","hood"]。
   * 只在词级别比对（CJK 无空格的语言此重叠少见，按整体词处理即可）。
   */
  function stripOverlap(prevWords, nextWords) {
    var maxK = Math.min(prevWords.length, nextWords.length, 8);
    for (var k = maxK; k >= 1; k--) {
      var match = true;
      for (var i = 0; i < k; i++) {
        if (wordKey(prevWords[prevWords.length - k + i]) !== wordKey(nextWords[i])) {
          match = false;
          break;
        }
      }
      if (match) return nextWords.slice(k);
    }
    return nextWords;
  }

  function resegmentCues(cues, opts) {
    opts = opts || {};
    var maxDur = opts.maxDurationMs != null ? opts.maxDurationMs : 6000; // 单句最长时长
    var maxWords = opts.maxWords != null ? opts.maxWords : 16; // 单句最多词数（12→16：12 对中文目标偏短）
    var minWords = opts.minWords != null ? opts.minWords : 3; // 单句最少词数（碎句黏合下限）
    // 长停顿阈值：明显大于旧 maxGap(300，"同句紧密延续")。ASR 常无标点，单靠 maxWords
    // 硬切会断在半句；一个超过 longPauseMs 的间隙本身就是自然停顿边界，即使没标点也在此切句。
    // 间隙 < longPauseMs 视为同一语流可继续合并（含正常换气停顿），>= 即断。
    var longPauseMs = opts.longPauseMs != null ? opts.longPauseMs : 700;
    // 句间视觉尾缩（修「字幕墙」）：YouTube 滚动 ASR 几乎每条都与下一条时间重叠，
    // cleanupCues 去重叠后前句 end 被精确压到后句 start → 连续语流内句单元首尾相接、
    // gap 恒为 0，字幕永不消隐。这里在产出句单元时把 end 往回缩一点点，制造句间断点，
    // 但绝不侵蚀真实停顿、绝不让 end < start：
    //  - 仅当该句 duration > tailTrimMs*2 才缩（短句不缩，避免缩没）。
    //  - 缩后保证 end-start >= TAIL_TRIM_MIN_VISIBLE_MS（下限 300ms，仍可读）。
    //  - 真停顿（下一句 start 与本句原始 end 间本就有间隙）天然不受影响——尾缩只是让
    //    「原本紧贴」的句子之间也出现 ~tailTrimMs 断点。tailTrimMs=0 完全关闭（向后兼容）。
    var tailTrimMs = opts.tailTrimMs != null ? opts.tailTrimMs : 120;
    if (!(tailTrimMs > 0)) tailTrimMs = 0;
    var TAIL_TRIM_MIN_VISIBLE_MS = 300;
    var list = (cues || []).filter(function (c) {
      return c && c.content;
    });
    if (!list.length) return [];

    var out = [];
    var cur = null; // 当前累积段：{start,end,words:[]}

    function flush() {
      if (!cur) return;
      var content = collapseWhitespace(cur.words.join(" "));
      if (content) {
        var endMs = cur.end;
        // 视觉尾缩：仅长句缩（duration > tailTrimMs*2），缩后保证 >= 最小可视时长。
        if (tailTrimMs > 0 && cur.end - cur.start > tailTrimMs * 2) {
          var trimmed = cur.end - tailTrimMs;
          if (trimmed - cur.start < TAIL_TRIM_MIN_VISIBLE_MS) {
            trimmed = cur.start + TAIL_TRIM_MIN_VISIBLE_MS;
          }
          if (trimmed < endMs) endMs = trimmed; // 绝不放大，只回缩
        }
        out.push({
          start: cur.start,
          end: endMs,
          duration: Math.max(0, endMs - cur.start),
          content: content,
        });
      }
      cur = null;
    }

    for (var idx = 0; idx < list.length; idx++) {
      var c = list[idx];
      var words = collapseWhitespace(c.content).split(" ").filter(Boolean);
      if (!words.length) continue;

      if (!cur) {
        cur = { start: c.start, end: c.end, words: words.slice() };
      } else {
        var gap = c.start - cur.end;
        var added = stripOverlap(cur.words, words);
        var prevText = cur.words.join(" ");
        var ended = SENTENCE_END_RE.test(prevText);
        var wouldWords = cur.words.length + added.length;
        var wouldDur = c.end - cur.start;
        // 可并入下一条：续句(未自然结束) 或 自然结束但太短(< minWords，碎句黏合)；
        // 两种都仍受「间隙不超 longPauseMs + 不超 maxWords/maxDur」约束。
        // 长停顿(gap >= longPauseMs)是自然边界，优先于碎句黏合：即使当前段太短/未结束，
        // 一旦遇到长停顿也不再合并，断在此处（比 maxWords 硬切更自然）。
        var canMerge = !ended || cur.words.length < minWords;
        var mergeable =
          gap < longPauseMs && canMerge && wouldWords <= maxWords && wouldDur <= maxDur;
        if (mergeable) {
          for (var w = 0; w < added.length; w++) cur.words.push(added[w]);
          cur.end = Math.max(cur.end, c.end);
        } else {
          // 无法再合并（长停顿 / 会超上限）→ 当前段（含太短的碎句）单独成段
          flush();
          cur = { start: c.start, end: c.end, words: words.slice() };
        }
      }

      // 切句时机（优先级）：
      //  - 超 maxWords / 超 maxDur → 立即切（防超长段，不变）。
      //  - 自然结束(句尾标点)但仅当词数已达 minWords 才切；不足 minWords 先不切，
      //    留待与下一条 cue 黏合（minWords 合并优先于句尾立即切）。
      //  长停顿切句已在上面的合并判定中处理（gap >= longPauseMs 不再并入，自然成段）。
      var curWords = cur.words.length;
      var endedNow = SENTENCE_END_RE.test(cur.words.join(" "));
      if (
        curWords >= maxWords ||
        cur.end - cur.start >= maxDur ||
        (endedNow && curWords >= minWords)
      ) {
        flush();
      }
    }
    flush();
    return out;
  }

  /* ---------------------------------------------------------------
   * 3. 工具函数 + 默认配置
   * ------------------------------------------------------------- */

  /**
   * 默认配置（popup 与 isolated 共用同一份，避免两边漂移）。
   * key 统一为 "dualsub:" + origin。
   */
  var DEFAULT_CONFIG = {
    enabled: true,
    apiBaseUrl: "",
    apiKey: "",
    apiModel: "gpt-4o-mini",
    sourceLang: "auto", // auto = 用第一条 ASR / 第一条轨道
    targetLang: "zh-Hans",
    systemPrompt: "", // 空 = 用 core 默认行级 prompt（一步到位输出自然分行的中文字幕行）
    sentencePrompt: "", // 已废弃（v0.4.0 移除句级重断路径）；保留键仅为兼容旧导出配置，不再使用
    // 显示样式
    fontSize: 22, // px —— 语义为"基准高度(FONT_BASE_HEIGHT=480，常规非全屏)下的字号"；
    //               实际渲染字号随播放器高度由 computeFontPx 同比缩放（全屏放大、退出缩小）。
    fontWeight: "500", // 字重："400"|"500"|"600"|"700"… 直接写入 CSS font-weight。
    fontFamily: "", // 字体族：空 = 用扩展内置默认族；否则整串写入 CSS font-family（仅本地/系统字体，不远程加载）。
    bottomOffset: 90, // px，距播放器底部
    fontColor: "#ffffff",
    transColor: "#7fdfff", // 译文颜色
    stroke: true, // 描边（旧布尔开关，保留做向后兼容；新配置改用 strokeWidth）
    shadow: true, // 阴影（旧布尔开关，保留做向后兼容；新配置改用 shadowStrength）
    strokeWidth: 1.2, // px，描边粗细（范围 0–3，0=无描边）。0 即关闭描边，无需 class 开关
    strokeColor: "#000000", // 描边颜色
    shadowStrength: "medium", // 阴影强度："none"|"weak"|"medium"|"strong"
    background: false, // 背景框
    transOnTop: true, // true=译文在上，原文在下
    showOriginal: true, // 是否显示原文行
    showLoading: true, // 译文未到时显示轻量"翻译中…"指示（false=只显原文）
    clipSeconds: 12,
    // 首个 clip 单独用更短目标（秒）。开场长 ASR 句在 clipSeconds=12 时仍可能吃进 3–4 条 cue、
    // 源文 200+ 字 → 首包 4–6s+。firstClipSeconds 压首单元 token，后续 clip 仍用 clipSeconds。
    firstClipSeconds: 4,
    // 单 clip 源文字符软上限（0=关闭）。防止超长 cue 组把一次请求撑爆；只在 cue 边界断开。
    maxSourceCharsPerClip: 160,
    // 单 clip 最多 cue 条数软上限（0=关闭）。
    maxCuesPerClip: 4, // 每个翻译 clip 多少秒（按 cue 边界就近切）。v0.4.1 从 15 收到 12：
    //                  推理模型(gpt-5.x-mini) prompt 越长 reasoning token 越多、首单元越慢；
    //                  更短 clip → 单次请求更轻 → 首包/换段更稳（见 e2e-harness A/B）。
    batchLines: 14, // 已废弃（v0.4.0 一个 clip = 一次请求，不再 clip 内分批）；保留键兼容旧配置。
    contextLines: 3, // 已废弃（v0.4.0 整 clip 一次翻，模型自带上下文）；保留键兼容旧配置。
    globalConcurrency: 4, // 跨 clip 的全局 in-flight 翻译请求上限（信号量）。滑动窗口预取
    //                       (depth=3)若不封顶会冲垮网关→429；此值统一封顶。
    reasoningEffort: "low", // 推理模型(gpt-5.x-mini)的 reasoning_effort。行级 prompt 把规则写死 +
    //                  「直接给结果不要思考过程」压住 reasoning 爆点；"low" 时实测延迟 4.5-6.7s 稳定、
    //                  reasoning 14-103 token。取值 low|medium|high；空串或 "default" = 不发该字段。
    minLineChars: 6,
    // 字幕行目标上限（字）。后处理 splitLongLines 用；只在短语标记边界拆，绝不切词。
    maxLineChars: 16, // 最小行长（可视字符）：模型偶尔吐出过短碎行时，把短行【整行】并入相邻行
    //                  （只在行边界落点，绝不切词）。<=0 关闭合并。规则2「每行不要过分短」的兜底。
    tailTrimMs: 120, // 句间视觉尾缩(ms)：连续语流句单元 end 回缩此值制造句间断点(修字幕墙)。
    //                  0=关闭。仅长句(duration>2×)缩，缩后保留 >=300ms 可视；真停顿不受影响。
    maxCharsPerScreen: 20, // 已废弃（v0.4.0 模型直接分行，代码不再切割）；保留键兼容旧配置/UI。
    maxDurPerScreen: 4000, // 已废弃（v0.4.0 模型直接分行，代码不再切割）；保留键兼容旧配置/UI。
  };

  /**
   * 规整颜色值：合法的 #rgb/#rrggbb 才接受，否则回落 fallback。
   * 用于杜绝 <input type=color> 空值/默认 #000000 污染配置。
   */
  function normalizeColor(v, fallback) {
    var s = String(v == null ? "" : v).trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return s.toLowerCase();
    return fallback;
  }

  // 阴影强度 → text-shadow 预设串。none=无；逐级加重，strong 保证 1080p 亮背景可读。
  var SHADOW_PRESETS = {
    none: "none",
    weak: "0 1px 2px #000",
    medium: "0 0 4px #000, 0 1px 2px #000",
    strong: "0 0 6px #000, 0 1px 3px #000, 0 0 2px #000",
  };

  /** 把 shadowStrength 取值映射到 text-shadow 串；非法值回落 medium。 */
  function shadowCss(strength) {
    var k = String(strength == null ? "" : strength).trim().toLowerCase();
    return SHADOW_PRESETS[k] != null ? SHADOW_PRESETS[k] : SHADOW_PRESETS.medium;
  }

  /** 规整描边粗细：0–3 的有限数；非法回落 fallback；负数夹到 0、超 3 夹到 3。 */
  function normalizeStrokeWidth(v, fallback) {
    var f = Number(fallback);
    if (!Number.isFinite(f)) f = DEFAULT_CONFIG.strokeWidth;
    // null/undefined/空串(trim 后为空) = 缺失 → 回落 fallback；真数字 0 仍保留为 0。
    if (v == null || (typeof v === "string" && v.trim() === "")) return f;
    var n = Number(v);
    if (!Number.isFinite(n)) return f;
    if (n < 0) n = 0;
    if (n > 3) n = 3;
    return n;
  }

  /**
   * 平滑迁移旧配置（向后兼容）：
   *  - 老用户只有布尔 stroke/shadow，没有新字段 strokeWidth/strokeColor/shadowStrength。
   *  - 迁移规则：旧 stroke===false → strokeWidth=0；旧 shadow===false → shadowStrength="none"。
   *  - 仅在新字段缺失时迁移，已显式设置新字段的不动（用户改过就尊重）。
   * 返回新对象，不改入参。读取/合并配置后调用一次即可，让老配置不会炸掉。
   */
  function migrateConfig(config) {
    var c = Object.assign({}, config || {});
    if (c.strokeWidth == null) {
      // 旧 stroke 显式 false → 无描边(0)；否则用默认粗细
      c.strokeWidth = c.stroke === false ? 0 : DEFAULT_CONFIG.strokeWidth;
    }
    if (c.strokeColor == null) c.strokeColor = DEFAULT_CONFIG.strokeColor;
    if (c.shadowStrength == null) {
      // 旧 shadow 显式 false → 无阴影；否则用默认强度
      c.shadowStrength = c.shadow === false ? "none" : DEFAULT_CONFIG.shadowStrength;
    }
    return c;
  }

  function toInt(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  }

  function collapseWhitespace(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ---------------------------------------------------------------
   * 3b. 字号随播放器尺寸自适应（纯函数，便于离线单测）
   * -------------------------------------------------------------
   * 固定 px 是绝对值：全屏后播放器变大但字幕不跟着放大，看着就变小了。
   * 这里把 fontSize 配置语义定为"基准高度(FONT_BASE_HEIGHT，默认 480，
   * 常规非全屏 16:9 约 360~480)下的字号"，实际字号按播放器当前高度同比缩放：
   *   实际字号 = clamp(min, baseFontSize * playerHeight / baseHeight, max)
   * 全屏（高度变大）→ 同比放大；退出全屏（高度变小）→ 同比缩小。
   * isolated.js 用 ResizeObserver 观察播放器高度变化，调用本函数算字号写 CSS 变量。
   */
  var FONT_BASE_HEIGHT = 480; // 基准播放器高度（常规非全屏 16:9 约 360~480）
  var FONT_MIN_PX = 10; // 字号下限（极小窗口也可读）
  var FONT_MAX_PX = 96; // 字号上限（4K 全屏也不至于巨大到溢出）

  /**
   * 按播放器高度计算实际字号（px，四舍五入到整数）。
   *  - playerHeight: 播放器容器当前像素高度。
   *  - baseFontSize: 配置里的基准字号（FONT_BASE_HEIGHT 高度下的字号）。
   *  - baseHeight/min/max: 可选覆盖，默认用上面常量。
   * playerHeight 非正/非数时回落为 baseFontSize（仍 clamp）——加载早期取不到尺寸的兜底。
   */
  function computeFontPx(playerHeight, baseFontSize, baseHeight, min, max) {
    var base = Number(baseFontSize);
    if (!Number.isFinite(base) || base <= 0) base = DEFAULT_CONFIG.fontSize;
    var bh = Number(baseHeight);
    if (!Number.isFinite(bh) || bh <= 0) bh = FONT_BASE_HEIGHT;
    var lo = Number(min);
    if (!Number.isFinite(lo) || lo <= 0) lo = FONT_MIN_PX;
    var hi = Number(max);
    if (!Number.isFinite(hi) || hi <= 0) hi = FONT_MAX_PX;

    var h = Number(playerHeight);
    var px;
    if (!Number.isFinite(h) || h <= 0) {
      px = base; // 尺寸未知 → 用基准字号兜底
    } else {
      px = base * (h / bh);
    }
    if (px < lo) px = lo;
    if (px > hi) px = hi;
    return Math.round(px);
  }
  /* ---------------------------------------------------------------
   * 4. 翻译：一步到位「自然分行的中文字幕行」（v0.4.0 架构简化）
   * -------------------------------------------------------------
   * 旧架构（v0.2.1→v0.3.x）让模型先把碎片重组成「完整句」，再由代码把整句
   * 拆回逐行时间轴 —— 这一「拆回」动作硬切中文译文，把「经常」切成「经/常」、
   * 「隔三差/五」斩断（用户最痛的切词 bug 的根因），还堆了 16 个职责重叠的
   * 切割/对齐函数（splitTranslation/splitTransIntoN/alignOriginalToScreens…）。
   *
   * 新架构（已用真实 API 在 3 批真实字幕验证）：让模型【一步到位】直接吐出
   * 「自然分好行的中文字幕行」，代码只负责配时间轴，绝不再做任何译文切割。
   *  - 没有「拆回逐行」动作 → 切词从根消失（代码永不在词中间落刀）。
   *  - 模型输出的字幕行数可能 != 原始 cue 数：按【字符长度比例】把该 clip 覆盖
   *    的总时间分给各输出行（行边界对齐；因为不切词所以不会切字）。
   *  - reasoning 爆点用 reasoning_effort:low + 把规则写死进 prompt + 「直接给结果
   *    不要思考过程」压住（实测延迟 4.5-6.7s 稳定、reasoning 14-103 token）。
   * 后处理兜底（即使 prompt 漏网也保证）：去每行行尾逗号/句号、丢空行、合并连续重复行。
   */

  // 已验证 system prompt（直接写死规则 + 压 reasoning）。{TARGET_LANG} 仅在调用方
  // 传自定义 prompt 时替换；默认 prompt 面向简体中文，无占位符（替换为 no-op）。
  var DEFAULT_SYSTEM_PROMPT =
    "你是专业字幕翻译。下面是被ASR切碎的英文字幕行。请把它们的完整意思翻译成简体中文，并切分成适合阅读的字幕行，规则严格如下：\n" +
    "1) 在自然语义/短语边界断行，绝不把一个词语切成两半。\n" +
    "2) 一句一意：一行只表达一个完整小意群；不要把两句粘成一行（如「就是烧水我们…」「比如泡茶也许…」应拆开）。\n" +
    "3) 每行长度适中：尽量 8-16 个汉字，不要过长（尽量不超过 18 字）；也不要切得太碎（除非这段原文内容本来就很少）。\n" +
    "4) 不要在行尾留下半截连接尾巴（如以「的/和/与/或/及/而/以/把/被/让/从/在/以至于」结尾却把后续成分甩到下一行）。\n" +
    "5) 去掉每行行尾的逗号和句号；但行中间的顿号、问号、感叹号保留。\n" +
    "6) 只输出中文字幕行，每行一条，不要行号、不要英文/其它语言字母、不要任何解释或思考过程。\n" +
    "直接给结果。";

  function buildSystemPrompt(targetLang, customPrompt) {
    var tpl = customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "简体中文");
  }

  /**
   * 把碎片 cue 拼成带序号的 user message（`1. xxx\n2. yyy...`）。序号只帮模型
   * 理解原文顺序/碎片归属，模型输出不要求带序号（parseSubtitleLines 会剥离漏网序号）。
   */
  function buildNumberedSourceLines(lines) {
    return (lines || [])
      .map(function (t, i) {
        return i + 1 + ". " + collapseWhitespace(t);
      })
      .join("\n");
  }

  // 行尾标点去除（规则3）：仅去行尾的逗号/句号/空白；行中顿号、问号、感叹号保留。
  var TRAILING_PUNCT_RE = /[，。,.\s]+$/u;
  // 漏网的行号前缀（模型偶尔违反规则4）：「1. 」「1、」「1) 」「1）」等。
  var LEADING_NUM_RE = /^\s*\d{1,3}\s*[.、)）:：]\s*/u;

  /**
   * 解析模型输出为「干净的中文字幕行数组」（后处理兜底，纯函数）。
   *  - 按换行切；逐行剥离漏网行号前缀、去行尾逗号/句号、trim。
   *  - 丢空行；合并连续完全相同的重复行（ASR 回声/模型复读兜底）。
   * 不做任何按词/按字切割 —— 模型已分好行，代码只清洗，不动行边界。
   */
  function parseSubtitleLines(text) {
    if (typeof text !== "string") return [];
    var raw = text.replace(/\r/g, "").split("\n");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var ln = raw[i].replace(LEADING_NUM_RE, "");
      ln = collapseWhitespace(ln).replace(TRAILING_PUNCT_RE, "").trim();
      ln = sanitizeSubtitleLine(ln);
      if (!ln) continue; // 丢空行
      if (out.length && out[out.length - 1] === ln) continue; // 合并连续重复行
      out.push(ln);
    }
    return out;
  }

  /**
   * 译文行杂质清洗（v0.4.1）：模型偶发夹带非目标脚本（如马拉雅拉姆字母）或英文专名。
   *  - 去掉 CJK/数字/空白/常用中文标点以外的字符（含拉丁字母、其它 Unicode 脚本）。
   *  - 折叠空白；若洗完为空则返回空串（上层 parse/merge 会丢空行）。
   * 绝不在 CJK 词中间插入/删除汉字——只剥杂质。
   */
  function sanitizeSubtitleLine(line) {
    var s = String(line == null ? "" : line);
    if (!s) return "";
    // 保留：CJK 统一表意、扩展A常见区粗略、数字、空白、中文/通用标点
    s = s.replace(/[^一-鿿㐀-䶿0-9\s，。！？、：；“”‘’（）()\-–—…·℃°%\/.，]/gu, "");
    s = collapseWhitespace(s).trim();
    // 去掉拉丁串后可能留下「个 瓶子」：仅压 CJK 之间的空格，数字两侧空格保留（「功率是 8.8 千瓦」）。
    s = s.replace(/([一-鿿])\s+([一-鿿])/gu, "$1$2");
    return s;
  }

  // 可视长度（按码点计，CJK/拉丁字符各计 1）。用于最小行长判定 + 时间轴占比权重。
  function charLen(s) {
    var n = 0;
    var str = String(s == null ? "" : s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      // 跳过代理对低位，避免 emoji/扩展区算两次
      if (c >= 0xdc00 && c <= 0xdfff) continue;
      n++;
    }
    return n;
  }

  // 拼接两行：边界两侧都是拉丁/数字时插一个空格（不粘连英文词），否则直接相连（CJK 不加空格）。
  function joinLine(a, b) {
    var x = String(a || "");
    var y = String(b || "");
    if (!x) return y;
    if (!y) return x;
    var lastCh = x[x.length - 1];
    var firstCh = y[0];
    var sep = /[0-9A-Za-z]/.test(lastCh) && /[0-9A-Za-z]/.test(firstCh) ? " " : "";
    return x + sep + y;
  }

  /**
   * 最小行长兜底（规则2：每行不要过分短）。把短于 minChars 的行【整行】合并到相邻行 ——
   * 只在【行边界】落点，绝不切词（这是与旧架构的根本区别）。
   *  - 贪心：某行短于阈值 → 把它后面的行并进来，直到达标或并完。
   *  - 末行若仍短 → 向前并入前一行。
   *  - 全部都短（原文内容本来就少）→ 合并成一行，宁可一行也不切碎。
   * minChars<=0 关闭合并，原样返回（便于 A/B 与单测）。
   */
  function mergeShortLines(lines, minChars) {
    var min = minChars > 0 ? minChars : 0;
    var src = (lines || []).slice();
    if (!min || src.length <= 1) return src;
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (out.length && charLen(out[out.length - 1]) < min) {
        out[out.length - 1] = joinLine(out[out.length - 1], src[i]);
      } else {
        out.push(src[i]);
      }
    }
    // 末行仍短 → 向前并（>=2 行时）。
    while (out.length >= 2 && charLen(out[out.length - 1]) < min) {
      var last = out.pop();
      out[out.length - 1] = joinLine(out[out.length - 1], last);
    }
    return out;
  }

  // 强连接尾（几乎总是半截）：和/与/或/及/而/以/把/被/让/从/在
  // 「的」单独处理：很多完整短语以「的」结尾（这根本不是真的 / 一步步运作的），不能一律并。
  var STRONG_DANGLING_TAIL_RE = /(?:[和与或及而以把被让从在]|以至于)$/u;
  // 「的」后接的下一行若像定语中心语（东西/地方/时候…）才合并，避免误并完整句。
  var DE_NOMINAL_HEAD_RE = /^(东西|事情|地方|时候|人|原因|问题|方法|方式|样子|结果|情况|部分|内容|时间|过程|作用|意义|感觉|声音|颜色|味道|温度|速度|功率|电压|电流|水壶|电热|炉灶)/u;

  function isDanglingLine(line, nextLine) {
    var s = String(line == null ? "" : line);
    if (!s) return false;
    if (STRONG_DANGLING_TAIL_RE.test(s)) return true;
    if (/的$/u.test(s)) {
      // 末行「…的」通常是完整收尾（不是真的/运作的）→ 不并
      if (nextLine == null) return false;
      var nxt = String(nextLine);
      if (!nxt) return false;
      // 下一行是名词中心语开头 → 典型半截定语（专门烧水的 + 东西…）
      if (DE_NOMINAL_HEAD_RE.test(nxt)) return true;
      // 下一行很短（<=4 字）且整行像名词尾巴时也并（东西叫水壶 会更长，靠 head re）
      return false;
    }
    return false;
  }

  /**
   * 合并半截连接尾行（v0.4.1 观感打磨）。
   *  - 强连接尾（和/与/…）整行并入下一行。
   *  - 「的」仅在下一行像定语中心语时并入（防「不是真的」「运作的」误并）。
   *  - 末行强连接尾 → 向前并；末行「…的」不并。
   *  - 只在行边界落点，绝不切词；空/单行/无半截原样返回。
   */
  function mergeDanglingLines(lines) {
    var src = (lines || []).slice();
    if (src.length <= 1) return src;
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var cur = String(src[i] == null ? "" : src[i]);
      if (!cur) continue;
      if (out.length && isDanglingLine(out[out.length - 1], cur)) {
        out[out.length - 1] = joinLine(out[out.length - 1], cur);
      } else {
        out.push(cur);
      }
    }
    // 末行仅强连接尾才向前并（「…的」完整收尾保留）
    while (out.length >= 2 && STRONG_DANGLING_TAIL_RE.test(out[out.length - 1])) {
      var last = out.pop();
      out[out.length - 1] = joinLine(out[out.length - 1], last);
    }
    return out;
  }

  // 超长粘句安全拆分点：只在这些「话语标记」之前断开，标记本身完整保留到下一行。
  // 绝不在字/词中间切开——找不到安全点就整行保留。
  var LONG_LINE_SPLIT_MARKERS = [
    "就是", "我们", "你们", "他们", "咱们",
    "从", "比如", "例如", "还有", "而且", "并且",
    "但是", "不过", "所以", "因为", "如果", "然后",
    "以及", "以至于", "其实", "总之", "也许", "可能",
    "一个", "这种", "那个",
  ];

  /**
   * 拆超长/粘句字幕行（v0.4.3 可读性打磨）。
   *  - 仅当 charLen(line) > maxChars 时尝试拆。
   *  - 只在 LONG_LINE_SPLIT_MARKERS 之前断开，且左右两边都 >= minPart（默认 4）。
   *  - 优先选使左段落在 8–maxChars 的切点；找不到安全点 → 原样保留（宁可不切词）。
   *  - maxChars<=0 关闭。可递归拆到都不再超长或无法再拆。
   */
  function splitLongLines(lines, maxChars, minPart) {
    var max = maxChars > 0 ? maxChars : 0;
    var minP = minPart > 0 ? minPart : 4;
    // 粘句门槛：即使总长未超过 max，只要 >= glueMin 也尝试在话语标记处拆（一句一意）。
    var glueMin = Math.min(10, max > 0 ? max : 10);
    var src = (lines || []).slice();
    if (!max || !src.length) return src;

    function trySplit(line) {
      var s = String(line == null ? "" : line);
      var n = charLen(s);
      // 太短不拆；刚好舒适且无强粘句需求时，后面找不到好切点也会原样返回。
      if (n < glueMin) return [s];
      var best = null; // {left, right, score, leftLen}
      for (var m = 0; m < LONG_LINE_SPLIT_MARKERS.length; m++) {
        var mk = LONG_LINE_SPLIT_MARKERS[m];
        var from = 0;
        while (from < s.length) {
          var at = s.indexOf(mk, from);
          if (at < 0) break;
          if (at === 0) {
            from = mk.length;
            continue; // 行首标记不拆
          }
          var left = s.slice(0, at);
          var right = s.slice(at);
          var ll = charLen(left);
          var rl = charLen(right);
          if (ll >= minP && rl >= minP) {
            // 超长行：任何安全切点都可；未超长粘句：左段应是完整短句（<=max 且不宜过长）。
            if (n <= max && ll > max) {
              from = at + mk.length;
              continue;
            }
            var score = 0;
            if (ll >= 4 && ll <= max) score += 100 - Math.abs(8 - ll); // 左段 4–max，越近 8 越好
            else if (ll > max) score += Math.max(0, 30 - (ll - max));
            else score += ll;
            // 总长越超 max 越倾向拆
            if (n > max) score += 20;
            if (!best || score > best.score || (score === best.score && Math.abs(8 - ll) < Math.abs(8 - best.leftLen))) {
              best = { leftLen: ll, score: score, left: left, right: right };
            }
          }
          from = at + mk.length;
        }
      }
      // 未超长且没找到像样切点 → 不拆
      if (!best) return [s];
      if (n <= max && best.score < 90) return [s]; // 粘句只接受左段舒适的高分切点
      return trySplit(best.left).concat(trySplit(best.right));
    }

    var out = [];
    for (var i = 0; i < src.length; i++) {
      var parts = trySplit(src[i]);
      for (var j = 0; j < parts.length; j++) {
        if (parts[j]) out.push(parts[j]);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * 4a. 时间轴排布常量（layoutTimeline 用）。
   * ------------------------------------------------------------- */
  // 每段至少可视这么久(ms)，也是「一屏可视时长地板」：除整段太短放不下的退化情形外，
  // 任何一行 endMs-startMs >= 此值（不闪现）。
  var SEG_MIN_VISIBLE_MS = 800;
  // 目标阅读速度（字/秒）：每行「该显示多久」= ceil(字数/TARGET_CPS*1000)，剩余 slot 留白成停顿。
  var TARGET_CPS = 7;
  // 行与行之间的最小可见间隙(ms)：非末行终点往回扣此值，露出停顿（让位于可视地板）。
  var INTER_SEG_GAP_MS = 120;

  /**
   * 给定各段字数 lens 与时间区间，算出每段 { startMs, endMs }（缺陷5+7）。
   *  - 屏起点：按字数占比线性排布的「时隙边界」(slotStart)，贴合语音、不漏过、单调不回退。
   *  - 屏终点：endMs = min(slotStart + idealMs, slotEnd)，idealMs = max(地板, ceil(字数/CPS*1000))。
   *    剩余 slot 时间留白成句间停顿（缺陷5：不慢飘）。语音密(slot 比 ideal 还短)则顶到 slotEnd。
   *  - 地板兜底（缺陷7）：若某 slot 本身 < 地板，向后顺移借时间补足；整段总时长太短放不下时
   *    （sum(地板) > span）按比例缩放地板让步——优先级：不丢字 > 不超cap > 可视地板 > 目标速度。
   */
  function layoutTimeline(lens, startMs, endMs, minVisible, targetCps) {
    var n = lens.length;
    var span = Math.max(0, endMs - startMs);
    var total = 0;
    for (var i = 0; i < n; i++) total += lens[i] || 1;
    // slot 边界（字数占比），单调不回退、首=startMs、末=endMs。
    var slotStart = new Array(n);
    var slotEnd = new Array(n);
    var acc = 0;
    var prev = startMs;
    for (var j = 0; j < n; j++) {
      slotStart[j] = prev;
      acc += lens[j] || 1;
      var e = j === n - 1 ? endMs : startMs + Math.round((span * acc) / total);
      if (e < prev) e = prev;
      slotEnd[j] = e;
      prev = e;
    }
    // 地板兜底：保证每个 slot 时长 >= minVisible（最后一个 slot 终点固定为 endMs）。
    // 若 n*minVisible > span（整段太短放不下）→ 缩放地板让步（可视地板让位给不丢字/不超cap）。
    var floor = minVisible;
    if (n * floor > span && n > 0) floor = Math.floor(span / n);
    if (floor > 0) {
      // 从前往后：若 slot 太短，向后推它的终点（顺移后续 slotStart），保持单调全覆盖。
      for (var k = 0; k < n; k++) {
        var dur = slotEnd[k] - slotStart[k];
        if (dur < floor) {
          var want = slotStart[k] + floor;
          if (k === n - 1) want = endMs; // 末段终点锁死
          if (want > slotEnd[k]) {
            slotEnd[k] = Math.min(want, endMs);
            if (k < n - 1 && slotEnd[k] > slotStart[k + 1]) slotStart[k + 1] = slotEnd[k];
          }
        }
      }
      // 反向兜底：末段可能被压短，向前借（把前一段终点提前）。
      for (var m = n - 1; m > 0; m--) {
        var d2 = slotEnd[m] - slotStart[m];
        if (d2 < floor) {
          var need = floor - d2;
          var newStart = Math.max(slotEnd[m - 1] - need, slotStart[m - 1] + Math.max(1, floor));
          if (newStart < slotStart[m]) {
            slotStart[m] = Math.max(newStart, slotStart[m - 1] + Math.min(floor, slotEnd[m - 1] - slotStart[m - 1]));
            slotEnd[m - 1] = slotStart[m];
          }
        }
      }
    }
    // 每段终点提前到 起点+idealMs，剩余留白（缺陷5）。语音密则顶到 slotEnd。
    // v0.3.1：非末屏强制保留 INTER_SEG_GAP_MS 句间断点（治「无间隙一直显示」），
    // 但句间断点让位于可视地板——slot 太短放不下断点时优先保 SEG_MIN_VISIBLE_MS，不闪现。
    var out = [];
    for (var p = 0; p < n; p++) {
      var sStart = slotStart[p];
      var sEnd = slotEnd[p];
      var slotDur = sEnd - sStart;
      var ideal = Math.max(minVisible, Math.ceil(((lens[p] || 1) / targetCps) * 1000));
      // idealMs 不得超过本 slot 可用时长（不能挤占下一屏语音位置）。
      var dispEnd = sStart + Math.min(ideal, slotDur);
      if (p < n - 1) {
        // 非末屏：从 slotEnd 往回扣一个断点，使本屏与下屏之间出现可见间隙。
        // 优先级：不超 slotEnd > 可视地板(minVisible) > 句间断点。
        var gapped = sEnd - INTER_SEG_GAP_MS;
        var floorEnd = sStart + minVisible;
        var want = Math.max(floorEnd, Math.min(dispEnd, gapped));
        if (want < dispEnd) dispEnd = want;
      }
      if (dispEnd > sEnd) dispEnd = sEnd;
      if (dispEnd < sStart) dispEnd = sStart;
      out.push({ startMs: sStart, endMs: dispEnd });
    }
    return out;
  }
  /* ---------------------------------------------------------------
   * 4b. 按字符比例配时间轴（v0.4.0 核心）：把模型吐出的「不可再切的整行」
   *     字幕行铺到该 clip 覆盖的总时间上。代码只配时间，绝不切译文。
   * ------------------------------------------------------------- */

  /**
   * 把 N 行字幕（每行已是不可再切的整行）铺到 [startMs,endMs] 时间窗，按各行字符数
   * 占比分配显示区间，并为每行就近配上原文（仅供双语显示/对照，按时间重叠归并 cue）。
   *  - lines: 模型输出并清洗后的中文字幕行数组（行边界即时间轴边界，不切词）。
   *  - startMs/endMs: 该 clip 覆盖的总时间（取自 clip.startMs / clip.endMs）。
   *  - cues: 该 clip 的原始 cue（v0.4.1：按时隙时间重叠分给各输出行 + 空槽最近邻回填；可空）。
   * 复用 layoutTimeline（字符数为占比权重 + SEG_MIN_VISIBLE_MS 可视地板 + 句间留白），
   * 但输入是【不可再切的整行】—— 行长就是权重，layoutTimeline 不会、也无需碰行内字符。
   * 返回：[{ srcStart, srcEnd, originalText, translation, startMs, endMs }]（与渲染单元同构）。
   *   srcStart/srcEnd 为 1-based 输出行号（仅排序用，不再回映 cue 时间）。
   */
  function buildClipUnits(lines, startMs, endMs, cues) {
    var arr = (lines || []).filter(function (l) {
      return l != null && String(l).trim() !== "";
    });
    if (!arr.length) return [];
    var lens = arr.map(function (l) {
      return Math.max(1, charLen(l));
    });
    var times = layoutTimeline(lens, startMs, endMs, SEG_MIN_VISIBLE_MS, TARGET_CPS);

    // 原文按时间重叠就近分给各输出行：用 layoutTimeline 产出的「时隙」边界（贴语音、
    // 全覆盖），把每条 cue 归到其中点所落的那一行。仅供双语/对照显示，不参与切割。
    var origByLine = assignOriginalsToLines(times, cues, arr.length, startMs, endMs);

    var out = [];
    for (var i = 0; i < arr.length; i++) {
      out.push({
        srcStart: i + 1,
        srcEnd: i + 1,
        originalText: origByLine[i] || "",
        translation: arr[i],
        startMs: times[i].startMs,
        endMs: times[i].endMs,
      });
    }
    return out;
  }

  // 把 cue 按「时隙时间重叠」归到输出行，再对仍空的时隙做最近邻回填。
  // v0.4.1：旧中点分桶在「译文行 > cue」时会在语音间隙开出空 originalText（双语对照约 1/3 空行）。
  // 重叠分配允许长 cue 覆盖多个时隙（可重复）；宁可双语重复也不留白。
  function assignOriginalsToLines(times, cues, n, startMs, endMs) {
    var origByLine = new Array(n).fill("");
    var list = cues || [];
    if (!list.length || n <= 0) return origByLine;
    // 时隙边界：bound[k] = 第 k 行的起点；bound[n] = endMs。times[].startMs 即贴语音的 slotStart。
    var bound = [];
    for (var k = 0; k < n; k++) bound.push(times[k].startMs);
    bound.push(endMs);

    // Pass 1：时间重叠分配（cue.start < slotEnd && cue.end > slotStart）。
    for (var c = 0; c < list.length; c++) {
      var cue = list[c];
      var piece = collapseWhitespace(cue.content);
      if (!piece) continue;
      var cStart = Number(cue.start);
      var cEnd = Number(cue.end);
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd)) continue;
      if (cEnd < cStart) {
        var tmp = cStart;
        cStart = cEnd;
        cEnd = tmp;
      }
      var hit = false;
      for (var i = 0; i < n; i++) {
        var s0 = bound[i];
        var s1 = bound[i + 1];
        if (cStart < s1 && cEnd > s0) {
          origByLine[i] = origByLine[i] ? joinLine(origByLine[i], piece) : piece;
          hit = true;
        }
      }
      // 完全落在窗外的退化：退回中点就近桶，避免丢 cue。
      if (!hit) {
        var mid = (cStart + cEnd) / 2;
        var idx = 0;
        for (var j = 0; j < n; j++) {
          if (mid >= bound[j]) idx = j;
          else break;
        }
        origByLine[idx] = origByLine[idx] ? joinLine(origByLine[idx], piece) : piece;
      }
    }

    // Pass 2：最近邻回填仍空的时隙（纯间隙 / 布局留白）。
    for (var e = 0; e < n; e++) {
      if (origByLine[e]) continue;
      var prev = "";
      var next = "";
      for (var p = e - 1; p >= 0; p--) {
        if (origByLine[p]) {
          prev = origByLine[p];
          break;
        }
      }
      for (var q = e + 1; q < n; q++) {
        if (origByLine[q]) {
          next = origByLine[q];
          break;
        }
      }
      // 优先前邻（阅读方向连续）；没有则用后邻。
      origByLine[e] = prev || next || "";
    }
    return origByLine;
  }

  /**
   * 翻译一个 clip：一次 chat 调用，让模型直接吐「自然分行的中文字幕行」，
   * 解析清洗（去行号/去行尾标点/去空行/合并重复）+ 最小行长合并后返回字幕行数组。
   * 入参（opts）：
   *  - cues: 该 clip 的碎片 cue[]（带 content，顺序即源行号）
   *  - apiBaseUrl, apiKey, apiModel, targetLang
   *  - systemPrompt: 可选自定义（覆盖默认行级 prompt）
   *  - reasoningEffort: 透传 chatCompletion（默认配置 "low" 压 reasoning 爆点）
   *  - minLineChars: 最小行长（默认 DEFAULT_CONFIG.minLineChars）；<=0 关闭合并
   *  - temperature, timeoutMs, fetchImpl
   * 返回：string[] 中文字幕行（可能为空数组=模型空响应，调用方兜底显原文）。
   * 网络/HTTP/超时错误向上抛出（与旧 chatCompletion 一致），调用方兜底 + 退避。
   */
  async function translateClipLines(opts) {
    var cues = opts.cues || [];
    if (!cues.length) return [];

    var sys = buildSystemPrompt(opts.targetLang, opts.systemPrompt);
    var userContent = buildNumberedSourceLines(
      cues.map(function (c) {
        return c.content;
      })
    );

    var content = await chatCompletion({
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      apiModel: opts.apiModel,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      systemContent: sys,
      userContent: userContent,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });

    var lines = parseSubtitleLines(content);
    var min = opts.minLineChars != null ? opts.minLineChars : DEFAULT_CONFIG.minLineChars;
    // 后处理链（都只在行/短语边界落点，绝不切词）：
    //  1) 半截连接尾合并（的/和/以至于…）
    //  2) 过短碎行合并
    //  3) 超长粘句按话语标记拆分（一句一意）
    //  4) 再并一次半截尾 + 短行（拆完可能露出新的半截/过短）
    var maxLine = opts.maxLineChars != null ? opts.maxLineChars : (DEFAULT_CONFIG.maxLineChars || 16);
    lines = mergeDanglingLines(lines);
    lines = mergeShortLines(lines, min);
    lines = splitLongLines(lines, maxLine);
    lines = mergeDanglingLines(lines);
    // 拆完后不要再 mergeShortLines：会把「比如泡茶」(4字) 又粘回下一句。
    return lines;
  }
  /**
   * 发一次 chat/completions 并返回 message.content 字符串。
   * translateClipLines 复用：构造请求、AbortController 超时、
   * HTTP/网络错误归一化抛出。纯 I/O，不做任何对齐/解析（交给调用方）。
   * 出错（HTTP 非 200、网络异常、超时）抛 Error，调用方决定兜底。
   */
  async function chatCompletion(opts) {
    var fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) throw new Error("no fetch implementation available");

    var url = joinUrl(opts.apiBaseUrl, "/chat/completions");
    var body = {
      model: opts.apiModel,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
      messages: [
        { role: "system", content: opts.systemContent },
        { role: "user", content: opts.userContent },
      ],
    };
    // 推理模型限流：reasoning_effort=low 把句级重断 prompt 的 reasoning token 从 2000+ 砍到
    // ~70（延迟 40s→7s，质量不降）。空串/"default"/"none" → 不发该字段（兼容非推理模型与老网关）。
    var re = opts.reasoningEffort;
    if (re && re !== "default" && re !== "none") body.reasoning_effort = String(re);

    // 超时控制：AbortController 在 timeoutMs 后中断请求，按失败走兜底 + 退避，
    // 避免网关无响应时 clip 永久挂在 pending、占着并发位。
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20000;
    var fetchOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (opts.apiKey || ""),
      },
      body: JSON.stringify(body),
    };
    var timer = null;
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      var ac = new AbortController();
      fetchOpts.signal = ac.signal;
      timer = setTimeout(function () {
        try {
          ac.abort();
        } catch (e) {}
      }, timeoutMs);
    }

    var resp;
    try {
      resp = await fetchImpl(url, fetchOpts);
    } catch (e) {
      if (timer) clearTimeout(timer);
      // AbortError（超时）与网络异常统一抛出，调用方兜底显示原文
      var aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
      throw new Error(aborted ? "translate timeout (" + timeoutMs + "ms)" : "translate network error: " + (e && e.message ? e.message : e));
    }
    if (timer) clearTimeout(timer);

    if (!resp.ok) {
      var errText = "";
      try {
        errText = await resp.text();
      } catch (e) {}
      // HTTP 429（限流）单独打标，便于自适应 gate 识别并降并发（第3层）。
      var httpErr = new Error("translate HTTP " + resp.status + " " + (errText || "").slice(0, 200));
      if (resp.status === 429) httpErr.code = "429";
      throw httpErr;
    }

    var data = await resp.json();
    return data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  }
  /** 拼接 base 和 path，避免重复/缺失斜杠 */
  function joinUrl(base, path) {
    var b = String(base || "").replace(/\/+$/, "");
    var p = String(path || "").replace(/^\/+/, "");
    return b + "/" + p;
  }

  /* ---------------------------------------------------------------
   * 5. clip 切分（边播边翻的预取单元）
   * ------------------------------------------------------------- */

  /**
   * 把 cue 列表按时间切成 clip（默认 60 秒一个）。
   * 一条 cue 归属到它 start 所在的 clip。返回 clip 数组：
   * { index, startMs, endMs, cues: cue[] }。
   * 注意：按硬时间格切会把跨边界的句子切到两个 clip 各翻一次，浪费 token。
   * 推荐用 sliceClipsByCue（按 cue 边界就近切，不在句子中间断）。
   */
  function sliceClips(cues, clipMs) {
    var size = clipMs && clipMs > 0 ? clipMs : 60000;
    var clips = [];
    for (var i = 0; i < cues.length; i++) {
      var idx = Math.floor(cues[i].start / size);
      if (!clips[idx]) {
        clips[idx] = { index: idx, startMs: idx * size, endMs: (idx + 1) * size, cues: [] };
      }
      clips[idx].cues.push(cues[i]);
    }
    // 去掉空洞，返回紧凑数组（保留原 index 字段）
    return clips.filter(Boolean);
  }

  /**
   * 按 cue 边界切 clip：累积 cue 直到时长达到 ~targetMs，就在当前 cue 之后断开。
   * 绝不把一条 cue 切到两个 clip，clip 之间不重叠、不重复 → 省 token。
   * opts（可选，v0.4.2 首包打磨）：
   *  - firstTargetMs: 仅第 0 个 clip 使用的更短目标时长（压 TTFT）。
   *  - maxCuesPerClip: 每 clip 最多 cue 条数软上限（0=关）。
   *  - maxSourceChars: 每 clip 源文字符软上限（0=关）。
   * 软上限都只在 cue 边界生效，单条超长 cue 仍整条进 clip。
   * 返回 clip 数组：{ index, startMs, endMs, cues, startIndex }（index 从 0 连续）。
   * startMs 用该 clip 第一条 cue 的 start（稳定，可做缓存 key 的一部分）。
   */
  function sliceClipsByCue(cues, targetMs, opts) {
    opts = opts || {};
    var defaultSize = targetMs && targetMs > 0 ? targetMs : 30000;
    // 首 clip 可用更短目标压 TTFT；非法/缺失则回落 defaultSize。
    var firstSize = opts.firstTargetMs != null ? Number(opts.firstTargetMs) : defaultSize;
    if (!Number.isFinite(firstSize) || firstSize <= 0) firstSize = defaultSize;
    var maxCues = opts.maxCuesPerClip != null ? Number(opts.maxCuesPerClip) : 0;
    if (!Number.isFinite(maxCues) || maxCues < 0) maxCues = 0;
    maxCues = Math.floor(maxCues);
    var maxChars = opts.maxSourceChars != null ? Number(opts.maxSourceChars) : 0;
    if (!Number.isFinite(maxChars) || maxChars < 0) maxChars = 0;
    maxChars = Math.floor(maxChars);

    var clips = [];
    var i = 0;
    var n = (cues || []).length;
    while (i < n) {
      var size = clips.length === 0 ? firstSize : defaultSize;
      var startMs = cues[i].start;
      var group = [];
      var startIndex = i;
      var charCount = 0;
      while (i < n) {
        group.push(cues[i]);
        charCount += String(cues[i].content == null ? "" : cues[i].content).length;
        var spanned = cues[i].end - startMs;
        i++;
        // 达到目标时长就收尾（至少 1 条）；下一条另起 clip
        if (spanned >= size) break;
        // 软上限：只在 cue 边界断开，绝不切碎单条 cue
        if (maxCues > 0 && group.length >= maxCues) break;
        if (maxChars > 0 && charCount >= maxChars) break;
      }
      clips.push({
        index: clips.length,
        startMs: startMs,
        endMs: group[group.length - 1].end,
        cues: group,
        startIndex: startIndex,
      });
    }
    return clips;
  }

  /**
   * 预取队列重排：保证 currentIdx 在队首先发起（抢信号量 + 网关首包）。
   * plan 中其余下标保持相对顺序；current 不在 plan 时原样返回。
   */
  function prioritizePrefetch(plan, currentIdx) {
    if (!plan || !plan.length) return [];
    var cur = Number(currentIdx);
    if (!Number.isFinite(cur)) return plan.slice();
    cur = Math.floor(cur);
    var head = [];
    var tail = [];
    var seen = false;
    for (var i = 0; i < plan.length; i++) {
      var v = plan[i];
      if (!seen && v === cur) {
        head.push(v);
        seen = true;
      } else {
        tail.push(v);
      }
    }
    return seen ? head.concat(tail) : plan.slice();
  }

  /* ---------------------------------------------------------------
   * 5b. 预取计划（纯函数）：从当前 clip 起预取 ahead 段（滑动窗口）
   * -------------------------------------------------------------
   * 真根因（修正原 brief 的误诊）：预取本就是 1.5s 循环持续在跑、clip0 在
   * t=0 就开翻——不是"跨 clip 才触发"。真正卡顿在于：单 clip 的翻译延迟可能
   * > 单 clip 的播放时长(clipSeconds)。只提前一段(depth=1)时，depth-1 的窗口
   * 一旦落后就永远差一段——播到第 2-3 个 clip 边界(≈1 分钟)正好暴露，与用户
   * 实测吻合。把预取做成"滑动窗口 depth=2(clamped)"：返回 [idx, idx+1, idx+2]，
   * 调用方对每个下标各自独立发起 translateClip，"下下个"不被"下一个还 pending"阻塞。
   * 注意：更深的窗口必须配合【全局 in-flight 信号量】(makeSemaphore)封顶，否则
   * idx/idx+1/idx+2 各自 concurrency=3 → ~9 并发 → 429 → 退避 → 更卡。
   */
  var PREFETCH_AHEAD = 3; // 预取提前段数（当前段 + 后续 3 段）。再深需配合全局并发上限。

  // 当前段剩余播放时间低于此阈值时，动态多预取 1 段（追平被限速拖慢的窗口）。
  var PREFETCH_DEEPEN_MS = 15000;

  /**
   * 计算从 currentIdx 起需要预取的 clip 下标列表（含 currentIdx 自身）。
   *  - currentIdx: 当前播放位置所在 clip 下标。
   *  - clipCount: clip 总数（用于裁越界）。
   *  - ahead: 提前段数，默认 PREFETCH_AHEAD；负数/非法回落默认；0 表示只翻当前段。
   *  - opts: 可选。{ remainMsInCurrent } —— 当前段剩余播放时间（ms）。当其
   *          < PREFETCH_DEEPEN_MS(15000) 时，额外多预取 1 段（depth+1，上限不超过
   *          clipCount），让接近段尾时自动加深窗口。不传 opts 时行为与旧版完全一致。
   * 返回升序、已裁越界的下标数组。currentIdx 越界/clipCount<=0 时返回 []。
   */
  function planPrefetch(currentIdx, clipCount, ahead, opts) {
    var n = Number(clipCount);
    if (!Number.isFinite(n) || n <= 0) return [];
    var idx = Number(currentIdx);
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.floor(idx);
    if (idx < 0) idx = 0;
    if (idx >= n) return []; // 当前下标越界 → 无可预取
    var depth = Number(ahead);
    if (!Number.isFinite(depth) || depth < 0) depth = PREFETCH_AHEAD;
    depth = Math.floor(depth);
    // 动态加深：接近当前段段尾（剩余播放时间不足）时多预取 1 段。
    if (opts && opts.remainMsInCurrent != null) {
      var remain = Number(opts.remainMsInCurrent);
      if (Number.isFinite(remain) && remain < PREFETCH_DEEPEN_MS) depth += 1;
    }
    var out = [];
    for (var i = idx; i <= idx + depth && i < n; i++) out.push(i);
    return out;
  }

  /* ---------------------------------------------------------------
   * 5c. 全局并发信号量（跨 clip 的 in-flight 请求上限）
   * -------------------------------------------------------------
   * 滑动窗口预取(depth=3)会让 idx..idx+3 几乎同时各自发起翻译。每个 clip 现在
   * 一次 translateClipLines = 一个请求。若不封顶，瞬时并发可达 ~4+，足以触发网关
   * 429 → 退避 → 反而更卡。这里提供一个进程级（每个内容脚本
   * 实例一个）的小信号量：所有 clip 的所有批请求都先 acquire 一个令牌再发，
   * 发完 release。在全局 cap 下，滑动窗口仍能尽量保持最大领先，但绝不冲垮网关。
   * 纯逻辑、无定时器、可离线单测：用 Promise 队列实现"超额则排队等令牌"。
   */

  /**
   * 造一个并发信号量。
   *  - max: 同时允许的最大令牌数（<=0 视为 1）。
   * 返回 { run(fn), acquire(), release(), get inFlight(), get max(), get queued() }。
   *  - run(fn): 等到有令牌后执行 fn()（可返回 Promise），结束(成功/抛错)自动 release。
   *            这是给翻译请求用的入口——把单次请求包进来即受全局上限约束。
   */
  function makeSemaphore(max) {
    var cap = Number(max);
    if (!Number.isFinite(cap) || cap < 1) cap = 1;
    cap = Math.floor(cap);
    var inFlight = 0;
    var waiters = []; // 等令牌的 resolve 队列（FIFO）

    function acquire() {
      if (inFlight < cap) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        waiters.push(resolve);
      });
    }

    function release() {
      if (waiters.length > 0) {
        // 把令牌直接转交给下一个等待者（inFlight 维持不变）
        var next = waiters.shift();
        next();
      } else if (inFlight > 0) {
        inFlight--;
      }
    }

    function run(fn) {
      return acquire().then(function () {
        var p;
        try {
          p = Promise.resolve(fn());
        } catch (e) {
          release();
          throw e;
        }
        return p.then(
          function (v) {
            release();
            return v;
          },
          function (e) {
            release();
            throw e;
          }
        );
      });
    }

    return {
      run: run,
      acquire: acquire,
      release: release,
      get inFlight() {
        return inFlight;
      },
      get max() {
        return cap;
      },
      get queued() {
        return waiters.length;
      },
    };
  }

  /**
   * 把一个翻译错误归类为 gate 可消费的种类（第3层）。
   *  - "429"：HTTP 限流（chatCompletion 已在 err.code 或 message 打标）。
   *  - "timeout"：AbortController 超时（message 含 "timeout"）。
   *  - "other"：其余网络/HTTP 错误（不触发降并发）。
   */
  function errorKind(err) {
    if (!err) return "other";
    var msg = String(err.code || "") + " " + String(err.message || err);
    if (/\b429\b/.test(msg)) return "429";
    if (/timeout/i.test(msg)) return "timeout";
    return "other";
  }

  /**
   * 自适应并发 gate（第3层，治根因诱因）：在 makeSemaphore 基础上让 cap 可变。
   *  - 初始 cap = max；下限 min（>=1）。
   *  - run(fn)：同信号量，acquire 时若 inFlight 已达当前 cap 则排队。
   *  - reportError("429"|"timeout")：cap 减半(向下取整，不低于 min)，并进入冷却窗口
   *    （冷却期内成功不计入恢复，避免抖动）。其余 kind 不降并发。
   *  - 连续 N 次成功(默认 8)且不在冷却 → cap +1（不超过 max），并清零成功计数。
   *  - cap 缩小时不强杀在途请求；只是 acquire 处用当前 cap 卡新令牌，多出的自然 drain。
   * 暴露 cap() 只读当前上限，便于单测同步断言。
   */
  function makeAdaptiveGate(opts) {
    opts = opts || {};
    var max = toInt(opts.max, 4);
    if (max < 1) max = 1;
    var min = toInt(opts.min, 1);
    if (min < 1) min = 1;
    if (min > max) min = max;
    var recoverAfter = opts.recoverAfter > 0 ? Math.floor(opts.recoverAfter) : 8;
    var cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : 5000;

    var cap = max;
    var inFlight = 0;
    var waiters = [];
    var okStreak = 0;
    var coolUntil = 0;

    function pump() {
      // 有空位且有等待者 → 放行
      while (inFlight < cap && waiters.length > 0) {
        var next = waiters.shift();
        inFlight++;
        next();
      }
    }
    function acquire() {
      if (inFlight < cap) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        waiters.push(resolve);
      });
    }
    function release() {
      if (inFlight > 0) inFlight--;
      pump();
    }
    function recordSuccess(now) {
      now = now != null ? now : Date.now();
      if (now < coolUntil) return; // 冷却期内不计入恢复
      okStreak++;
      if (okStreak >= recoverAfter) {
        okStreak = 0;
        if (cap < max) {
          cap++;
          pump();
        }
      }
    }
    function reportError(kind, now) {
      now = now != null ? now : Date.now();
      if (kind !== "429" && kind !== "timeout") return;
      okStreak = 0;
      coolUntil = now + cooldownMs;
      var next = Math.floor(cap / 2);
      if (next < min) next = min;
      cap = next;
      // cap 缩小不主动放行；在途 release 时按新 cap 自然收敛
    }
    function run(fn) {
      return acquire().then(function () {
        var p;
        try {
          p = Promise.resolve(fn());
        } catch (e) {
          release();
          throw e;
        }
        return p.then(
          function (v) {
            recordSuccess();
            release();
            return v;
          },
          function (e) {
            release();
            throw e;
          }
        );
      });
    }
    return {
      run: run,
      reportError: reportError,
      recordSuccess: recordSuccess,
      cap: function () {
        return cap;
      },
      get max() {
        return cap;
      },
      get inFlight() {
        return inFlight;
      },
      get queued() {
        return waiters.length;
      },
    };
  }

  /* ---------------------------------------------------------------
   * 6. 持久缓存 key + LRU 裁剪
   * ------------------------------------------------------------- */

  /**
   * 生成缓存 key：videoId + 轨道 code + 目标语言 + model + clip 起始毫秒。
   * 同一视频/轨道/语言/模型下，clip 起点稳定 → 重看/拖回/刷新可命中不重翻。
   */
  function makeCacheKey(parts) {
    parts = parts || {};
    return [
      "dsc",
      parts.videoId || "",
      parts.trackCode || "",
      parts.targetLang || "",
      parts.apiModel || "",
      parts.clipStartMs != null ? parts.clipStartMs : "",
    ].join("|");
  }

  /**
   * LRU 裁剪缓存对象（防止 chrome.storage.local 配额溢出）。
   * cacheObj: { key: { t:写入时间戳, lines:string[] } }。
   * 超过 maxEntries 时按 t 升序淘汰最旧的。返回新对象（不改入参）。
   */
  function pruneCache(cacheObj, maxEntries) {
    var max = maxEntries && maxEntries > 0 ? maxEntries : 800;
    var keys = Object.keys(cacheObj || {});
    if (keys.length <= max) return Object.assign({}, cacheObj);
    keys.sort(function (a, b) {
      return (cacheObj[a].t || 0) - (cacheObj[b].t || 0);
    });
    var drop = keys.length - max;
    var out = {};
    for (var i = drop; i < keys.length; i++) out[keys[i]] = cacheObj[keys[i]];
    return out;
  }

  /* ---------------------------------------------------------------
   * 7. 失败退避：连续失败 N 次后停止自动重试
   * ------------------------------------------------------------- */

  /**
   * 造一个退避控制器（每个 clip 一个）。
   *  - shouldTry(now): 是否允许此刻发起翻译（未到下次允许时间且未超上限）。
   *  - fail(now): 记一次失败，指数退避下次允许时间，超 maxFails 永久停。
   *  - reset(): 用户改配置/手动重试时恢复。
   */
  function makeBackoff(opts) {
    opts = opts || {};
    var maxFails = opts.maxFails != null ? opts.maxFails : 4;
    var baseMs = opts.baseMs != null ? opts.baseMs : 2000;
    var maxMs = opts.maxMs != null ? opts.maxMs : 60000;
    var fails = 0;
    var nextAt = 0;
    var stopped = false;
    return {
      shouldTry: function (now) {
        now = now != null ? now : Date.now();
        if (stopped) return false;
        return now >= nextAt;
      },
      fail: function (now) {
        now = now != null ? now : Date.now();
        fails++;
        if (fails >= maxFails) {
          stopped = true;
          return;
        }
        var delay = Math.min(maxMs, baseMs * Math.pow(2, fails - 1));
        nextAt = now + delay;
      },
      reset: function () {
        fails = 0;
        nextAt = 0;
        stopped = false;
      },
      get fails() {
        return fails;
      },
      get stopped() {
        return stopped;
      },
    };
  }
  /* ---------------------------------------------------------------
   * 9. 运行时占用优化：二分查找当前 cue + cue→clip 映射
   * -------------------------------------------------------------
   * 渲染 tick 高频触发，原来每次线性扫整个 clip 的 cues 找命中。这里提供
   * O(log n) 二分 + "上次命中下标"提示，使大多数相邻 tick 退化为 O(1)。
   * 纯函数，便于离线单测。cues 必须按 start 升序（cleanupCues 已保证）。
   */

  /**
   * 找 ms 命中哪条 cue（cue.start <= ms < cue.end）。
   *  - cues: 按 start 升序的 cue[]。
   *  - hint: 上次命中的下标（可选）。先看 hint 及其相邻是否仍命中（O(1)），
   *          不中再二分。
   * 返回命中下标；ms 落在两条 cue 的间隙（无字幕）或越界时返回 -1。
   */
  /**
   * 渲染一个单元时的「译文未到」指示标记（纯函数，v0.3.1 治症状1「永久翻译中」）。
   * 入参：translation（该渲染单元译文，null/"" = 无译文）、clipState（所属 clip 状态）。
   * 返回 { pending, failed }：
   *  - 有译文 → 都 false（正常显示译文）。
   *  - 无译文 + clipState==="failed"(达 maxFails 终态) → failed=true（显「翻译失败」）。
   *  - 无译文 + 未结案(clipState 为 undefined=尚未翻 / "pending"=正在翻) → pending=true（显「翻译中…」）。
   *  - 无译文 + 已结案("done"/"error"：该行属覆盖缺口或降级，译文确实没有) → 都 false（优雅显原文）。
   *    这是关键：旧逻辑 `trans==null && st!=="error" && st!=="failed"` 会让一个 done 但某行缺译文的
   *    clip 永久 pending（UI 永久「翻译中…」）。"done" 已结案 → 不再转圈。
   */
  function clipDisplayFlags(translation, clipState) {
    var hasTrans = translation != null && translation !== "";
    if (hasTrans) return { pending: false, failed: false };
    if (clipState === "failed") return { pending: false, failed: true };
    if (clipState == null || clipState === "pending") return { pending: true, failed: false };
    return { pending: false, failed: false };
  }

  function findCueIndexAt(cues, ms, hint) {
    var n = (cues || []).length;
    if (!n) return -1;
    // 快路径：先验证 hint 及相邻下标（连续播放时命中率极高）
    if (hint != null && hint >= 0 && hint < n) {
      if (ms >= cues[hint].start && ms < cues[hint].end) return hint;
      var nx = hint + 1;
      if (nx < n && ms >= cues[nx].start && ms < cues[nx].end) return nx;
    }
    // 二分：找最后一个 start <= ms 的 cue
    var lo = 0;
    var hi = n - 1;
    var cand = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= ms) {
        cand = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cand === -1) return -1; // ms 在第一条 cue 之前
    return ms < cues[cand].end ? cand : -1; // 落在间隙里则不命中
  }

  /**
   * 由 clip 列表构造一个"全局 cue 下标 → {clipIdx, cueIdxInClip}"的映射数组。
   * clip 内的 cues 是原始 cues 的连续切片（sliceClipsByCue 保证），所以可一次
   * 遍历建表。渲染时用 findCueIndexAt 拿到全局下标后 O(1) 反查所属 clip。
   * 返回长度 = 总 cue 数的数组，元素 { clipIdx, cueIdx }。
   */
  function cueClipIndexMap(clips) {
    var map = [];
    if (!Array.isArray(clips)) return map;
    for (var ci = 0; ci < clips.length; ci++) {
      var cs = clips[ci].cues || [];
      for (var k = 0; k < cs.length; k++) {
        map.push({ clipIdx: ci, cueIdx: k });
      }
    }
    return map;
  }

  /* ---------------------------------------------------------------
   * 10. 配置导入 / 导出（换机器、重装免重填）
   * -------------------------------------------------------------
   * 导出：把当前配置序列化为带版本号的 JSON 文本（含 apiKey，调用方需提示用户）。
   * 导入：解析 JSON，只接受 DEFAULT_CONFIG 已知的键，类型不符的回落默认。
   * 纯函数（不碰 storage/DOM），round-trip 后配置应等价。
   */
  function exportConfig(config) {
    var out = {};
    var keys = Object.keys(DEFAULT_CONFIG);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out[k] = config && config[k] != null ? config[k] : DEFAULT_CONFIG[k];
    }
    return JSON.stringify({ __dualsub: 1, config: out }, null, 2);
  }

  /**
   * 解析导入文本，返回 { ok, config?, error? }。
   * 兼容两种格式：{__dualsub,config} 包裹 或 直接的扁平配置对象。
   * 只挑 DEFAULT_CONFIG 已知键，并按默认值类型做最小校验（数字/布尔/字符串）。
   */
  function importConfig(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: "JSON 解析失败：" + (e && e.message ? e.message : e) };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "内容不是有效的配置对象" };
    }
    var src = parsed.config && typeof parsed.config === "object" ? parsed.config : parsed;
    var out = Object.assign({}, DEFAULT_CONFIG);
    var keys = Object.keys(DEFAULT_CONFIG);
    var any = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (src[k] == null) continue;
      var def = DEFAULT_CONFIG[k];
      var v = src[k];
      if (typeof def === "number") {
        // 用 Number 而非 parseInt：保留小数字段（如 strokeWidth=1.2）；整数字段不受影响。
        var num = Number(v);
        if (Number.isFinite(num)) {
          out[k] = num;
          any = true;
        }
      } else if (typeof def === "boolean") {
        out[k] = !!v;
        any = true;
      } else {
        out[k] = String(v);
        any = true;
      }
    }
    if (!any) return { ok: false, error: "未找到任何可识别的配置字段" };
    return { ok: true, config: out };
  }

  /* ---------------------------------------------------------------
   * 导出双语 .srt（任务 B1）：复用实时翻译已产出的渲染单元，离线纯函数生成。
   * ------------------------------------------------------------- */

  /** 毫秒 → SRT 时间戳 `HH:MM:SS,mmm`（借鉴 srt 程序 srt_utils.format_time，补零）。 */
  function formatSrtTime(ms) {
    var t = Math.max(0, Math.round(Number(ms) || 0));
    var msPart = t % 1000;
    var totalSec = Math.floor(t / 1000);
    var sec = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60);
    var min = totalMin % 60;
    var hr = Math.floor(totalMin / 60);
    function p2(x) { return (x < 10 ? "0" : "") + x; }
    function p3(x) { return (x < 10 ? "00" : x < 100 ? "0" : "") + x; }
    return p2(hr) + ":" + p2(min) + ":" + p2(sec) + "," + p3(msPart);
  }

  /**
   * 由渲染单元生成合法 SRT 字符串（任务 B1）。
   * 入参：
   *  - renderUnits: [{ startMs|start, endMs|end, originalText, translation }]
   *    （兼容 isolated.js 的 start/end 命名与句级的 startMs/endMs）
   *  - opts.mode: "bilingual_orig_top" | "bilingual_trans_top" | "only_translated"
   *      默认 bilingual_orig_top（原文在上、译文在下）。
   * 行为：
   *  - 按 startMs 升序稳定排序；序号从 1 递增；时间 `HH:MM:SS,mmm --> ...`。
   *  - 译文为空：bilingual 两种 mode 只输出原文（不重复空行）；only_translated 回退原文。
   *  - 原文与译文都空的单元跳过（不产出空块）。
   * 返回：SRT 文本字符串（块间空行分隔，末尾换行）。
   */
  function buildSrt(renderUnits, opts) {
    opts = opts || {};
    var mode = opts.mode || "bilingual_orig_top";
    var units = (renderUnits || [])
      .map(function (u, i) {
        return {
          startMs: u.startMs != null ? u.startMs : u.start,
          endMs: u.endMs != null ? u.endMs : u.end,
          originalText: collapseWhitespace(u.originalText || ""),
          translation: collapseWhitespace(u.translation || ""),
          _i: i, // 稳定排序的兜底键（startMs 相等时保持原序）
        };
      })
      .filter(function (u) {
        return u.originalText || u.translation;
      });

    units.sort(function (a, b) {
      var d = (a.startMs || 0) - (b.startMs || 0);
      return d !== 0 ? d : a._i - b._i;
    });

    var blocks = [];
    var seq = 0;
    for (var k = 0; k < units.length; k++) {
      var u = units[k];
      var orig = u.originalText;
      var trans = u.translation;
      var textLines;
      if (mode === "only_translated") {
        // 仅译文；译文空回退原文（不丢内容）
        textLines = [trans || orig];
      } else if (mode === "bilingual_trans_top") {
        textLines = trans ? [trans, orig].filter(Boolean) : [orig];
      } else {
        // bilingual_orig_top（默认）
        textLines = trans ? [orig, trans].filter(Boolean) : [orig];
      }
      textLines = textLines.filter(function (l) {
        return l && l.length;
      });
      if (!textLines.length) continue;
      seq++;
      blocks.push(
        seq +
          "\n" +
          formatSrtTime(u.startMs) +
          " --> " +
          formatSrtTime(u.endMs) +
          "\n" +
          textLines.join("\n")
      );
    }
    return blocks.length ? blocks.join("\n\n") + "\n" : "";
  }
  var EXPORTS = {
    parseJson3: parseJson3,
    parseVtt: parseVtt,
    cleanupCues: cleanupCues,
    resegmentCues: resegmentCues,
    collapseWhitespace: collapseWhitespace,
    normalizeColor: normalizeColor,
    shadowCss: shadowCss,
    normalizeStrokeWidth: normalizeStrokeWidth,
    migrateConfig: migrateConfig,
    computeFontPx: computeFontPx,
    planPrefetch: planPrefetch,
    prioritizePrefetch: prioritizePrefetch,
    makeSemaphore: makeSemaphore,
    makeAdaptiveGate: makeAdaptiveGate,
    errorKind: errorKind,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    buildSystemPrompt: buildSystemPrompt,
    buildNumberedSourceLines: buildNumberedSourceLines,
    parseSubtitleLines: parseSubtitleLines,
    sanitizeSubtitleLine: sanitizeSubtitleLine,
    mergeShortLines: mergeShortLines,
    mergeDanglingLines: mergeDanglingLines,
    splitLongLines: splitLongLines,
    charLen: charLen,
    layoutTimeline: layoutTimeline,
    buildClipUnits: buildClipUnits,
    translateClipLines: translateClipLines,
    chatCompletion: chatCompletion,
    sliceClips: sliceClips,
    sliceClipsByCue: sliceClipsByCue,
    makeCacheKey: makeCacheKey,
    pruneCache: pruneCache,
    makeBackoff: makeBackoff,
    joinUrl: joinUrl,
    findCueIndexAt: findCueIndexAt,
    clipDisplayFlags: clipDisplayFlags,
    cueClipIndexMap: cueClipIndexMap,
    exportConfig: exportConfig,
    importConfig: importConfig,
    formatSrtTime: formatSrtTime,
    buildSrt: buildSrt,
  };

  return EXPORTS;
});
