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
    var maxGap = opts.maxGapMs != null ? opts.maxGapMs : 300; // 小于此间隙视为同句延续
    var maxDur = opts.maxDurationMs != null ? opts.maxDurationMs : 6000; // 单句最长时长
    var maxWords = opts.maxWords != null ? opts.maxWords : 12; // 单句最多词数
    var minWords = opts.minWords != null ? opts.minWords : 3; // 单句最少词数（碎句黏合下限）
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
        out.push({
          start: cur.start,
          end: cur.end,
          duration: Math.max(0, cur.end - cur.start),
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
        // 两种都仍受「间隙小 + 不超 maxWords/maxDur」约束。这样 "OK." 这种孤立短句
        // 会优先黏进相邻句，而不是句尾标点一到就立即单独成段。
        var canMerge = !ended || cur.words.length < minWords;
        var mergeable =
          gap <= maxGap && canMerge && wouldWords <= maxWords && wouldDur <= maxDur;
        if (mergeable) {
          for (var w = 0; w < added.length; w++) cur.words.push(added[w]);
          cur.end = Math.max(cur.end, c.end);
        } else {
          // 确实无法再合并（间隙过大 / 会超上限）→ 当前段（含太短的碎句）单独成段
          flush();
          cur = { start: c.start, end: c.end, words: words.slice() };
        }
      }

      // 切句时机：
      //  - 超 maxWords / 超 maxDur → 立即切（防超长段，逻辑不变）。
      //  - 自然结束(句尾标点)但仅当词数已达 minWords 才切；不足 minWords 先不切，
      //    留待与下一条 cue 黏合（minWords 合并优先于句尾立即切）。
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
    systemPrompt: "", // 空 = 用 core 默认
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
    globalConcurrency: 4, // 跨 clip 的全局 in-flight 翻译请求上限（信号量）。滑动窗口预取
    //                       (depth=2)叠加批内并发(3)若不封顶会冲垮网关→429；此值统一封顶。
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
  // 已进一步瘦身：相比最初 ~509 字符砍掉一大半固定开销，但保留三条硬约束：
  //  1) 结合上下文理解碎片语义；2) 每个输入行号一行译文；3) 行号与行数完全一致。
  var DEFAULT_SYSTEM_PROMPT =
    "Translate each numbered subtitle line to natural {TARGET_LANG}. " +
    "Fragments may lack punctuation; use context to infer meaning. " +
    "Keep the same line numbers, one translation per line, no extra text.";

  function buildSystemPrompt(targetLang, customPrompt) {
    var tpl = customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "the target language");
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

    var fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) throw new Error("no fetch implementation available");

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

    var url = joinUrl(opts.apiBaseUrl, "/chat/completions");
    var body = {
      model: opts.apiModel,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userContent },
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
    var content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    return alignTranslations(originals, content);
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
    async function worker() {
      while (bi < batches.length) {
        var b = batches[bi++];
        var sub = cues.slice(b.start, b.end);
        // 仅当批起点不在自然句首时带 1 句上下文；clip 第一批(start=0)不带
        var ctx = null;
        if (b.start > 0) {
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
  };

  return EXPORTS;
});
