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
   * 用整条 json3 event 的连续文本做唯一权威分词，再把词映射回它覆盖的 seg 时间。
   *
   * YouTube 的 seg 是时间片，不是词边界：同一个词可被拆成 ["6", "TV"]、
   * ["pur", "pose"]，空白/换行也可能单独占一个 seg。旧实现逐 seg 调 RESTORE_WORD_RE，
   * canonical 得到两个 token；显示侧对拼接后的整句分词只得到一个，必然 fail-closed。
   * 这里不看语言：先拼原始 event（保留纯空白 seg 作为真实分隔），只分词一次；
   * 时间仍完全来自源 seg，在一个 seg 内按该 seg 覆盖的 token 数均分，与旧口径一致。
   */
  function timedJson3EventTokens(segs, start, eventEnd, boundAfter) {
    // boundAfter(t)：返回严格晚于 t 的最早 cue 起点，用作 token.end 上界。
    // 必须按**每个 token 自己的 start** 求上界，不能整条 event 共用一个标量：
    // 真实轨里 event 大幅重叠，某个 token 的 start 可能晚于下一条 event 的 start，
    // 共用标量会把它压成零宽（实测 pczh.ja 2022 个）。逐 token 求界则恒有
    // bound > tokenStart，零宽在数学上不可能出现。
    // eventEnd 仍用于 piece 时间派生 —— 那是源轨给的时长，不能改。
    var pieces = [];
    var raw = "";
    (segs || []).forEach(function (seg) {
      if (!seg || typeof seg.utf8 !== "string") return;
      var charStart = raw.length;
      raw += seg.utf8;
      pieces.push({
        charStart: charStart,
        charEnd: raw.length,
        offset: Number(seg.tOffsetMs),
      });
    });

    // 纯空白/换行 seg 常常没有 offset。一次反向扫描把下一个真实边界传播回来，
    // 避免前一个词被错误延到 eventEnd，也避免逐 piece 向后查找的平方复杂度。
    var followingOffset = NaN;
    for (var pieceIndex = pieces.length - 1; pieceIndex >= 0; pieceIndex--) {
      var piece = pieces[pieceIndex];
      var offset = piece.offset;
      var nextOffset = followingOffset;
      piece.timeStart = Number.isFinite(offset) ? start + Math.max(0, offset) : start;
      var timeEnd = Number.isFinite(nextOffset)
        ? start + Math.max(Math.max(0, offset) || 0, nextOffset)
        : eventEnd;
      piece.timeEnd = Math.max(timeEnd, piece.timeStart);
      piece.nativeTiming = Number.isFinite(offset);
      if (piece.nativeTiming) followingOffset = offset;
    }

    var matches = [];
    var re = newWordRe();
    var match;
    while ((match = re.exec(raw)) !== null) {
      if (!match[0]) { re.lastIndex++; continue; }
      matches.push({ text: match[0], charStart: match.index, charEnd: match.index + match[0].length });
    }

    // pieces 与 matches 都按字符位置递增。单调扫描一次，记录每个 token 覆盖的首尾
    // piece 及它在该 piece 内的序号；不再让每个 token 反复扫描全部 pieces/matches。
    var matchCursor = 0;
    pieces.forEach(function (currentPiece) {
      while (matchCursor < matches.length && matches[matchCursor].charEnd <= currentPiece.charStart) matchCursor++;
      var indexes = [];
      for (var i = matchCursor; i < matches.length && matches[i].charStart < currentPiece.charEnd; i++) {
        if (matches[i].charEnd > currentPiece.charStart) indexes.push(i);
      }
      currentPiece.matchCount = indexes.length;
      indexes.forEach(function (wordIndex, position) {
        var word = matches[wordIndex];
        if (!word.firstPiece) {
          word.firstPiece = currentPiece;
          word.firstPos = position;
          word.nativeTiming = currentPiece.nativeTiming;
        } else {
          word.nativeTiming = word.nativeTiming && currentPiece.nativeTiming;
        }
        word.lastPiece = currentPiece;
        word.lastPos = position;
      });
    });

    return matches.map(function (word) {
      if (!word.firstPiece || !word.lastPiece) return null;
      var first = word.firstPiece;
      var last = word.lastPiece;
      var tokenStart = first.timeStart + Math.round((first.timeEnd - first.timeStart) * word.firstPos / Math.max(1, first.matchCount));
      var tokenEnd = last.timeStart + Math.round((last.timeEnd - last.timeStart) * (word.lastPos + 1) / Math.max(1, last.matchCount));
      // rollingEnd 是**未夹上界**的派生 end，只供 appendTimelineTokens 判定滚动重复。
      //
      // 一个量两个用途，需求相反：
      //   · 渲染时间要求 end 不越过下一条 cue 起点（否则屏与屏时间窗穿插）
      //   · 滚动重复去重要求末词与下一条的重复前缀"时间重叠"才认定为同一次发声
      // 实测 pczh.ja 802 个 cue 对：637 处末词越界，其中 13 处的去重复**仅靠**这段
      // 越界重叠才成立。若直接夹掉 end，这 13 处的重复词会被渲染两次。
      // 因此夹的是 end（渲染用），保留 rollingEnd（判定用）—— 不可合并成一个字段。
      var rollingEnd = Math.max(tokenEnd, tokenStart);
      var endBound = typeof boundAfter === "function" ? boundAfter(tokenStart) : Infinity;
      if (!Number.isFinite(endBound) || endBound <= tokenStart) endBound = Infinity;
      return {
        text: word.text,
        start: tokenStart,
        end: Math.min(rollingEnd, endBound),
        rollingEnd: rollingEnd,
        nativeTiming: word.nativeTiming,
      };
    }).filter(Boolean);
  }

  /**
   * 非语音标记 —— 方括号完整包裹、内部无句内标点的 cue。
   *
   * ASR 轨会把音效写成独立 cue：[Applause] [Music] [笑い] [拍手] [鼻息] [叫び声]，
   * 也包括来源/说话人标签 [Vsauce]。这些都不是语音，翻译成"掌声/音乐"既占屏又白烧
   * token —— 实测 DGdsIrAjp3k 有 9 条共覆盖 158s（视频总长约 330s），其中两个整块
   * 里一句人话都没有，却各发了一次完整翻译请求。
   *
   * 判据是形态，不是词表：
   *   方括号 [] 或【】完整包裹  +  内部不含句内标点
   * 语言中立（22 条真实轨里日语英语音效全部命中），且不误伤歌词 —— 歌词用圆括号且
   * 带真实语流标点，如 "(Up, up, up; up, up)" 会被保留。
   *
   * 不用词表的理由：音效词随语言无限延伸，维护名单必然漏，且违反语言中立。
   */
  var NON_SPEECH_MARKER_RE = /^[\[【]\s*[^\[\]【】,;，；。．!?！？…]{1,30}\s*[\]】]$/;

  function isNonSpeechMarker(text) {
    return NON_SPEECH_MARKER_RE.test(String(text || "").trim());
  }

  /**
   * 解析 YouTube json3 字幕格式。
   * 除 event 的粗粒度时间外，保留 seg.tOffsetMs 推导出的 token 时间。后续语义
   * 重分段可以自由跨 ASR event 重组，仍准确落回原音频区间。
   */
  function parseJson3(json) {
    const out = [];
    if (!json || !Array.isArray(json.events)) return out;
    const events = json.events;
    // 每条 event 的时间上界 = 下一条有正文且起点更晚的 event 的 start。
    //
    // 滚动窗口 ASR 轨（YouTube 自动字幕的线上主流形态）的 dDurationMs 故意伸进后续
    // event：同一句话滚动重复出现，时长覆盖整个滚动窗口而非该句实际语音。
    // timedJson3EventTokens 给末词定 end 时没有后继 seg offset 可用，只能落到 eventEnd，
    // 于是**每条 cue 的末词都被拉长到下一条 cue 覆盖区**。
    //
    // 实测 23 条真实轨：14 条滚动轨全中，token 时长 >2s 的词占 8.50%（4884/57472），
    // 异常词数≈cue 数（mxh 553 cue / 522 异常、sp9 895/804）；9 条干净轨全为 0，
    // 形态分野完全一致。canonical token 流因此产生 5939 处相邻重叠（最大 6599ms）。
    // 后果：单元时间取自 token 跨度，屏与屏的时间窗互相穿插，原文与译文在时间轴上
    // 本就对不齐 —— mxhxL1LzKww 实测 #24 起连续 8 屏译文整体错开一屏。
    //
    // 上界传给 timedJson3EventTokens 夹 token.end（渲染时间），同时那里保留未夹的
    // rollingEnd 供滚动重复去重 —— 两个需求方向相反，必须分成两个字段。
    // cue.end 仍用原始 eventEnd：cleanupCues 会按后一条 start 压平，且 blockSourceCues
    // 等按 cue 时间算跨度的调用方依赖原有口径。
    // 上界必须取"所有起点晚于本条的 event 中最早的那个"，不能按数组顺序取下一条。
    // 真实轨 pczh.ja-orig 的 event 并非按 start 递增（cleanupCues 的 sort 发生在本函数
    // 之后），按数组顺序取会拿到一个更早的 start，把 token 夹成零宽并让时间轴倒流
    // ——实测 552 处，例：token "つ" 被夹成 9113-9113，其后 "え" 起点 7399 反而更早。
    const upperBounds = (() => {
      const starts = [];
      for (const candidate of events) {
        if (!candidate || !Array.isArray(candidate.segs)) continue;
        if (!candidate.segs.some((seg) => seg && typeof seg.utf8 === "string" && seg.utf8.trim())) continue;
        starts.push(toInt(candidate.tStartMs, 0));
      }
      starts.sort((a, b) => a - b);
      return starts;
    })();
    const boundedEnd = (start) => {
      // 二分找第一个 > start 的起点：O(log n)，整轨 O(n log n)，803 cue 实测解析 13ms。
      let lo = 0, hi = upperBounds.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (upperBounds[mid] > start) hi = mid; else lo = mid + 1;
      }
      return lo < upperBounds.length ? upperBounds[lo] : Infinity;
    };
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const ev = events[eventIndex];
      if (!ev || !Array.isArray(ev.segs)) continue;
      const start = toInt(ev.tStartMs, 0);
      const duration = toInt(ev.dDurationMs, 0);
      const eventEnd = start + duration;
      const rawSegs = ev.segs.filter((seg) => seg && typeof seg.utf8 === "string");
      // 纯空白 seg 也是词间真实分隔，不能先 filter(trim) 再 join；否则
      // ["hello", " ", "world"] 会被误拼成 "helloworld"。collapseWhitespace 只用于显示。
      const content = collapseWhitespace(rawSegs.map((seg) => seg.utf8).join(""));
      if (!content) continue;
      // 音效/说话人标记不是语音：不进翻译管线，也不占屏。
      if (isNonSpeechMarker(content)) continue;
      const tokens = timedJson3EventTokens(rawSegs, start, eventEnd, boundedEnd);
      out.push({ start: start, end: eventEnd, duration: duration, content: content, tokens: tokens });
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * TTML / IMSC1 解析（Netflix 等人工成品字幕轨）
   *
   * 与 json3 的本质区别：**没有词级时间**。实测 Netflix 英文轨 415 条 <p>，
   * 内联时间戳 0 个（YouTube json3 词级覆盖 85.3%）。所以这里产出的 cue
   * 不带 tokens，下游 nativeTiming 分支自然走 else —— 不需要任何站点分支。
   * ------------------------------------------------------------- */

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      // &amp; 必须最后解码，否则 "&amp;quot;" 会被二次解码成引号
      .replace(/&amp;/g, "&");
  }

  /**
   * TTML 时间值 → 毫秒。Netflix 用 tick（"13277430832t"），必须按声明的
   * ttp:tickRate 换算，不能硬编码；同时兼容 TTML 合法的时钟与秒表示。
   */
  function ttmlTimeToMs(v, tickRate) {
    if (!v) return null;
    var s = String(v).trim();
    if (/^\d+t$/.test(s)) {
      var rate = tickRate > 0 ? tickRate : 10000000;
      return Math.round((parseInt(s, 10) / rate) * 1000);
    }
    var c = s.match(/^(\d+):(\d\d):(\d\d)(?:[.,](\d+))?$/);
    if (c) {
      var frac = c[4] ? Number("0." + c[4]) : 0;
      return Math.round((Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]) + frac) * 1000);
    }
    if (/^[\d.]+s$/.test(s)) return Math.round(parseFloat(s) * 1000);
    if (/^[\d.]+ms$/.test(s)) return Math.round(parseFloat(s));
    return null;
  }

  /**
   * 剥离音效与说话人标记，返回可翻译的台词文本。
   *
   * 为什么必须剥：实测英文轨 415 条里 56 条（13%）是纯音效
   * "[soothing music playing]"，另有 51 条音效与台词混排。原样送翻译既烧
   * token，也只会得到「[舒缓的音乐播放]」这种没人要看的字幕。
   *
   * 行首 "-" 是**分隔符**，不是台词的一部分 —— 它只在同一条 cue 里有两个以上
   * 说话人时才有意义。所以它的保留条件是「剥离后仍剩 ≥2 行」，而不是「原文有
   * 没有写」。真轨里 12 条踩了这个坑，典型的一条：
   *   源：  "-[soothing music playing]<br/>-Don't go in there, he's with a patient."
   *   剥后：只剩一行台词，那个 "-" 已经不分隔任何东西
   *   错的："- Don't go in there, ..."（凭空多出个破折号）
   *   对的："Don't go in there, ..."
   */
  function stripSubtitleAnnotations(text) {
    var lines = String(text == null ? "" : text).split("\n");
    var kept = [];
    var hadAnnotation = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var dash = /^\s*-\s*/.test(line);
      var body = line.replace(/^\s*-\s*/, "");
      // 方括号标记：音效 [music playing] 与说话人 [Jim]
      var stripped = body.replace(/\[[^\]]*\]/g, "");
      // 圆括号在部分轨里也用于音效标注，但只在整段成对且独占时才剥，
      // 避免吃掉台词里的正常插入语。
      stripped = stripped.replace(/^\s*\([^)]*\)\s*$/g, "");
      stripped = stripped.replace(/\s{2}/g, " ").trim();
      if (stripped !== body.trim()) hadAnnotation = true;
      if (stripped) kept.push({ dash: dash, text: stripped });
    }
    // 分隔符只在真的需要分隔（≥2 行存活）时才写回
    var useDash = kept.length > 1;
    var speech = kept.map(function (k) {
      return (useDash && k.dash ? "- " : "") + k.text;
    }).join("\n");
    return { speech: speech, hadAnnotation: hadAnnotation, annotationOnly: speech === "" };
  }

  /**
   * 解析 TTML / IMSC1 字幕轨为与 parseJson3 同构的 cue 流。
   *
   * 产出 cue：{ start, end, content, position }
   *   - content 已剥离音效/说话人标记，<br/> 保留为 "\n"（人工换行是排版
   *     信息，抹成空格会把两个说话人的话连读）
   *   - position 来自 region 的 tts:displayAlign（Netflix 避让画面文字时会
   *     把字幕切到上方，实测 415 条里 19 条在上方）
   *   - 不带 tokens：这类轨没有词级时间
   * 纯音效 cue 整条丢弃（不送翻译、不占屏）。
   */
  function parseTtml(text) {
    var out = [];
    if (typeof text !== "string" || text.indexOf("<") < 0) return out;
    var tickRate = Number((text.match(/ttp:tickRate="(\d+)"/) || [])[1] || 10000000);

    // region 的 displayAlign 决定字幕在上方还是下方
    var regionAlign = {};
    var regionRe = /<region\b([^>]*)>/g;
    var rm;
    while ((rm = regionRe.exec(text))) {
      var rid = (rm[1].match(/xml:id="([^"]+)"/) || [])[1];
      var align = (rm[1].match(/tts:displayAlign="([^"]+)"/) || [])[1];
      if (rid) regionAlign[rid] = align === "before" ? "top" : "bottom";
    }

    var pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    var m;
    while ((m = pRe.exec(text))) {
      var attrs = m[1];
      var inner = m[2];
      var start = ttmlTimeToMs((attrs.match(/\bbegin="([^"]+)"/) || [])[1], tickRate);
      var end = ttmlTimeToMs((attrs.match(/\bend="([^"]+)"/) || [])[1], tickRate);
      if (start == null || end == null || !(end > start) || start < 0) continue;
      var region = (attrs.match(/\bregion="([^"]+)"/) || [])[1] || null;

      // <br/> → 硬换行；span（斜体/外语）只影响样式，文本要留下
      inner = inner.replace(/<br\s*\/?>/gi, "\n");
      inner = inner.replace(/<\/?span[^>]*>/gi, "");
      var raw = decodeXmlEntities(inner.replace(/<[^>]*>/g, ""))
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim();
      if (!raw) continue;
      var ann = stripSubtitleAnnotations(raw);
      if (ann.annotationOnly) continue; // 纯音效：不翻译也不显示
      out.push({
        start: start,
        end: end,
        duration: end - start,
        content: ann.speech,
        position: regionAlign[region] || "bottom",
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
      if (isNonSpeechMarker(content)) continue;
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

  /**
   * 按外部语义恢复器给出的句末 token 下标重组连续 token。模型只提出边界，
   * 文本和时间都由源 token 决定；无效边界被拒绝，避免模型改写/丢词。
   */
  function segmentTokensByBoundaries(tokens, boundaries) {
    var list = (tokens || []).map(function (token) {
      return {
        text: collapseWhitespace(token && token.text || ""),
        start: toInt(token && token.start, 0),
        end: toInt(token && token.end, 0),
      };
    }).filter(function (token) { return token.text; });
    if (!list.length) return [];
    var seen = {};
    var ends = (boundaries || []).map(function (value) { return Number(value); })
      .filter(function (value) { return Number.isInteger(value) && value >= 0 && value < list.length && !seen[value] && (seen[value] = true); })
      .sort(function (a, b) { return a - b; });
    if (ends[ends.length - 1] !== list.length - 1) ends.push(list.length - 1);
    var out = [];
    var first = 0;
    for (var i = 0; i < ends.length; i++) {
      var last = ends[i];
      if (last < first) continue;
      var group = list.slice(first, last + 1);
      out.push({
        start: group[0].start,
        end: Math.max(group[group.length - 1].end, group[0].start),
        duration: Math.max(0, group[group.length - 1].end - group[0].start),
        content: collapseWhitespace(joinRestoredWords(group.map(function (token) { return token.text; }))),
        tokens: group,
      });
      first = last + 1;
    }
    return out;
  }

  function appendTimelineTokens(out, incoming) {
    var next = (incoming || []).filter(function (token) { return token && collapseWhitespace(token.text || ""); });
    if (!next.length) return;
    // 滚动 ASR 会把任意长度的旧前缀连同原词级时间再次发出。只有文本相等且
    // 每个对应 token 的时间区间真实重叠时才去重；相邻 cue 合法重复同一个词时
    // 时间不重叠，必须保留。不能用固定 8 词或纯文本后缀猜测 canonical source。
    var max = Math.min(out.length, next.length);
    var cut = 0;
    for (var n = max; n >= 1; n--) {
      var sameRollingSpan = true;
      for (var j = 0; j < n; j++) {
        var prior = out[out.length - n + j];
        var current = next[j];
        var sameText = String(prior.text).toLowerCase() === String(current.text).toLowerCase();
        var priorStart = Number(prior.start), priorEnd = Number(prior.rollingEnd != null ? prior.rollingEnd : prior.end);
        var currentStart = Number(current.start), currentEnd = Number(current.rollingEnd != null ? current.rollingEnd : current.end);
        var timedOverlap = Number.isFinite(priorStart) && Number.isFinite(priorEnd) &&
          Number.isFinite(currentStart) && Number.isFinite(currentEnd) &&
          Math.max(priorStart, currentStart) < Math.min(priorEnd, currentEnd);
        if (!sameText || !timedOverlap) { sameRollingSpan = false; break; }
      }
      if (sameRollingSpan) { cut = n; break; }
    }
    for (var i = cut; i < next.length; i++) out.push(next[i]);
  }

  // 无原生词级时间的轨（人工成品字幕：Netflix TTML、用户上传 SRT/VTT）在这里按
  // cue 时长均摊出 token 时间。
  //
  // 切词必须用 splitDisplayWords 而不是 restoredWords：两者词边界完全一致（前者
  // 就是按后者的 match span 切的），差别只在标点——restoredWords 按设计剥掉标点，
  // 而 canonical token 流是下游渲染与 SRT 导出重建文本的**唯一**来源，用它切词
  // 会把源文标点永久丢掉：真轨 "It works. It works like crazy!" 上屏成
  // "It works It works like crazy"。
  //
  // YouTube ASR 自带词级时间、走不到这个分支，且本身无标点，所以这个缺陷此前
  // 一直不可见；Netflix 句级轨 100% 走这里，全轨标点全灭。
  //
  // 标点不只是观感：句号是最强的分屏信号，语义分屏 prompt 依赖它判句末。
  function fallbackCueTokens(cue) {
    var words = splitDisplayWords(cue && cue.content || "");
    if (!words.length) return [];
    var start = Number(cue && cue.start);
    var end = Number(cue && cue.end);
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end < start) end = start;
    return words.map(function (word, index) {
      return {
        text: word,
        start: start + Math.round((end - start) * index / words.length),
        end: start + Math.round((end - start) * (index + 1) / words.length),
        nativeTiming: false,
      };
    });
  }

  /**
   * 建立唯一 canonical token 流。正文、顺序和时间只来自源轨；滚动字幕的首尾
   * 重叠在这里去重一次，后续 unit、renderer、cache 和 SRT 都只能引用 token span。
   */
  function timelineTokensForCue(cue) {
    var native = (cue && cue.tokens || []).filter(function (token) {
      return token && collapseWhitespace(token.text || "");
    }).map(function (token) {
      var cueStart = Number(cue && cue.start);
      var start = Number(token.start);
      var end = Number(token.end);
      if (!Number.isFinite(start)) start = Number.isFinite(cueStart) ? cueStart : 0;
      if (!Number.isFinite(end) || end < start) end = start;
      // rollingEnd 必须透传到这里：appendTimelineTokens 就在下游用它判滚动重复。
      // 丢掉会回落到已夹的 end，重复词被渲染两次（实测 fixture 出现 "boil water boil water"）。
      var rolling = Number(token.rollingEnd);
      return {
        text: collapseWhitespace(token.text),
        start: Math.round(start),
        end: Math.round(end),
        rollingEnd: Number.isFinite(rolling) && rolling >= end ? Math.round(rolling) : undefined,
        nativeTiming: token.nativeTiming !== false,
      };
    });
    return native.length ? native : fallbackCueTokens(cue);
  }

  // 源 cue 时间失真的判定阈值。低于此值即认为该 cue 自报的时长不可能是真实语速
  // (200ms/词 ≈ 300 wpm 已是极快语速的地板)。
  var IMPLAUSIBLE_MS_PER_WORD = 200;

  /**
   * 修复源轨自报时间失真的 cue —— 这是「字幕后半段几乎看不见」的**根**。
   *
   * YouTube ASR 会给出这种 cue:
   *   [40322-41322] 1000ms / 13 词 = 77ms/词 ≈ 650 wpm(没人这么说话)
   * 而它后面往往紧跟着大段静音(该例 1002ms)。真机轨共 9 条这样的 cue,
   * 白白空着的静音合计 6919ms。
   *
   * 为什么必须在**这一层**修:cue 的 [start,end] 是 fallbackCueTokens 均匀
   * 摊给每个词的唯一依据。cue 被压缩 → 它切出的每一屏 startMs/endMs **全都**
   * 是错的。下游只延长屏尾(可读时长补偿)治不了这个:
   *   - 错的 startMs 永远修不回来;
   *   - 一条 cue 切成多屏时,浪费的静音在**最后一屏之后**,中间那些屏
   *     紧邻下一屏、gap 为 0,根本无处可借。实测那条 95ms/词 的屏就是如此。
   *
   * 做法:把失真 cue 的 end 向后延伸进它后面的真实静音,延到「按 200ms/词
   * 勉强读得完」为止,绝不越过下一条 cue 的 start。只动 end,不动 start,
   * 所以出现时刻仍严格来自源轨。静音不够就延多少算多少。
   */
  function repairImplausibleCueTiming(cues) {
    var list = Array.isArray(cues) ? cues : [];
    var out = list.map(function (cue) { return cue; });
    for (var i = 0; i < out.length; i++) {
      var cue = out[i];
      if (!cue) continue;
      // 带原生词级时间的 cue 不碰:它的时间是真实测量值,不是均摊猜测
      if (cue.tokens && cue.tokens.length) continue;
      var words = restoredWords(cue.content || "").length;
      if (!words) continue;
      var start = Number(cue.start);
      var end = Number(cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      if ((end - start) >= words * IMPLAUSIBLE_MS_PER_WORD) continue;

      var next = out[i + 1];
      var nextStart = next ? Number(next.start) : Infinity;
      if (!Number.isFinite(nextStart)) nextStart = Infinity;
      var want = start + words * IMPLAUSIBLE_MS_PER_WORD;
      var repaired = Math.min(want, nextStart);
      if (repaired <= end) continue;
      out[i] = Object.assign({}, cue, { end: repaired });
    }
    return out;
  }

  function buildCanonicalTokenTimeline(cues) {
    var raw = [];
    repairImplausibleCueTiming(cues).forEach(function (cue) {
      appendTimelineTokens(raw, timelineTokensForCue(cue));
    });

    var canonical = raw.map(function (token) {
      return {
        text: collapseWhitespace(token.text),
        startMs: toInt(token.start, 0),
        endMs: Math.max(toInt(token.end, 0), toInt(token.start, 0)),
        nativeTiming: token.nativeTiming === true,
      };
    });
    // canonical token 流保留各词的原生时间，一个都不改。
    //
    // 这里曾经按词序"前推"收敛重叠（startMs = max(自身, 上一个词的 endMs)）。那是错的：
    // 前推让时间凭空增加且永不归还，于是整轨累积漂移 —— 实测中位晚 1960ms、末段晚 2.2s，
    // 52 个单元被挤到 400ms 以下，用户实测"完全对不上原始音频"。按词数重新锚定同样在累积
    // （1441→2080ms）。结论：startMs 是唯一必须精确贴合音轨的量，任何改动都会漂移。
    //
    // 重叠改由渲染层的 clampOverlappingRenderUnits 只截 endMs 处理，漂移严格为 0。
    // canonical 这一层还有 validateTokenSpanCoverage 的 fail-closed 契约：单元时间必须与
    // token 跨度严格相等，在这里动时间会直接违约。
    var identity = canonical.map(function (token) {
      return [token.text, token.startMs, token.endMs, token.nativeTiming ? 1 : 0].join("\x1f");
    }).join("\x1e");
    var fingerprint = hashCacheIdentity("token-v1\x1d" + identity);
    var tokens = canonical.map(function (token, index) {
      return {
        id: fingerprint + ":" + index,
        index: index,
        text: token.text,
        startMs: token.startMs,
        endMs: token.endMs,
        nativeTiming: token.nativeTiming,
      };
    });
    return {
      version: "token-v1",
      sourceFingerprint: fingerprint,
      tokens: tokens,
      // 重发前缀的回看窗口在这里定稿：它是源轨属性，必须在还看得见源 cue 时算好，
      // 不能留给对齐阶段从 display cue 反推（见 computeDupWindow 注释）。
      dupWindow: computeDupWindow(cues),
    };
  }

  /**
   * 把显示分段（resegment / semantic 产生的 cue）映射为 canonical timeline 上的
   * token 边界。canonical token 流是唯一权威来源：正文、顺序、时间都取自它，显示
   * cue 只贡献"切在哪里"。
   *
   * 关键背景：canonical 与 resegment 从同一源各自独立去重，且对"重复词跨"的处理
   * 方向相反——
   *   · canonical（appendTimelineTokens）按"词级时间重叠"去重：两次出现时间不重叠
   *     时保留重复词（如 gap 分隔的滚动 ASR "on the stove … on the stove"）。
   *   · resegmentCues（stripOverlap）按"文本"去重且封顶 8 词：会删掉 canonical 保留
   *     的那份重复。
   * 因此显示词流既可能比 canonical 多一份重复（canonical 删、display 留），也可能
   * 比 canonical 少一份（canonical 留、display 删）。旧实现只处理前一个方向，真机上
   * 遇到后一个方向就 throw，整轨字幕加载失败。这里做双向去重容忍的单调对齐：
   *   1. 词相等 → 匹配，游标 +1，消费该显示词；
   *   2. 显示词是 canonical 已删的重复（等于最近已消费 token）→ 跳过该显示词，游标不动；
   *   3. canonical 游标处 token 是 display 已删的重复（等于最近已消费 token）→ 游标 +1，
   *      不消费显示词（把该重复 token 归入当前区间）；
   *   4. 都不成立 → 真正的正文漂移，fail-closed 抛错（不削弱 fail-closed 语义）。
   * 只有"重复词"允许被跳过；引入 canonical 里不存在的新词或丢失非重复词一律抛错。
   * 边界只影响换行位置，token 正文与时间仍由 validateTokenSpanCoverage 对 canonical
   * 复核，故此处对重复接缝的容忍不会污染正文或时轴。
   */
  /**
   * 重复接缝的回看范围不能是魔法常量。曾固定为 32,而 YouTube 滚动 ASR 的重发
   * 前缀长度由【单条 cue 的词数】决定:当一条 cue 长 40 词、重发前缀 35 词时,
   * 同一个词的上一次出现距离可达 36 > 32,回看窗口看不见它 → 判不出是重复 →
   * 抛 "display cue does not align to canonical timeline" → 整轨字幕失效。
   * 实测 seg40/ov35、seg60/ov50、seg80/ov70 均因此失败,而 seg40/ov20 正常。
   *
   * 正确口径:回看范围 = 最长一条【源】cue 的词数(重发前缀不可能超过它)。
   * 这样窗口随数据自适应,既不会因常量偏小而漏判,也不会无界放大到把
   * 正文里合法的同词复现误判成重复(真实英文语料同词相邻距离中位 84)。
   *
   * 注意口径是【源 cue】而不是 display cue。重发前缀长度是源轨的物理属性,
   * 与显示侧怎么切分无关。曾用 display cue 词数,于是显示侧一旦切得更细
   * (人工字幕轨长句硬拆后单元从 40 词降到 12 词),窗口跟着缩到 12,再也看不见
   * 35 词的重发前缀 → 整轨抛 display cue does not align to canonical timeline。
   * 因此窗口由 buildCanonicalTokenTimeline 在解析源 cue 时算好挂在 timeline 上,
   * 对齐阶段直接用,不再从 display 反推。
   */
  function computeDupWindow(cues) {
    var maxWords = 0;
    (cues || []).forEach(function (cue) {
      var n = restoredWords(cue && cue.content).length;
      if (n > maxWords) maxWords = n;
    });
    return maxWords;
  }
  function isRecentDuplicateToken(tokens, cursor, wk, dupWindow) {
    var limit = dupWindow > 0 ? dupWindow : 0;
    for (var back = 1; back <= limit && cursor - back >= 0; back++) {
      if (wordKey(tokens[cursor - back].text) === wk) return true;
    }
    return false;
  }
  function mapDisplayCuesToBoundaries(timeline, cues) {
    var tokens = timeline && Array.isArray(timeline.tokens) ? timeline.tokens : [];
    var cursor = 0;
    var boundaries = [];
    // 窗口优先取 timeline 上定稿的源轨口径；旧调用方传入的 timeline 没有这个字段时
    // 退回按 display 推导（行为与历史一致），保证向后兼容。
    var dupWindow = timeline && Number(timeline.dupWindow) > 0
      ? Number(timeline.dupWindow)
      : computeDupWindow(cues);

    // 消费掉 canonical 游标处、display 已删除的重复 token（display 端去重造成的落差）。
    // 只在这些 token 是"最近已消费 token 的重复"时前进，避免吞掉真正的新内容。
    function drainCanonicalDuplicates(nextDisplayKey) {
      while (cursor < tokens.length) {
        var ck = wordKey(tokens[cursor].text);
        if (nextDisplayKey != null && ck === nextDisplayKey) break; // 让它去和显示词正常匹配
        if (!isRecentDuplicateToken(tokens, cursor, ck, dupWindow)) break; // 不是重复 → 停，交给正常流程/报错
        cursor++;
      }
    }

    (cues || []).forEach(function (cue) {
      var words = restoredWords(cue && cue.content || "");
      var consumed = 0;
      for (var wi = 0; wi < words.length; wi++) {
        var wk = wordKey(words[wi]);
        if (!wk) continue;
        // 方向 3：先跳过 canonical 保留、display 删除的重复 token（除非它正好等于本显示词）。
        drainCanonicalDuplicates(wk);
        // 方向 1：正常匹配。
        if (cursor < tokens.length && wordKey(tokens[cursor].text) === wk) {
          cursor++;
          consumed++;
          continue;
        }
        // 方向 2：显示词是 canonical 已删除的重复 → 跳过该显示词，游标不动。
        if (isRecentDuplicateToken(tokens, cursor, wk, dupWindow)) continue;
        // 方向 4：真正的漂移。
        throw new Error("display cue does not align to canonical timeline");
      }
      if (consumed > 0) boundaries.push(cursor - 1);
    });

    // 收尾：末段之后 canonical 可能仍留有 display 已删的重复 token，并入最后一段。
    drainCanonicalDuplicates(null);
    if (cursor !== tokens.length) {
      throw new Error("display cues do not cover canonical timeline");
    }
    if (boundaries.length && boundaries[boundaries.length - 1] !== tokens.length - 1) {
      boundaries[boundaries.length - 1] = tokens.length - 1;
    }
    return boundaries;
  }

  function buildCueTokenSpanUnits(timeline, cues) {
    var boundaries = mapDisplayCuesToBoundaries(timeline, cues);
    return buildTokenSpanUnits(timeline, boundaries);
  }

  // 一条字幕至少要可读这么久 —— 下限必须**随词数增长**,不能是个定值。
  //
  // 定值(曾用 1200ms)的问题:1 词和 13 词拿到同样的预算。实测真机轨里
  // ASR 自己就会给出 "13 词 / 1000ms"(77ms/词 ≈ 650 wpm,没人这么说话)
  // 这类明显失真的 cue —— 定值下限认为它「够长」,于是完全不管,长句照旧
  // 一闪而过。真机轨共 9 条原始 cue 的每词时长低于 150ms。
  //
  // 参考量:该轨正常语速中位约 350ms/词、p10 约 255ms/词。取 200ms/词
  // 作为「勉强读得完」的地板(约 300 wpm),明显偏快才补,不动正常语速的行。
  var MIN_VISIBLE_MS = 1200; // 单条字幕的绝对下限(极短单元用)
  var MIN_MS_PER_WORD = 200; // 每词可读时长地板(长单元用)

  // 一个显示单元的目标可读时长。取「绝对下限」与「按词数折算」的较大者。
  function minVisibleMsForUnit(text) {
    var words = restoredWords(String(text == null ? "" : text)).length;
    return Math.max(MIN_VISIBLE_MS, words * MIN_MS_PER_WORD);
  }

  /**
   * 给过短的显示单元补足可读时长 —— 只向后延进**真正的静音**里。
   *
   * 单元时间原本直接照抄自身 token 跨度(buildTokenSpanUnits),没有任何下限:
   * 实测真机轨 449 个单元中有 63 个短于 1200ms,最短仅 113ms("I")。
   * 长句在句中被切开时,后半截尤其容易只分到很短的跨度。
   *
   * 约束(不能靠加时长换来别的毛病):
   *  - 只吃掉与下一单元之间的空隙,绝不与下一单元重叠 —— 否则字幕会串行/抢位;
   *  - 不改 startMs —— 出现时刻必须仍然精确对齐语音,这是上一版刚修好的;
   *  - 借不够就借多少算多少(能改善就改善),不硬凑,不挪动别人的时间。
   */
  /**
   * 消除相邻显示单元的重叠 —— 只截 endMs，绝不动 startMs。
   *
   * 滚动窗口 ASR 轨（YouTube 自动字幕）相邻 cue 大幅重叠，同一句话在连续几条窗口里
   * 反复出现。cleanupCues 只压 cue 外层时间，而渲染单元的时间取自 token 跨度，
   * 于是重叠原封不动到达屏幕：实测真实轨 439 个单元里 233 个（53%）与下一条重叠，
   * 同一时刻最多 3 条字幕叠在一起。
   *
   * 为什么只能截 endMs：
   * startMs 是唯一必须精确贴合音轨的量。任何"把后续单元往后推"的做法都会让时间
   * 凭空增加且不归还，整轨累积漂移 —— 实测前推方案中位晚 1960ms、末尾晚 10s，
   * 按词重新锚定也仍然累积（1441→2080ms）。截 endMs 则漂移严格为 0。
   *
   * 代价是重叠区内单元变短，但"何时出现"对同步感的影响远大于"显示多久"，
   * 且随后的 padShortUnitsIntoSilence 会把过短的单元补进真实静音。
   */
  function clampOverlappingRenderUnits(units) {
    var list = Array.isArray(units) ? units : [];
    for (var i = 0; i < list.length - 1; i++) {
      var cur = list[i];
      var next = list[i + 1];
      if (!cur || !next) continue;
      if (cur.endMs > next.startMs) {
        cur.endMs = Math.max(cur.startMs, next.startMs);
      }
    }
  }

  function padShortUnitsIntoSilence(units, minVisibleMs) {
    var list = Array.isArray(units) ? units : [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u) continue;
      // 下限按该单元自己的词数算(显式传入则一律用传入值,便于测试)
      var floor = minVisibleMs != null ? minVisibleMs : minVisibleMsForUnit(u.originalText);
      var dur = u.endMs - u.startMs;
      if (dur >= floor) continue;
      var next = list[i + 1];
      // 末条没有后继约束,可以直接补到下限
      var limit = next ? next.startMs : u.startMs + floor;
      var target = Math.min(u.startMs + floor, limit);
      if (target > u.endMs) u.endMs = target;
    }
    return list;
  }

  // 一个词最多能占多久的"说话时间"。超出这个量的部分不是在说话，是静音。
  //
  // 为什么需要它：YouTube 的 json3 里每个 seg 只有 tOffsetMs（词的**开始**时刻），
  // 没有任何词级时长字段。于是 parseJson3 只能把词的 end 填成下一个词的 start，
  // 相邻词之间必然零间隔 —— 说话人真实的停顿被吞进了前一个词的显示时长里。
  // 实测真实 ASR 轨：4070 个 token 中 3483 个零距，渲染层 436/439 个相邻单元
  // 空隙为 0ms，字幕整段连成一片没有任何呼吸感。
  //
  // 但停顿信息其实在数据里：同一 event 内相邻词的 offset 间隔中位 241ms，
  // 而有 500 处 ≥500ms、114 处 ≥1000ms —— 那些就是真实的停顿。
  // 按"每词最多占 MAX_SPEECH_MS_PER_WORD"回推，多余的时间让回去即为停顿。
  // 取值依据（真实 ASR 轨实测，不是拍的）：源 token 相邻间隔 = 真实说话速度，
  // 中位 241ms/词、p75 400ms、p90 640ms。而渲染单元的时长却是中位 498ms/词 ——
  // 高出真实语速的那部分就是被吞掉的静音。取 p75 的 400ms 作为"说话"上界：
  // 比它更慢的部分按静音让回去，同时不会把正常语速的单元削短。
  var MAX_SPEECH_MS_PER_WORD = 400;
  // 让出的空隙小于这个值就不值得让（避免制造大量肉眼看不见的 1 帧空档）
  var MIN_MEANINGFUL_GAP_MS = 120;

  /**
   * 把单元尾部那段"其实没人在说话"的时间让回去，形成真实停顿。
   *
   * 只动 endMs，且只在【本单元自己的时长明显超过说完它所需的时间】时才动；
   * startMs 一个都不许改（出现时刻是唯一必须精确贴合音轨的量，改动会整轨累积
   * 漂移 —— v0.7.3 就是这么错的）。也绝不动 canonical token 跨度。
   *
   * 与 padShortUnitsIntoSilence 的关系：本函数削到的目标绝不低于可读下限
   * （minVisibleMsForUnit），而后者只处理时长不足下限的单元，两者作用域不相交，
   * 因此调用顺序颠倒对真实轨结果无影响（实测两种顺序均 185/186、无过短单元）。
   * 仍按"先补时长、后让停顿"排列，因为这个次序的语义更直白：先保证看得清，
   * 再把多出来的静音让回去。
   */
  function restoreSpeechPauses(units) {
    var list = Array.isArray(units) ? units : [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u) continue;
      var next = list[i + 1];
      if (!next) continue; // 末条后面没有内容，留着不影响观感
      var gap = next.startMs - u.endMs;
      if (gap >= MIN_MEANINGFUL_GAP_MS) continue; // 本来就有停顿
      var words = restoredWords(u.originalText).length;
      if (!words) continue;
      // 停顿发生在【末词说完之后】，不是均摊在整个单元上。所以判据必须落在末词上：
      // 单元里最后一个词的开口时刻 + 一个词的说话时长 = 这句话真正说完的时刻，
      // 之后的时间都是静音。按整单元均摊会漏掉一半真实停顿（实测 ASR 轨只能
      // 保住 49%）—— 因为长单元整体时长常常并不宽裕，但末词后面照样有静音。
      var lastWordStartMs = Number(u.lastTokenStartMs);
      var spokenUntil = Number.isFinite(lastWordStartMs)
        ? lastWordStartMs + MAX_SPEECH_MS_PER_WORD
        : u.startMs + words * MAX_SPEECH_MS_PER_WORD;
      // 不得短于可读下限，也不得早于 startMs
      var floor = minVisibleMsForUnit(u.originalText);
      var target = Math.max(spokenUntil, u.startMs + floor);
      if (target >= u.endMs) continue;
      // 让出的空隙太小就不折腾
      if (u.endMs - target < MIN_MEANINGFUL_GAP_MS) continue;
      u.endMs = target;
    }
    return list;
  }

  function buildTokenSpanUnits(timeline, boundaries) {
    var tokens = timeline && Array.isArray(timeline.tokens) ? timeline.tokens : [];
    if (!tokens.length) return [];
    var ends = [];
    var previous = -1;
    (boundaries || []).forEach(function (value) {
      var end = Number(value);
      if (!Number.isInteger(end) || end < 0 || end >= tokens.length || end <= previous) {
        throw new Error("invalid token boundary");
      }
      ends.push(end);
      previous = end;
    });
    if (ends[ends.length - 1] !== tokens.length - 1) ends.push(tokens.length - 1);
    var first = 0;
    var built = ends.map(function (last, index) {
      var span = tokens.slice(first, last + 1);
      var unit = {
        id: timeline.sourceFingerprint + ":u" + index + ":" + first + "-" + (last + 1),
        sourceFingerprint: timeline.sourceFingerprint,
        tokenStart: first,
        tokenEnd: last + 1,
        startMs: span[0].startMs,
        endMs: Math.max(span[span.length - 1].endMs, span[0].startMs),
        originalText: collapseWhitespace(joinRestoredWords(span.map(function (token) { return token.text; }))),
      };
      first = last + 1;
      return unit;
    });
    // 这里**不做**可读时长补偿:units 是 canonical provenance,
    // validateTokenSpanCoverage 明确要求 startMs/endMs 与 token 跨度逐一相等
    // (source timing mismatch),这是刻意的 fail-closed 契约。
    // 补时长属于呈现层,落在 renderUnits 上(见 padShortUnitsIntoSilence 调用处)。
    return built;
  }

  function invalidCoverage(reason, coveredTokens) {
    return { ok: false, coveredTokens: coveredTokens || 0, error: reason };
  }

  function validateTokenSpanCoverage(timeline, units) {
    var tokens = timeline && Array.isArray(timeline.tokens) ? timeline.tokens : [];
    var list = Array.isArray(units) ? units : [];
    if (!tokens.length) return list.length ? invalidCoverage("units without tokens", 0) : { ok: true, coveredTokens: 0 };
    if (!list.length) return invalidCoverage("missing units", 0);
    var cursor = 0;
    var ids = {};
    for (var i = 0; i < list.length; i++) {
      var unit = list[i] || {};
      if (unit.sourceFingerprint !== timeline.sourceFingerprint) return invalidCoverage("source fingerprint mismatch", cursor);
      if (!unit.id || ids[unit.id]) return invalidCoverage("duplicate or missing unit id", cursor);
      ids[unit.id] = true;
      if (!Number.isInteger(unit.tokenStart) || !Number.isInteger(unit.tokenEnd) || unit.tokenStart !== cursor || unit.tokenEnd <= unit.tokenStart || unit.tokenEnd > tokens.length) {
        return invalidCoverage(unit.tokenStart < cursor ? "token overlap" : "token gap", cursor);
      }
      var span = tokens.slice(unit.tokenStart, unit.tokenEnd);
      var original = collapseWhitespace(joinRestoredWords(span.map(function (token) { return token.text; })));
      if (collapseWhitespace(unit.originalText || "") !== original) return invalidCoverage("source text mismatch", cursor);
      if (Number(unit.startMs) !== Number(span[0].startMs) || Number(unit.endMs) !== Math.max(Number(span[span.length - 1].endMs), Number(span[0].startMs))) {
        return invalidCoverage("source timing mismatch", cursor);
      }
      cursor = unit.tokenEnd;
    }
    if (cursor !== tokens.length) return invalidCoverage("token gap at end", cursor);
    return { ok: true, coveredTokens: cursor };
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function createTimelineSnapshot(opts) {
    opts = opts || {};
    var timeline = clonePlain(opts.timeline || { version: "token-v1", sourceFingerprint: "", tokens: [] });
    var units = clonePlain(opts.units || []);
    var coverage = validateTokenSpanCoverage(timeline, units);
    if (!coverage.ok) throw new Error("timeline coverage invalid: " + coverage.error);
    var translations = opts.translations || {};
    var translationMap = {};
    var timelineTokens = Array.isArray(timeline.tokens) ? timeline.tokens : [];
    var renderUnits = units.map(function (unit) {
      var translation = String(translations[unit.id] == null ? "" : translations[unit.id]);
      translationMap[unit.id] = translation;
      // 末词开口时刻：restoreSpeechPauses 判断"话说完了没"的依据。
      // 只读不改 canonical token 时间。
      var lastTok = timelineTokens[unit.tokenEnd - 1];
      return {
        unitId: unit.id,
        sourceFingerprint: unit.sourceFingerprint,
        tokenStart: unit.tokenStart,
        tokenEnd: unit.tokenEnd,
        originalText: unit.originalText,
        translation: translation,
        startMs: unit.startMs,
        endMs: unit.endMs,
        lastTokenStartMs: lastTok ? lastTok.startMs : null,
      };
    });
    // 可读时长补偿只作用于呈现层:units 必须与 token 跨度严格一致
    // (validateTokenSpanCoverage 的 fail-closed 契约),renderUnits 才是真正
    // 拿去画的那份。只延 endMs、只吃真实静音、不动 startMs、不动 token 跨度。
    clampOverlappingRenderUnits(renderUnits);
    padShortUnitsIntoSilence(renderUnits);
    // 把末词说完之后的静音让回去，形成真实停顿（只动 endMs，不动 startMs）。
    restoreSpeechPauses(renderUnits);
    var snapshot = {
      version: "timeline-snapshot-v1",
      revision: Math.max(0, toInt(opts.revision, 0)),
      videoId: String(opts.videoId || ""),
      trackCode: String(opts.trackCode || ""),
      sourceFingerprint: timeline.sourceFingerprint,
      status: renderUnits.every(function (unit) { return unit.translation.trim(); }) ? "verified" : "provisional",
      timeline: timeline,
      units: units,
      translations: translationMap,
      renderUnits: renderUnits,
      coverage: coverage,
    };
    return deepFreeze(snapshot);
  }

  function cuesFromTimelineSnapshot(snapshot) {
    if (!snapshot || !snapshot.timeline || !Array.isArray(snapshot.units)) return [];
    return snapshot.units.map(function (unit) {
      var span = snapshot.timeline.tokens.slice(unit.tokenStart, unit.tokenEnd);
      return {
        start: unit.startMs,
        end: unit.endMs,
        duration: Math.max(0, unit.endMs - unit.startMs),
        content: unit.originalText,
        unitId: unit.id,
        tokenStart: unit.tokenStart,
        tokenEnd: unit.tokenEnd,
        sourceFingerprint: unit.sourceFingerprint,
        semanticGroupId: unit.semanticGroupId != null ? String(unit.semanticGroupId) : String(unit.id),
        tokens: span.map(function (token) {
          return {
            id: token.id,
            index: token.index,
            text: token.text,
            start: token.startMs,
            end: token.endMs,
            nativeTiming: token.nativeTiming,
          };
        }),
      };
    });
  }

  // 语义恢复协议：模型只可在源词之间加入 .?!|，绝不拥有正文所有权。
  // 逐词归一化后必须完全相等，否则整个 chunk 无效并由调用方重试/回退。
  // 词数计量必须与「屏上所见」一致 —— 屏上显示为一个词的就算一个词,否则
  // 「切分/DP 按 token 数」与「最终校验按正则」口径不一,一个显示 12 词的合格屏
  // 会被算成 13 词而误触发 oversize 抛错,拖垮整轨 semantic。因此下列都算一个词:
  //   - 连字符/撇号复合词:purpose-built、old-fashioned、plug-in、don't
  //   - 数字内分隔符:1,800、334,720、8.8、120.5(千分位逗号与小数点)
  // 真实字幕轨(4067 token)实测含 20 个这类数字 token,是上一轮完整轨才暴露的
  // 词/token 粒度错位的源头之一。
  //
  // 字母类必须是 Unicode 而非 ASCII。曾用 [A-Za-z0-9]，于是任何带变音符号的拉丁
  // 语言都在变音字母处断开：波兰语 "najsłodszych" 被切成 "najs"+"odszych"，且 ł
  // 本身作为分隔符被丢掉 —— 词数被高估（切分器按"词数 ≤12"限长，数的是碎片不是
  // 单词，屏上出现 20+ 真实单词的超长行），同时原文肉眼可见地缺字母。
  // \p{L} 覆盖全部 Unicode 字母，\p{M} 覆盖组合用变音记号（NFD 分解形式），
  // \p{N} 覆盖各语言数字。
  //
  // 连写文字（scriptio continua：汉字、假名、泰语、老挝语、高棉语、缅甸语）不靠
  // 空格分词，整句会被算成【一个】词 —— 于是所有以"词数"为单位的长度上限、时间
  // 分配、切分判据统统失效：实测 92 字日文长句、125 字泰文长句都是 1 词 1 段，
  // 原样铺满屏幕且永不被拆。语言中立的解法是让这些文字【一字一词】，而不是给它们
  // 另开分支：下游 maxWords、token 跨度时间、去重对齐全按原样生效，无需任何
  // "如果是中日泰就特殊处理"的判断。汉字/假名一字约合两个拉丁字符宽，一字一词也
  // 让"词数"重新近似屏幕宽度。韩文与越南语用空格分词，故不在此列。
  // 用 Script_Extensions（scx）而不是 Script：ー(U+30FC 长音符)、・(中点) 这类字符的
  // Script 是 Common，\p{Script=Katakana} 匹配不到，只有 scx 才认它们属于假名书写。
  // 当前实现里这些字符即便漏掉也会被标点尾巴 [^\p{L}\p{M}\p{N}\s]* 顺带吸收，
  // 但那是巧合而非设计；scx 让"哪些字符属于连写文字"这件事直接说对，
  // 不依赖另一条规则替它兜底。
  var UNSPACED_SET = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}" +
    "\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
  var UNSPACED_SCRIPT_SOURCE = "[" + UNSPACED_SET + "]\\p{M}*";
  // Script_Extensions 不只包含文字：日文句号“。”、逗号“、”、中点“・”等纯标点
  // 也可能声称属于 Han/Hiragana/Katakana。它们若成为独立 token，wordKey() 必清成
  // 空键，canonical 侧保留而 display 侧跳过，两条词流从第一个标点起永久错位。
  //
  // 不用语言白名单，也不用 Chrome 112+ 的 v 集合交集：在 u 模式下用正向预查，
  // 要求连写 token 的首字符本身至少是 Unicode 字母/组合记号/数字。长音符“ー”是 Lm，
  // 仍会保留；纯标点语言无关地排除，与空格分词分支的既有行为一致。
  var WORD_CONTENT = "[\\p{L}\\p{M}\\p{N}]";
  var UNSPACED_WORD_SOURCE = "(?=" + WORD_CONTENT + ")" + UNSPACED_SCRIPT_SOURCE;
  // 空格分词语言的字母类必须【排除】连写文字，否则 \p{L} 也匹配汉字/假名，
  // 拉丁分支会贪婪地把后面的连写文字一起吞掉："NASAが温度マップ" 成为一个 token，
  // 而显示侧按一字一词算 —— 两条词流错位，混排轨直接对齐失败（实测）。
  // 用否定预查而不是 v 标志的集合减法：v 标志要 Chrome 112+，而目标环境含很低配的
  // 老设备，u 标志的兼容面更宽。
  var SPACED_LETTER = "(?:(?![" + UNSPACED_SET + "])[\\p{L}\\p{M}\\p{N}])";
  var RESTORE_WORD_RE = new RegExp(
    "[0-9]+(?:[.,][0-9]+)+" +
    "|" + UNSPACED_WORD_SOURCE +
    "|" + SPACED_LETTER + "+(?:['’-]" + SPACED_LETTER + "+)*",
    "gu"
  );

  // 全系统唯一的"什么算一个词"权威定义。此前有三份互相矛盾的词正则:
  // parseJson3 与 restoredBoundaryMarks 各写了一份【不含连字符】的版本,
  // 而这里的 RESTORE_WORD_RE 【含连字符】。于是 "purpose-built" 在
  // canonical 侧被切成 2 个 token、在显示侧是 1 个词 —— 两条词流从该处起
  // 永久错位,最终在对齐时抛 "display cue does not align to canonical timeline",
  // 整轨字幕加载失败(连英文原文一起消失)。真机轨含 old-fashioned / plug-in /
  // purpose-built 三个这类词,只要视频讲到就必崩。
  // 因此:任何需要"把文本切成词"的地方都必须使用 newWordRe()/restoredWords(),
  // 不得再各自手写正则。
  function newWordRe() {
    // flags 必须从权威正则继承，不能硬写 "g"。RESTORE_WORD_RE 用了 \p{L} 等
    // Unicode 属性转义，它们只在带 u 标志时成立；丢掉 u 之后 \p 退化成字面量
    // "p"，整个字符类变成 [p{LMN}] —— parseJson3 把 "purpose-built" 切成
    // ["p","p","p"]（实测），词流全线崩坏。
    return new RegExp(RESTORE_WORD_RE.source, RESTORE_WORD_RE.flags);
  }

  // 单次翻译请求超时。全系统唯一定义，isolated.js 也从 Core 取此值，
  // 不再各处硬写 20000（曾有 4 处各写一遍）。
  //
  // 为什么是 90s：实测同一网关同一模型（gpt-5.4-mini）翻 4 行波兰语，端到端
  // 10.0s–32.4s 不等（含边界修复的二次请求）。原先写死 20s 时，慢的那一批请求
  // 被自己的超时掐断，重试也常常再次超时，整个 clip 全成 [未翻译] —— 用户看到的
  // 大面积未翻译有一半来自这里，与语言无关。上限仍需存在，否则卡死的请求会永远
  // 占住重试队列。
  // 一个源单元的词数上限，断句层与翻译守卫层的**唯一权威**。
  //
  // DISPLAY = 舒适阅读宽度（断句的目标值）；SOURCE_UNIT_MAX = 语法续接允许的硬上限。
  // 两者曾在断句处（continuationMaxWords: 14）与翻译守卫处（cap 12）各写一份且不一致，
  // 导致 13-14 词的合法续接单元永远翻不了 —— 真机才暴露，离线门禁全绿。
  var DISPLAY_UNIT_MAX_WORDS = 12;
  var SOURCE_UNIT_MAX_WORDS = 14;
  // 仅作为模型输入容量的绝对保险丝；实际显示硬门禁是 SOURCE_DISPLAY_MAX_WIDTH
  // 的语言无关半角视觉宽度。值不能低于短 token 书写系统中一个合规短屏的容量。
  var SEMANTIC_MAX_TOKENS = 40;
  // 所有源语言共用半角视觉宽度，而不是“英文词数/日文字符数”。源文单屏硬上限
  // 52，中文译文更紧凑到 48；完整语义允许跨多个显示单元，但任何实际行都不能靠
  // 缩成小字来塞下。
  var SOURCE_DISPLAY_PREFERRED_WIDTH = 48;
  var SOURCE_DISPLAY_MAX_WIDTH = 52;

  // 词数上限允许突破视觉宽度上限的最大倍数。见 tokenCapFor 的说明：
  // 拉丁轨确实需要按词数放宽，但放宽不能无上界，否则长词内容会堆到 173% 宽度。
  var WIDTH_OVERSHOOT_LIMIT = 1.25;
  var TRANSLATION_DISPLAY_MAX_WIDTH = 48;

  var TRANSLATE_TIMEOUT_MS = 90000;

  function restoredWords(text) {
    return String(text || "").match(RESTORE_WORD_RE) || [];
  }

  // 全系统唯一的"把词拼回文本"权威实现，与 RESTORE_WORD_RE 是一对；凡是把词数组
  // 还原成显示文本的地方都必须走它，不得再各自 join(" ")。
  //
  // 连写文字一字一词（见 RESTORE_WORD_RE 注释），若无脑用空格拼回，45 字中文会变成
  // "米 玛 斯 是 …" 89 字 —— 原文被硬生生撑开一倍，屏上全是散字。规则很简单：
  // 相邻两个词只要有一侧属于连写文字，就直接相接不加空格；两侧都是空格分词语言
  // （英/波/俄/越…）才加空格。这样中英混排 "NASAが温度" 也能正确还原。
  var UNSPACED_EDGE_RE = new RegExp("^" + UNSPACED_SCRIPT_SOURCE + "$", "u");
  // 切分成“显示用词”：词边界必须完全来自唯一权威 RESTORE_WORD_RE；显示侧只负责
  // 把被权威正则忽略的标点附着回相邻 token，绝不能另写一套 tokenizer。
  //
  // 每个空白块内按 newWordRe() 的 match span 取 token：首 token 吸收前置标点，
  // 各 token 吸收到下一个 token 前的尾随标点。这样既保留句末判定所需的标点，又保证
  // restoredWords(displayPiece) 与 canonical token 一一对应：
  //   “0.1mmず” → [“0.1”, “mm”, “ず”]，不会再变成 [“0.”,“1mm”,“ず”]。
  function splitDisplayWords(text) {
    var out = [];
    var pendingPrefix = "";
    var rawWords = collapseWhitespace(text).split(" ").filter(Boolean);
    for (var i = 0; i < rawWords.length; i++) {
      var raw = rawWords[i];
      var matches = [];
      var re = newWordRe();
      var match;
      while ((match = re.exec(raw)) !== null) {
        if (!match[0]) { re.lastIndex++; continue; }
        matches.push({ text: match[0], start: match.index, end: match.index + match[0].length });
      }
      // 整块都不含字母/数字（人工字幕的说话人分隔符 "-"、破折号、省略号…）：
      // 它不是词，不能单独成 token —— canonical token 流与显示词流必须逐词一一对应，
      // 而显示侧的权威 restoredWords 按定义不会产出这种块。放行会让游标错位一格，
      // 整轨抛 "display cue does not align to canonical timeline"（Netflix 双说话人
      // 行 13% 命中，实测整轨字幕失效）。附到下一个真实词的前缀上，字形一个不丢。
      if (!matches.length) {
        pendingPrefix += raw + " ";
        continue;
      }
      for (var p = 0; p < matches.length; p++) {
        var current = matches[p];
        var nextStart = p + 1 < matches.length ? matches[p + 1].start : raw.length;
        var prefix = p === 0 ? pendingPrefix + raw.slice(0, current.start) : "";
        if (p === 0) pendingPrefix = "";
        out.push(prefix + current.text + raw.slice(current.end, nextStart));
      }
    }
    // 收尾：若全文只剩纯标点块（无任何真实词），挂到最后一个词后面，绝不丢字形。
    if (pendingPrefix) {
      if (out.length) out[out.length - 1] += " " + pendingPrefix.trim();
      else out.push(pendingPrefix.trim());
    }
    return out;
  }

  function joinRestoredWords(words) {
    var list = Array.isArray(words) ? words : [];
    var out = "";
    for (var i = 0; i < list.length; i++) {
      var word = String(list[i] == null ? "" : list[i]);
      if (!word) continue;
      if (!out) { out = word; continue; }
      var prevChar = out.slice(-1);
      var glue = UNSPACED_EDGE_RE.test(prevChar) || UNSPACED_EDGE_RE.test(word.slice(0, 1));
      out += glue ? word : " " + word;
    }
    return out;
  }

  // 语义恢复分块的单一权威参数。整轨恢复按块送模型:块越大重叠开销越低。
  // 实测(gpt-5.5,180s 真实轨):c120/o30 需 10 次调用 13494 token;c200/o20 只需
  // 7 次调用 10145 token(省 25%)、快 31%,且句中硬切比例还略降(45%→42%)——
  // 200 词上下文对边界判断已足够,而 30/120 的 25% 重叠是纯重复发送开销。
  var SEMANTIC_CHUNK_WORDS = 200;
  var SEMANTIC_OVERLAP_WORDS = 20;

  function chunkTokenRanges(tokens, size, overlap) {
    var n = (tokens || []).length;
    var limit = Math.max(1, Math.floor(Number(size) || 120));
    var keep = Math.max(0, Math.min(limit - 1, Math.floor(Number(overlap) || 0)));
    var out = [];
    for (var start = 0; start < n;) {
      var end = Math.min(n, start + limit);
      out.push({ start: start, end: end, commitStart: start, commitEnd: end === n ? end : end - keep });
      if (end === n) break;
      start = end - keep;
    }
    return out;
  }

  function packRestoredTokens(tokens, marks, opts) {
    opts = opts || {};
    var maxWords = Math.max(1, Math.floor(Number(opts.maxWords) || 24));
    var list = (tokens || []).filter(function (t) { return t && t.text; });
    if (!list.length || !Array.isArray(marks) || marks.length !== list.length) return [];
    var ends = [];
    var start = 0;
    while (start < list.length) {
      // 模型声明的 | 和 . 都是经过词流校验的语义边界，必须逐个兑现。
      // 不能为了靠近长度上限吞掉前一个 |，否则确定性排版又会破坏语义。
      var marked = -1;
      for (var i = start; i < list.length; i++) {
        if (marks[i] === "." || marks[i] === "|") { marked = i; break; }
      }
      var end = marked >= 0 ? marked : list.length - 1;
      // 无模型边界时仍不按长度强切，完整保留并由审计暴露 oversize。
      ends.push(end);
      start = end + 1;
    }
    var units = segmentTokensByBoundaries(list, ends);
    var semanticGroup = 0;
    for (var ui = 0; ui < units.length; ui++) {
      units[ui].semanticGroupId = "sg" + semanticGroup;
      var endIndex = ends[ui];
      if (marks[endIndex] === ".") semanticGroup++;
    }
    return units;
  }

  function unitWordCount(unit) {
    return restoredWords(unit && unit.content).length;
  }

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
        content: collapseWhitespace(c.content || "").replace(/^\.(?=[A-Za-z])/u, ""),
        // JSON3 语义恢复依赖每个词的原生偏移。清洗排序/去重叠只改 cue 外层时间，
        // 不能在这里丢掉 token 元数据，否则运行时会永久误判为“无词级时间”。
        tokens: Array.isArray(c.tokens) ? c.tokens.map((token) => ({
          text: collapseWhitespace(token && token.text || ""),
          start: toInt(token && token.start, 0),
          end: toInt(token && token.end, 0),
          // rollingEnd 必须透传：它是滚动重复去重的唯一判据（见 timedJson3EventTokens）。
          // 在这里丢掉会让 appendTimelineTokens 回落到已夹的 end，重复词被渲染两次。
          rollingEnd: token && token.rollingEnd != null ? toInt(token.rollingEnd, 0) : undefined,
          nativeTiming: !!(token && token.nativeTiming),
        })).filter((token) => token.text) : undefined,
      }))
      .filter((c) => c.content.length > 0);

    // 修正 end：end 必须 >= start
    for (const c of list) {
      if (c.end < c.start) c.end = c.start + (c.duration > 0 ? c.duration : 0);
      if (c.end < c.start) c.end = c.start;
    }

    list.sort((a, b) => a.start - b.start || a.end - b.end);

    // 去重叠：把前一句的 end 压到不超过后一句的 start。
    // 注意只压 cue 外层：token 时间的真实重叠是 appendTimelineTokens 判定滚动重复词的
    // 唯一依据，在这里抹平会让去重复词失效（同一句话被重复渲染）。渲染时间的去重叠
    // 收敛在 buildCanonicalTokenTimeline —— 那里是唯一权威时间源。
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

  /**
   * 非台词的音效/场景标记（字幕作者写给观众的旁注，不是有人在说话）。
   *
   * 三种包裹形态取自真实人工上传轨（_-mBeYC2KGc，Technology Connections）：
   *   *awkward pause*
   *   [sound level increases slightly as compressor kicks in]
   *   ♫ icy smooth jazz ♫
   *
   * 必须单独占一屏。它们不带句末标点，所以 SENTENCE_END_RE 看不见边界，
   * 分屏层会把它当成"还没说完的句子"继续吞下一条台词，实测产出：
   *   "*awkward pause* But there's an increasingly popular variety of them..."
   * 译文跟着黏成「尴尬停顿但有一种越来越受欢迎的款式」——旁注和台词混成一句。
   *
   * 判据只认「整条都是标记」，不匹配句中夹带的星号/括号：台词里出现
   * (like this) 属于正常内容，拆开反而破句。
   */
  var SOUND_CUE_RE = /^\s*(?:\*[^*]+\*|\[[^\]]+\]|[♪♫][^♪♫]+[♪♫])\s*$/;

  function isSoundCue(text) {
    return SOUND_CUE_RE.test(String(text == null ? "" : text));
  }

  /**
   * 音效标记被宽度拆成多屏后，给每片补齐包裹符。
   *
   * 拆分本身是对的（可读性优先，见 flush 处说明），但直接拆会留下断头：
   *   ["[compressor kicks in, and a second, much louder", "fan spins up at the same time]"]
   * 观众看到孤立的 "[" 或 "]" 会以为字幕出错。补齐后：
   *   ["[compressor kicks in, and a second, much louder]", "[fan spins up at the same time]"]
   * 每片都是自洽的旁注，读起来仍是"这是音效说明"而不是台词。
   *
   * 只动首尾字符，不碰词本身 —— 净化类操作绝不许删原文内容。
   */
  function rewrapSoundCueChunks(chunks) {
    var first = joinRestoredWords(chunks[0]).trim();
    var open = first.charAt(0);
    var close = open === "[" ? "]" : (open === "*" ? "*" : (open === "♪" || open === "♫" ? open : ""));
    if (!close) return chunks;
    return chunks.map(function (ws, idx) {
      var copy = ws.slice();
      var lastIdx = copy.length - 1;
      if (lastIdx < 0) return copy;
      // 非首片补开符、非末片补闭符；词内容本身一个字符都不动。
      if (idx > 0) copy[0] = open + String(copy[0] == null ? "" : copy[0]);
      if (idx < chunks.length - 1) copy[lastIdx] = String(copy[lastIdx] == null ? "" : copy[lastIdx]) + close;
      return copy;
    });
  }

  // 对齐用的词键：转小写、去掉词首尾的标点，保留内部的撇号/连字符。
  //
  // 字符类必须是 Unicode。曾用 [^0-9a-z一-鿿]，它只认 ASCII 字母、数字和 CJK，
  // 于是任何带变音符号或非拉丁字母的词都被当成"标点包裹"而遭削首去尾：
  //   "Łódź" -> "d"、"żółty" -> "ty"、"świat" -> "wiat"
  //   "ąćę" / "Привет" / 全角数字 -> ""（整词清空）
  // 键一旦被削，同一个词在 canonical 与 display 两侧算出不同的键，对齐直接抛
  // "display cue does not align to canonical timeline" —— 整轨字幕失效
  // （实测视频 scWj1BMRHUA 的波兰语轨即因此整轨拒绝，屏上全是 [未翻译]）。
  // \p{L} 字母 + \p{M} 组合记号 + \p{N} 数字，覆盖全部书写系统。
  function wordKey(w) {
    return String(w || "")
      .toLowerCase()
      .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
  }

  /**
   * 去掉 next 开头与 prev 结尾重叠的词，返回 next 去重叠后的词数组。
   * 例：prev="...how transformers work" next="work under the hood"
   *     → next 去掉开头的 "work" → ["under","the","hood"]。
   * 只在词级别比对（CJK 无空格的语言此重叠少见，按整体词处理即可）。
   */
  /**
   * 去掉「滚动 ASR 重发」造成的重复前缀。
   *
   * 关键约束：重复文本本身**不是**重发的充分证据。滚动重发的定义是
   * “同一次发声被上一条 cue 和这一条 cue 各写了一遍”，它必须有时间证据 ——
   * 源轨的两条 cue 在时间上重叠（YouTube json3 滚动窗口正是如此）。
   *
   * 人工成品字幕轨（Netflix TTML，实测相邻重叠 0 处）里重复文本是**真台词**：
   *   "It works. It works like crazy!"        → 曾被删成 "It works. like crazy!"（病句）
   *   "Tobes! Tobes, Tobes, Tobes, Tobes!"    → 曾被删掉一个 Tobes
   *   "He almost..." / "Almost what?"         → 跨 cue 的合法重复，曾被删掉 Almost
   * 实测 Netflix 英文轨 352 cue 因此丢 12 个词，全是这类合法重复。
   *
   * 判据不能是「间隙有多大」：上面最后一例的两条 cue 只隔 83ms，任何间隙阈值都
   * 会误判。判据是「这条轨会不会滚动重发」，由 resegmentCues 的调用方按轨来源
   * 声明（opts.rollingSource），一次判定、全轨一致，不逐对猜时间。
   */
  function stripOverlap(prevWords, nextWords, rollingSource) {
    // 源轨不是滚动轨 → 不存在重发，重复即真实内容，原样保留。
    if (rollingSource === false) return nextWords;
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
    var maxDur = opts.maxDurationMs != null ? opts.maxDurationMs : 6000;
    var hasExplicitMaxWords = opts.maxWords != null;
    var maxWords = hasExplicitMaxWords ? opts.maxWords : 12;
    // 「词数」对逐字文字（中日韩泰…）不是宽度的等价物：splitDisplayWords 把连写文字
    // 逐字切成 token，于是 maxWords=12 对拉丁文约 60-70 视觉宽度（舒适），对日文只有
    // 12 —— 实测 Dw43jxWZvPg 日语轨 1146 屏中 97% ≤12 字符，中位 9 字符，疯狂分屏。
    // 修法不是给 CJK 加特例分支，而是把上限的单位统一成视觉宽度：宽度是屏能装多少的
    // 唯一真实约束，词数只是它在等宽拉丁文下的近似。口径复用 semanticTokenBudgets，
    // 与语义模式同源，不另算一套（语义轨本来就不碎，正因为它走的是宽度口径）。
    var visualWidthCap = opts.maxVisualWidth != null
      ? Math.max(12, Math.floor(Number(opts.maxVisualWidth))) : null;
    // 把宽度上限折算成这批词的 token 数上限。
    //
    // 关键：只**放宽**，永不收紧。宽度折算的用途是「逐字文字里 1 token = 1 字，词数上限
    // 严重低估了屏能装的内容」，所以取 max(词数上限, 宽度折算出的上限)。
    // 若写成直接采用折算值，拉丁轨会被收紧：`unit0 has four words` 平均宽 5.25，
    // 52/5.25≈9 < 12，于是 12 词的既有行为被压到 9 词，还会把一个 cue 劈成两半分到
    // 相邻单元（实测 browser-replay full-srt 因此失败）。词数上限对拉丁文本来就合适，
    // 折算值只该在它明显偏小时接管。
    function tokenCapFor(words, wordCap) {
      if (visualWidthCap == null) return wordCap;
      var list = (words || []).filter(function (w) { return String(w || "").trim(); });
      if (!list.length) return wordCap;
      var average = semanticDisplayWidth(collapseWhitespace(joinRestoredWords(list))) / list.length;
      if (!(average > 0)) return wordCap;
      var widthCap = Math.floor(visualWidthCap / average);
      // 词数上限仍是主判据（上面那段说明了为什么不能改成直接采用折算值），
      // 但它不能无上界地压过宽度：英文技术内容里 12 个长词（Single-hose、
      // air conditioners、figuratively）实测能堆到 90 字符 = 宽度上限 52 的 173%，
      // 真实轨上 12% 的屏超宽、p99 达 82，尾部完全失控。那是可读性问题，
      // 不是"宽度只是近似"能解释的量级。
      //
      // 所以给放宽留一个封顶：宽度可以被突破（拉丁轨确实需要），但不得超过
      // WIDTH_OVERSHOOT_LIMIT 倍。取 1.25 —— p90 是 54（上限的 1.04 倍）属正常
      // 波动必须放行，1.25 对应 65 字符，把 47 条 60~90 字符的失控屏收回来，
      // 同时不触碰绝大多数只是轻微越界的正常屏。
      var overshootCap = Math.floor(visualWidthCap * WIDTH_OVERSHOOT_LIMIT / average);
      return Math.max(Math.min(wordCap, overshootCap), widthCap);
    }
    var hasExplicitContinuationMaxWords = opts.continuationMaxWords != null;
    var continuationMaxWords = hasExplicitContinuationMaxWords
      ? Math.max(maxWords, Math.floor(Number(opts.continuationMaxWords) || maxWords)) : null;
    // 完整句短于这个词数时先不落屏，留一轮给 orphanPrepMerge 判断下一条是不是
    // 「句末孤立介词短语」（It vanished. + in the vacuum chamber.）——那不是新句子。
    // 它**只**推迟落屏时机，不授权跨句合并：一屏两句由 canMerge 单点拒绝。
    // 取 3 而不是别的数：介词短语续接的语义前提是主句本身很短、信息不完整；
    // 3 词以上的完整句已能独立成屏，不需要靠后续短语补足。
    var SENTENCE_FLUSH_MIN_WORDS = opts.minWords != null ? opts.minWords : 3;
    var longPauseMs = opts.longPauseMs != null ? opts.longPauseMs : 700;
    var grammarContinuationMaxGapMs = opts.grammarContinuationMaxGapMs != null
      ? opts.grammarContinuationMaxGapMs : 2200;
    var grammarContinuationMaxDurationMs = opts.grammarContinuationMaxDurationMs != null
      ? opts.grammarContinuationMaxDurationMs : 12000;
    var tailTrimMs = opts.tailTrimMs != null ? opts.tailTrimMs : 120;
    if (!(tailTrimMs > 0)) tailTrimMs = 0;
    var TAIL_TRIM_MIN_VISIBLE_MS = 300;

    // ASR 的一个 cue 可能已包含多个完整句。先在强句末标点处分开，再做跨 cue 合并；
    // 时间按字符权重落回原 cue 区间，不猜词级时间，也不制造重叠。
    function splitCueAtSentenceEnds(cue) {
      var text = collapseWhitespace(cue.content || "");
      if (!text) return [];
      var parts = [];
      var re = /.*?[.!?。！？…]+["'”’)\]]*(?=\s+|$)|.+$/g;
      var m;
      while ((m = re.exec(text))) {
        var part = collapseWhitespace(m[0]);
        if (part) parts.push(part);
      }
      if (parts.length <= 1) {
        return [{ start: cue.start, end: cue.end, duration: Math.max(0, cue.end - cue.start), content: text }];
      }
      var total = 0;
      for (var i = 0; i < parts.length; i++) total += Math.max(1, parts[i].length);
      var span = Math.max(0, cue.end - cue.start);
      var acc = 0;
      var out = [];
      for (var j = 0; j < parts.length; j++) {
        var partStart = cue.start + Math.round(span * acc / total);
        acc += Math.max(1, parts[j].length);
        var partEnd = j === parts.length - 1 ? cue.end : cue.start + Math.round(span * acc / total);
        out.push({ start: partStart, end: partEnd, duration: Math.max(0, partEnd - partStart), content: parts[j] });
      }
      return out;
    }

    // 「这条轨会不会滚动重发」由调用方按轨来源显式声明，默认 true 保持既有行为。
    //
    // 不能靠推断：token 上的 rollingEnd 只有 parseJson3 会产生，而真实 YouTube
    // VTT 自动轨同样滚动重发却没有 tokens —— 用 rollingEnd 推断会漏掉它们。
    // 反过来 Netflix TTML 是人工成品轨（实测相邻重叠 0 处），重复即真台词。
    // 唯一可靠的信息在调用方：它知道这份 cue 是哪个解析器出来的。
    var rollingSourceTrack = opts.rollingSource !== false;

    var list = [];
    // 这里**不做**时间修复:resegment 只决定「切在哪里」,它的 cue 时间下游
    // 会被丢弃(最终显示时间一律来自 canonical token)。在这里改时间只会
    // 干扰长停顿/碎句黏合等分屏判定 —— 那是另一套已被测试锁定的行为。
    // 每个 piece 记住它来自**哪条源 cue**：同一条源 cue 内切出的两段绝不可能是
    // 滚动重发（"It works." / "It works like crazy!" 来自同一条），stripOverlap
    // 必须能区分「跨源 cue 的重复」和「同源 cue 内的重复」。
    (cues || []).filter(function (c) { return c && c.content; }).forEach(function (c, srcIdx) {
      var pieces = splitCueAtSentenceEnds(c);
      for (var i = 0; i < pieces.length; i++) {
        pieces[i].srcIdx = srcIdx;
        list.push(pieces[i]);
      }
    });
    if (!list.length) return [];

    var out = [];
    var cur = null;

    function hasEnglishContinuationTail(words) {
      var text = collapseWhitespace((words || []).join(" ")).replace(/[,:;!?]+$/g, "").toLowerCase();
      return /(?:^|\s)(?:to|of|for|with|from|at|in|on|by|about|into|over|under|between|through|and|or|but|because|that|which|who|whose|when|while|if|than|as|the|a|an|my|your|his|her|its|our|their|other|one|much|many|more|less|pretty|is|are|was|were|be|been|being|do|does|did|have|has|had|will|would|can|could|should|may|might|must|\w+n['’]t|\w+['’](?:ll|re|ve|d|m|s))$/.test(text);
    }

    // 某些 ASR 片段不是“尾词命中介词”，而是从限定结构开头后被连续截碎：
    // One / And one of those other / The …。一旦识别，只在 gap/词数/10s 三个硬边界内
    // 延续到完整句末；这取代 v0.5.1 的“一次续接锁”，避免 4/5/6/14 类无意义碎片。
    function startsSyntacticFragmentChain(words) {
      var text = collapseWhitespace((words || []).join(" ")).replace(/^["']+|[,:;]+$/g, "").toLowerCase();
      if (!text || words.length > 6) return false;
      return /^(?:one|a|an|the|this|these|those)(?:\s|$)/.test(text) ||
        /^(?:and|but|or)\s+(?:one|a|an|the|this|these|those)(?:\s|$)/.test(text);
    }

    function startsWithContinuation(words) {
      var text = collapseWhitespace((words || []).join(" ")).toLowerCase();
      return /^(?:such as|as well as|which|that|who|whose|where|when|while|because|than|and|or|but)\b/.test(text);
    }

    // 自动字幕通常只在真正的新句首使用大写；下一 cue 以小写词/数字开头时，
    // 它几乎肯定仍是当前句的宾语、补语或复合词后半段（much / water、stove / top）。
    // 这里只作为 grammarMerge 的必要信号，仍受 gap、词数和 12 秒三个硬上限约束。
    function startsLowercaseContinuation(cue) {
      var text = collapseWhitespace(cue && cue.content || "");
      return /^[a-z0-9]/.test(text);
    }

    function startsOrphanPrepositionalPhrase(words) {
      var text = collapseWhitespace((words || []).join(" ")).toLowerCase();
      return /^(?:on|in|at|with|for|from|by|to|of|under|over|through|into|during|after|before|without)\b/.test(text);
    }

    // maxWords 此前只作为"跨 cue 合并"的判据，单条源 cue 自身超限时无人拆它。
    // ASR 轨每条只有几个词，掩盖了这个缺口；人工字幕轨一条就是一整句长文本
    // （实测 scWj1BMRHUA 有 16 词单条），于是原样透传到屏上 —— 既超出舒适阅读
    // 宽度，又超过翻译层的词数上限被 fail-closed 拒成 [未翻译]。
    //
    // 拆分口径必须是 canonical 的 RESTORE_WORD_RE token，不是空白分词：
    // 一个空白词可能含多个 token（Onesecond[.designly.com]、1,800）或零个
    // token（纯标点）。按空白均摊会让显示侧与 canonical 侧的 token 下标错位，
    // 整轨抛 "display cue does not align to canonical timeline"（首版实测 15 红）。
    // 因此这里以「累计 token 数」决定切点，空白词本身保持完整不切开。
    function splitWordsToCap(words, cap) {
      if (cap <= 0) return [words];
      var totalTokens = 0;
      var counts = [];
      for (var i = 0; i < words.length; i++) {
        var n = restoredWords(words[i]).length;
        counts.push(n);
        totalTokens += n;
      }
      if (totalTokens <= cap) return [words];
      // 均摊成尽量等长的若干块，避免 12 + 1 这种孤儿尾巴
      var parts = Math.ceil(totalTokens / cap);
      var target = Math.ceil(totalTokens / parts);
      var chunks = [];
      var curChunk = [];
      var curTokens = 0;
      for (var j = 0; j < words.length; j++) {
        // 达到目标块长就收口，或者再加这个词会越过 cap 时必须收口；不切开单个空白词。
        // 用【或】而不是与：一词一 token 的连写文字里 counts[j] 恒为 1，与关系下
        // "已达 target"和"再加就超 cap"这两件事很难同时成立，收口被推迟到贴着 cap
        // 才发生，块长分布明显偏斜（实测中文长句 好11词/坏12词）。或关系让块长稳定
        // 落在 target 附近，屏宽更均匀。
        var wouldExceedCap = curTokens + counts[j] > cap;
        if (curChunk.length && (curTokens >= target || wouldExceedCap)) {
          chunks.push(curChunk);
          curChunk = [];
          curTokens = 0;
        }
        curChunk.push(words[j]);
        curTokens += counts[j];
      }
      if (curChunk.length) chunks.push(curChunk);
      return chunks;
    }

    function flush() {
      if (!cur) return;
      // 超长硬拆的上限分两档，因为这里有两个互相拉扯的约束：
      //  - 未合并的单元就是原样一条源 cue（人工字幕轨的整句长文本落在这里），
      //    按 maxWords 拆，得到舒适阅读宽度；
      //  - 合并出来的单元是 grammarMerge / orphanPrepMerge 有意越过 maxWords 的产物
      //    （语法未完成的句子续接、孤立限定词并入）。在 maxWords 处拆会把刚合好的
      //    语义单元重新切碎，实测打红 7 条续接门禁；但完全不拆也不行 ——
      //    整句送译对超过 SEMANTIC_MAX_TOKENS 的单元直接 fail-closed，
      //    整 clip 变 [未翻译]。所以按「合并逻辑自己允许的最大宽度」兜底拆，
      //    上限口径复用 mergeHardCap（与 orphanCap / continuationCap 同源，
      //    不在这里另算一套，否则两处漂移就是下一个 bug）。
      var wordCap = cur.merged ? (cur.mergeHardCap || maxWords) : maxWords;
      // 音效/场景标记照常按宽度拆 —— 可读性优先于形式完整。
      //
      // 曾让它整条不拆以保住包裹符，结果 "[compressor kicks in, and a second,
      // much louder fan spins up at the same time]" 78 字符挤一屏（maxVisualWidth=48
      // 的 163%）且只给 3.5s，屏上糊成一坨。宽度上限本来就是可读性判据，
      // 为了让方括号成对而突破它是本末倒置。
      //
      // 真正要守的是「不出现断头包裹符」，所以拆完给每片补上包裹（下面的
      // rewrapSoundCueChunks），而不是拒绝拆分。
      var isMark = isSoundCue(joinRestoredWords(cur.words));
      var chunks = splitWordsToCap(cur.words, tokenCapFor(cur.words, wordCap));
      if (isMark && chunks.length > 1) chunks = rewrapSoundCueChunks(chunks);
      var span = Math.max(0, cur.end - cur.start);
      var weights = chunks.map(function (ws) {
        return Math.max(1, collapseWhitespace(joinRestoredWords(ws)).length);
      });
      var weightTotal = weights.reduce(function (a, b) { return a + b; }, 0);
      var acc = 0;
      for (var ci = 0; ci < chunks.length; ci++) {
        var content = collapseWhitespace(joinRestoredWords(chunks[ci]));
        var pieceStart = cur.start + Math.round(span * acc / weightTotal);
        acc += weights[ci];
        var pieceEnd = cur.start + Math.round(span * acc / weightTotal);
        if (!content) continue;
        var endMs = pieceEnd;
        // 尾部留白只作用于最后一块：中间块的 end 就是下一块的 start，
        // 在这里裁剪会凭空制造缝隙并让时间不再连续。
        if (ci === chunks.length - 1 && tailTrimMs > 0 && pieceEnd - pieceStart > tailTrimMs * 2) {
          var trimmed = pieceEnd - tailTrimMs;
          if (trimmed - pieceStart < TAIL_TRIM_MIN_VISIBLE_MS) trimmed = pieceStart + TAIL_TRIM_MIN_VISIBLE_MS;
          if (trimmed < endMs) endMs = trimmed;
        }
        out.push({ start: pieceStart, end: endMs, duration: Math.max(0, endMs - pieceStart), content: content });
      }
      cur = null;
    }

    for (var idx = 0; idx < list.length; idx++) {
      var c = list[idx];
      // 空白切分对连写文字（中日泰…）无效：整句没有空格，只得到【一个】巨词，
      // splitWordsToCap 无处可切，45 词的中文长句原样铺满屏幕（实测 92 字日文 /
      // 125 字泰文 / 45 字中文全都 1 段）。
      // 但这里【不能】直接用 restoredWords()：它会剥掉标点，而下游的句末判定
      // (SENTENCE_END_RE)、小写续接、引号处理都依赖词上带着原标点，剥了会打红 15 条。
      // 正确做法是保留空白切分的结果（含标点），仅对"内部还含连写文字"的巨词按
      // 权威口径再切一层，切点落在字与字之间，标点自然留在所属的字上。
      var words = splitDisplayWords(c.content);
      if (!words.length) continue;

      if (!cur) {
        cur = { start: c.start, end: c.end, words: words.slice(), fragmentChain: startsSyntacticFragmentChain(words), srcIdx: c.srcIdx };
      } else {
        var gap = c.start - cur.end;
        // 滚动重发的时间证据：两条 piece 必须来自**不同**源 cue，且这两条源 cue
        // 在时间上真实重叠。同一源 cue 内切出的两段（"It works." / "It works
        // like crazy!"）不可能是重发，源轨零重叠时（人工成品字幕）同理。
        // 同一源 cue 内切出的两段绝不可能是重发（"It works." / "It works like
        // crazy!"）；跨 cue 时才看轨形态。两个条件都不依赖间隙大小。
        var sameSource = cur.srcIdx != null && cur.srcIdx === c.srcIdx;
        var added = stripOverlap(cur.words, words, !sameSource && rollingSourceTrack);
        var ended = SENTENCE_END_RE.test(cur.words.join(" "));
        var wouldWords = cur.words.length + added.length;
        var wouldDur = c.end - cur.start;
        // 合并判据里的所有词数上限都必须走同一折算口径，否则逐字文字永远达不到
        // maxWords，碎片既不被合并也不被拆分，原样停留在源轨的破碎边界上。
        var effMaxWords = tokenCapFor(cur.words.concat(added), maxWords);
        var orphanCap = hasExplicitContinuationMaxWords
          ? continuationMaxWords : effMaxWords + (hasExplicitMaxWords ? 8 : 2);
        var orphanPrepMerge = ended && startsOrphanPrepositionalPhrase(words) &&
          gap < grammarContinuationMaxGapMs && wouldWords <= orphanCap &&
          wouldDur <= grammarContinuationMaxDurationMs;
        // ended 的单元不会走到这里：完整句在上一轮循环末尾就被 flush 了（见下方
        // `if (endedNow)`）。这里只剩「句子未结束」和 orphanPrepMerge（句号后紧跟
        // 孤立介词短语，本身不是新句子）两种情况。
        // 不要在这里再加一条「短句可破例合并」——那会与 flush 形成两套判据，正是
        // Jay 报的跨句分屏缺陷的来源。
        // 音效/场景标记两侧都是硬边界：它自己不吞下一条台词，台词也不并进它。
        // 判据放在 canMerge 这一个点上，和「一屏不放两个完整句」同源，
        // 不在 flush 侧另开一套（两处各判必然漂移）。
        var soundCueBoundary = isSoundCue(cur.words.join(" ")) || isSoundCue(c.content);
        var canMerge = (!ended || orphanPrepMerge) && !soundCueBoundary;
        var normalMerge = gap < longPauseMs && wouldWords <= effMaxWords && wouldDur <= maxDur;
        var continuationCap = hasExplicitContinuationMaxWords
          ? continuationMaxWords
          : (hasExplicitMaxWords ? effMaxWords + Math.max(4, Math.ceil(effMaxWords * 0.75)) : effMaxWords + 2);
        // 下一 cue 若在内部很快出现句号，只需把第一个完整句并入；其后的新句已由
        // splitCueAtSentenceEnds 拆成独立 piece，不应计入这次续接的词数预算。
        var addedEndsSentence = SENTENCE_END_RE.test(added.join(" "));
        var effectiveContinuationCap = !hasExplicitContinuationMaxWords && hasExplicitMaxWords && addedEndsSentence
          ? continuationCap + 4 : continuationCap;
        var nextStartsNewSentence = /^(?:And|But|Or|So)\b/.test(c.content || "") &&
          !hasEnglishContinuationTail(cur.words) && !cur.fragmentChain;
        var baseGrammarNeeded = hasEnglishContinuationTail(cur.words) ||
          cur.fragmentChain || startsWithContinuation(words);
        var lowercaseContinuation = startsLowercaseContinuation(c);
        var grammarNeeded = !nextStartsNewSentence && (baseGrammarNeeded || lowercaseContinuation);
        var grammarGapLimit = baseGrammarNeeded ? grammarContinuationMaxGapMs : longPauseMs;
        var grammarMerge = !ended && grammarNeeded && gap < grammarGapLimit &&
          wouldWords <= effectiveContinuationCap && wouldDur <= grammarContinuationMaxDurationMs;
        if (canMerge && (normalMerge || grammarMerge || orphanPrepMerge)) {
          for (var w = 0; w < added.length; w++) cur.words.push(added[w]);
          cur.end = Math.max(cur.end, c.end);
          // 源标识跟着推进到最后并入的那条 piece：下一轮判重发时，对照的必须是
          // 「cur 目前吃到哪条源 cue」，而不是它最初来自哪条。
          cur.srcIdx = c.srcIdx;
          cur.merged = true;
          // 记下"本次合并被允许到多宽"。flush 的超长兜底拆分复用这个值，
          // 而不是另算一套上限 —— 上限只有一个来源，两处各算必然漂移。
          var allowedCap = normalMerge ? effMaxWords : 0;
          if (orphanPrepMerge && orphanCap > allowedCap) allowedCap = orphanCap;
          if (grammarMerge && effectiveContinuationCap > allowedCap) allowedCap = effectiveContinuationCap;
          if (!(cur.mergeHardCap > allowedCap)) cur.mergeHardCap = allowedCap;
        } else {
          flush();
          cur = { start: c.start, end: c.end, words: words.slice(), fragmentChain: startsSyntacticFragmentChain(words), srcIdx: c.srcIdx };
        }
      }

      var curWords = cur.words.length;
      var endedNow = SENTENCE_END_RE.test(cur.words.join(" "));
      // 这里**不能**改成 `if (endedNow)` 无条件落屏。看着更干净，但会让下一轮的
      // `ended` 恒为 false，从而静默废掉 orphanPrepMerge：「It vanished.」+
      // 「in the vacuum chamber.」这种句末孤立介词短语再也并不回去（实测由
      // 一屏变两屏）。那个短语不是新句子，属于同一屏的语法续接。
      // 一屏不放两个完整句子这条规则由 canMerge 单点负责（见上），不在这里重复实现。
      if (endedNow && curWords >= SENTENCE_FLUSH_MIN_WORDS) {
        flush();
      } else if (!cur.fragmentChain && !hasEnglishContinuationTail(cur.words) &&
        (curWords >= tokenCapFor(cur.words, maxWords) || cur.end - cur.start >= maxDur)) {
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
    sourceLang: "auto", // auto = 使用 manifest 候选顺序；显式值按 languageCode 选择
    targetLang: "zh-Hans",
    systemPrompt: "", // 空 = 使用语言/供应商无关的连续 block 翻译角色
    sentencePrompt: "", // 已废弃；保留键仅为兼容旧导出配置，不再使用
    waitForFirstTranslation: true,
    // 「等首块译文」的兜底检查间隔（不是等待上限）。每次到点检查首块是否仍在翻译中：
    // 在跑就继续等，已停就放行。首块实测 12.7~23.6s，任何固定上限都会提前放行。
    waitForFirstTranslationCheckMs: 2000,
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
    clipSeconds: 30,
    // 首块适度缩短首包，但仍要有足够上下文，不能退回逐碎片翻译。
    firstClipSeconds: 12,
    // block 只在源 cue 边界切分；字符与 cue 上限用于保护模型容量，不定义译文行数。
    maxSourceCharsPerClip: 600,
    maxCuesPerClip: 12,
    batchLines: 14, // 已废弃（v0.4.0 一个 clip = 一次请求，不再 clip 内分批）；保留键兼容旧配置。
    contextLines: 3, // 已废弃（v0.4.0 整 clip 一次翻，模型自带上下文）；保留键兼容旧配置。
    globalConcurrency: 4, // 跨 clip 的全局 in-flight 翻译请求上限（信号量）。滑动窗口预取
    //                       (depth=3)若不封顶会冲垮网关→429；此值统一封顶。
    reasoningEffort: "low", // 推理模型(gpt-5.x-mini)的 reasoning_effort。行级 prompt 把规则写死 +
    //                  「直接给结果不要思考过程」压住 reasoning 爆点；"low" 时实测延迟 4.5-6.7s 稳定、
    //                  reasoning 14-103 token。取值 low|medium|high；空串或 "default" = 不发该字段。
    minLineChars: 10,
    // 双语对照固定一行；该值属于翻译 identity，不触发本地中文切分。
    maxLineChars: 0,
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
  function normalizeTargetLang(value) {
    var raw = String(value == null ? "" : value).trim().toLowerCase().replace(/_/g, "-");
    if (raw === "zh" || raw === "zh-cn" || raw === "zh-hans" || raw === "cmn" || raw === "简体中文") return "zh-Hans";
    return null;
  }

  function migrateConfig(config) {
    var c = Object.assign({}, config || {});
    delete c.skipChineseSource;
    // 旧「等首块译文」是固定超时上限（8s），语义已改成兜底检查间隔并换键名。
    // 直接丢弃旧值：把 8000 当检查间隔用会白等一轮，而它作为上限本就是错的。
    delete c.waitForFirstTranslationMs;
    c.targetLang = normalizeTargetLang(c.targetLang) || DEFAULT_CONFIG.targetLang;
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
   * 4. 翻译：上下文感知且源 cue 与译文 1:1 对齐（v0.5.1）
   * -------------------------------------------------------------
   * 旧架构（v0.2.1→v0.3.x）让模型先把碎片重组成「完整句」，再由代码把整句
   * 拆回逐行时间轴 —— 这一「拆回」动作硬切中文译文，把「经常」切成「经/常」、
   * 「隔三差/五」斩断（用户最痛的切词 bug 的根因），还堆了 16 个职责重叠的
   * 切割/对齐函数（splitTranslation/splitTransIntoN/alignOriginalToScreens…）。
   *
   * semantic 主路径先把英文恢复成可独立翻译的完整语义单元，再按编号翻成自然中文字幕，输出与单元 1:1：
   *  - fallback 技术 cue 只显示原文，不进入翻译，避免生成六字左右的碎中文。
   *  - 时间轴与英文原文直接沿用对应语义单元，不再做跨行猜测或二次切词。
   *  - 双语对照固定两行：英文一行、中文一行；任一语言内部都不折行。
   *  - reasoning 爆点用 reasoning_effort:low + 把规则写死进 prompt + 「直接给结果
   *    不要思考过程」压住（实测延迟 4.5-6.7s 稳定、reasoning 14-103 token）。
   * 后处理兜底：按编号落槽、保留必要中文标点并清洗格式噪声；缺槽拒绝缓存并交给调用方退避重试。
   */

  // 通用翻译角色；具体 block JSON schema、覆盖和分屏规则由调用路径追加。
  // {TARGET_LANG} 仅供自定义 prompt 替换。
  var DEFAULT_SYSTEM_PROMPT =
    "你是专业中文字幕翻译。源字幕可以是任意语言。先通读给出的连续语流，按整句理解，再用自然、准确、简洁的简体中文表达说话者的完整意思。\n" +
    "理解和可读性优先于逐词、逐行对齐；不得遗漏、重复、臆造，不为了凑成整句而补出源文没有的内容。\n" +
    "中文字幕不输出中文句号“。”；疑问句和感叹句保留问号或感叹号，必要的逗号可以保留。专名、数字、单位和固定表达必须保持完整。\n" +
    "严格遵守随后给出的 JSON 协议，只返回 JSON，不要返回 Markdown、解释或思考过程。";

  // 先确定源语言，再在同一 languageCode 内选择质量更高的轨。人工轨只有 cue 级
  // 时间也能由 canonical timeline 映射，不能再为了 ASR 的词级 offset 牺牲原文质量。
  // 该排序只看 YouTube 的 kind/code 数据契约，不包含任何语言名单。
  function preferManualTrack(tracks, candidate) {
    if (!candidate || !Array.isArray(tracks)) return candidate || null;
    var language = String(candidate.languageCode || candidate.code || "").replace(/-asr$/i, "").toLowerCase();
    if (!language) return candidate;
    var manual = tracks.find(function (track) {
      if (!track) return false;
      var trackLanguage = String(track.languageCode || track.code || "").replace(/-asr$/i, "").toLowerCase();
      var isAsr = track.kind === "asr" || /-asr$/i.test(String(track.code || ""));
      return trackLanguage === language && !isAsr;
    });
    return manual || candidate;
  }

  /**
   * 选源字幕轨。先尊重用户显式 sourceLang；auto 跟音轨的实际语言。
   * 确定语言后在该语言内统一优先人工轨（preferManualTrack），不维护任何语言名单。
   */
  /**
   * 译文语言固定为 zh-Hans，所以源轨已经是中文时这个扩展没有存在意义：
   * 不选轨、不请求翻译、不渲染、也不隐藏 YouTube 原生字幕，完全隐身。
   *
   * 返回 null 即可 —— 调用侧（isolated.js onManifest）本来就有「无可用轨」
   * 分支走 resetForNewVideo()，其中 restoreNativeCaptions() 会摘掉
   * dualsub-hide-native-captions，原生字幕照常显示。不新增第二条路径。
   *
   * yue（粤语）是例外，要翻译：书面粤语（唔、係、嘅、咁樣）和标准中文差异大，
   * 那是真翻译不是繁简转码。它的语言码不带 zh 前缀，天然落在下面的判据之外。
   *
   * zh-Hant → zh-Hans 属于字形转换而不是翻译，不该花 API 的钱，一并跳过。
   */
  function isChineseTrackCode(code) {
    var s = String(code == null ? "" : code).trim().toLowerCase();
    if (!s) return false;
    s = s.replace(/[-_]asr$/, "");        // 中文 ASR 轨同样跳过
    // zh 前缀覆盖 zh / zh-Hans / zh-Hant / zh-CN / zh-TW / zh-HK / zh-Hans-CN…
    // cmn 是官话的 ISO 639-3 码（cmn / cmn-Hans / cmn-Hant），同样是中文，
    // 只按 zh 判会漏。分隔符同时接受 - 和 _，因为真实轨里两种都出现过。
    // 仍用前缀而非整串匹配，才能覆盖任意 BCP47 子标签组合；yue/zhuang/zha
    // 不以 zh 或 cmn 加分隔符开头，不会被误伤。
    return /^(?:zh|cmn)(?:[-_]|$)/.test(s);
  }

  /**
   * 按**字幕实际内容**判断这条轨是不是中文。
   *
   * 为什么光看语言码不够：isChineseTrackCode 只认元数据，而真实轨里中文字幕
   * 常常不带中文码 —— 上传者人工上传时语言选错（标成 en）、YouTube 未能识别
   * （languageCode="und"）、搬运号轨名写「简体中文」但码是 en。实测这几种形状
   * 全都绕过了码判据，整轨被送去「翻译」，等于花钱把中文翻成中文。
   *
   * 判据用字形而不是语言码，因为字形是内容自带的、不依赖任何人填对元数据。
   * 两个必须避开的误伤：
   *  - 日语：日文混用汉字，光看汉字会把日语轨当中文跳过。假名（平假名/片假名）
   *    是日语的排他信号 —— 中文正文不会出现假名，所以见到成比例的假名即判日语。
   *  - 粤语：项目刻意要翻译书面粤语（见 isChineseTrackCode 注释）。粤语专用字
   *    在标准中文里几乎不出现，命中即放行去翻译。
   *
   * 阈值取「汉字占中日韩字符的多数」而非绝对数量：中文轨里夹英文专名很常见
   * （「用 ChatGPT 写代码」），按绝对数量会被几个拉丁词带偏。
   */
  var CANTONESE_MARKERS = /[唔係嘅咁哋嚟攞睇冇喺乜嗰啲噉]/;
  function looksChineseSubtitleText(text) {
    var s = String(text == null ? "" : text);
    if (!s.trim()) return false;
    // 假名 = 日语排他信号。中文正文不含假名，出现即判日语，不跳过。
    var kana = (s.match(/[\p{scx=Hiragana}\p{scx=Katakana}]/gu) || []).length;
    var han = (s.match(/\p{scx=Han}/gu) || []).length;
    var hangul = (s.match(/\p{scx=Hangul}/gu) || []).length;
    if (!han) return false;
    // 假名达到汉字的 5% 就当日语：日文里汉字可以很密（新闻体），但只要是日语
    // 就一定有助词假名（の、を、は…）。中文轨的假名只可能来自零星外来词引用。
    if (kana * 20 >= han) return false;
    if (hangul >= han) return false;
    // 粤语专用字命中 → 是真翻译目标，放行。
    if (CANTONESE_MARKERS.test(s)) return false;
    // 汉字须占 CJK 字符的多数（此处 kana/hangul 已被上面压到少数，等价于汉字为主）。
    return han > kana + hangul;
  }

  /**
   * 抽样整轨 cue 文本判语言。
   *
   * 抽样而非全量：低配 Chromebook 是目标环境之一，整轨可能上万条 cue，
   * 逐条跑 Unicode 正则是白烧 CPU。判语言只需要有代表性的样本。
   * 取头中尾三段而非只取开头：开头常是台标/赞助商念白（"本视频由…赞助"），
   * 只看开头会被一段外语开场带偏。
   *
   * 文本字段读 content 而非 text：cleanupCues 产出的 cue 用的是 content
   * （见 cleanupCues），只读 text 会全拿到空串 → 恒判「非中文」→ 守卫静默失效。
   * 首次实现就踩了这个坑：单测用 {text:…} 造 fixture 所以全绿，真机浏览器
   * 回放立刻红（仍发起 1 次翻译）。两个名字都接受，避免再被字段名咬。
   */
  function cueDisplayText(cue) {
    if (!cue) return "";
    var v = cue.content;
    if (v == null || v === "") v = cue.text;
    return v == null ? "" : String(v);
  }

  function looksChineseCueList(cues, sampleLimit) {
    var list = Array.isArray(cues) ? cues : [];
    if (!list.length) return false;
    var limit = sampleLimit || 60;
    var texts = [];
    if (list.length <= limit) {
      texts = list.map(cueDisplayText);
    } else {
      // 头中尾各取三分之一，覆盖开场、正片、结尾。
      var per = Math.floor(limit / 3);
      var mid = Math.floor(list.length / 2) - Math.floor(per / 2);
      [0, mid, list.length - per].forEach(function (start) {
        list.slice(Math.max(0, start), Math.max(0, start) + per).forEach(function (c) {
          texts.push(cueDisplayText(c));
        });
      });
    }
    return looksChineseSubtitleText(texts.join("\n"));
  }

  function pickTrack(tracks, sourceLang) {
    if (!tracks || !tracks.length) return null;
    var list = tracks;
    var picked;
    if (!sourceLang || sourceLang === "auto") {
      // auto = 跟音轨的实际语言，而不是「轨道数组第一条」。
      //
      // 轨顺序不保证原语言在首位：3teflb1QNN4（Vsauce，英语音轨 + 西语人工翻译轨）
      // 取首条就给英文视频配上西语源字幕，整片按西语翻译。
      //
      // 音轨语言的唯一可靠信号是 ASR 轨：YouTube 只对音轨实际说的语言做语音识别，
      // 所以 kind="asr" 那条轨的 languageCode 就是音轨语言。轨的其他元数据都不行 ——
      // 实测该视频三条轨的 vss_id 分别是 ".en" / "a.en" / ".es-419"，"." 前缀只代表
      // 人工上传（西语翻译轨也有这个前缀），isTranslatable 三条全是 true。
      //
      // 没有 ASR 轨时无从判断音轨语言，保留 YouTube 给的顺序（不猜）。
      var asr = list.find(function (t) {
        return t && (t.kind === "asr" || /-asr$/i.test(String(t.code || ""))) && t.languageCode;
      });
      var audioLang = asr ? String(asr.languageCode).replace(/-asr$/i, "").split("-")[0].toLowerCase() : "";
      picked = (audioLang && list.find(function (t) {
        return String((t && t.languageCode) || "").replace(/-asr$/i, "").split("-")[0].toLowerCase() === audioLang;
      })) || list[0];
    } else {
      var exact = list.find(function (t) {
        return t.code === sourceLang || t.languageCode === sourceLang;
      });
      var prefix = list.find(function (t) {
        return String(t.languageCode || "").split("-")[0] === String(sourceLang).split("-")[0];
      });
      picked = exact || prefix || null;
    }
    picked = preferManualTrack(list, picked);
    // 中文源轨：返回 null，让调用侧走「无可用轨」分支，本扩展完全不介入。
    // 判据放在出口单点，auto 与显式 sourceLang 两条路都覆盖。
    if (picked && (isChineseTrackCode(picked.languageCode) || isChineseTrackCode(picked.code))) {
      return null;
    }
    return picked;
  }

  function buildSystemPrompt(targetLang, customPrompt) {
    var tpl = customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "简体中文");
  }

  function sanitizeSubtitleLine(line) {
    var s = String(line == null ? "" : line);
    if (!s) return "";
    // 白名单只能用来剔除"不该出现在字幕里的字符"，不能用来剔除文字本身。
    //
    // 曾经的白名单是 [^一-鿿㐀-䶿0-9\s，。！？…]，即"只留汉字/数字/标点"，于是译文里
    // 一切拉丁字母都被删掉 —— 而中文字幕里本来就该保留人名、品牌、术语的原文：
    //   "嗨 Vsauce 我是 Michael"  ->  "嗨，，我是"        （实测 3/3 复现）
    //   "米玛斯(Mimas)是最可爱的" ->  "是最可爱的之一"
    // 这不是模型没译好，是产品把已译好的内容删了。用户看到的"翻译不完整"里
    // 有一部分就是这么来的，而且与源语言无关（英、波、日文轨都中招）。
    //
    // 改为只删真正不该显示的东西：控制字符、以及不属于任何书写系统的私有区/
    // 装饰符号。字母、数字、标记、常见标点全部保留。
    s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu, "");
    // 中文句号在这里**不删**。
    //
    // 产品显示契约仍然是「中文字幕不显示句号」，但句号同时是最强的断屏信号：
    // 句末 > 句内逗号 > 词组间。若在清洗阶段就删掉，分屏器拿到的文本里句号已不存在，
    // 只能退而断在逗号上 —— 实测 "…更慢，它们仍值得使用。它们在许多日常任务中…"
    // 被断成「尽管这里的电热水壶更慢」+「它们仍值得使用它们在许多日常任务中依然很实用」，
    // 两个独立句子被焊进同一屏。
    //
    // 因此句号保留到显示的最后一步再由 stripDisplayPeriods 统一移除：
    // 先用它断句，再让它消失。
    s = collapseWhitespace(s).trim();
    // 仅压 CJK 之间的多余空格（模型有时会在汉字间加空格）；
    // 拉丁词与数字两侧的空格必须保留，否则 "功率是 8.8 千瓦"、"我是 Michael" 会粘连。
    // 用前视而非捕获右侧汉字：捕获会把右侧汉字消耗掉，相邻的多处空格只压掉第一处
    //（"这 是 一句话" → "这是 一句话"，实测）。
    s = s.replace(/([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])\s+(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])/gu, "$1");
    // 模型偶尔会在 URL 内部插空格（实测俄语轨输出 "https:// example. com/ kettle"）。
    // 空格一进去这段就不再是一个 URL 原子：保护逻辑与宽度判定全部失效，
    // 用户也复制不出可用链接。程序确定性收回，不依赖 prompt——
    // 模型无法感知自己破坏了原子性，这类不变量必须由代码保证。
    //
    // 匹配 scheme 之后由「URL 合法字符 + 其间空白」组成的最长串，删掉其中空白。
    // 收尾用 (?<=[\w/#=&%~+-]) 保证不吞掉 URL 后面那个属于句子的空格，
    // 也不把结尾的中文标点或纯标点算进链接。
    s = s.replace(
      /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%\s]*(?<=[A-Za-z0-9\-_~/#=&%+])/giu,
      function (m) { return m.replace(/\s+/gu, ""); }
    );
    return s;
  }

  /**
   * 判断一条中文显示单元是否合规。
   *
   * opts.sourceText = 该单元原文;opts.continues = 该句是否在下一单元继续。
   *
   * 为什么必须知道「是否继续」:分屏器会**故意**在句中切开(一屏最多 ~12 词),
   * 这种单元的忠实译文本来就该断在句中,尾部形态检查对它无意义。判据不是
   * 「原文结尾是什么标点」(原文可能以单词结尾却仍未说完,如 "...want to do with"),
   * 而是「这一屏是不是整句的结尾」—— 只有整句到此为止、译文却还断在逗号/连词上,
   * 才说明真的没译完。
   *
   * 此前不看上下文一律拒绝逗号结尾,把 "If you're a human person," →
   * "如果你是人类，" 这种完全正确的译文判违规;在 gpt-5.4-mini 上首 clip
   * 3 行有 2 行被误杀(实测 3/3 复现),整段回退英文。
   */
  function validateChineseDisplayUnit(text, opts) {
    var raw = String(text == null ? "" : text);
    var s = raw.trim();
    if (!s) return { ok: false, reason: "empty" };
    if (/\r|\n/.test(raw)) return { ok: false, reason: "internal-newline" };

    if (opts === undefined) opts = {};
    else if (typeof opts === "string") opts = { sourceText: opts };

    var src = String(opts.sourceText == null ? "" : opts.sourceText).trim();
    var maxVisualWidth = Math.max(1, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    if (semanticDisplayWidth(s) > maxVisualWidth) return { ok: false, reason: "visual-width" };
    // 句子是否在本屏之后继续:显式传入优先;否则由原文自身形态推断
    // (未以终止标点收尾 = 还没说完,含以单词结尾的情况)。
    var continues;
    if (opts.continues != null) {
      continues = !!opts.continues;
    } else if (src) {
      continues = !/[.!?。！？…]["'”’)\]]?$/.test(src);
    } else {
      continues = false; // 无上下文:保持原有严格行为
    }

    // 「模型压根没翻译、原样回吐源文」必须在这里显式判定。
    //
    // 此前没有这条判据：它是靠 sanitizeSubtitleLine 删光所有拉丁字母、
    // 让译文变成空串再落进 empty 分支实现的 —— 用副作用当判定。代价是
    // 人名/品牌/术语的原文（Vsauce、Michael、Mimas、SodaStream）也一起被删，
    // 已译好的内容被产品自己抹掉。
    //
    // 正确判据是「整条里中日文字够不够」，而不是「有没有出现拉丁字母」：
    // 合法中文字幕里夹几个专有名词很正常，但一整句都是源语言就是没译。
    // 判据与源语言无关（英、波、俄、日…都适用）。
    //
    // 计量单位必须是「词」而不是「字符」：一个拉丁单词是一个语义单位，
    // 按字符数算会让 "嗨 Vsauce 我是 Michael" 的汉字占比只有 3/16=0.19，
    // 把完全正确的译文误杀（实测）。按词计则是 3 个汉字词 : 2 个外文词。
    var cjkChars = (s.match(/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/gu) || []).length;
    if (!cjkChars) return { ok: false, reason: "no-chinese" };
    // 外文词：连续的非 CJK 字母序列（数字不算——"8.8 千瓦"里的数字属于译文）
    var foreignWords = (s.match(
      /(?:(?![\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])[\p{L}\p{M}])+(?:['’-](?:(?![\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])[\p{L}\p{M}])+)*/gu
    ) || []).length;
    // 汉字/假名一字即一个语义单位，与外文词等量齐观。
    // 外文词多于中文单位时，说明这条基本没译（阈值放宽到 1.0 倍，
    // 宁可漏判也不误杀 —— 漏判只是显示一条质量差的译文，误杀是整句回退英文）。
    if (foreignWords > cjkChars) {
      return { ok: false, reason: "mostly-untranslated" };
    }

    if (!continues) {
      if (/[，、：；,……]$/.test(s)) return { ok: false, reason: "non-terminal-punctuation" };
      // 单字连接词「到/和/与/从」不进表：它们常是词尾（想到、做到、暖和、参与、服从），
      // 全片真轨 clip 6「真没想到」被判悬空，整个 clip 回退英文。
      if (/(?:虽然|尽管|如果|因为|但是|但|可能|以及|而且|所以|就是|或|并且)$/.test(s)) {
        return { ok: false, reason: "dangling-tail" };
      }
    }
    return { ok: true, reason: "ok" };
  }

  var DEFAULT_RESTORATION_PROMPT =
    "你是多语言字幕语义边界规划器。源文可能是任意语言；sourceText 是完整连续原文，groups 是按 Unicode 词法边界映射回 canonical token 的原子组。\n" +
    "只决定应在哪些 token 之后结束一个字幕单元；不得回显、改写、添加、删除、合并、拆分或重排任何 token。\n" +
    "只判断完整句、完整分句或自然话语的含义在哪里结束。不得在条件与结果、否定范围、因果、转折、指代、短语、修饰关系、数字+单位、专名、URL、复合词或不可分割表达中间结束语义。\n" +
    "字幕一屏只能放下有限内容：请在保证每段语义自足的前提下尽量多切。一个单元通常不应超过约 14 个英文词；超过时，请在它内部找到同样能独立成句的分句边界（并列分句、从句边界、话题转折处）再切一刀，而不是留成一个长段。确实切不动才允许保留长段。\n" +
    "只返回严格 JSON：{\"semanticCutsAfter\":[\"token-id\",...]}; 每个 id 必须是 group.toId 且严格递增。不要返回其它字段、正文、Markdown 或解释。";

  // 语义字幕长度不能再用“英文词数”一把尺子量所有语言。这里按实际字符视觉负载
  // 计算 token 预算，不读取 languageCode，也没有逐语言分支：全宽东亚字符约占两个
  // 半宽字符，其余字符按一个计；预算只由当前 token 流本身决定。
  var DISPLAY_WIDE_CHAR_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Bopomofo}\uFF01-\uFF60\uFFE0-\uFFE6]/u;
  function semanticDisplayWidth(text) {
    var width = 0;
    Array.from(String(text || "")).forEach(function (ch) {
      if (/\p{M}/u.test(ch)) return;
      width += DISPLAY_WIDE_CHAR_RE.test(ch) ? 2 : 1;
    });
    return width;
  }
  // 给语义模型看的“词法提示层”。canonical token 仍是唯一时间/覆盖权威；这里仅用
  // 标准 Intl.Segmenter 在重建全文上形成不可切开的候选组，并把每组映射回 canonical
  // token ID。没有 languageCode、脚本名单或逐语言规则；不支持 Segmenter 的运行时则
  // 安全退回一 token 一组。模型只能返回组末 token ID，正文和时间都不能被它改写。
  function semanticPlanningTokenId(token) {
    var value = token && token.tokenId != null ? token.tokenId : (token && token.id != null ? token.id : null);
    if (value == null || String(value) === "") throw new Error("semantic planning token id missing");
    return String(value);
  }

  function semanticPlanningGroups(tokens) {
    var list = (tokens || []).filter(function (t) { return t && String(t.text || "").trim(); });
    list.forEach(semanticPlanningTokenId);
    if (!list.length) return { sourceText: "", groups: [] };
    var texts = list.map(function (t) { return String(t.text); });
    var sourceText = joinRestoredWords(texts);
    var spans = [];
    var cursor = 0;
    for (var i = 0; i < texts.length; i++) {
      var at = sourceText.indexOf(texts[i], cursor);
      if (at < 0) at = cursor;
      spans.push({ start: at, end: at + texts[i].length });
      cursor = at + texts[i].length;
    }
    var segments = [];
    try {
      if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        segments = Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(sourceText))
          .filter(function (seg) { return seg && seg.isWordLike; });
      }
    } catch (ignored) { segments = []; }
    if (!segments.length) {
      segments = spans.map(function (span) { return { index: span.start, segment: sourceText.slice(span.start, span.end) }; });
    }
    var groups = [];
    segments.forEach(function (seg) {
      var start = Number(seg.index) || 0;
      var end = start + String(seg.segment || "").length;
      var first = -1;
      var last = -1;
      for (var si = 0; si < spans.length; si++) {
        if (spans[si].end <= start || spans[si].start >= end) continue;
        if (first < 0) first = si;
        last = si;
      }
      if (first < 0) return;
      var previous = groups[groups.length - 1];
      if (previous && first < previous.tokenEnd) {
        previous.tokenEnd = Math.max(previous.tokenEnd, last + 1);
        previous.toId = semanticPlanningTokenId(list[previous.tokenEnd - 1]);
        previous.text = joinRestoredWords(texts.slice(previous.tokenStart, previous.tokenEnd));
        return;
      }
      groups.push({
        fromId: semanticPlanningTokenId(list[first]),
        toId: semanticPlanningTokenId(list[last]),
        text: joinRestoredWords(texts.slice(first, last + 1)),
        visualWidth: semanticDisplayWidth(joinRestoredWords(texts.slice(first, last + 1))),
        tokenStart: first,
        tokenEnd: last + 1,
      });
    });
    // Segmenter 只返回 word-like 段；确保任何未覆盖 canonical token 都仍有合法 cut owner。
    for (var ti = 0; ti < list.length; ti++) {
      var covered = groups.some(function (g) { return ti >= g.tokenStart && ti < g.tokenEnd; });
      if (!covered) groups.push({ fromId: String(list[ti].tokenId), toId: String(list[ti].tokenId), text: texts[ti], tokenStart: ti, tokenEnd: ti + 1 });
    }
    groups.sort(function (a, b) { return a.tokenStart - b.tokenStart; });
    // 数字+后续量词/单位/名词是跨语言都不可悬空的数量短语。这里只看 token 文本形态，
    // 不维护 volt/mm/公里等语言名单；字面数字后紧邻的下一个 word-like group 原子合并。
    var quantityGroups = [];
    groups.forEach(function (group) {
      var previous = quantityGroups[quantityGroups.length - 1];
      if (previous && previous.tokenEnd === group.tokenStart && /^[+-]?\d+(?:[.,]\d+)*$/u.test(previous.text)) {
        previous.tokenEnd = group.tokenEnd;
        previous.toId = group.toId;
        previous.text = joinRestoredWords(texts.slice(previous.tokenStart, previous.tokenEnd));
        previous.visualWidth = semanticDisplayWidth(previous.text);
      } else quantityGroups.push(group);
    });
    groups = quantityGroups;
    return { sourceText: sourceText, groups: groups };
  }

  var DEFAULT_DISPLAY_PROMPT =
    "你是多语言字幕自然显示边界规划器。semanticCutsAfter 已由语义阶段确定且不可修改；你只建议完整语义跨度内部适合换屏的位置。不得改写或回显正文，不得切开短语、修饰关系、数字+单位、专名、URL、复合词或不可分割表达。\n" +
    "只返回严格 JSON：{\"displayCutsAfter\":[\"token-id\",...]}; 每个 id 必须是 group.toId 且严格递增。不要返回其它字段、Markdown 或解释。";

  function parseTokenCutsResponse(raw, allowedTokenIds, field) {
    var text = String(raw || "").trim();
    var fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();
    var value;
    try { value = JSON.parse(text); } catch (_) { throw new Error("invalid " + field + " JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(field + " response must be an object");
    var keys = Object.keys(value).sort();
    if (keys.join("|") !== field) throw new Error(field + " fields invalid");
    if (!Array.isArray(value[field])) throw new Error(field + " must be an array");
    var allowed = (allowedTokenIds || []).map(String);
    var positions = {};
    allowed.forEach(function (id, index) { positions[id] = index; });
    var previous = -1;
    return value[field].map(function (rawId) {
      if (typeof rawId !== "string" && typeof rawId !== "number") throw new Error(field + " token ID invalid");
      var id = String(rawId);
      if (!Object.prototype.hasOwnProperty.call(positions, id)) throw new Error("unknown " + field + " token ID: " + id);
      var position = positions[id];
      if (position <= previous) throw new Error(field + " must be strictly increasing");
      previous = position;
      return id;
    });
  }

  function parseBoundaryPlanResponse(raw, allowedTokenIds) {
    return { semanticCutsAfter: parseTokenCutsResponse(raw, allowedTokenIds, "semanticCutsAfter") };
  }

  function parseDisplayCutsResponse(raw, allowedTokenIds) {
    return parseTokenCutsResponse(raw, allowedTokenIds, "displayCutsAfter");
  }

  /**
   * 模型只恢复边界，正文/时间完全来自 source tokens。任一 chunk 文本不等价即抛错，
   * 让运行层按现有退避整包重试，绝不接受半段或模型改写。
   */
  async function restoreTokenBoundaries(opts) {
    opts = opts || {};
    var tokens = (opts.tokens || []).filter(function (t) { return t && t.text; }).map(function (token, index) {
      var copy = Object.assign({}, token);
      copy.tokenId = String(token.tokenId != null ? token.tokenId : (token.id != null ? token.id : "t" + index));
      copy.start = toInt(token.start != null ? token.start : token.startMs, 0);
      copy.end = Math.max(copy.start, toInt(token.end != null ? token.end : token.endMs, copy.start));
      return copy;
    });
    if (!tokens.length) return { tokens: [], marks: [] };
    var seenIds = {};
    tokens.forEach(function (token) {
      if (seenIds[token.tokenId]) throw new Error("duplicate boundary token ID: " + token.tokenId);
      seenIds[token.tokenId] = true;
    });
    var ranges = chunkTokenRanges(tokens, opts.chunkWords || SEMANTIC_CHUNK_WORDS, opts.overlapWords || SEMANTIC_OVERLAP_WORDS);
    var marks = new Array(tokens.length).fill("");
    var prompt = opts.systemPrompt || DEFAULT_RESTORATION_PROMPT;
    for (var ri = 0; ri < ranges.length; ri++) {
      var range = ranges[ri];
      var chunk = tokens.slice(range.start, range.end);
      var planning = semanticPlanningGroups(chunk);
      var ids = planning.groups.map(function (group) { return group.toId; });
      var request = JSON.stringify({
        sourceText: planning.sourceText,
        groups: planning.groups.map(function (group) { return { fromId: group.fromId, toId: group.toId, text: group.text, visualWidth: group.visualWidth }; }),
        tokens: chunk.map(function (token) { return { id: token.tokenId, text: String(token.text) }; }),
        preferredTokens: Math.max(1, Math.floor(Number(opts.preferredMaxWords) || 10)),
        maxTokens: Math.max(1, Math.floor(Number(opts.maxWords) || 12)),
        preferredVisualWidth: Math.max(12, Math.floor(Number(opts.preferredVisualWidth) || SOURCE_DISPLAY_PREFERRED_WIDTH)),
        maxVisualWidth: Math.max(12, Math.floor(Number(opts.maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH)),
      });
      var plan = null;
      var attempts = opts.attempts != null ? Math.max(1, Number(opts.attempts)) : 2;
      for (var attempt = 0; attempt < attempts; attempt++) {
        try {
          // runRequest（可选）让调用方把这次模型请求纳入其全局并发闸门并指定优先级，
          // 使整轨语义恢复只用富余容量、绝不与首屏翻译抢占端点。默认直接执行（无闸门）。
          var doChat = function () {
            return chatCompletion({
            apiBaseUrl: opts.apiBaseUrl,
            apiKey: opts.apiKey,
            apiModel: opts.apiModel,
            temperature: opts.temperature,
            reasoningEffort: opts.reasoningEffort,
            systemContent: prompt,
            userContent: request,
            timeoutMs: opts.timeoutMs,
            fetchImpl: opts.fetchImpl,
            onUsage: opts.onUsage,
            signal: opts.signal,
            });
          };
          var response = typeof opts.runRequest === "function" ? await opts.runRequest(doChat) : await doChat();
          plan = parseBoundaryPlanResponse(response, ids);
          break;
        } catch (error) {
          if (error && /translate aborted|translate timeout|translate network|translate HTTP/i.test(String(error.message || error))) throw error;
          plan = null;
        }
      }
      if (!plan) throw new Error("invalid boundary plan chunk " + ri);
      var semanticSet = {};
      plan.semanticCutsAfter.forEach(function (id) { semanticSet[id] = true; });
      for (var pos = range.commitStart; pos < range.commitEnd; pos++) {
        var tokenId = tokens[pos].tokenId;
        if (semanticSet[tokenId]) marks[pos] = ".";
      }
    }
    return { tokens: tokens, marks: marks };
  }

  var SEMANTIC_REFINE_MAX_WORDS = 16;

  var DEFAULT_REFINE_PROMPT =
    "你是字幕语义边界规划器。给你的是一个**过长**的字幕单元，一屏放不下，必须切开。\n" +
    "目标：切开后每一段都不超过 targetMaxWords 个词。段落越长，需要的切点越多——切一刀不够就继续切。\n" +
    "切点按优先级选（前面找不到再降级）：\n" +
    "1) 并列分句、从句边界、话题转折处（最优，切开后各自语义自足）\n" +
    "2) 介词短语、状语从句、同位语的起始处\n" +
    "3) 上面都没有时，选最接近目标长度的短语边界——读者读不完的长屏比切在次优位置更糟。\n" +
    "只有整段本来就不超过 targetMaxWords 时，才返回空数组。\n" +
    "不得回显、改写、增删或重排任何 token。\n" +
    "只返回严格 JSON：{\"semanticCutsAfter\":[\"token-id\",...]}; 每个 id 必须是 group.toId 且严格递增，且不得是本段最后一个 token。不要返回其它字段、正文、Markdown 或解释。";

  /**
   * 语义阶段的定向补切：只对超长单元再问一次模型。
   *
   * 为什么不做确定性宽度切分：那样切出来的是 "you can see all of the inner"
   * 这种残句，正是碎片化翻译的根源。语义自足只有模型判断得了，程序只负责
   * 「找出哪些段过长」和「校验返回的切点合法」。
   * 失败、超时、返回空一律保留原样 —— 过长优于切坏。
   */
  async function refineOversizedSemanticUnits(tokens, marks, opts) {
    opts = opts || {};
    var list = tokens || [];
    if (!list.length) return marks;
    var out = (marks || []).slice();
    var maxWords = Math.max(8, Math.floor(Number(opts.refineMaxWords) || SEMANTIC_REFINE_MAX_WORDS));

    // 枚举当前语义段 [start, end]（end 处 mark 为 "."，末段收尾）。
    var segments = [];
    var segStart = 0;
    for (var i = 0; i < list.length; i++) {
      if (out[i] === "." || i === list.length - 1) {
        segments.push({ start: segStart, end: i });
        segStart = i + 1;
      }
    }
    var oversized = segments.filter(function (seg) { return seg.end - seg.start + 1 > maxWords; });
    if (!oversized.length) return out;

    for (var s = 0; s < oversized.length; s++) {
      var seg = oversized[s];
      var chunk = list.slice(seg.start, seg.end + 1);
      var planning = semanticPlanningGroups(chunk);
      var lastTokenId = String(chunk[chunk.length - 1].tokenId);
      // allowed 必须是**完整**的 group 边界列表：parseTokenCutsResponse 用它建立
      // 位置索引并校验递增，事先剔除段末会让索引错位，导致模型返回的合法切点
      // 被判为 unknown 而整包抛错（表现为补切请求发了但一刀不落）。
      // 段末切点在拿到结果之后再丢弃。
      var allowed = planning.groups.map(function (group) { return group.toId; });
      if (allowed.length < 2) continue;
      var payload = {
        sourceText: planning.sourceText,
        groups: planning.groups.map(function (group) {
          return { fromId: group.fromId, toId: group.toId, text: group.text };
        }),
        currentWordCount: chunk.length,
        targetMaxWords: maxWords,
      };
      try {
        var doChat = (function (body) {
          return function () {
            return chatCompletion({
              apiBaseUrl: opts.apiBaseUrl,
              apiKey: opts.apiKey,
              apiModel: opts.apiModel,
              reasoningEffort: opts.reasoningEffort,
              systemContent: opts.refineSystemPrompt || DEFAULT_REFINE_PROMPT,
              userContent: JSON.stringify(body),
              timeoutMs: opts.timeoutMs || TRANSLATE_TIMEOUT_MS,
              fetchImpl: opts.fetchImpl,
              onUsage: opts.onUsage,
              signal: opts.signal,
            });
          };
        })(payload);
        var runner = typeof opts.runRefineRequest === "function" ? opts.runRefineRequest : opts.runRequest;
        var response = typeof runner === "function" ? await runner(doChat) : await doChat();
        var cuts = parseTokenCutsResponse(response, allowed, "semanticCutsAfter");
        var cutSet = {};
        // 段末切点在这里丢弃：切在末尾等于没切，但它不该让整包作废。
        (cuts || []).forEach(function (id) { if (id !== lastTokenId) cutSet[id] = true; });
        for (var pos = seg.start; pos < seg.end; pos++) {
          if (cutSet[String(list[pos].tokenId)]) out[pos] = ".";
        }
      } catch (error) {
        // 网络/超时/解析失败都不升级为整轨失败：保留原语义段。
        // 但必须可观测——静默吞掉解析失败会让「请求发了却一刀不落」这类
        // bug 藏在正常日志里（实测藏了整整一轮真实跑）。
        if (typeof opts.onRefineFailure === "function") {
          try { opts.onRefineFailure(String((error && error.message) || error)); } catch (_) {}
        }
        if (error && /translate aborted/i.test(String(error.message || error))) throw error;
      }
    }
    return out;
  }

  async function suggestDisplayTokenBoundaries(tokens, semanticMarks, opts) {
    opts = opts || {};
    var list = tokens || [];
    if (!list.length) return [];
    var planning = semanticPlanningGroups(list);
    var ids = list.map(function (token) { return String(token.tokenId); });
    var semanticCuts = [];
    (semanticMarks || []).forEach(function (mark, index) { if (mark === ".") semanticCuts.push(ids[index]); });
    var payload = {
      sourceText: planning.sourceText,
      tokens: list.map(function (token) { return { id: String(token.tokenId), text: token.text }; }),
      groups: planning.groups.map(function (group) {
        return { fromId: group.fromId, toId: group.toId, text: group.text, visualWidth: semanticDisplayWidth(group.text) };
      }),
      semanticCutsAfter: semanticCuts,
      preferredVisualWidth: Math.max(12, Math.floor(Number(opts.preferredVisualWidth) || SOURCE_DISPLAY_PREFERRED_WIDTH)),
      maxVisualWidth: Math.max(12, Math.floor(Number(opts.maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH)),
    };
    try {
      var doChat = function () {
        return chatCompletion({
          apiBaseUrl: opts.apiBaseUrl,
          apiKey: opts.apiKey,
          apiModel: opts.apiModel,
          reasoningEffort: opts.reasoningEffort,
          systemContent: opts.displaySystemPrompt || DEFAULT_DISPLAY_PROMPT,
          userContent: JSON.stringify(payload),
          timeoutMs: opts.timeoutMs || TRANSLATE_TIMEOUT_MS,
          fetchImpl: opts.fetchImpl,
          onUsage: opts.onUsage,
          signal: opts.signal,
        });
      };
      var displayRunner = typeof opts.runDisplayRequest === "function" ? opts.runDisplayRequest : opts.runRequest;
      var response = typeof displayRunner === "function" ? await displayRunner(doChat) : await doChat();
      return parseDisplayCutsResponse(response, ids);
    } catch (error) {
      if (error && /translate aborted/i.test(String(error.message || error))) throw error;
      return [];
    }
  }

  function enforceVisualDisplayMarks(tokens, marks, maxVisualWidth) {
    var list = tokens || [];
    var out = (marks || []).slice();
    if (out.length !== list.length) throw new Error("visual display marks length mismatch");
    var cap = Math.max(12, Math.floor(Number(maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH));
    var suggested = {};
    for (var si = 0; si < out.length; si++) {
      if (out[si] === "|") { suggested[si] = true; out[si] = ""; }
    }
    var originalEnds = [];
    for (var i = 0; i < out.length; i++) if (out[i] === ".") originalEnds.push(i);
    if (originalEnds[originalEnds.length - 1] !== list.length - 1) originalEnds.push(list.length - 1);
    var segmentStart = 0;
    originalEnds.forEach(function (segmentEnd) {
      var segment = list.slice(segmentStart, segmentEnd + 1);
      if (semanticDisplayWidth(joinRestoredWords(segment.map(function (t) { return t.text; }))) <= cap) {
        segmentStart = segmentEnd + 1;
        return;
      }
      var groups = semanticPlanningGroups(segment).groups;
      var widthOf = function (start, end) {
        return semanticDisplayWidth(joinRestoredWords(groups.slice(start, end).map(function (group) { return group.text; })));
      };
      for (var atom = 0; atom < groups.length; atom++) {
        if (widthOf(atom, atom + 1) > cap) throw new Error("lexical group exceeds visual width cap");
      }
      var totalWidth = widthOf(0, groups.length);
      var minPieces = Math.max(2, Math.ceil(totalWidth / cap));
      var bestCuts = null;
      for (var pieces = minPieces; pieces <= groups.length && !bestCuts; pieces++) {
        var target = totalWidth / pieces;
        var dp = Array.from({ length: pieces + 1 }, function () { return new Array(groups.length + 1).fill(null); });
        dp[0][0] = { score: 0, cuts: [] };
        for (var piece = 1; piece <= pieces; piece++) {
          for (var end = piece; end <= groups.length; end++) {
            for (var start = piece - 1; start < end; start++) {
              if (!dp[piece - 1][start]) continue;
              var width = widthOf(start, end);
              if (width > cap) continue;
              var penalty = Math.pow(width - target, 2);
              if (width < target * 0.45) penalty += Math.pow(target, 2) * 4;
              var proposedCut = end < groups.length ? segmentStart + groups[end - 1].tokenEnd - 1 : -1;
              if (proposedCut >= 0 && suggested[proposedCut]) penalty -= Math.pow(target, 2) * 0.2;
              var score = dp[piece - 1][start].score + penalty;
              if (!dp[piece][end] || score < dp[piece][end].score) {
                dp[piece][end] = { score: score, cuts: dp[piece - 1][start].cuts.concat(end < groups.length ? [end] : []) };
              }
            }
          }
        }
        if (dp[pieces][groups.length]) bestCuts = dp[pieces][groups.length].cuts;
      }
      if (!bestCuts) throw new Error("cannot partition visual display groups");
      bestCuts.forEach(function (groupEnd) {
        var cut = segmentStart + groups[groupEnd - 1].tokenEnd - 1;
        if (out[cut] !== ".") out[cut] = "|";
      });
      segmentStart = segmentEnd + 1;
    });
    return out;
  }

  // 语义单元长度上限的兜底切分。模型给的切点可能让某段远超上限；
  // 这里在**已有的词法组边界**上补切点（组边界仍是可验证的源 token 位置，
  // 不是按比例或宽度猜的），组边界仍不够时才在上限处硬切。
  // 永不抛错：宁可多一个切点，也不能让整个 clip 丢失译文。
  // 兜底切分：把「词数」和「视觉宽度」两个上限一起守住。
  //
  // 2026-08-23：原本这里只按词数(maxTokens=40)兜底，但注释在 SEMANTIC_MAX_TOKENS
  // 处已经写明——真正的显示硬门禁是 SOURCE_DISPLAY_MAX_WIDTH 的视觉宽度，词数只是
  // 模型输入保险丝。结果真实跑里出现 40 词 / 中文 137 宽（约合规屏的 2.8 倍）的单元：
  // 词数恰好不超过 40，兜底一刀不落，而它显示上根本读不完。
  // 现在两个判据谁先触发就在谁那里切，切点仍只落在词法组边界（可验证的源 token
  // 位置），不按比例、不按译文长度猜。
  function enforceSemanticTokenLimitMarks(tokens, marks, maxTokens, maxVisualWidth) {
    var out = (marks || []).slice();
    var groups = semanticPlanningGroups(tokens).groups;
    var boundaries = {};
    groups.forEach(function (group) { boundaries[group.tokenEnd] = true; });
    var widthCap = Number(maxVisualWidth) > 0 ? Number(maxVisualWidth) : 0;
    // 累计当前单元的视觉宽度：源文按 token 文本量（含词间空格）估算。
    function widthOf(from, to) {
      var text = joinRestoredWords(tokens.slice(from, to + 1).map(function (t) { return String(t.text); }));
      return semanticDisplayWidth(text);
    }
    var start = 0;
    for (var i = 0; i < tokens.length; i++) {
      var isCut = out[i] === "." || out[i] === "|";
      var tooManyWords = i - start + 1 > maxTokens;
      var tooWide = widthCap > 0 && !tooManyWords && widthOf(start, i) > widthCap;
      if (tooManyWords || tooWide) {
        // 从当前位置往回找最近的词法组边界作为切点。
        var cut = -1;
        for (var b = i; b > start; b--) {
          if (boundaries[b]) { cut = b - 1; break; }
        }
        if (cut < start) cut = start + maxTokens - 1;
        if (cut >= i) cut = i - 1;
        if (cut < start) cut = start;
        if (out[cut] !== ".") out[cut] = "|";
        start = cut + 1;
        isCut = out[i] === "." || out[i] === "|";
      }
      if (isCut) start = i + 1;
    }
    return out;
  }

  async function restoreAndPackTokens(opts) {
    opts = opts || {};
    var restored = await restoreTokenBoundaries(opts);
    var maxWords = opts.maxWords || 12;
    var preferredMaxWords = opts.preferredMaxWords || 10;
    var preferredVisualWidth = Math.max(12, Math.floor(Number(opts.preferredVisualWidth) || SOURCE_DISPLAY_PREFERRED_WIDTH));
    var maxVisualWidth = Math.max(preferredVisualWidth, Math.floor(Number(opts.maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH));
    // 模型 cut 已经被 parseBoundaryPlanResponse 限定到 Unicode group.toId。不要再用
    // 英语正则“复审”模型边界：那会在任意其它语言上形成第二套、互相漂移的判定器。
    // semantic 与 display 使用两次单字段请求，避免弱模型混淆两个概念。显示建议失败时
    // 保留纯确定性 DP；它永远不能新增、删除或移动 semantic cut。
    if (opts.enableDisplaySuggestions === true) {
      var displayIds = await suggestDisplayTokenBoundaries(restored.tokens, restored.marks, opts);
      var displaySet = {};
      displayIds.forEach(function (id) { displaySet[id] = true; });
      for (var di = 0; di < restored.tokens.length; di++) {
        if (restored.marks[di] !== "." && displaySet[String(restored.tokens[di].tokenId)]) restored.marks[di] = "|";
      }
    }
    // 语义切点定下之后，对仍然过长的单元做一次定向补切（只问模型，不盲切）。
    restored.marks = await refineOversizedSemanticUnits(restored.tokens, restored.marks, opts);
    restored.marks = enforceSemanticTokenLimitMarks(restored.tokens, restored.marks, SEMANTIC_MAX_TOKENS, maxVisualWidth);
    // 显示分屏**不能**放在这里：这一步的产物是「送去翻译的语义单元」，
    // 在翻译前按宽度切开会让模型收到 "you can see all of the inner" 这种残句，
    // 正是碎片化翻译的根源。分屏必须发生在拿到完整语义译文之后。
    if (opts.semanticOnly !== true) restored.marks = enforceVisualDisplayMarks(restored.tokens, restored.marks, maxVisualWidth);
    var units = packRestoredTokens(restored.tokens, restored.marks, { maxWords: maxWords });
    for (var ri = 0; ri < units.length; ri++) {
      var finalWords = unitWordCount(units[ri]);
      var finalWidth = semanticDisplayWidth(units[ri].content);
      if (opts.semanticOnly !== true && (finalWords > SEMANTIC_MAX_TOKENS || finalWidth > maxVisualWidth)) {
        throw new Error("unresolved oversized semantic unit: " + finalWords + " tokens / " + finalWidth + " width");
      }
    }
    return units;
  }

  /**
   * 从模型返回里取出第一个完整 JSON 对象。
   *
   * 廉价模型最高频的协议偏差不是内容错，而是「把正确的 JSON 包在废话里」：
   *   好的，这是翻译结果：{"translations":[…]}  希望有帮助！
   * 此前只剥 ```json 围栏、其余一律按 invalid JSON 整块拒绝（约 32 秒字幕全丢）。
   * 那是在拿协议洁癖换用户的字幕 —— 内容完全可用，只是被寒暄包着。
   *
   * 做法：先试整体 parse（正常模型走这条，零开销）；失败则从第一个 '{' 起做
   * 括号配平扫描，字符串内的括号与转义不计数，取第一个自洽的对象。
   * 不用贪心正则 /\{[\s\S]*\}/ —— 译文里带 '}' 或后面跟第二个对象都会切错。
   */
  function extractJsonObject(raw, requiredKey) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return null;

    // 只在字符串外把 ",}" / ",]" 的多余逗号去掉 —— 小模型高频语法失误。
    // 必须跳过字符串内容，否则译文里出现 ",}" 会被改坏（净化只删语法噪声，不动文字）。
    function repairTrailingCommas(src) {
      var out = "", inStr = false, esc = false;
      for (var i = 0; i < src.length; i++) {
        var ch = src[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === "\\") { out += ch; if (inStr) esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (!inStr && ch === ",") {
          var j = i + 1;
          while (j < src.length && /\s/.test(src[j])) j++;
          if (src[j] === "}" || src[j] === "]") continue; // 丢掉这个逗号
        }
        out += ch;
      }
      return out;
    }
    function tryParse(s) {
      try { return JSON.parse(s); } catch (_) {}
      try { return JSON.parse(repairTrailingCommas(s)); } catch (_) {}
      return null;
    }
    // 候选是否可用：要求带 requiredKey 的，就不能拿一个恰好配平的内层对象顶替。
    // （实测：尾逗号 payload 会让括号扫描先命中内层 {"unitId":…}，若不校验就会
    // 把「JSON 语法错」误报成「顶层字段不对」，把真实病因藏起来。）
    function usable(v) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return v || null;
      if (requiredKey && !(requiredKey in v)) return null;
      return v;
    }

    var fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      var f = usable(tryParse(fenced[1].trim()));
      if (f) return f;
      text = fenced[1].trim();
    }
    var whole = usable(tryParse(text));
    if (whole) return whole;

    var start = text.indexOf("{");
    while (start >= 0) {
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < text.length; i++) {
        var ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { if (inStr) esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            var cand = usable(tryParse(text.slice(start, i + 1)));
            if (cand) return cand;
            break;
          }
        }
      }
      start = text.indexOf("{", start + 1);
    }
    return null;
  }

  // 整句翻译、中文自己切屏（2026-10-01 重构，思路移植自 VideoLingo 的 translate→align）。
  //
  // 旧路径先把英文切成屏再逐屏翻译：英文切点落在 "electric | kettles" 这种短语中间时，
  // 中文要么被逼着补内容凑整句（臆造），要么跟着劈成「电热|水壶」。两轮真轨各中一种。
  // 根因是顺序：切点在翻译之前就定死了。
  //
  // 现在英文片段（piece）只是「可选切口」：模型整句翻译后，自己决定每屏覆盖哪几个
  // 连续 piece，可以把多个 piece 合成一屏。中文切口因此落在中文自然停顿处，每屏的时间
  // 仍由它覆盖的 piece 的词级时间戳决定（startMs 红线不变）。
  var SCREEN_PROTOCOL_PROMPT =
    "\n输入 sentences 按顺序给出若干句原文，每句由一个或多个连续片段 piece 组成；piece 只是可选的切屏位置，不是翻译单位。\n" +
    "做法：每句先整句译成通顺中文，再把这句中文切成字幕屏。每屏覆盖连续的若干 piece（from 到 to，可以只有一个，也可以合并多个），屏的切口只能落在 piece 之间。\n" +
    "中文切口要在自然停顿处（逗号、分句之间），绝不能把一个词、专名或数字+单位劈到两屏；每屏不超过 maxChars 个汉字。屏数越少越好：一句话不超过 maxChars 就整句一屏；相邻两屏合起来不超过 maxChars 就合成一屏，只有放不下才切。\n" +
    "每屏文字对应它覆盖的那段原文，可以在一句之内为中文语序微调，但不得把别的句子的内容提前或挪后。原文句末标点（. ! ? 等）之后必须换屏，绝不跨句合并。\n" +
    "每屏单独读也必须忠实于原意：否定、条件、目的、比较不得被切到两屏，以致前后屏连读时意思变反或变弱；拆不开就压缩措辞放进一屏。屏尾不留逗号、顿号、冒号。\n" +
    "协议硬约束：只返回 {\"screens\":[{\"from\":\"u0\",\"to\":\"u1\",\"text\":\"…\"}]}；所有屏按顺序首尾相接、恰好覆盖全部 piece 一次，from/to 原样复制 piece id，不要输出其他字段。";

  /**
   * 校验 {screens:[{from,to,text}]}：按 piece 顺序首尾相接、恰好覆盖一次。
   * 结构违规（缺口/重叠/未知 id/超 token 上限）一律 fail-closed；
   * lenient 时只把内容不合格的屏置空（该屏回退原文），不连坐整个 clip。
   */
  function parseScreenCoverageResponse(raw, pieces, opts) {
    opts = opts || {};
    var payload = extractJsonObject(raw, "screens");
    if (!payload || !Array.isArray(payload.screens)) throw new Error("screen coverage invalid JSON");
    var indexById = {};
    pieces.forEach(function (piece, index) {
      indexById[piece.alias] = index;
      if (piece.endsSentence == null) piece.endsSentence = SENTENCE_FINAL_RE.test(String(piece.sourceText || ""));
    });
    var cursor = 0;
    var out = [];
    payload.screens.forEach(function (item) {
      if (!item || typeof item !== "object") throw new Error("screen coverage entry invalid");
      var from = indexById[String(item.from)];
      // 弱模型单 piece 屏常省略 to：按 from 处理。
      var to = item.to == null ? from : indexById[String(item.to)];
      if (from == null || to == null) throw new Error("screen coverage unknown piece");
      if (from !== cursor || to < from) throw new Error("screen coverage gap or overlap");
      // 原文句末标点之后必须换屏：跨句合并会把上一句的尾巴和下一句的开头拼进同一屏
      // （ds-40-v18 第 18 屏「它被引用了三次，但到视频结束时」）。只认源文自带的句末标点，
      // 不认语义阶段的分组：分组是分句级的，按它拦会挡掉「electric | kettles」这类必须的合并。
      for (var k = from; k < to; k++) {
        if (pieces[k].endsSentence) throw new Error("screen coverage crosses sentence boundary");
      }
      var tokenCount = pieces[to].tokenEnd - pieces[from].tokenStart;
      if (tokenCount > SEMANTIC_MAX_TOKENS) throw new Error("screen coverage span exceeds token limit");
      var rawText = item.text != null ? item.text : item.translation;
      var text = sanitizeSubtitleLine(String(rawText == null ? "" : rawText));
      // 「本屏之后句子是否还在继续」与上面的换屏硬约束同口径：只看原文句末标点。
      // 旧判据按语义分组（分句级）判断，模型在分句交界处收「但」「因为」这种
      // 承接下一分句的词时被当成悬空尾巴，整个 clip 失败回退英文（v0.11.0 候选
      // 全片真轨 clip 6 / 29：screen coverage invalid Chinese unit: dangling-tail）。
      var continues = !pieces[to].endsSentence;
      var verdict = text.trim()
        ? validateChineseDisplayUnit(text, { sourceText: pieces[to].sourceText, continues: continues, maxVisualWidth: Number.MAX_SAFE_INTEGER })
        : { ok: false, reason: "empty" };
      if (!verdict.ok) {
        if (!opts.lenient) throw new Error("screen coverage invalid Chinese unit: " + verdict.reason);
        text = "";
      }
      // 软约束：首轮违规就带原因重试一次，末轮照收（整 clip 回退英文远比一屏偏宽/偏挤严重）。
      //  - 超宽：模型没守 maxChars，后续合并/渲染都兜不住（全片真轨「你能找到的硬接线电磁炉，
      //    无论是独立式还是与烤箱相连的」26 字）。
      //  - 文字远多于覆盖的语音：语序调整把整句挂到一个极短 piece 上（全片真轨 "output" 0.3s
      //    挂「一台1500瓦电水壶输出的三倍」），借静音和合并都救不回来。
      if (opts.strictSoft && text) {
        var maxWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
        if (semanticDisplayWidth(text) > maxWidth) {
          throw new Error("screen coverage soft: 第 " + (out.length + 1) + " 屏「" + text + "」超过 " + Math.floor(maxWidth / 2) + " 字，请在同一句内多切一屏");
        }
        var haveMs = Number(pieces[to].endMs) - Number(pieces[from].startMs);
        var needMs = Math.ceil(semanticDisplayWidth(text) / 2) * READING_MS_PER_CHAR;
        if (haveMs > 0 && needMs > haveMs * 2.5 && needMs > haveMs + 800) {
          throw new Error("screen coverage soft: 第 " + (out.length + 1) + " 屏「" + text + "」文字远多于它覆盖的原文「" +
            pieces.slice(from, to + 1).map(function (p) { return p.sourceText; }).join(" ") + "」，请把意思放回对应原文所在的屏");
        }
      }
      cursor = to + 1;
      out.push({ from: from, to: to, text: text });
    });
    if (cursor !== pieces.length) throw new Error("screen coverage tail missing");
    return out;
  }

  var SENTENCE_FINAL_RE = /[.!?。！？…‼⁇]["'”’)\]]*$/;

  /** 整句送译，返回按 piece 覆盖的中文屏 [{from,to,text}]（from/to 为 piece 下标）。 */
  async function translateSentenceScreens(opts) {
    opts = opts || {};
    var pieces = (opts.pieces || []).map(function (piece, index) {
      return {
        alias: "u" + index,
        sourceText: collapseWhitespace(piece.content || ""),
        tokenStart: piece.tokenStart,
        tokenEnd: piece.tokenEnd,
        semanticGroupId: String(piece.semanticGroupId != null ? piece.semanticGroupId : "sg" + index),
        endsSentence: SENTENCE_FINAL_RE.test(collapseWhitespace(piece.content || "")),
        startMs: Number(piece.start),
        endMs: Number(piece.end),
      };
    });
    if (!pieces.length) return [];
    var sentences = [];
    pieces.forEach(function (piece, index) {
      if (!index || piece.semanticGroupId !== pieces[index - 1].semanticGroupId) sentences.push([]);
      sentences[sentences.length - 1].push({ id: piece.alias, text: piece.sourceText });
    });
    var maxChars = Math.max(4, Math.floor((Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH) / 2));
    var userContent = JSON.stringify({ maxChars: maxChars, sentences: sentences });
    var baseSys = buildSystemPrompt(opts.targetLang, opts.systemPrompt) + SCREEN_PROTOCOL_PROMPT;
    var lastError = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      var content = await chatCompletion({
        apiBaseUrl: opts.apiBaseUrl,
        apiKey: opts.apiKey,
        apiModel: opts.apiModel,
        temperature: opts.temperature,
        reasoningEffort: opts.reasoningEffort,
        systemContent: attempt ? baseSys + "\n上一次输出未通过覆盖校验（" + String(lastError && lastError.message) + "）：屏必须按顺序首尾相接、恰好覆盖全部 piece 一次，原文句末标点之后必须换屏，每屏不超过 maxChars 字，每屏文字对应它覆盖的原文。" : baseSys,
        userContent: userContent,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
        onUsage: opts.onUsage,
        signal: opts.signal,
      });
      try {
        return parseScreenCoverageResponse(content, pieces, {
          lenient: !!opts.lenient, strictSoft: attempt === 0, maxVisualWidth: opts.maxVisualWidth,
        });
      } catch (error) {
        // fail-soft-ok: 只吞覆盖校验错误换一次重试，两次都失败时在循环后原样抛出 lastError。
        if (!/screen coverage/.test(String(error && error.message))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  var DEFAULT_BLOCK_TRANSLATION_PROMPT =
    "输入是一段连续语音的完整原文。先通读整段，再译成通顺连贯的目标语言。\n" +
    "译文完整性是第一要求：原文每个意思都要译出，不省略、不概括、不压缩。\n" +
    "专有名词（品牌、人名、型号如 AA/AAA）保留原文写法，不要音译。\n" +
    "只返回严格 JSON：{\"segments\":[{\"sourceFrom\":\"c0\",\"sourceTo\":\"c3\",\"screens\":[{\"sourceFrom\":\"c0\",\"sourceTo\":\"c1\",\"text\":\"第一屏\"},{\"sourceFrom\":\"c2\",\"sourceTo\":\"c3\",\"text\":\"第二屏\"}]}]}。\n" +
    "字幕要在语音结束前读完：观众阅读速度约每秒 5 个汉字，而每屏能显示多久由 sourceCues " +
    "的 startMs/endMs 决定。所以译文要精炼上屏 —— 用更短的说法表达同一个意思，" +
    "去掉可省的连接词、冗余修饰和不影响理解的重复，不追求与原文逐词对应。\n" +
    "但精炼不等于删减：原文的每个信息点都必须还在，只是说法更紧凑。" +
    "「毫无疑问，我们需要衣服来抵御自然环境」→「我们需要衣服御寒」是精炼（信息全在，更短）；" +
    "删掉「御寒」这个原因就是删减，不允许。两者冲突时保留信息，宁可该屏偏长。\n" +
    "screens 是把该段完整译文按语义切好的字幕屏：每个 screen 对象必须写 sourceFrom、sourceTo、text；" +
    "screen 的 sourceFrom/sourceTo 表示这屏译文覆盖的源 cue 范围，必须按源 cue 顺序连续、无重叠、无缺口；" +
    "sourceFrom/sourceTo 必须准确对应这屏译文实际翻译的源文片段，错配会导致中英双语错位；" +
    "同一源 cue 范围不得翻译两次，不得返回两个 screen 覆盖同一段原文；如果一句话需要两屏，必须把源 cue 范围也切成前后两段。\n" +
    "目标 12-24 个汉字，但这是排版目标而非删减理由 —— 意思单元超长也要完整写出，宁可该屏偏长，绝不省略；" +
    "每屏覆盖的源文不超过 12 个英文词，超过时在语义边界处拆成多屏；" +
    "分开后某半太短读起来断气就不分，分开后各自更清楚就分；不切开词语、专名、数字+单位；" +
    "一句话说完必须写句号（或问号、感叹号），不得省略 —— 这是屏边界的判据；" +
    "一屏里不要放两个完整句子。\n" +
    "segments 必须按源 cue 顺序连续且恰好覆盖全部输入；相邻源 cue 若有 750ms 或更长停顿，必须成为两个 segment 的边界，screen 也不得跨越该停顿。不得返回 Markdown、解释或其它字段。\n" +
    "输入里 sourceText 是完整原文，据它翻译；sourceCues 只用于标注每个 segment 覆盖的 cue 区间；contextBefore/contextAfter 只供理解上下文，不得进入输出覆盖范围。";
  // 分工：模型负责**语义**（译文完整 + 断点自然），程序负责**宽度**（超宽屏内部再切，
  // 但绝不撤销模型给的断点）。
  //
  // 这个分工是三次真实实测（gpt-5.4-mini）逼出来的，两个目标压给任一单方都失败：
  //   - 只让程序分屏（v5）：程序只能看字数和标点，会把独立句子焊在一起
  //     （「90年代你可能记得这个与其另用电池测试器」），且 Jay 的 11 组样例里存在
  //     宽度不单调的矛盾（38 一屏 / 46 两屏），说明判据本质是语感，程序无法表达。
  //   - 只让模型分屏且给硬宽度上限：模型为守上限而压缩译文，丢内容
  //     （「判断电池还有没有电」整句消失）—— 违反完整性第一。
  //   - 让模型分屏但不提长度：模型给回 118/143 单位的巨块，等于没分屏。
  // 现在给目标长度但明确「宁可超也不许删」，实测完整性 15/15 + 超宽 0。
  //
  // 早先 v4 的 `lines` 也是「模型分屏」，但那时输入是逐 cue 碎片，模型没见过完整语流，
  // 输出 100% 句内无标点 + 切词 + 错译。病根是输入碎，不是「模型分屏」本身。
  //
  // 已知残留限制（不再追，追不动）：源是无标点 ASR 流，`in fact`/`actually` 这类衔接词
  // 前面本来就没有任何句子边界信号，模型有时写句号有时不写。写了的由 splitAtSentenceEnd
  // 拆开；没写的会出现「…就是这么做的事实上，这个版本的想法」两句同屏。gpt-5.4-mini 与
  // gpt-5.5 都会偶发，在 prompt 里显式要求「说完必须写句号」实测无效（三次跨模型验证）。
  // 程序侧无从判断 —— 无标点时句子边界不可见，这与中文分词的困难同源。

  /**
   * block 译文缓存契约版本 —— 单一权威来源。
   *
   * 任何改变译文最终形态的修复都必须升版，否则旧缓存里存的是修复前的 lines，
   * 且 integrity 校验会因内容自洽而通过，导致缓存命中时完全绕过修复。
   * v2: 悬挂定语标记合并（「…的」+「徽章」→「…的徽章」）。
   */
  // v3: 两处改动使旧缓存条目的显示形态不再正确，必须整体失效重算。
  //   1. 每屏原文改为顺序往前取、不回头重播（takeForwardSourceWords）；旧条目里
  //      存的是按时间区间反查拼出的重复原文，内容自洽会通过 integrity 校验。
  //   2. block prompt 改为按显示容量生成，模型的分屏结果随之不同。
  // v4：分屏与时间派生规则整体改变（句号保留到分屏后、长停顿分组、时间由源词范围
  // 派生、汉字原子黏合）。旧缓存存的是按旧规则分好的 lines，其 integrity 自洽会通过
  // 校验，不升版就会绕过本次修复继续命中坏分屏。
  // v5：模型契约由「输出分好屏的 lines」改为「输出整段带标点的 text」，输入也由逐条
  // sourceCues 改为整段 sourceText。旧缓存里存的是模型自行切碎、句内无标点的短行，
  // 其 integrity 自洽会通过校验，不升版就会继续命中那批坏分屏。
  // v6：契约由「模型交整段 text、程序独立分屏」改为「模型交语义分好的 screens、程序只做
  // 宽度兜底」。旧缓存里存的是程序按纯字数规则分出的屏（含焊句：「…记得这个与其另用电池
  // 测试器」），其 integrity 自洽会通过校验，不升版就会继续命中那批坏分屏。
  // v7：prompt 增加「按可显示时长精炼措辞」的要求（输出结构不变，但译文形态变了，
  // 旧缓存里是不受时长约束的长译文，不升版会继续命中那批读不完的屏）。
  // v8：screens 从字符串改为 {sourceFrom,sourceTo,text} 对象。旧缓存/旧模型输出没有
  // 屏级覆盖范围，程序只能按比例猜配，正是整句重译和屏级错位的根因。
  // v9：请求只发 unitId + sourceText（去掉 coverFrom/coverTo/maxVisualWidth/semanticGroupId
  // 逐单元冗余），响应只要求 unitId + translation。输出形态变了必须升版本作废旧缓存。
  // v10：恢复整段投喂。v9 把 sourceText 换成逐 cue units[] 导致模型只看到碎片，
  // 译文碎片化（丢 "and"、猜错 "I" 上下文）。v10 恢复 sourceText 为整段拼接，
  // 同时保留 v9 的 sourceCues 精简（只发 id+时间不发全文）。旧缓存里存的是逐 cue
  // 译文，其 integrity 自洽会通过校验，不升版会继续命中那批碎片化译文。
  // v11：ASCII 句号纳入屏尾去标点集 + splitAtSentenceEnd + SENTENCE_FINAL_PUNCT；
  // prompt 增加每屏英文词数上限（≤12 词），防止 32 词塞一屏。
  // v12：屏跨长停顿不再拒绝整块，改为在停顿处拆屏分配译文；
  // 源词 >14 时程序侧兜底拆屏；prompt 强调 sourceFrom/sourceTo 准确性。
  // v15: 语义主路径（semanticOnly）。
  // v16: 提示词要求每屏中文本地闭合；语义路径接可读性合并，合并处补逗号。
  var BLOCK_CONTRACT_VERSION = "block-v20";

  var BLOCK_SEGMENT_MAX_GAP_MS = 750;
  var BLOCK_MIN_DISPLAY_MS = 300;
  // 阅读速度上限，来自 Netflix Timed Text Style Guide（简体中文，成人节目 9 字/秒）。
  // https://partnerhelp.netflixstudios.com/hc/en-us/articles/215986007
  // 换算成每字最少显示毫秒数：1000/9 ≈ 111ms。此前代码里用过 180ms/字（5.5 字/秒）
  // 的自拟值，把合格的屏也算成读不完（实测同一批数据 17 屏 vs 4 屏），故以行业标准为准。
  var READING_MS_PER_CHAR = Math.ceil(1000 / 9);
  // 句末标点 —— 断点强弱上与逗号同级（Jay：「一视同仁」），但它额外是**硬边界**：
  // 一件事说完了，下一件不得挤进同一屏。装填时用它强制换屏。
  var SENTENCE_FINAL_PUNCT = /[。！？!?….]\s*$/u;

  /**
   * 为保住词组允许的极小超宽（半角单位）—— 单一权威常量。
   *
   * 用户明确允许「偶尔接受长句」。在无标点可断的长句上，把断点强行压进容量内
   * 往往只能切在词内部（实测「同样|贵」「工程|师」）；宁可让一屏多出一两个字符，
   * 也不要把词切开。只在候选断点是词内部时才动用，正常情况下容量仍是 cap。
   */
  var DISPLAY_SOFT_OVERFLOW = 2;

  /** 源轨里所有 ≥ maxInternalGapMs 的真实停顿区间（说话人停下来的静音段） */
  function longPauseRanges(cues, maxInternalGapMs) {
    var ranges = [];
    if (!(maxInternalGapMs > 0)) return ranges;
    for (var i = 1; i < cues.length; i++) {
      var gapStart = Number(cues[i - 1].end);
      var gapEnd = Number(cues[i].start);
      if (gapEnd - gapStart >= maxInternalGapMs) ranges.push([gapStart, gapEnd]);
    }
    return ranges;
  }

  // 语言无关：一屏字幕不得停留在说话人的长停顿里。落在停顿内的边界钳到停顿的对应一侧，
  // 这样静音处不显示字幕，同时不牺牲译文的语义完整性。
  function clampToPauseSide(pauses, ms, startSide) {
    for (var i = 0; i < pauses.length; i++) {
      if (ms > pauses[i][0] && ms < pauses[i][1]) return startSide ? pauses[i][1] : pauses[i][0];
    }
    return ms;
  }

  function semanticSegmentIntegrity(segment) {
    return hashCacheIdentity([
      "semantic-span-v2",
      String(segment.sourceFingerprint || ""),
      String(segment.sourceTextHash || ""),
      String(segment.segmentId || ""),
      Number(segment.tokenStart),
      Number(segment.tokenEnd),
      String(segment.translation || ""),
    ].join("\x1f"));
  }

  /** Materialize model-free semantic token spans; cue boundaries are never used as cuts. */
  function materializeSemanticTranslation(segments, sourceCues, opts) {
    opts = opts || {};
    var timeline = opts.tokens && opts.tokens.tokens ? opts.tokens : (opts.tokens ? { tokens: opts.tokens } : buildCanonicalTokenTimeline(sourceCues || []));
    var tokens = timeline.tokens || [];
    var sourceFingerprint = String(timeline.sourceFingerprint || "");
    var maxVisualWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    var cursor = 0;
    var output = (segments || []).map(function (segment, index) {
      if (!segment || segment.segmentId !== "b" + index ||
          !Number.isInteger(segment.tokenStart) || !Number.isInteger(segment.tokenEnd) ||
          segment.tokenStart !== cursor || segment.tokenEnd <= segment.tokenStart || segment.tokenEnd > tokens.length) {
        throw new Error("semantic translation coverage invalid");
      }
      if (opts.requireIntegrity && segment.integrity !== semanticSegmentIntegrity(segment)) {
        throw new Error("semantic translation integrity mismatch");
      }
      var span = tokens.slice(segment.tokenStart, segment.tokenEnd);
      if (span.length > SEMANTIC_MAX_TOKENS) throw new Error("semantic translation span exceeds token limit");
      if (!span.length) throw new Error("semantic translation span empty");
      var originalText = joinRestoredWords(span.map(function (token) { return token.text; }));
      if (segment.sourceFingerprint != null && segment.sourceFingerprint !== sourceFingerprint) throw new Error("semantic translation source fingerprint mismatch");
      if (segment.sourceTextHash != null && segment.sourceTextHash !== hashCacheIdentity(originalText)) throw new Error("semantic translation source text mismatch");
      var translation = sanitizeSubtitleLine(String(segment.translation == null ? "" : segment.translation)).replace(/。/g, "");
      // 过宽不再让整个 clip 失败：整块回退英文远比一行略宽严重。
      // 这里只标记 overflow，由显示层分屏承担；token span 不因此改变。
      var overflow = semanticDisplayWidth(translation) > maxVisualWidth * 2 + DISPLAY_SOFT_OVERFLOW;
      var unit = {
        unitId: timeline.sourceFingerprint + ":u" + index + ":" + segment.tokenStart + "-" + segment.tokenEnd,
        tokenStart: segment.tokenStart,
        tokenEnd: segment.tokenEnd,
        startMs: span[0].startMs,
        endMs: Math.max(span[span.length - 1].endMs, span[0].startMs),
        originalText: originalText,
        translation: translation,
        srcStart: segment.tokenStart + 1,
        srcEnd: segment.tokenEnd,
        semanticGroupId: "sg" + index,
        displayOverflow: overflow,
      };
      cursor = segment.tokenEnd;
      return unit;
    });
    if (cursor !== tokens.length) throw new Error("semantic translation coverage tail missing");
    return output;
  }

  /**
   * 语义单元 → 最终显示单元的唯一入口：物化 → 合并读不完的屏 → 借静音 → 去重叠。
   *
   * 网络路径（translateContextBlock）和缓存命中路径（isolated.js readVerifiedClipCache）
   * 必须走同一个函数。此前管线只接在网络路径，缓存命中直接用物化结果 —— 同一 clip
   * 首播与重播显示不同，harness 只能手抄一份管线去比对。
   *
   * 合并处理的是算术（字数 vs 毫秒，Netflix 简中 9 字/秒），语感断点仍归模型。
   */
  function materializeReadableSemanticUnits(segments, cues, opts) {
    opts = opts || {};
    cues = cues || [];
    var units = materializeSemanticTranslation(segments, cues, opts);
    var lastCue = cues[cues.length - 1];
    var pauses = longPauseRanges(cues, Math.max(0, Math.floor(Number(opts.maxInternalGapMs) || BLOCK_SEGMENT_MAX_GAP_MS)));
    return enforceDisplayMonotonicity(
      extendIntoSilence(mergeUnreadableUnits(units, { maxVisualWidth: opts.maxVisualWidth }), pauses,
        { blockEndMs: Number(lastCue && lastCue.end) || 0 }),
      Math.max(1, Math.floor(Number(opts.minDisplayMs) || BLOCK_MIN_DISPLAY_MS)));
  }

  /**
   * 合并「时间窗不够读完」的相邻屏。
   *
   * 为什么需要：屏的时间严格来自它覆盖的源 cue（红线：startMs 不许动、不许侵入下一屏），
   * 所以当源 cue 本身很短时，无论译文怎么精炼都读不完 —— 实测西语 c4「y por moda」只有
   * 820ms，中文「也为了时尚，展现个性」9 字按 9 字/秒需要 1000ms，91ms/字。
   * 合并相邻两屏则时间窗相加、字数相加，人均阅读时间被摊平（91ms/字 → 156ms/字），
   * 且 start 取前屏、end 取后屏，两个红线都不碰。
   *
   * 为什么由程序做而不是模型：这是算术不是语感。「够不够读」由字数和毫秒数唯一确定，
   * 不存在两种合理答案；交给模型反而引入不确定性（弱模型心算 startMs/endMs 更不可靠），
   * 还要多花 prompt token。语感判断（该不该在这里断句）仍归模型 —— 本函数只在
   * 模型的断点确实读不完时才撤销它，且受下列硬约束限制。
   *
   * 硬约束（全部复用既有不变量，不新增规则）：
   *  - 不跨 segment 合并：segment 边界就是 750ms 长停顿，是真实语音结构边界。
   *  - 不把两个完整句子并到一屏：句末标点是既有硬边界（splitAtSentenceEnd 的判据）。
   *  - 合并后不得超过最大显示宽度：否则渲染层还得再切，白合并。
   *  - 只有「合并后确实改善」才合并：避免把两个都不够的屏合成一个仍不够的长屏。
   */
  function mergeUnreadableUnits(units, opts) {
    opts = opts || {};
    var maxWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    var msPerChar = Math.max(1, Math.floor(Number(opts.readingMsPerChar) || READING_MS_PER_CHAR));
    // 需要多久才读得完这段译文。宽字符（汉字/假名）与窄字符（拉丁字母、数字）都算
    // 一个阅读单位：Netflix 的 9 字/秒针对的是汉字，拉丁词整体读得更快，按字符计
    // 反而高估，所以这里用 semanticDisplayWidth/2 折算成"汉字等价数"。
    function readMsNeeded(text) {
      var chars = Math.ceil(semanticDisplayWidth(text) / 2);
      return chars * msPerChar;
    }
    function shortfall(unit) {
      return readMsNeeded(unit.translation) - (unit.endMs - unit.startMs);
    }
    // 每字可用毫秒：合并的判据。合并把两屏的字数和时间都相加，缺口绝对值完全可能
    // 变大（字加得比时间快），但人均阅读时间被摊平 —— 那才是合并的目的（skill §3：
    // 91→156 ms/字）。旧判据比总缺口，2026-08-24 真轨实测把 7 屏可救的正确合并拒掉。
    function msPerReadChar(unit) {
      return (unit.endMs - unit.startMs) / Math.max(1, readMsNeeded(unit.translation) / msPerChar);
    }
    // 两屏能否合成一屏：同一停顿组、原文前屏不是句末、译文前屏不是完整句、合并后不超宽。
    // 原文句末判据与整句协议的硬约束同口径（SENTENCE_FINAL_RE），不把两句焊进一屏。
    function mergePair(a, b) {
      if ((b.pauseGroupId || 0) !== (a.pauseGroupId || 0)) return null; // 不跨长停顿（真实静音边界）
      if (endsWithSentenceFinal(a.translation)) return null;
      // 原文前屏已是句末时，只允许并入同样完整的下一句（「I don't know. | Doesn't matter.」
      // → 「我不知道，无所谓」），不许把上一句的尾巴和下一句的半句拼进一屏（ds-40-v18 第 18 屏）。
      if (SENTENCE_FINAL_RE.test(collapseWhitespace(a.originalText || "")) &&
        !SENTENCE_FINAL_RE.test(collapseWhitespace(b.originalText || ""))) return null;
      var mergedText = joinDisplayScreens(a.translation, b.translation);
      if (semanticDisplayWidth(mergedText) > maxWidth) return null;
      return {
        blockSegmentId: a.blockSegmentId,
        pauseGroupId: a.pauseGroupId || 0,
        srcStart: a.srcStart,
        srcEnd: b.srcEnd,
        // token span 取并集：coverage ledger 靠它验证「每个源词恰好覆盖一次」。
        tokenStart: a.tokenStart,
        tokenEnd: b.tokenEnd,
        originalText: joinDisplayScreens(a.originalText, b.originalText),
        translation: mergedText,
        startMs: a.startMs,   // 红线：出现时刻取前屏，绝不前推
        endMs: b.endMs,       // 红线：结束取后屏，绝不越过它
      };
    }
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var cur = units[i];
      // 先向后并：反复把后继屏并进来，直到读得完或撞上任一硬约束。
      while (shortfall(cur) > 0 && i + 1 < units.length) {
        var forward = mergePair(cur, units[i + 1]);
        if (!forward || !(msPerReadChar(forward) > msPerReadChar(cur))) break;
        cur = forward;
        i++;
      }
      // 向后并不了（下一屏是新句子、或并了更挤）时再向前并进上一屏。
      // ds-40-v19：「看这里」0.4s | 「这个理由被引用了三次」0.8s——后屏读不完，
      // 而它的下一屏是新句子，只能并回前屏。只在两屏里更挤的那一屏变宽松时才接受，
      // 不把一个够读的前屏拖成读不完。
      if (shortfall(cur) > 0 && out.length) {
        var prev = out[out.length - 1];
        var backward = mergePair(prev, cur);
        if (backward && msPerReadChar(backward) > Math.min(msPerReadChar(prev), msPerReadChar(cur))) {
          out[out.length - 1] = backward;
          continue;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /**
   * 读不完的屏借用后面的静音时间。
   *
   * 真实数据（mxh.en-orig，v0.9.0 ledger 跑）：9/30 屏读不完，而它们后面紧跟着
   * 无人说话的静音 —— #04 后 2028ms、#17 后 1122ms、#24 后 1056ms。字幕在 end
   * 就消失，静音期屏幕空着，读不完的字被硬截断。
   *
   * 为什么这是根修而不是补丁：
   *  - 合并（mergeUnreadableUnits）会把两个语义单元并成一屏，改变模型的断点；
   *    借静音不动任何断点、不动任何文字，只把已经空着的时间用起来。
   *  - startMs 是红线（出现时刻必须贴音轨），这里一个都不动，只延 endMs。
   *  - 绝不越过下一屏 startMs，所以不会侵占后一句的语音时间，也不产生重叠。
   *
   * 硬约束：不得延进长停顿。「静音处永不显示字幕」是既有红线（clampToPauseSide），
   * 所以可借的只有语音之间的短间隙，长停顿一侧必须钳住。这条约束让本函数对
   * 「短屏后面紧跟长停顿」无能为力 —— 那种情况只能靠模型在时长预算内精炼措辞。
   */
  function extendIntoSilence(units, pauses, opts) {
    opts = opts || {};
    var msPerChar = Math.max(1, Math.floor(Number(opts.readingMsPerChar) || READING_MS_PER_CHAR));
    return (units || []).map(function (unit, index) {
      var needed = Math.ceil(semanticDisplayWidth(unit.translation) / 2) * msPerChar;
      var have = unit.endMs - unit.startMs;
      if (have >= needed) return unit;
      // 末屏的天花板：块内没有"下一屏"可当边界，但块之外还有内容 —— 借静音必须
      // 止步于本块最后一条源 cue 的结束时刻，否则会探进下一个 clip 的首屏区间。
      // 2026-08-24 实测：不设这个上界时，跨 clip 边界处出现 182ms 重叠（两屏同时在屏）。
      // 生产渲染层(isolated.js)虽有最终去重叠，但块内不该先产出越界值再让下游收拾。
      var ceiling = index + 1 < units.length ? units[index + 1].startMs
        : (Number(opts.blockEndMs) > 0 ? Math.min(unit.startMs + needed, Number(opts.blockEndMs))
                                       : unit.startMs + needed);
      var wanted = Math.min(unit.startMs + needed, ceiling);
      // 红线：不得把 end 推进长停顿（静音处不显示字幕）。
      var endMs = Math.round(clampToPauseSide(pauses || [], wanted, false));
      if (!(endMs > unit.endMs)) return unit;
      var next = {};
      Object.keys(unit).forEach(function (k) { next[k] = unit[k]; });
      next.endMs = Math.min(endMs, ceiling);   // 只延 end，startMs 不动，绝不越过下一屏 start
      return next;
    });
  }

  function endsWithSentenceFinal(text) {
    var s = collapseWhitespace(String(text || ""));
    if (!s) return false;
    return SENTENCE_FINAL_PUNCT.test(s.slice(-1));
  }

  function joinDisplayScreens(a, b) {
    var left = collapseWhitespace(String(a == null ? "" : a));
    var right = collapseWhitespace(String(b == null ? "" : b));
    if (!left) return right;
    if (!right) return left;
    // 两屏各自是闭合的中文句（句号已在物化时去掉）。直接拼会粘成
    // 「其中一个用途就是烧水我们这么做有很多原因」—— 2026-08-25 真轨 ds-40-prog 实测。
    // 左屏以汉字/假名收尾且无标点时补一个中文逗号；其余情况沿用原拼接口径。
    // 百分号收尾同理（「长约16%」|「为什么？」全片真轨实测粘连）；裸数字不补，
    // 「1500」|「瓦」是数字+单位，补逗号反而拆开。
    if (/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}%％]$/u.test(left) &&
        /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u.test(right)) return left + "，" + right;
    // 中日韩之间不加空格，拉丁字符之间加 —— 复用 joinRestoredWords 的既有口径。
    return joinRestoredWords([left, right]);
  }

  /**
   * 保证相邻屏在时间上不重叠。
   *
   * 真实 YouTube json3 ASR 轨是滚动窗口：每条源 cue 都与前一条大幅重叠（实测样本
   * 6/6 条全部重叠）。屏时间由源 cue 时间派生，所以重叠会直接传递到显示层 ——
   * 实测出现「屏1 end=24399 > 屏2 start=22720」的倒挂，两屏字幕同时在屏上。
   *
   * 修法只截 endMs，绝不动 startMs：出现时刻是唯一必须精确贴合音轨的量，前推会让
   * 整轨累积漂移。若截断后不足最短显示时长，就保留 minDisplayMs 并让下一屏的
   * startMs 成为硬边界（宁可短暂重叠 <minDisplayMs，也不让字幕早于语音出现）。
   *
   * 要求 units 已按 start 升序。字段名可配：块内 units 用 startMs/endMs，渲染时间线
   * 用 start/end —— 后者是跨块汇合后的唯一去重叠点，块内那次看不见块边界。
   */
  function enforceDisplayMonotonicity(units, minDisplayMs, opts) {
    opts = opts || {};
    var sKey = opts.startKey || "startMs";
    var eKey = opts.endKey || "endMs";
    for (var i = 0; i + 1 < units.length; i++) {
      var nextStart = units[i + 1][sKey];
      if (units[i][eKey] > nextStart) {
        units[i][eKey] = Math.max(nextStart, units[i][sKey] + minDisplayMs);
      }
    }
    return units;
  }

  async function translateContextBlock(opts) {
    opts = opts || {};
    var cues = opts.cues || [];
    if (!cues.length) return { segments: [], units: [] };
    var timeline = buildCanonicalTokenTimeline(cues);
    var semantic = await restoreAndPackTokens({
      tokens: timeline.tokens,
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      apiModel: opts.apiModel,
      targetLang: opts.targetLang,
      systemPrompt: opts.boundarySystemPrompt,
      preferredMaxWords: opts.preferredMaxWords,
      maxWords: opts.maxWords,
      preferredVisualWidth: opts.preferredVisualWidth,
      maxVisualWidth: opts.maxVisualWidth,
      semanticOnly: true,
      onRefineFailure: opts.onRefineFailure,
      attempts: opts.attempts,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      onUsage: opts.onUsage,
      signal: opts.signal,
    });
    var semanticCues = [];
    var tokenCursor = 0;
    (semantic || []).forEach(function (unit, index) {
      var count = unit.tokens.length;
      semanticCues.push({
        start: unit.start,
        end: unit.end,
        content: unit.content,
        tokens: unit.tokens,
        tokenStart: tokenCursor,
        tokenEnd: tokenCursor + count,
        unitId: "u" + index,
        semanticGroupId: unit.semanticGroupId,
      });
      tokenCursor += count;
    });
    if (tokenCursor !== timeline.tokens.length) throw new Error("semantic token packing coverage mismatch");
    var screens = await translateSentenceScreens({
      pieces: semanticCues,
      apiBaseUrl: opts.apiBaseUrl,
      apiKey: opts.apiKey,
      apiModel: opts.apiModel,
      targetLang: opts.targetLang,
      systemPrompt: opts.systemPrompt,
      maxVisualWidth: opts.maxVisualWidth,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      onUsage: opts.onUsage,
      signal: opts.signal,
      lenient: !!opts.lenient,
    });
    var segments = screens.map(function (screen, index) {
      var first = semanticCues[screen.from];
      var last = semanticCues[screen.to];
      var segment = {
        segmentId: "b" + index,
        sourceFingerprint: timeline.sourceFingerprint,
        sourceTextHash: hashCacheIdentity(joinRestoredWords(timeline.tokens.slice(first.tokenStart, last.tokenEnd).map(function (token) { return token.text; }))),
        tokenStart: first.tokenStart,
        tokenEnd: last.tokenEnd,
        translation: screen.text,
      };
      segment.integrity = semanticSegmentIntegrity(segment);
      return segment;
    });
    return { segments: segments, units: materializeReadableSemanticUnits(segments, cues, { tokens: timeline, maxVisualWidth: opts.maxVisualWidth, maxInternalGapMs: opts.maxInternalGapMs, minDisplayMs: opts.minDisplayMs }) };
  }

  // 记住哪些 (baseUrl|model) 拒绝 reasoning_effort，避免每个 clip 都白撞一次 400。
  // 一轨 50 clip × 2 请求，不记的话就是上百次无谓往返。
  var REASONING_EFFORT_UNSUPPORTED = Object.create(null);
  function reasoningEffortKey(baseUrl, model) { return String(baseUrl || "") + "|" + String(model || ""); }
  // 各家兼容网关对「不认识的字段」措辞不一（Unrecognized request argument /
  // unknown field / unsupported parameter…），统一按 reasoning_effort 是否出现在
  // 错误文本里判定，不去枚举措辞。
  function isUnsupportedReasoningEffortError(status, message) {
    if (status !== 400 && status !== 422) return false;
    return /reasoning_effort/i.test(String(message || ""));
  }

  /**
   * 发一次 chat/completions 并返回 message.content 字符串。
   * translateSentenceScreens / restoreTokenBoundaries 复用：构造请求、AbortController 超时、
   * HTTP/网络错误归一化抛出。纯 I/O，不做任何对齐/解析（交给调用方）。
   * 出错（HTTP 非 200、网络异常、超时）抛 Error，调用方决定兜底。
   */
  async function chatCompletion(opts) {
    var fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) throw new Error("no fetch implementation available");
    var url = chatCompletionsUrl(opts.apiBaseUrl);
    var body = {
      model: opts.apiModel,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
      messages: [
        { role: "system", content: opts.systemContent },
        { role: "user", content: opts.userContent },
      ],
    };
    var re = opts.reasoningEffort;
    var reKey = reasoningEffortKey(opts.apiBaseUrl, opts.apiModel);
    // 已知该端点/模型不认识这个字段就别再发（下面 400 分支会记住）。
    var sendReasoningEffort = !!(re && re !== "default" && re !== "none") && !REASONING_EFFORT_UNSUPPORTED[reKey];
    if (sendReasoningEffort) body.reasoning_effort = String(re);
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : TRANSLATE_TIMEOUT_MS;
    var fetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (opts.apiKey || "") },
      body: JSON.stringify(body),
    };
    var timer = null;
    var timeoutTriggered = false;
    var externalSignal = opts.signal || null;
    var externalAbortHandler = null;
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      var ac = new AbortController();
      fetchOpts.signal = ac.signal;
      if (externalSignal) {
        externalAbortHandler = function () { try { ac.abort(); } catch (_) {} };
        if (externalSignal.aborted) externalAbortHandler();
        else if (typeof externalSignal.addEventListener === "function") externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
      }
      timer = setTimeout(function () {
        timeoutTriggered = true;
        try { ac.abort(); } catch (_) {}
      }, timeoutMs);
    } else if (externalSignal) {
      fetchOpts.signal = externalSignal;
    }
    function cleanupAbortContext() {
      if (timer) clearTimeout(timer);
      if (externalSignal && externalAbortHandler && typeof externalSignal.removeEventListener === "function") {
        try { externalSignal.removeEventListener("abort", externalAbortHandler); } catch (_) {}
      }
    }
    var headersReceived = false;
    try {
      var resp = await fetchImpl(url, fetchOpts);
      headersReceived = true;
      var data = null;
      var responseText = "";
      if (typeof resp.text === "function") {
        responseText = await resp.text();
      } else if (typeof resp.json === "function") {
        try { data = await resp.json(); } catch (_) { throw malformedApiResponseError(resp, ""); }
      }
      if (externalSignal && externalSignal.aborted) throw runtimeAbortErrorForCore();
      if (data == null) {
        var contentType = responseContentType(resp);
        if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*</.test(responseText)) throw htmlApiResponseError(resp, contentType);
        try {
          if (responseText) data = JSON.parse(responseText);
          else if (typeof resp.json === "function") data = await resp.json();
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          throw malformedApiResponseError(resp, contentType);
        }
      }
      if (!resp.ok) {
        var apiMessage = data && data.error && (data.error.message || data.error.code) || "";
        // 兼容性降级：不认识 reasoning_effort 的模型会 400/422 直接拒掉整个请求，
        // 而该字段默认就是 "low"——用户什么都不改就会撞上，整条语义路径对这些模型
        // 完全不可用。记住这个端点/模型并当场重发一次（不带该字段）。
        // 只在本次确实发了该字段时才重试，避免把无关的 400 也当成它。
        if (sendReasoningEffort && isUnsupportedReasoningEffortError(resp.status, apiMessage)) {
          REASONING_EFFORT_UNSUPPORTED[reKey] = true;
          cleanupAbortContext();
          var retryOpts = {};
          for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) retryOpts[k] = opts[k]; }
          retryOpts.reasoningEffort = "";
          return await chatCompletion(retryOpts);
        }
        var httpErr = new Error("translate HTTP " + resp.status + (apiMessage ? " " + String(apiMessage).slice(0, 200) : ""));
        if (resp.status === 429) httpErr.code = "429";
        throw httpErr;
      }
      if (externalSignal && externalSignal.aborted) throw runtimeAbortErrorForCore();
      if (typeof opts.onUsage === "function" && data && data.usage) {
        try { opts.onUsage(data.usage); } catch (_) {}
      }
      return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    } catch (e) {
      var aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
      if (aborted) {
        if (externalSignal && externalSignal.aborted && !timeoutTriggered) throw new Error("translate aborted");
        throw new Error("translate timeout (" + timeoutMs + "ms)");
      }
      if (!headersReceived && !(e && e.code)) throw new Error("translate network error: " + (e && e.message ? e.message : e));
      throw e;
    } finally {
      cleanupAbortContext();
    }
  }

  function runtimeAbortErrorForCore() {
    var err = new Error("translate aborted");
    err.name = "AbortError";
    return err;
  }

  function responseContentType(resp) {
    try { return String(resp && resp.headers && resp.headers.get("content-type") || ""); } catch (e) { return ""; }
  }

  function safeResponsePath(resp) {
    try { return new URL(String(resp && resp.url || "")).pathname || "/"; } catch (e) { return ""; }
  }

  function responseMeta(resp, contentType) {
    var status = Number(resp && resp.status) || 0;
    var path = safeResponsePath(resp);
    var bits = ["HTTP " + status];
    if (contentType) bits.push(contentType.split(";")[0]);
    if (path) bits.push("路径 " + path);
    if (resp && resp.redirected) bits.push("发生重定向");
    return bits.join("，");
  }

  function responseError(message, resp) {
    var err = new Error(message);
    var status = Number(resp && resp.status) || 0;
    if (status) err.code = String(status);
    return err;
  }

  function htmlApiResponseError(resp, contentType) {
    var path = safeResponsePath(resp);
    var correctChatPath = /\/chat\/completions\/?$/.test(path);
    var claimsJson = /application\/json/i.test(String(contentType || ""));
    if (resp && resp.ok && correctChatPath && claimsJson) {
      return responseError(
        "API 请求路径正确，但网关或上游返回了被错误标记为 JSON 的 HTML（" + responseMeta(resp, contentType) + "）。" +
        "请检查所选模型的上游路由，或稍后重试",
        resp
      );
    }
    return responseError(
      "API 返回 HTML 而不是 JSON（" + responseMeta(resp, contentType) + "）。" +
      "请确认填写的是 OpenAI 兼容 API Base URL（通常以 /v1 结尾），不要填写控制台或网站首页",
      resp
    );
  }

  function malformedApiResponseError(resp, contentType) {
    return responseError("API 返回的不是有效 JSON（" + responseMeta(resp, contentType) + "）", resp);
  }

  /** 允许填写 API Base URL 或完整 /chat/completions 地址，避免重复拼接。 */
  function chatCompletionsUrl(base) {
    var b = String(base || "").trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(b)) return b;
    return joinUrl(b, "/chat/completions");
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
      if (opts.keepSemanticGroups) {
        while (i < n) {
          var runStart = i;
          var semanticId = cues[i].semanticGroupId != null ? String(cues[i].semanticGroupId) : "cue:" + i;
          var runChars = 0;
          while (i < n) {
            var currentId = cues[i].semanticGroupId != null ? String(cues[i].semanticGroupId) : "cue:" + i;
            if (currentId !== semanticId) break;
            runChars += String(cues[i].content == null ? "" : cues[i].content).length;
            i++;
          }
          var runCount = i - runStart;
          if (maxCues > 0 && runCount > maxCues) throw new Error("semantic group exceeds clip cue limit");
          var prospectiveSpan = cues[i - 1].end - startMs;
          var wouldOverflow = group.length > 0 && (
            prospectiveSpan >= size ||
            (maxCues > 0 && group.length + runCount > maxCues) ||
            (maxChars > 0 && charCount + runChars > maxChars)
          );
          if (wouldOverflow) { i = runStart; break; }
          for (var gi = runStart; gi < i; gi++) group.push(cues[gi]);
          charCount += runChars;
        }
      } else {
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
  /**
   * 决定"这一刻该翻哪些 clip"—— 预取窗口的唯一权威判据。
   *
   * 之前这个决策内联在 isolated.js 的 prefetchAround 里，因此无法被测试覆盖，
   * 于是一个致命回归长期没人发现：整轨语义恢复期间（semanticPending）计划被砍成
   * [idx]（只翻当前正在播的那一段）。实测这段时间在 37 分钟轨上长达 9.5 分钟
   * （6261 token / 35 块 × 单块 16.4s，且刻意用最低优先级只吃富余并发），
   * 期间单 clip 翻译约 9.5s 而一个 clip 只覆盖约 14s 播放 —— 边播边翻，
   * 译文永远追着播放跑。整轨模拟覆盖率 0%。
   *
   * 现在语义恢复改为跟着播放位置滑动（区间恢复），不再存在"长期 pending"，
   * 因此预取窗口不再因恢复而降级：任何时刻都按 ahead 深度预取。
   *
   * 返回 { plan, reason }。reason 供门禁与诊断使用，不影响行为。
   */
  function planTranslationWindow(opts) {
    opts = opts || {};
    var idx = Number(opts.currentIdx);
    var count = Number(opts.clipCount);
    if (!Number.isFinite(count) || count <= 0) return { plan: [], reason: "no-clips" };
    if (!Number.isFinite(idx) || idx < 0 || idx >= count) return { plan: [], reason: "idx-out-of-range" };
    var plan = planPrefetch(idx, count, opts.ahead, { remainMsInCurrent: opts.remainMsInCurrent });

    // 翻译不得越过语义恢复边界。
    //
    // 语义恢复会重新切分句子边界，跨越边界的旧译文无法继承（真机实测 28 条新单元
    // 里 17 条与旧边界交叉切开），只能作废重翻。所以「已恢复到哪里」就是「可以翻到
    // 哪里」—— 越过去翻的那部分注定要扔掉，是纯浪费。
    //
    // 恢复速度是播放的 3.5x，截断不会让翻译闲置；当前段永远保留（首屏可用性底线，
    // 哪怕它暂时还在 fallback 断句上，也必须先有中文）。
    // clip 起始时间由调用方给出（clipStartMs[i]）—— 不能按 clipSeconds 均分推算：
    // clipSeconds 是用户可配的，且首个 clip 刻意更短，均分算出的下标是错的。
    var readyUntil = opts.semanticReadyUntilMs;
    var clipStartMs = opts.clipStartMs;
    if (readyUntil != null && Number.isFinite(Number(readyUntil)) && Array.isArray(clipStartMs)) {
      var limit = Number(readyUntil);
      var clamped = plan.filter(function (i) {
        var s = Number(clipStartMs[i]);
        return !Number.isFinite(s) || s < limit;
      });
      // 当前段无论如何都要翻 —— 没有中文比断句将来会变更糟。
      if (!clamped.length) clamped = [Math.floor(idx)];
      if (clamped.length !== plan.length) {
        return { plan: prioritizePrefetch(clamped, Math.floor(idx)), reason: "clamped-to-semantic" };
      }
      plan = clamped;
    }
    return { plan: prioritizePrefetch(plan, Math.floor(idx)), reason: "window" };
  }

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
    var waiterSeq = 0;
    var okStreak = 0;
    var coolUntil = 0;

    function pump() {
      // 有空位且有等待者 → 放行
      while (inFlight < cap && waiters.length > 0) {
        var next = waiters.shift();
        inFlight++;
        next.resolve();
      }
    }
    function acquire(priority) {
      if (inFlight < cap) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        waiters.push({ resolve: resolve, priority: Number(priority) || 0, seq: waiterSeq++ });
        waiters.sort(function (a, b) { return b.priority - a.priority || a.seq - b.seq; });
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
    function run(fn, priority) {
      return acquire(priority).then(function () {
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
   * 生成缓存 key：架构版本 + 视频/轨道/语言/model + clip 起点 + cue 边界/正文指纹。
   * cue 指纹确保语义边界回修前后不碰撞，缓存中的译文与共享时间轴始终同批 1:1。
   */
  function hashCacheIdentity(value) {
    var text = String(value == null ? "" : value);
    var h1 = 0x811c9dc5;
    var h2 = 0x9e3779b9;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  function normalizeEndpointIdentity(value) {
    var raw = String(value || "").trim();
    try {
      var parsed = new URL(raw);
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.hash = "";
      if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      return parsed.toString().replace(/\/$/, "");
    } catch (e) {
      // 非 URL 配置最终会在请求层失败；身份层仍保留大小写，绝不制造碰撞。
      return raw.replace(/\/+$/, "");
    }
  }

  function makeCacheKey(parts) {
    parts = parts || {};
    var normalizedBase = normalizeEndpointIdentity(parts.apiBaseUrl);
    return [
      "dsc-v90",
      parts.contractVersion || BLOCK_CONTRACT_VERSION,
      parts.segmentationMode || "fallback",
      parts.videoId || "",
      parts.trackCode || "",
      parts.targetLang || "",
      parts.apiModel || "",
      hashCacheIdentity(normalizedBase),
      hashCacheIdentity((parts.systemPrompt || DEFAULT_SYSTEM_PROMPT) + "\n" + (parts.blockSystemPrompt || DEFAULT_BLOCK_TRANSLATION_PROMPT)),
      parts.reasoningEffort || "default",
      parts.maxLineChars != null ? Number(parts.maxLineChars) : "",
      parts.clipStartMs != null ? parts.clipStartMs : "",
      parts.cueFingerprint || "",
    ].join("|");
  }

  /* ---------------------------------------------------------------
   * 站点适配层
   *
   * 唯一权威：每个受支持站点的所有差异都收敛在这张表里 —— 播放器/视频元素
   * 选择器、要隐藏的原生字幕容器、可信的字幕主机与 URL 形态、字幕格式、
   * 轨是否滚动重发。渲染、时间轴、语义分屏、翻译、ledger 全部与站点无关。
   *
   * 加新站点只允许往这张表里加一项 + 写它的取轨脚本，禁止在下游任何地方
   * 出现 if (site === "...") 分支 —— 那就是平行实现的开端。
   * ------------------------------------------------------------- */

  var SITE_ADAPTERS = {
    youtube: {
      id: "youtube",
      // 匹配 host（判定当前页属于哪个站点）
      hostRe: /(^|\.)youtube\.com$/,
      playerSelector: ".html5-video-player",
      videoSelector: ".html5-main-video, video",
      // 原生字幕容器：注入双语字幕后要隐藏它，否则和我们的叠加层重影
      nativeCaptionSelector: ".ytp-caption-window-container",
      // 字幕轨格式：json3 带词级时间（tOffsetMs）
      trackFormat: "json3",
      // 滚动 ASR 轨：同一句话在连续时间片里重发，重复文本要去重
      rollingSource: true,
      trustedHostRe: /^(?:youtube\.com|.*\.youtube\.com)$/,
      pathRe: /^\/api\/timedtext\/?$/,
      /* YouTube 的 timedtext URL 自带可交叉校验的参数：v/lang/kind 必须与轨道
       * 元数据一致，pot 签名必须在，tlang（YouTube 机翻）必须不在。 */
      checkTrackUrl: function (parsed, meta) {
        var urlVideo = parsed.searchParams.getAll("v");
        var urlLang = parsed.searchParams.getAll("lang");
        var urlKind = parsed.searchParams.getAll("kind");
        var pot = parsed.searchParams.get("pot");
        if (urlVideo.length !== 1 || urlVideo[0] !== meta.videoId) return false;
        if (urlLang.length !== 1 || urlLang[0] !== meta.languageCode) return false;
        if (!pot || parsed.searchParams.has("tlang")) return false;
        if (meta.kind === "asr") {
          return urlKind.length === 1 && urlKind[0] === "asr" &&
            meta.code === meta.languageCode + "-asr";
        }
        return urlKind.length === 0 && meta.code === meta.languageCode;
      },
      /* 观看页 URL → 视频 id：?v=xxx，以及 /shorts|live|embed/xxx */
      videoIdFrom: function (url) {
        var q = url.searchParams.get("v");
        if (q) return q;
        var m = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{1,128})(?:\/|$)/);
        return m ? m[1] : "";
      },
    },
    netflix: {
      id: "netflix",
      hostRe: /(^|\.)netflix\.com$/,
      // Netflix 没有 .html5-video-player 之类的语义 class。实测 DOM：
      //   div.watch-video--player-view (absolute, 856x685) → div.watch-video → video
      // 注意 default-ltr-iqcdef-cache-* 是编译期生成的 CSS class，会随构建变化，
      // 绝不能当选择器用。
      playerSelector: ".watch-video--player-view, .watch-video",
      videoSelector: "video",
      // 实测容器：.player-timedtext (856x481) > .player-timedtext-text-container
      nativeCaptionSelector: ".player-timedtext",
      // IMSC1 / TTML：句级时间，无内联词级时间戳（实测词级 0%）
      trackFormat: "ttml",
      // 人工成品轨：重复文本是真台词，不得当滚动重发删除
      rollingSource: false,
      // 字幕走签名 CDN 直链，形如 https://ipv4-cxxx-....oca.nflxvideo.net/range/...
      trustedHostRe: /^(?:[a-z0-9.-]+\.)?nflxvideo\.net$/,
      pathRe: /^\/[\w./-]*$/,
      /* Netflix 的 CDN 直链没有可交叉校验的语言参数（语言只存在于轨道元数据），
       * 所以只能校验元数据自身一致性：code 必须等于 languageCode，且不接受
       * asr —— Netflix 只有人工轨，出现 asr 说明数据被污染。 */
      checkTrackUrl: function (parsed, meta) {
        return meta.kind === "" && meta.code === meta.languageCode;
      },
      /* 观看页 URL 形如 /watch/80075919（可带 ?trackId=...） */
      videoIdFrom: function (url) {
        var m = url.pathname.match(/^\/watch\/(\d{1,32})(?:\/|$)/);
        return m ? m[1] : "";
      },
    },
  };

  /**
   * 按字幕文档的**实际内容**选解析器。
   *
   * 为什么不按站点的 trackFormat 直接派发：格式是数据的属性，不是站点的属性。
   * 同一站点可能给不同格式（Netflix 有 imsc1 与 webvtt 两种 profile），
   * 按内容嗅探既覆盖得全，也不会在站点改格式时静默产出空轨。
   * trackFormat 只作为「预期格式」用于诊断日志，不参与派发。
   */
  function parseSubtitleText(text) {
    if (typeof text !== "string") return [];
    var head = text.slice(0, 2048).replace(/^\uFEFF/, "").trim();
    if (head.charAt(0) === "{") {
      try { return parseJson3(JSON.parse(text)); } catch (e) { return []; }
    }
    if (/^WEBVTT/m.test(head)) return parseVtt(text);
    if (/<tt\b|<tt:tt\b|xmlns[^>]*ttml/i.test(head)) return parseTtml(text);
    // 未知形态：按 vtt 尽力而为（历史行为），失败就是空轨，由上游重试。
    return parseVtt(text);
  }

  /** 按 host 判定站点适配器；未支持的站点返回 null（不猜、不回落）。 */
  function siteAdapterFor(hostname) {
    var host = String(hostname == null ? "" : hostname).toLowerCase();
    var keys = Object.keys(SITE_ADAPTERS);
    for (var i = 0; i < keys.length; i++) {
      var a = SITE_ADAPTERS[keys[i]];
      if (a.hostRe.test(host)) return a;
    }
    return null;
  }

  /**
   * 当前页的视频 id。规则由站点适配器给出，这里只负责选适配器 ——
   * 加站点不需要改这个函数。
   */
  function pageVideoId(href) {
    var url;
    try { url = new URL(String(href)); } catch (e) { return ""; }
    var adapter = siteAdapterFor(url.hostname);
    if (!adapter) return "";
    return adapter.videoIdFrom(url) || "";
  }

  /**
   * 校验 MAIN world 送来的字幕轨道清单。DOM CustomEvent 是不可信边界：
   * 只允许目标站点的 HTTPS 字幕 URL，并限制所有字段和数组大小。
   * 返回去除未知字段的新对象；任一轨道非法时整包拒绝。
   *
   * site 决定用哪套 URL 形态校验。缺省 youtube 以保持既有行为。
   */
  function validateTrackManifest(content, options) {
    options = options || {};
    if (!content || typeof content !== "object" || !Array.isArray(content.files)) return null;
    var adapter = SITE_ADAPTERS[String(content.site || options.site || "youtube")];
    if (!adapter) return null;
    var videoId = String(content.videoId == null ? "" : content.videoId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) return null;
    if (options.expectedVideoId != null && String(options.expectedVideoId) !== videoId) return null;
    if (!content.files.length || content.files.length > 64) return null;
    var files = [];
    var identities = {};
    for (var i = 0; i < content.files.length; i++) {
      var raw = content.files[i];
      if (!raw || typeof raw !== "object") return null;
      var rawUrl = String(raw.url == null ? "" : raw.url);
      if (!rawUrl || rawUrl.length > 8192) return null;
      var parsed;
      try { parsed = new URL(rawUrl); } catch (e) { return null; }
      var host = String(parsed.hostname || "").toLowerCase();
      if (parsed.protocol !== "https:" || !adapter.trustedHostRe.test(host) ||
        !adapter.pathRe.test(parsed.pathname)) return null;
      var code = String(raw.code == null ? "" : raw.code);
      var languageCode = String(raw.languageCode == null ? "" : raw.languageCode);
      var name = String(raw.name == null ? code : raw.name);
      var kind = String(raw.kind == null ? "" : raw.kind);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(languageCode) || name.length > 256 || (kind !== "" && kind !== "asr")) return null;
      // URL 与元数据的交叉校验规则由适配器自己给出，不在这里按站点分支。
      if (!adapter.checkTrackUrl(parsed, {
        videoId: videoId, code: code, languageCode: languageCode, kind: kind,
      })) return null;
      var identity = [code, languageCode, kind].join("\x1f");
      if (identities[identity]) return null;
      identities[identity] = true;
      // kind 必须保留：auto 选轨靠 kind="asr" 那条轨的 languageCode 判定音轨语言
      // （轨顺序不保证原语言在前，其他元数据无法区分原语言轨和人工翻译轨）。
      files.push({ name: name, code: code, languageCode: languageCode, kind: kind, url: parsed.toString() });
    }
    return { site: adapter.id, videoId: videoId, files: files };
  }

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
  function exportConfig(config, opts) {
    opts = opts || {};
    var out = {};
    var keys = Object.keys(DEFAULT_CONFIG);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === "apiKey" && !opts.includeSecrets) continue;
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
      if (k === "targetLang") {
        var normalizedTarget = normalizeTargetLang(v);
        if (!normalizedTarget) return { ok: false, error: "当前版本仅支持简体中文译文（zh-Hans）" };
        out[k] = normalizedTarget;
        any = true;
      } else if (typeof def === "number") {
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
          // Translation coverage units are immutable single-line strings; preserve any explicit
          // safe line break from imported snapshots rather than collapsing it during export.
          translation: String(u.translation || "")
            .replace(/\r/g, "")
            .split("\n")
            .map(function (line) { return collapseWhitespace(line); })
            .filter(Boolean)
            .join("\n"),
          _i: i, // 稳定排序的兜底键（startMs 相等时保持原序）
        };
      })
      .filter(function (u) {
        return u.originalText || u.translation;
      });

    if (opts.requireTranslations) {
      var hasMissingTranslation = units.some(function (u) {
        return u.originalText && String(u.translation || "").trim() === "";
      });
      if (hasMissingTranslation) return "";
    }

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

  /**
   * 诊断快照 SRT:按**当前**已翻译内容原样导出,不做 fail-closed 拦截。
   *
   * 与 buildSrt 的区别和分工:
   *   buildSrt(requireTranslations:true) = 成品导出,任何缺译文都拒绝出文件
   *                                        (绝不产出半英文半中文成品)。
   *   buildProgressSrt                   = 诊断用,故意允许半成品,但会把
   *                                        未翻译单元显式标记出来,并在文件头
   *                                        附上每单元时长/每词时长统计,
   *                                        方便直接看出「长句一闪而过」这类问题。
   * 两者共用同一个 buildSrt 渲染核心,不另写一套时间格式化逻辑。
   */
  function buildProgressSrt(renderUnits, opts) {
    opts = opts || {};
    var list = (renderUnits || []).filter(function (u) {
      return u && (String(u.originalText || "").trim() || String(u.translation || "").trim());
    });
    var marked = list.map(function (u) {
      var trans = String(u.translation || "").trim();
      return {
        startMs: u.startMs != null ? u.startMs : u.start,
        endMs: u.endMs != null ? u.endMs : u.end,
        originalText: u.originalText,
        // 未翻译的显式标记,避免把半成品误当成品看
        translation: trans || "[未翻译]",
      };
    });
    var body = buildSrt(marked, { mode: opts.mode || "bilingual_orig_top" });
    if (!body) return "";
    var stats = progressSrtStats(list);
    var header = [
      "0",
      "00:00:00,000 --> 00:00:00,000",
      "[DualSub 诊断快照] " + (opts.videoId || "unknown") +
        " | 单元 " + stats.total + " | 已译 " + stats.translated + " | 未译 " + stats.untranslated,
      "每词时长 中位 " + stats.medianMsPerWord + "ms / p10 " + stats.p10MsPerWord + "ms" +
        " | <150ms/词 的单元 " + stats.tooFast + " 个" + (stats.worst ? " | 最差 " + stats.worst.msPerWord + "ms/词: " + stats.worst.text : ""),
    ].join("\n");
    return header + "\n\n" + body;
  }

  /** 诊断统计:单元时长与每词时长分布,用来定位「读不完」的单元 */
  function progressSrtStats(units) {
    var perWord = [];
    var tooFast = 0;
    var worst = null;
    var translated = 0;
    (units || []).forEach(function (u) {
      var text = String(u.originalText || "").trim();
      if (String(u.translation || "").trim()) translated++;
      if (!text) return;
      var startMs = u.startMs != null ? u.startMs : u.start;
      var endMs = u.endMs != null ? u.endMs : u.end;
      var words = text.split(/\s+/).filter(Boolean).length;
      if (!words || !(endMs > startMs)) return;
      var ratio = Math.round((endMs - startMs) / words);
      perWord.push(ratio);
      if (ratio < 150) tooFast++;
      if (!worst || ratio < worst.msPerWord) worst = { msPerWord: ratio, text: text };
    });
    perWord.sort(function (a, b) { return a - b; });
    function at(p) {
      if (!perWord.length) return 0;
      return perWord[Math.min(perWord.length - 1, Math.floor(perWord.length * p))];
    }
    return {
      total: (units || []).length,
      translated: translated,
      untranslated: (units || []).length - translated,
      medianMsPerWord: at(0.5),
      p10MsPerWord: at(0.1),
      tooFast: tooFast,
      worst: worst,
    };
  }
  var EXPORTS = {
    parseJson3: parseJson3,
    parseVtt: parseVtt,
    parseTtml: parseTtml,
    parseSubtitleText: parseSubtitleText,
    stripSubtitleAnnotations: stripSubtitleAnnotations,
    ttmlTimeToMs: ttmlTimeToMs,
    cleanupCues: cleanupCues,
    resegmentCues: resegmentCues,
    segmentTokensByBoundaries: segmentTokensByBoundaries,
    buildCanonicalTokenTimeline: buildCanonicalTokenTimeline,
    buildCueTokenSpanUnits: buildCueTokenSpanUnits,
    buildTokenSpanUnits: buildTokenSpanUnits,
    cuesFromTimelineSnapshot: cuesFromTimelineSnapshot,
    validateTokenSpanCoverage: validateTokenSpanCoverage,
    createTimelineSnapshot: createTimelineSnapshot,
    semanticPlanningGroups: semanticPlanningGroups,
    enforceVisualDisplayMarks: enforceVisualDisplayMarks,
    restoredWords: restoredWords,
    TRANSLATE_TIMEOUT_MS: TRANSLATE_TIMEOUT_MS,
    BLOCK_CONTRACT_VERSION: BLOCK_CONTRACT_VERSION,
    joinRestoredWords: joinRestoredWords,
    chunkTokenRanges: chunkTokenRanges,
    SEMANTIC_CHUNK_WORDS: SEMANTIC_CHUNK_WORDS,
    SEMANTIC_OVERLAP_WORDS: SEMANTIC_OVERLAP_WORDS,
    packRestoredTokens: packRestoredTokens,
    collapseWhitespace: collapseWhitespace,
    normalizeColor: normalizeColor,
    shadowCss: shadowCss,
    normalizeStrokeWidth: normalizeStrokeWidth,
    normalizeTargetLang: normalizeTargetLang,
    migrateConfig: migrateConfig,
    computeFontPx: computeFontPx,
    planPrefetch: planPrefetch,
    planTranslationWindow: planTranslationWindow,
    DISPLAY_UNIT_MAX_WORDS: DISPLAY_UNIT_MAX_WORDS,
    SOURCE_UNIT_MAX_WORDS: SOURCE_UNIT_MAX_WORDS,
    SEMANTIC_MAX_TOKENS: SEMANTIC_MAX_TOKENS,
    SEMANTIC_REFINE_MAX_WORDS: SEMANTIC_REFINE_MAX_WORDS,
    DEFAULT_REFINE_PROMPT: DEFAULT_REFINE_PROMPT,
    refineOversizedSemanticUnits: refineOversizedSemanticUnits,
    SOURCE_DISPLAY_PREFERRED_WIDTH: SOURCE_DISPLAY_PREFERRED_WIDTH,
    SOURCE_DISPLAY_MAX_WIDTH: SOURCE_DISPLAY_MAX_WIDTH,
    READING_MS_PER_CHAR: READING_MS_PER_CHAR,
    mergeUnreadableUnits: mergeUnreadableUnits,
    joinDisplayScreens: joinDisplayScreens,
    extendIntoSilence: extendIntoSilence,
    longPauseRanges: longPauseRanges,
    enforceDisplayMonotonicity: enforceDisplayMonotonicity,
    isNonSpeechMarker: isNonSpeechMarker,
    BLOCK_MIN_DISPLAY_MS: BLOCK_MIN_DISPLAY_MS,
    pickTrack: pickTrack,
    TRANSLATION_DISPLAY_MAX_WIDTH: TRANSLATION_DISPLAY_MAX_WIDTH,
    PREFETCH_AHEAD: PREFETCH_AHEAD,
    prioritizePrefetch: prioritizePrefetch,
    makeAdaptiveGate: makeAdaptiveGate,
    errorKind: errorKind,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_RESTORATION_PROMPT: DEFAULT_RESTORATION_PROMPT,
    DEFAULT_DISPLAY_PROMPT: DEFAULT_DISPLAY_PROMPT,
    semanticDisplayWidth: semanticDisplayWidth,
    buildSystemPrompt: buildSystemPrompt,
    sanitizeSubtitleLine: sanitizeSubtitleLine,
    // 中文显示契约的收口点（屏尾去标点 + 句号不显示）。与 sanitizeSubtitleLine 同级：
    // 都是对外可见的产品契约，不是内部辅助，因此可直接断言。
    // 中文分屏契约的唯一实现者。Jay 逐条确认过 11 组「输入 → 期望分屏」样例，那些
    // 样例就是本函数的产品规格，必须能直接断言 —— 经公开入口测会被时间层与屏数
    // 上限干扰，测不到排版本身。同 stripTrailingBreakPunct：契约点，不是内部辅助。
    validateChineseDisplayUnit: validateChineseDisplayUnit,
    preferManualTrack: preferManualTrack,
    looksChineseSubtitleText: looksChineseSubtitleText,
    looksChineseCueList: looksChineseCueList,
    extractJsonObject: extractJsonObject,
    DEFAULT_BLOCK_TRANSLATION_PROMPT: DEFAULT_BLOCK_TRANSLATION_PROMPT,
    materializeSemanticTranslation: materializeSemanticTranslation,
    materializeReadableSemanticUnits: materializeReadableSemanticUnits,
    // semantic segment 的完整性戳与其底层 hash 一并导出：缓存读回时
    // materializeSemanticTranslation({requireIntegrity:true}) 会复算它，
    // 任何要产出「与 translateContextBlock 同形」segments 的外部调用方
    // （回放夹具、离线重放工具）都必须能复算同一个戳，否则只能写出
    // tokenStart/sourceFingerprint 为空的伪 segment，缓存必然被丢弃。
    semanticSegmentIntegrity: semanticSegmentIntegrity,
    hashCacheIdentity: hashCacheIdentity,
    translateContextBlock: translateContextBlock,
    translateSentenceScreens: translateSentenceScreens,
    parseScreenCoverageResponse: parseScreenCoverageResponse,
    SCREEN_PROTOCOL_PROMPT: SCREEN_PROTOCOL_PROMPT,
    parseBoundaryPlanResponse: parseBoundaryPlanResponse,
    parseDisplayCutsResponse: parseDisplayCutsResponse,
    suggestDisplayTokenBoundaries: suggestDisplayTokenBoundaries,
    restoreTokenBoundaries: restoreTokenBoundaries,
    restoreAndPackTokens: restoreAndPackTokens,
    chatCompletion: chatCompletion,
    chatCompletionsUrl: chatCompletionsUrl,
    sliceClipsByCue: sliceClipsByCue,
    makeCacheKey: makeCacheKey,
    validateTrackManifest: validateTrackManifest,
    SITE_ADAPTERS: SITE_ADAPTERS,
    siteAdapterFor: siteAdapterFor,
    pageVideoId: pageVideoId,
    makeBackoff: makeBackoff,
    joinUrl: joinUrl,
    findCueIndexAt: findCueIndexAt,
    clipDisplayFlags: clipDisplayFlags,
    cueClipIndexMap: cueClipIndexMap,
    exportConfig: exportConfig,
    importConfig: importConfig,
    formatSrtTime: formatSrtTime,
    buildSrt: buildSrt,
    buildProgressSrt: buildProgressSrt,
    progressSrtStats: progressSrtStats,
  };

  return EXPORTS;
});
