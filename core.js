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
    systemPrompt: "", // 空 = 用 core 默认（逐行兜底路径的 prompt）
    sentencePrompt: "", // 空 = 用 core 句级重断默认 prompt（主路径：句级语义重断 + 翻译）
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
    clipSeconds: 30, // 每个翻译 clip 多少秒（按 cue 边界就近切）
    batchLines: 14, // 每批最多多少行（clip 内再分批）。瘦身 prompt 后调高省固定开销
    contextLines: 3, // 每批携带的「前 N 条原文」作为上下文（不翻译、不计入对齐）。
    //                  跨批不再孤立翻译：模型可借上下文理解碎片/指代/话题连贯。0=关闭。
    globalConcurrency: 4, // 跨 clip 的全局 in-flight 翻译请求上限（信号量）。滑动窗口预取
    //                       (depth=2)叠加批内并发(3)若不封顶会冲垮网关→429；此值统一封顶。
    tailTrimMs: 120, // 句间视觉尾缩(ms)：连续语流句单元 end 回缩此值制造句间断点(修字幕墙)。
    //                  0=关闭。仅长句(duration>2×)缩，缩后保留 >=300ms 可视；真停顿不受影响。
    maxCharsPerScreen: 20, // 长句分段：单屏最多译文字符数(CJK 约 20)。超过按标点切成多段分屏滚动。
    //                       0 或极大值=关闭分段（向后兼容）。
    maxDurPerScreen: 4000, // 长句分段：单屏最长时长(ms)。超过即使字数不多也按标点切分，避免久不动。
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
   * 4. 翻译：分批 + 上下文 + 按行号对齐
   * -------------------------------------------------------------
   * 核心策略（brief 已验证质量好）：
   *  - 绝不逐句翻译。把一批 cue 拼成带行号的文本一次性发给 LLM。
   *  - system prompt 要求模型先在脑内恢复标点/合并碎片理解语义，
   *    但输出严格"每个输入行号一行译文，行号和行数完全一致"。
   *  - 拿回结果后按行号对齐回各 cue。行数/行号不匹配时做兜底。
   */

  // 默认 system prompt（{TARGET_LANG} 会被替换为目标语言）
  // ⚠️ 取舍说明（经 Jay 确认，推翻原来"砍到 509→3 句"的省 token 决策）：
  //   之前为省 token 把 prompt 砍到只剩 3 句，结果译文翻译腔重、不连贯，明显逊于
  //   沉浸式翻译/sider 类原版。根因不是模型弱，是策略砍太狠——模型只能逐行硬译。
  //   这里有意把固定开销加回来换质量：给足口语化/连贯性/语序自由/术语约束。
  // 硬约束（绝不能动，否则破坏逐行→时间轴对齐）：每个输入行号对应输出同一行号的
  //   一行译文、行号与行数完全一致、只输出译文。其余是质量引导。
  var DEFAULT_SYSTEM_PROMPT =
    "You are translating video subtitles into natural, fluent {TARGET_LANG}. " +
    "Write the way a native speaker actually speaks: colloquial, smooth, easy to read. " +
    "Avoid stiff word-for-word translation, literal translationese, or bookish phrasing.\n" +
    "Use the surrounding context lines to understand fragments, resolve pronouns and references, " +
    "and keep the topic coherent across lines. The text comes from speech recognition, so a line " +
    "may lack punctuation or be cut mid-sentence; mentally restore the meaning before translating.\n" +
    "You may freely reorder words and rephrase WITHIN each line so the {TARGET_LANG} reads naturally — " +
    "do not translate word by word. But every input line number must map to exactly one output line " +
    "with the SAME number; never merge, split, drop, or reorder the lines themselves.\n" +
    "Keep proper nouns, names, and technical terms sensible: preserve them or use the common accepted " +
    "translation, do not invent odd renderings.\n" +
    "Output format (strict): one translation per input line, prefixed with its original line number, " +
    "line count identical to the input. Output ONLY the translations — no explanations, no source text, " +
    "no extra commentary.";

  function buildSystemPrompt(targetLang, customPrompt) {
    var tpl = customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "the target language");
  }

  /* ---------------------------------------------------------------
   * 句级语义重断（主路径）：让 LLM 一次调用同时把无标点 ASR 碎片
   * 重组成完整句子 + 翻译，并标注每句覆盖的源行号范围，供时间轴回映。
   * 输出协议（每行一条，固定三段分隔）：
   *   [3-5] ||| Restored full sentence. ||| 重组后的完整译文。
   * 解析器（parseSentenceResponse）容忍单行号 [3]、范围 [3-5]、多余空白。
   * 覆盖性校验（alignSentences）：源行号必须连续覆盖全部输入行、不重叠/不遗漏，
   * 否则标记 fallback，由调用方退回逐行对齐路径（保留旧 alignTranslations）。
   * ------------------------------------------------------------- */

  // 在前置任务（口语/连贯/语序自由/术语约束）基础上扩展为「句级重断 + 翻译」。
  var DEFAULT_SENTENCE_SYSTEM_PROMPT =
    "You restore and translate auto-generated video subtitles. " +
    "You will receive numbered subtitle fragments from speech recognition: they have NO punctuation " +
    "and are often cut mid-sentence or merged across sentences.\n" +
    "Your job, in ONE pass:\n" +
    "1. Regroup the consecutive fragments into complete, natural sentences and restore punctuation.\n" +
    "2. For each restored sentence, state which input line numbers it is built from, as a CONTIGUOUS range.\n" +
    "3. Translate each complete sentence into natural, fluent, colloquial {TARGET_LANG} — " +
    "the way a native speaker actually talks, never stiff word-for-word translationese.\n" +
    "Use neighbouring fragments as context to resolve pronouns, references and keep the topic coherent. " +
    "Keep proper nouns, names and technical terms sensible (preserve or use the common accepted translation).\n" +
    "Output format (STRICT): one restored sentence per line, exactly:\n" +
    "[startLine-endLine] ||| restored source sentence with punctuation ||| {TARGET_LANG} translation\n" +
    "A single-line sentence uses [n] (e.g. [4]). The ranges MUST be contiguous, in order, cover EVERY " +
    "input line exactly once, and never overlap or skip a line. " +
    "You MUST account for EACH input line number — every line from the first to the last must fall inside " +
    "exactly one range. Do NOT drop, merge away or ignore any line. Intelligently distribute the full " +
    "restored sentence and its translation across all the original line numbers it spans, so each source " +
    "line is represented; never collapse the whole input into one giant range when it is really several " +
    "sentences. Output ONLY these lines — no commentary, no blank lines, no source echo outside the middle field.";

  function buildSentenceSystemPrompt(targetLang, customPrompt) {
    var tpl =
      customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SENTENCE_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "the target language");
  }

  /**
   * 把碎片 cue 拼成带行号的 user message（句级重断用）。
   * 与 buildNumberedBatch 同构（"1. xxx"），单独留一个函数便于将来差异化。
   */
  function buildNumberedSourceLines(lines) {
    return (lines || [])
      .map(function (t, i) {
        return i + 1 + ". " + collapseWhitespace(t);
      })
      .join("\n");
  }

  /**
   * 解析句级重断模型输出，返回记录数组：
   *   [{ srcStart, srcEnd, originalText, translation }]
   * 每行格式 `[范围] ||| 原文句 ||| 译文`，容忍：
   *  - 单行号 [3] → srcStart=srcEnd=3；范围 [3-5] / [3 - 5]；
   *  - 三段分隔可有多余空白；分隔符固定为 |||。
   * 不做覆盖性校验（交给 alignSentences），只做语法解析。
   * 行号非法 / 段数不足的行直接跳过。
   */
  function parseSentenceResponse(text) {
    var out = [];
    if (typeof text !== "string") return out;
    var lines = text.replace(/\r/g, "").split("\n");
    // [n] 或 [a-b]（容忍内部空白与全角连字符）
    var rangeRe = /^\s*\[\s*(\d+)\s*(?:[-–—]\s*(\d+)\s*)?\]\s*(.*)$/;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(rangeRe);
      if (!m) continue;
      var a = parseInt(m[1], 10);
      var b = m[2] != null ? parseInt(m[2], 10) : a;
      if (!(a >= 1) || !(b >= a)) continue;
      // 范围已剥离，剩余形如「||| 原文 ||| 译文」（协议含范围后第一个分隔符）；
      // 容忍模型省略前导分隔符的「原文 ||| 译文」。先去掉可能的前导 |||，再按 ||| 切两段。
      var rest = (m[3] || "").replace(/^\s*\|\|\|\s*/, "");
      var parts = rest.split("|||");
      if (parts.length < 2) continue; // 至少要能切出 原文 + 译文
      var originalText = collapseWhitespace(parts[0]);
      // 译文取其后全部（极少数情况下译文自身含 ||| 时拼回分隔符）
      var translation = collapseWhitespace(parts.slice(1).join("|||"));
      if (!translation) continue;
      out.push({ srcStart: a, srcEnd: b, originalText: originalText, translation: translation });
    }
    return out;
  }

  /**
   * 本地轻量「按 n 份拆分一条译文」(借鉴 srt 程序 split_text_simple 思路，但纯本地不再调 API)。
   * 用途（A1 二次拆分回填）：句级模型把多个源行合并成 [a-b] 的一条长译文时，
   * 不立即整段退回逐行，先把这条译文近似拆成 (b-a+1) 份回填到各源行，时间轴更细。
   * 策略：优先按句末/逗号等标点切成片段；片段够则贪心按累计长度均衡聚成 n 组；
   *      标点不足则退化按字符长度近似等分（CJK 无空格也可切）。
   * 返回：长度 == n 的字符串数组；无法切出 n 份非空片段时返回 null（调用方退逐行兜底）。
   */
  function splitTranslation(text, n) {
    var s = collapseWhitespace(text);
    if (!s || !(n >= 1)) return null;
    if (n === 1) return [s];

    // 1) 先按标点（句末 / 逗号 / 顿号 / 分号，含中英）切片，保留标点在片尾。
    var segs = [];
    var re = /[^。！？\.!?；;，,、]+[。！？\.!?；;，,、]?/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var piece = collapseWhitespace(m[0]);
      if (piece) segs.push(piece);
    }
    if (segs.length === 0) segs = [s];

    // 2) 标点片段数 < n：再退化按字符近似等分（CJK 无空格场景）。
    if (segs.length < n) {
      segs = splitByLength(s, n);
      if (!segs) return null;
    }

    // 3) 片段数 >= n：贪心按累计长度把 segs 聚成正好 n 组（每组至少 1 片）。
    var total = 0;
    for (var i = 0; i < segs.length; i++) total += segs[i].length;
    var target = total / n;
    var groups = [];
    var buf = "";
    var acc = 0;
    for (var j = 0; j < segs.length; j++) {
      var remainSeg = segs.length - j;
      var remainGrp = n - groups.length;
      buf += segs[j];
      acc += segs[j].length;
      // 累计长度过半数边界，或必须给后面每组各留一片时，封一组（最多封 n-1 组，末组收尾）。
      var enough = acc >= target * (groups.length + 1);
      var forceSingle = remainSeg <= remainGrp;
      if ((enough || forceSingle) && groups.length < n - 1) {
        groups.push(buf);
        buf = "";
      }
    }
    if (buf) groups.push(buf);
    // 收尾对齐：若聚少了（最后一组吞太多），按需把最长组再砍；聚多了不可能(受 n-1 限制)。
    while (groups.length < n) {
      // 找最长组从中间按长度二分一次
      var idx = 0;
      for (var g = 1; g < groups.length; g++) if (groups[g].length > groups[idx].length) idx = g;
      var two = splitByLength(groups[idx], 2);
      if (!two) break;
      groups.splice(idx, 1, two[0], two[1]);
    }
    if (groups.length !== n) return null;
    for (var k = 0; k < groups.length; k++) {
      groups[k] = collapseWhitespace(groups[k]);
      if (!groups[k]) return null;
    }
    return groups;
  }

  /** 按字符长度把字符串近似等分成 n 份（每份非空）；不足以切出 n 份非空时返回 null。 */
  function splitByLength(text, n) {
    var s = collapseWhitespace(text);
    if (!s || s.length < n) return null;
    var out = [];
    var per = Math.floor(s.length / n);
    var pos = 0;
    for (var i = 0; i < n; i++) {
      var len = i === n - 1 ? s.length - pos : per;
      out.push(s.slice(pos, pos + len));
      pos += len;
    }
    for (var k = 0; k < out.length; k++) {
      out[k] = collapseWhitespace(out[k]);
      if (!out[k]) return null;
    }
    return out;
  }

  /**
   * 句级对齐：解析模型输出 + 覆盖性校验 + 时间轴回映。
   * 入参：
   *  - originalCues: 本次输入的碎片 cue[]（顺序即源行号 1..N，需带 start/end）。
   *  - modelText: 模型按句级协议输出的文本。
   * 返回：
   *   { ok, sentences, reason? }
   *   - ok=true：sentences = [{ srcStart, srcEnd, originalText, translation, startMs, endMs }]
   *     时间区间 = [首源行.start, 末源行.end]（按源 cue 推出）。
   *   - ok=false：覆盖性校验未过（漏行/重叠/越界/行数对不上/解析空）→ 调用方退回逐行对齐。
   *     reason 给出诊断（empty/gap/overlap/out-of-range/uncovered）。
   * 覆盖性规则（必须连续、覆盖全部、不重叠、不遗漏）：
   *   按 srcStart 排序后，第一条须从 1 开始，每条 srcStart == 上一条 srcEnd+1，
   *   末条 srcEnd == N。任一不满足即 ok=false。
   * A1 二次拆分回填（opts.splitFill=true 开启，默认关）：
   *   覆盖性通过后，对覆盖多源行的 [a-b] 记录（模型把多行合并成一条译文），
   *   不直接整段当一个粗时间轴单元，而是用 splitTranslation 把这条译文本地拆成
   *   (b-a+1) 份，逐份回填到各源行 → 渲染单元数 == 源行数，时间轴更细。
   *   任一记录拆不出对应份数 → 整体 ok=false(reason=split-fail)，调用方退逐行 fallback。
   */
  function alignSentences(originalCues, modelText, opts) {
    opts = opts || {};
    var cues = originalCues || [];
    var n = cues.length;
    if (!n) return { ok: false, sentences: [], reason: "empty-input" };

    var recs = parseSentenceResponse(modelText);
    if (!recs.length) return { ok: false, sentences: [], reason: "empty" };

    // 越界检查 + 排序（按 srcStart 升序，稳定）
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].srcStart < 1 || recs[i].srcEnd > n) {
        return { ok: false, sentences: [], reason: "out-of-range" };
      }
    }
    var sorted = recs.slice().sort(function (a, b) {
      return a.srcStart - b.srcStart;
    });

    // 覆盖性：从 1 连续到 N，逐条衔接、不重叠不遗漏
    var expect = 1;
    for (var j = 0; j < sorted.length; j++) {
      var r = sorted[j];
      if (r.srcStart !== expect) {
        return { ok: false, sentences: [], reason: r.srcStart < expect ? "overlap" : "gap" };
      }
      expect = r.srcEnd + 1;
    }
    if (expect !== n + 1) return { ok: false, sentences: [], reason: "uncovered" };

    // 时间轴回映：句区间 = [首源 cue.start, 末源 cue.end]
    if (!opts.splitFill) {
      var sentences = sorted.map(function (rec) {
        var first = cues[rec.srcStart - 1];
        var last = cues[rec.srcEnd - 1];
        return {
          srcStart: rec.srcStart,
          srcEnd: rec.srcEnd,
          originalText: rec.originalText,
          translation: rec.translation,
          startMs: first.start,
          endMs: last.end,
        };
      });
      return { ok: true, sentences: sentences };
    }

    // A1 二次拆分回填：把多源行 [a-b] 记录的合并译文本地拆成每行一份，回填到各源行。
    var units = [];
    for (var s = 0; s < sorted.length; s++) {
      var rec = sorted[s];
      var span = rec.srcEnd - rec.srcStart + 1;
      if (span === 1) {
        var c = cues[rec.srcStart - 1];
        units.push({
          srcStart: rec.srcStart,
          srcEnd: rec.srcStart,
          originalText: rec.originalText,
          translation: rec.translation,
          startMs: c.start,
          endMs: c.end,
        });
        continue;
      }
      var parts = splitTranslation(rec.translation, span);
      if (!parts) return { ok: false, sentences: [], reason: "split-fail" };
      for (var p = 0; p < span; p++) {
        var lineNo = rec.srcStart + p;
        var cue = cues[lineNo - 1];
        units.push({
          srcStart: lineNo,
          srcEnd: lineNo,
          // 回填后单位是源行：原文用该源行碎片，译文用拆出的对应份
          originalText: cue.content != null ? cue.content : rec.originalText,
          translation: parts[p],
          startMs: cue.start,
          endMs: cue.end,
        });
      }
    }
    return { ok: true, sentences: units };
  }

  /* ---------------------------------------------------------------
   * 长句智能分段（修「整句一屏堆 3-4 行 / splitFill 拦腰斩词」）
   * -------------------------------------------------------------
   * 句级重断后 LLM 常把多行 ASR 合并成一个很长的完整句（如 78 字、占屏 5.4s），
   * 整句一个渲染单元 → 软换行堆满画面、长时间不动；旧 splitFill 按字符数硬切又会把
   * 单词/数字拦腰斩断。这里按「单屏最多字数」硬上限把长句切成可读段，每段 <= cap，
   * 按字符占比线性分到它覆盖的时间窗，做成分屏滚动（到点切下一段）。
   * 切分语义（v0.2.2 起硬上限，非「只落标点」）：标点是优选切点；超长片段在内部按
   * 可读边界硬切（CJK 按字、拉丁词与数字成整体不斩断、实在超长的不可分原子按 cap 硬截）；
   * 每段 <= maxCharsPerScreen；无句中标点的长句也切；时长维度有最小段长/可视时长保护。
   */

  // 切点标点（句末 + 句中），命中处可断句；用于把长译文按可读片段切分。
  var SEGMENT_PUNCT_RE = /[^。！？．\.!?；;，,、…]+[。！？．\.!?；;，,、…]+/g;

  // 时长维度切分的下限保护（修「短句被切成单字闪烁」）：
  //  - SEG_MIN_VISIBLE_MS：每段至少可视这么久（ms），低于此不为凑时长再切。
  //  - segMinChars()：每段译文最小字符数 = max(2, ceil(cap/4))，随单屏上限自适应。
  // 时长维度只在「不破坏这两个下限」时才提高段数；短句宁可静止显示也不切碎。
  var SEG_MIN_VISIBLE_MS = 800;
  function segMinChars(cap) {
    return cap > 0 ? Math.max(2, Math.ceil(cap / 4)) : 2;
  }

  /**
   * 把一段文本按标点切成「原始片段」数组（保留标点在片尾、保留原字符不折叠）。
   * 末尾若有不带标点的残尾也作为一片。拼回所有片 === 原串（无丢字）。
   * 标点不足（整段无可切标点）→ 返回 [text]（单片，由上层决定是否退化按长度）。
   */
  function splitByPunctPieces(text) {
    var s = String(text == null ? "" : text);
    var pieces = [];
    var lastEnd = 0;
    var re = new RegExp(SEGMENT_PUNCT_RE.source, "g");
    var m;
    while ((m = re.exec(s)) !== null) {
      var end = re.lastIndex;
      // 不把数字间的小数点当切点（避免把 1.8 / v2.0 拦腰斩开）。
      var pc = s[end - 1];
      if ((pc === "." || pc === "．") && /[0-9]/.test(s[end - 2] || "") && /[0-9]/.test(s[end] || "")) {
        continue;
      }
      pieces.push(s.slice(lastEnd, end));
      lastEnd = end;
    }
    if (lastEnd < s.length) pieces.push(s.slice(lastEnd)); // 末尾无标点残尾
    if (!pieces.length) pieces.push(s);
    return pieces;
  }

  /**
   * 贪心把「标点片段」聚成若干组，使每组折叠后长度尽量 <= maxChars（至少 1 片/组，
   * 单片超长也不再切——绝不拦腰斩词）。返回折叠后的非空组字符串数组（>=1）。
   */
  /**
   * 判断单字符是否 CJK（中日韩，含假名/全角）。用于硬切时按字断行。
   */
  function isCJK(ch) {
    return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(ch);
  }

  /**
   * 把一段文本切成「原子」数组：CJK 单字成一原子；拉丁/数字串（含词内 . , :，
   * 保住 1.8 / 3,000 / v2.0）成一原子。空格不入原子（拉丁原子间重连时再补）。
   * 供 hardSplitPiece（硬切）与 splitOriginalIntoN（原文按占比均分）共用。
   */
  function tokenizeAtoms(s) {
    var atoms = [];
    var i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (ch === " ") { i++; continue; }
      if (isCJK(ch)) { atoms.push(ch); i++; continue; }
      // 拉丁/数字串：含数字/字母间的 . , : （保住 1.8 / 3,000 / v2.0）
      var j = i;
      while (j < s.length) {
        var c = s[j];
        if (c === " " || isCJK(c)) break;
        if ((c === "." || c === "," || c === ":") &&
            !(/[0-9A-Za-z]/.test(s[j - 1] || "") && /[0-9A-Za-z]/.test(s[j + 1] || ""))) break;
        j++;
      }
      if (j > i) { atoms.push(s.slice(i, j)); i = j; }
      else { atoms.push(s[i]); i++; }
    }
    return atoms;
  }

  /**
   * 把一个「超过 cap」的标点片段在内部按可读边界硬切成多块（每块 <= cap，无例外）。
   * 规则：CJK 按字可断；拉丁/数字串视为原子（绝不斩断词/数字/小数 1.8/版本 v2.0），
   * 拉丁原子之间用空格重连。单个不可分原子本身 > cap（URL/连写串）时降级：在原子内部
   * 按 cap 硬截成多块（字幕可读性 > 词完整性），保证每块 <= cap。
   */
  function hardSplitPiece(piece, cap) {
    var s = collapseWhitespace(piece);
    if (cap <= 0 || s.length <= cap) return [s];
    var atoms = tokenizeAtoms(s);
    var out = [];
    var buf = "";
    for (var k = 0; k < atoms.length; k++) {
      var a = atoms[k];
      // 单个原子本身就 > cap（实在切不动的 URL/连写串）→ 在原子内部按 cap 硬截。
      // 字幕可读性优先于词完整性：保证每段 <= cap，无例外。
      if (a.length > cap) {
        if (buf) { out.push(buf); buf = ""; }
        for (var off = 0; off < a.length; off += cap) out.push(a.slice(off, off + cap));
        continue;
      }
      var sep = (buf && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(a)) ? " " : "";
      var cand = buf + sep + a;
      if (buf && cand.length > cap) { out.push(buf); buf = a; }
      else { buf = cand; }
    }
    if (buf) out.push(buf);
    return out;
  }

  /**
   * 把整段译文切成「每段 <= cap」的可读段：先按标点切，再对超长片段硬切，
   * 最后把相邻小块在不超 cap 的前提下回粘（保可读）。cap<=0 = 不切。
   * 这是「单屏最多字数」的硬上限实现（标点是优选切点，不是唯一约束）。
   */
  function segmentTextByCap(trans, cap) {
    var s = collapseWhitespace(trans);
    if (cap <= 0 || s.length <= cap) return [s];
    var pieces = splitByPunctPieces(s);
    var segs = [];
    var buf = "";
    for (var p = 0; p < pieces.length; p++) {
      var sub = hardSplitPiece(pieces[p], cap);
      for (var q = 0; q < sub.length; q++) {
        var chunk = sub[q];
        var cand = buf ? buf + chunk : chunk;
        if (buf && collapseWhitespace(cand).length > cap) {
          segs.push(collapseWhitespace(buf));
          buf = chunk;
        } else {
          buf = cand;
        }
      }
    }
    if (collapseWhitespace(buf)) segs.push(collapseWhitespace(buf));
    return segs.length ? segs : [s];
  }

  function groupPiecesByLen(pieces, maxChars) {
    var cap = maxChars > 0 ? maxChars : Infinity;
    var groups = [];
    var buf = "";
    for (var i = 0; i < pieces.length; i++) {
      var pieceLen = collapseWhitespace(pieces[i]).length;
      var bufLen = collapseWhitespace(buf).length;
      // 当前组已非空、再加这片会超 cap → 先封一组
      if (buf && bufLen + pieceLen > cap) {
        groups.push(buf);
        buf = "";
      }
      buf += pieces[i];
    }
    if (collapseWhitespace(buf)) groups.push(buf);
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var c = collapseWhitespace(groups[g]);
      if (c) out.push(c);
    }
    return out.length ? out : [collapseWhitespace(pieces.join("")) || ""];
  }

  /**
   * 长句分段（纯函数，必导出）。
   * 入参：
   *  - unit: { startMs, endMs, originalText, translation, ... }（额外字段透传/忽略）
   *  - opts: { maxCharsPerScreen (默认 20，CJK 约 20 字), maxDurPerScreen (默认 4000ms) }
   * 行为（硬上限语义，v0.2.2 起；非旧版「只落标点」）：
   *  - translation 长度 <= maxCharsPerScreen 且 时长 <= maxDurPerScreen → 原样返回 [unit]（不分段）。
   *    maxCharsPerScreen<=0 或极大值 = 关闭分段（向后兼容）。
   *  - 否则把 translation 切成每段 <= maxCharsPerScreen 的可读段：标点是优选切点；超长片段
   *    在内部按可读边界硬切（CJK 按字、拉丁词与数字 1.8/v2.0 成整体不斩断、实在超长的不可分
   *    原子按 cap 硬截）；无句中标点的长句也切。每段 <= maxCharsPerScreen（无例外）。
   *  - 时长维度：段数不足以满足单屏最长时长时按时长提段数，但有下限保护——每段不短于
   *    segMinChars(cap) 字、不短于 SEG_MIN_VISIBLE_MS 可视，短句宁可静止显示也不切成单字。
   *  - originalText 同步切成同段数：标点足够按标点均衡聚组，否则按原子占比均分，每段都带
   *    对应原文片段（不再后段全空），拼回（去空格）无丢字。
   *  - 时间轴 [startMs,endMs] 按各译文段字符占比线性分配，段间连续、不重叠、覆盖整个区间。
   * 返回：[{ startMs, endMs, originalText, translation }, ...]，N>=1，拼接无丢字。
   */
  function segmentSentenceUnit(unit, opts) {
    opts = opts || {};
    unit = unit || {};
    var maxChars = opts.maxCharsPerScreen != null ? opts.maxCharsPerScreen : 20;
    var maxDur = opts.maxDurPerScreen != null ? opts.maxDurPerScreen : 4000;
    var startMs = unit.startMs != null ? unit.startMs : unit.start;
    var endMs = unit.endMs != null ? unit.endMs : unit.end;
    startMs = Number(startMs) || 0;
    endMs = Number(endMs);
    if (!Number.isFinite(endMs)) endMs = startMs;
    var origRaw = unit.originalText != null ? unit.originalText : "";
    var transRaw = unit.translation != null ? unit.translation : "";
    var trans = collapseWhitespace(transRaw);
    var orig = collapseWhitespace(origRaw);

    function passthrough() {
      return [
        {
          startMs: startMs,
          endMs: endMs,
          originalText: orig,
          translation: trans,
        },
      ];
    }

    // 关闭分段（maxChars<=0）或本就够短够快 → 原样返回。
    var durMs = endMs - startMs;
    var charOk = !(maxChars > 0) || trans.length <= maxChars;
    var durOk = !(maxDur > 0) || durMs <= maxDur;
    if (charOk && durOk) return passthrough();
    if (!trans) return passthrough(); // 无译文不分（原文兜底单元，已够短）

    // 译文按「单屏最多字数」硬上限切成可读段（标点优选切点；超长片段在内部按可读边界硬切，
    // CJK 按字、拉丁/数字成词不斩断；每段 <= maxChars）。再按时长需求决定是否进一步细分。
    var transGroups = maxChars > 0 ? segmentTextByCap(trans, maxChars) : [trans];

    // 时长维度：若按字数切完段数仍不足以满足「单屏最长时长」，按时长把段数提上来。
    // 但有下限保护，绝不为凑时长把短句切成单字闪烁：
    //  - 每段不短于 segMinChars(cap) 字 → 段数 <= floor(trans.length / minChars)。
    //  - 每段不短于 SEG_MIN_VISIBLE_MS 可视 → 段数 <= floor(durMs / minVisible)。
    var byDur = maxDur > 0 ? Math.ceil(durMs / maxDur) : 1;
    if (byDur > transGroups.length && maxChars > 0) {
      var minChars = segMinChars(maxChars);
      var capByChars = Math.floor(trans.length / minChars); // 字数下限决定的最大段数
      var capByVisible = Math.floor(durMs / SEG_MIN_VISIBLE_MS); // 可视时长下限决定的最大段数
      var maxSegs = Math.min(byDur, capByChars, capByVisible);
      if (maxSegs > transGroups.length) {
        // 用更小的等效 cap 重切，逼出更多段（但不超过下限允许的 maxSegs）。
        var tighterCap = Math.max(minChars, Math.ceil(trans.length / maxSegs));
        if (tighterCap < maxChars) transGroups = segmentTextByCap(trans, tighterCap);
      }
    }

    var n = transGroups.length;
    if (n <= 1) return passthrough(); // 切不动（整段是单个不可分原子或已够短）→ 原样返回

    // 原文同步切成 n 段（数量对齐译文）：标点足够按标点均衡聚组，否则按原子占比均分；
    // 每段都带对应原文片段（不再后段全空），拼回（去空格）无丢字。
    var origGroups = splitOriginalIntoN(orig, n);

    // 时间轴：按各译文段字符占比线性分配 [startMs,endMs]，段间连续、不重叠、全覆盖。
    var lens = [];
    var total = 0;
    for (var i = 0; i < n; i++) {
      var L = transGroups[i].length || 1;
      lens.push(L);
      total += L;
    }
    var units = [];
    var acc = 0;
    var prevEnd = startMs;
    var span = endMs - startMs;
    for (var j = 0; j < n; j++) {
      acc += lens[j];
      var segEnd = j === n - 1 ? endMs : startMs + Math.round((span * acc) / total);
      if (segEnd < prevEnd) segEnd = prevEnd; // 单调不回退（防 round 抖动）
      units.push({
        startMs: prevEnd,
        endMs: segEnd,
        originalText: origGroups[j] != null ? origGroups[j] : "",
        translation: transGroups[j],
      });
      prevEnd = segEnd;
    }
    return units;
  }

  /**
   * 把原文切成正好 n 段（数量与译文对齐），每段尽量非空、落在可读边界。
   * 两级策略：
   *  1. 句中标点片段 >= n → 贪心按累计长度均衡聚成 n 组（只在标点处切，绝不斩词）。
   *  2. 标点不足（英文 ASR 几乎无句中标点）→ 退化按「原子占比」均分：把原文切成原子
   *     （CJK 按字、拉丁词/数字成整体不斩断），再按字符占比线性均分到 n 组。
   * 这样每段都带对应原文片段（不再后段全空）；拼回（去空格）无丢字。
   * 原文原子数 < n（极短原文 + 多译文段）才会出现末尾若干空段——无可分内容，属合理。
   */
  function splitOriginalIntoN(orig, n) {
    var s = collapseWhitespace(orig);
    if (n <= 1) return [s];
    if (!s) return new Array(n).fill("");
    var pieces = splitByPunctPieces(s);
    // 标点片段足够 → 沿用按标点均衡聚组（可读切点优先）。
    if (pieces.length >= n) return groupPiecesIntoN(pieces, n);
    // 标点不足 → 按原子占比均分，保证每段尽量非空、不斩词。
    return splitAtomsIntoN(s, n);
  }

  /** 贪心把标点片段按累计长度均衡聚成正好 n 组（每组 collapse 后非空，不足补空）。 */
  function groupPiecesIntoN(pieces, n) {
    var total = 0;
    for (var i = 0; i < pieces.length; i++) total += collapseWhitespace(pieces[i]).length;
    var target = total / n;
    var groups = [];
    var buf = "";
    var acc = 0;
    for (var j = 0; j < pieces.length; j++) {
      var remainPiece = pieces.length - j;
      var remainGrp = n - groups.length;
      buf += pieces[j];
      acc += collapseWhitespace(pieces[j]).length;
      var enough = acc >= target * (groups.length + 1);
      var forceSingle = remainPiece <= remainGrp; // 必须给后面每组各留一片
      if ((enough || forceSingle) && groups.length < n - 1) {
        groups.push(collapseWhitespace(buf));
        buf = "";
      }
    }
    if (buf) groups.push(collapseWhitespace(buf));
    while (groups.length < n) groups.push(""); // 不足补空（不硬切词）
    return groups.slice(0, n);
  }

  /**
   * 把原文按「原子占比」均分成 n 组（标点不足时的退化路径）。
   * 原子：CJK 单字 / 拉丁词 / 数字串（成整体不斩断）。按字符占比贪心聚组，
   * 拉丁原子间用空格重连。原子数 >= n 时每组非空；原子数 < n 时末尾补空段。
   */
  function splitAtomsIntoN(s, n) {
    var atoms = tokenizeAtoms(s);
    if (!atoms.length) return new Array(n).fill("");
    var total = 0;
    for (var i = 0; i < atoms.length; i++) total += atoms[i].length;
    var target = total / n;
    var groups = [];
    var buf = "";
    var acc = 0;
    for (var j = 0; j < atoms.length; j++) {
      var a = atoms[j];
      var remainAtom = atoms.length - j;
      var remainGrp = n - groups.length;
      var sep = (buf && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(a)) ? " " : "";
      buf += sep + a;
      acc += a.length;
      var enough = acc >= target * (groups.length + 1);
      var forceSingle = remainAtom <= remainGrp; // 必须给后面每组各留一原子
      if ((enough || forceSingle) && groups.length < n - 1) {
        groups.push(buf);
        buf = "";
      }
    }
    if (buf) groups.push(buf);
    while (groups.length < n) groups.push(""); // 原子数 < n：末尾补空（无可分内容）
    return groups.slice(0, n);
  }

  /**
   * 把一批文本拼成带行号的 user message。
   * 输入 lines: string[]；返回 "1. ...\n2. ...\n"。
   */
  function buildNumberedBatch(lines) {
    return lines
      .map(function (t, i) {
        return i + 1 + ". " + collapseWhitespace(t);
      })
      .join("\n");
  }

  /**
   * 解析模型输出的带行号译文，返回 Map<行号(1-based), 译文>。
   * 容忍前导空白、"1." / "1．" / "1、" / "1)" / "1 -" 等多种行号写法。
   */
  function parseNumberedResponse(text) {
    var map = {};
    if (typeof text !== "string") return map;
    var lines = text.replace(/\r/g, "").split("\n");
    var lineRe = /^\s*(\d+)\s*[.．、):\-]+\s*(.*)$/;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(lineRe);
      if (m) {
        var n = parseInt(m[1], 10);
        var content = collapseWhitespace(m[2]);
        if (content) map[n] = content;
      }
    }
    return map;
  }

  /**
   * 按行号把译文对齐回原始行。
   * 入参 originals: string[]（本批原文，顺序即行号 1..N）。
   * 返回 string[]，与 originals 等长。
   * 兜底：
   *  - 命中行号 → 用译文。
   *  - 行号缺失 / 行数不匹配 → 该行留原文（保证不丢内容、不错位）。
   * 若整体行号完全对不上（map 为空但 fallbackByOrder 为真），
   * 退化为按出现顺序对齐（模型没给行号但给了等长若干行时）。
   */
  function alignTranslations(originals, modelText) {
    var n = originals.length;
    var map = parseNumberedResponse(modelText);
    var keys = Object.keys(map);
    var result = new Array(n);

    if (keys.length === 0) {
      // 模型完全没按行号输出 → 尝试按非空行顺序对齐
      var rawLines = String(modelText || "")
        .replace(/\r/g, "")
        .split("\n")
        .map(collapseWhitespace)
        .filter(function (l) {
          return l.length > 0;
        });
      for (var i = 0; i < n; i++) {
        result[i] = rawLines[i] != null ? rawLines[i] : originals[i];
      }
      return result;
    }

    for (var j = 0; j < n; j++) {
      var lineNo = j + 1;
      result[j] = map[lineNo] != null ? map[lineNo] : originals[j];
    }
    return result;
  }

  /**
   * 翻译一批 cue（核心入口，fetch 注入便于测试）。
   * 参数 opts:
   *   - cues: cue[]（本批要翻的字幕）
   *   - apiBaseUrl, apiKey, apiModel: 用户配置三件套（显式具名变量）
   *   - targetLang: 目标语言
   *   - systemPrompt: 可选自定义 system prompt
   *   - temperature: 默认 0.3
   *   - contextTail: 可选，上一批末尾若干原文，作为上下文（不计入对齐）
   *   - timeoutMs: 可选，单次请求超时（默认 20000，<=0 关闭）。超时按失败抛错走兜底。
   *   - fetchImpl: 注入的 fetch（默认用全局 fetch）
   * 返回：与 cues 等长的 string[]（译文）。
   * 出错（HTTP 非 200、网络异常、超时）时抛出 Error，由调用方决定兜底（保留原文）。
   */
  async function translateBatch(opts) {
    var cues = opts.cues || [];
    var originals = cues.map(function (c) {
      return c.content;
    });
    if (originals.length === 0) return [];

    var sys = buildSystemPrompt(opts.targetLang, opts.systemPrompt);
    var userContent = "";
    if (opts.contextTail && opts.contextTail.length) {
      // 上下文以注释形式前置，明确告知模型只翻译编号行
      userContent +=
        "[context, do NOT translate, for reference only]\n" +
        opts.contextTail.map(collapseWhitespace).join("\n") +
        "\n\n[translate these numbered lines]\n";
    }
    userContent += buildNumberedBatch(originals);

    var content = await chatCompletion({
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      apiModel: opts.apiModel,
      temperature: opts.temperature,
      systemContent: sys,
      userContent: userContent,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    return alignTranslations(originals, content);
  }

  /**
   * 发一次 chat/completions 并返回 message.content 字符串。
   * 抽出 translateBatch / translateSentences 共用：构造请求、AbortController 超时、
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
      throw new Error("translate HTTP " + resp.status + " " + (errText || "").slice(0, 200));
    }

    var data = await resp.json();
    return data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  }

  /**
   * 句级语义重断 + 翻译（主路径）。一次 chat 调用同时重组断句与翻译，
   * 然后用 alignSentences 解析 + 覆盖性校验 + 时间轴回映。
   * 入参（opts）：
   *  - cues: 本次输入的碎片 cue[]（带 start/end，顺序即源行号）
   *  - apiBaseUrl, apiKey, apiModel, targetLang
   *  - systemPrompt: 可选自定义（覆盖句级默认 prompt）
   *  - temperature, timeoutMs, fetchImpl
   *  - splitFill: 透传给 alignSentences（true=多源行合并译文本地拆分回填到每行，时间轴更细）
   * 返回：
   *   { ok, sentences, reason? }（直接转发 alignSentences 结果）
   *   - ok=true：句级时间轴可用，渲染层按完整句显示；
   *   - ok=false：覆盖性校验未过 → 调用方退回逐行 translateCues 兜底（reason 便于诊断）。
   * 网络/HTTP/超时错误向上抛出（与 translateBatch 一致），调用方兜底。
   */
  async function translateSentences(opts) {
    var cues = opts.cues || [];
    if (!cues.length) return { ok: false, sentences: [], reason: "empty-input" };

    var sys = buildSentenceSystemPrompt(opts.targetLang, opts.systemPrompt);
    var userContent =
      "Regroup, restore punctuation and translate these numbered fragments:\n" +
      buildNumberedSourceLines(
        cues.map(function (c) {
          return c.content;
        })
      );

    var content = await chatCompletion({
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      apiModel: opts.apiModel,
      temperature: opts.temperature,
      systemContent: sys,
      userContent: userContent,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    return alignSentences(cues, content, { splitFill: !!opts.splitFill });
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
   * 返回 clip 数组：{ index, startMs, endMs, cues, startIndex }（index 从 0 连续）。
   * startMs 用该 clip 第一条 cue 的 start（稳定，可做缓存 key 的一部分）。
   */
  function sliceClipsByCue(cues, targetMs) {
    var size = targetMs && targetMs > 0 ? targetMs : 30000;
    var clips = [];
    var i = 0;
    var n = (cues || []).length;
    while (i < n) {
      var startMs = cues[i].start;
      var group = [];
      var startIndex = i;
      while (i < n) {
        group.push(cues[i]);
        var spanned = cues[i].end - startMs;
        i++;
        // 达到目标时长就收尾（至少 1 条）；下一条另起 clip
        if (spanned >= size) break;
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
   * 滑动窗口预取(depth=2)会让 idx/idx+1/idx+2 几乎同时各自发起翻译。每个
   * translateCues 内部又有自己的批内并发池(默认 3)。若不封顶，瞬时并发可达
   * ~9，足以触发网关 429 → 退避 → 反而更卡。这里提供一个进程级（每个内容脚本
   * 实例一个）的小信号量：所有 clip 的所有批请求都先 acquire 一个令牌再发，
   * 发完 release。在全局 cap 下，滑动窗口仍能尽量保持最大领先，但绝不冲垮网关。
   * 纯逻辑、无定时器、可离线单测：用 Promise 队列实现"超额则排队等令牌"。
   */

  /**
   * 造一个并发信号量。
   *  - max: 同时允许的最大令牌数（<=0 视为 1）。
   * 返回 { run(fn), acquire(), release(), get inFlight(), get max(), get queued() }。
   *  - run(fn): 等到有令牌后执行 fn()（可返回 Promise），结束(成功/抛错)自动 release。
   *            这是给 translateCues 用的入口——把单批请求包进来即受全局上限约束。
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
   * 8. 翻译编排：首句优先 + 批内受控并发 + 增量回调
   * -------------------------------------------------------------
   * translateCues 把一个 clip 的 cue 切成多个 batch：
   *  - 首句优先：把 priorityIndex 附近的一小批排到最前先翻先返回。
   *  - 受控并发：用并发池（默认上限 3）替代串行 await。
   *  - 增量：每批完成就回调 onProgress(updates)，让 UI 尽快显示。
   *  - contextTail：仅当某批起点不在自然句首（上一条原文无句末标点）时，
   *    带上一条原文 1 句；clip 第一批不带。省 token 又保连贯。
   * 返回与 cues 等长的 string[]（全部批完成后）。fetch 注入便于测试。
   */
  function planBatches(cues, opts) {
    opts = opts || {};
    var batchSize = opts.batchSize > 0 ? opts.batchSize : 10;
    var priLines = opts.priorityLines > 0 ? opts.priorityLines : 4;
    var n = cues.length;
    var pri = opts.priorityIndex;
    var batches = [];
    var covered = new Array(n).fill(false);

    // 首句优先批：以 priorityIndex 为起点的一小批
    if (pri != null && pri >= 0 && pri < n) {
      var pEnd = Math.min(n, pri + priLines);
      batches.push({ start: pri, end: pEnd, priority: true });
      for (var x = pri; x < pEnd; x++) covered[x] = true;
    }
    // 其余按顺序补满（跳过已覆盖区间）
    var i = 0;
    while (i < n) {
      if (covered[i]) {
        i++;
        continue;
      }
      var start = i;
      var end = i;
      while (end < n && !covered[end] && end - start < batchSize) end++;
      batches.push({ start: start, end: end, priority: false });
      i = end;
    }
    return batches;
  }

  async function translateCues(opts) {
    var cues = opts.cues || [];
    var n = cues.length;
    var result = new Array(n);
    if (!n) return result;
    var concurrency = opts.concurrency > 0 ? opts.concurrency : 3;
    var batches = planBatches(cues, {
      batchSize: opts.batchSize,
      priorityIndex: opts.priorityIndex,
      priorityLines: opts.priorityLines,
    });
    // 首句优先批排最前，保证先被并发池取走
    batches.sort(function (a, b) {
      return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || a.start - b.start;
    });

    var bi = 0;
    // 上下文窗口：每批携带前 contextLines 条原文作为「参考不翻译」前缀，
    // 让模型借上下文理解碎片/代词指代/话题连贯（P1-a：扩上下文窗口）。
    //  - contextLines > 0：每批都带前 N 条原文（不只在句中断点），更连贯。
    //  - contextLines 未配置（null/未传）：退化为旧行为——仅当批起点不在自然句首
    //    (上一条原文无句末标点)时带 1 句，clip 第一批不带。保持向后兼容。
    // context 行不计入编号、不计入对齐（translateBatch 已把它放在编号区之外）。
    var contextLines = opts.contextLines != null ? opts.contextLines : null;
    async function worker() {
      while (bi < batches.length) {
        var b = batches[bi++];
        var sub = cues.slice(b.start, b.end);
        var ctx = null;
        if (contextLines != null) {
          // 新策略：每批都带前 N 条原文（N = contextLines，受 clip 起点裁剪）。
          var cl = contextLines > 0 ? Math.floor(contextLines) : 0;
          if (cl > 0 && b.start > 0) {
            var from = Math.max(0, b.start - cl);
            ctx = [];
            for (var ci = from; ci < b.start; ci++) ctx.push(cues[ci].content);
            if (!ctx.length) ctx = null;
          }
        } else if (b.start > 0) {
          // 旧策略：仅当批起点不在自然句首时带 1 句上下文；clip 第一批(start=0)不带。
          var prev = cues[b.start - 1];
          if (prev && !SENTENCE_END_RE.test(prev.content)) ctx = [prev.content];
        }
        var lines;
        try {
          var doBatch = function () {
            return translateBatch({
              cues: sub,
              apiBaseUrl: opts.apiBaseUrl,
              apiKey: opts.apiKey,
              apiModel: opts.apiModel,
              targetLang: opts.targetLang,
              systemPrompt: opts.systemPrompt,
              temperature: opts.temperature,
              contextTail: ctx,
              timeoutMs: opts.timeoutMs,
              fetchImpl: opts.fetchImpl,
            });
          };
          // 全局并发信号量（可选）：所有 clip 的所有批共享一个上限，避免滑动窗口
          // 预取(depth=2) × 批内并发(3) 叠加冲垮网关(~9 并发 → 429)。无 gate 时退化为旧行为。
          lines = opts.gate && typeof opts.gate.run === "function"
            ? await opts.gate.run(doBatch)
            : await doBatch();
        } catch (e) {
          if (opts.onError) opts.onError(e, b);
          if (opts.failFast) throw e;
          continue; // 该批失败：留空，调用方兜底显示原文
        }
        var updates = [];
        for (var k = 0; k < sub.length; k++) {
          result[b.start + k] = lines[k];
          updates.push({ index: b.start + k, text: lines[k] });
        }
        if (opts.onProgress) opts.onProgress(updates, b);
      }
    }

    var pool = [];
    for (var w = 0; w < Math.min(concurrency, batches.length); w++) pool.push(worker());
    await Promise.all(pool);
    return result;
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
    makeSemaphore: makeSemaphore,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    buildSystemPrompt: buildSystemPrompt,
    DEFAULT_SENTENCE_SYSTEM_PROMPT: DEFAULT_SENTENCE_SYSTEM_PROMPT,
    buildSentenceSystemPrompt: buildSentenceSystemPrompt,
    buildNumberedSourceLines: buildNumberedSourceLines,
    parseSentenceResponse: parseSentenceResponse,
    alignSentences: alignSentences,
    segmentSentenceUnit: segmentSentenceUnit,
    splitTranslation: splitTranslation,
    translateSentences: translateSentences,
    chatCompletion: chatCompletion,
    buildNumberedBatch: buildNumberedBatch,
    parseNumberedResponse: parseNumberedResponse,
    alignTranslations: alignTranslations,
    translateBatch: translateBatch,
    translateCues: translateCues,
    planBatches: planBatches,
    sliceClips: sliceClips,
    sliceClipsByCue: sliceClipsByCue,
    makeCacheKey: makeCacheKey,
    pruneCache: pruneCache,
    makeBackoff: makeBackoff,
    joinUrl: joinUrl,
    findCueIndexAt: findCueIndexAt,
    cueClipIndexMap: cueClipIndexMap,
    exportConfig: exportConfig,
    importConfig: importConfig,
    formatSrtTime: formatSrtTime,
    buildSrt: buildSrt,
  };

  return EXPORTS;
});
