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
   * 3. 工具函数
   * ------------------------------------------------------------- */

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
   * 4. 翻译：分批 + 上下文 + 按行号对齐
   * -------------------------------------------------------------
   * 核心策略（brief 已验证质量好）：
   *  - 绝不逐句翻译。把一批 cue 拼成带行号的文本一次性发给 LLM。
   *  - system prompt 要求模型先在脑内恢复标点/合并碎片理解语义，
   *    但输出严格"每个输入行号一行译文，行号和行数完全一致"。
   *  - 拿回结果后按行号对齐回各 cue。行数/行号不匹配时做兜底。
   */

  // 默认 system prompt（{TARGET_LANG} 会被替换为目标语言）
  var DEFAULT_SYSTEM_PROMPT =
    "You are a professional subtitle translator. The input is auto-generated " +
    "captions split into numbered fragments that may lack punctuation and " +
    "capitalization. Translate them into {TARGET_LANG}. First mentally restore " +
    "punctuation and merge fragments into coherent sentences to understand the " +
    "meaning and context, but OUTPUT exactly one translated line per numbered " +
    "input line, preserving the SAME numbering and the SAME number of lines. " +
    "Use natural, spoken {TARGET_LANG}. Output ONLY the numbered translations, " +
    "nothing else.";

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
   *   - fetchImpl: 注入的 fetch（默认用全局 fetch）
   * 返回：与 cues 等长的 string[]（译文）。
   * 出错（HTTP 非 200、网络异常）时抛出 Error，由调用方决定兜底（保留原文）。
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

    var resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (opts.apiKey || ""),
      },
      body: JSON.stringify(body),
    });

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

  var EXPORTS = {
    parseJson3: parseJson3,
    parseVtt: parseVtt,
    cleanupCues: cleanupCues,
    collapseWhitespace: collapseWhitespace,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    buildSystemPrompt: buildSystemPrompt,
    buildNumberedBatch: buildNumberedBatch,
    parseNumberedResponse: parseNumberedResponse,
    alignTranslations: alignTranslations,
    translateBatch: translateBatch,
    sliceClips: sliceClips,
    joinUrl: joinUrl,
  };

  return EXPORTS;
});
