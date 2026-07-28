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

  function resegmentTimelineSnapshot(snapshot, unitStart, unitEnd, replacementCues) {
    if (!snapshot || !snapshot.timeline || !Array.isArray(snapshot.units)) throw new Error("timeline snapshot required");
    var firstUnit = Number(unitStart);
    var afterUnit = Number(unitEnd);
    if (!Number.isInteger(firstUnit) || !Number.isInteger(afterUnit) || firstUnit < 0 || afterUnit <= firstUnit || afterUnit > snapshot.units.length) {
      throw new Error("replacement unit range invalid");
    }
    var tokenStart = snapshot.units[firstUnit].tokenStart;
    var tokenEnd = snapshot.units[afterUnit - 1].tokenEnd;
    // 装载质量门禁必须与生成这些单元的同一份语言无关视觉预算一致。固定 12/14
    // 会把连写文字按“字符数”拒掉，而空格语言按“词数”通过，形成隐蔽语言分支。
    var replacementBudget = semanticTokenBudgets(snapshot.timeline.tokens.slice(tokenStart, tokenEnd));
    (replacementCues || []).forEach(function (cue, ci) {
      var n = restoredWords(String(cue && cue.content || "")).length;
      var width = semanticDisplayWidth(String(cue && cue.content || ""));
      if (n > SEMANTIC_MAX_TOKENS || width > replacementBudget.maxVisualWidth) {
        throw new Error("semantic replacement unit " + ci + " has " + n + " tokens / " + width + " width");
      }
    });
    var sourceWords = snapshot.timeline.tokens.slice(tokenStart, tokenEnd).map(function (token) { return token.text; });
    var replacementWords = [];
    var localEnds = [];
    (replacementCues || []).forEach(function (cue) {
      var words = restoredWords(cue && cue.content || "");
      if (!words.length) throw new Error("replacement token unit empty");
      for (var i = 0; i < words.length; i++) replacementWords.push(words[i]);
      localEnds.push(tokenStart + replacementWords.length - 1);
    });
    // 带上实际数字：这条错误最常见的成因是调用方用了另一套下标空间
    // （原始轨 cue vs snapshot units），只报"mismatch"无法区分。
    if (replacementWords.length !== sourceWords.length) {
      throw new Error(
        "replacement token coverage mismatch: got " + replacementWords.length +
        " words for units [" + firstUnit + "," + afterUnit + ") = tokens [" +
        tokenStart + "," + tokenEnd + ") expecting " + sourceWords.length
      );
    }
    for (var w = 0; w < sourceWords.length; w++) {
      if (String(replacementWords[w]).toLowerCase() !== String(sourceWords[w]).toLowerCase()) {
        throw new Error("replacement token text mismatch at " + w);
      }
    }
    if (!localEnds.length || localEnds[localEnds.length - 1] !== tokenEnd - 1) throw new Error("replacement token coverage mismatch");
    var boundaries = [];
    for (var left = 0; left < firstUnit; left++) boundaries.push(snapshot.units[left].tokenEnd - 1);
    boundaries = boundaries.concat(localEnds);
    for (var right = afterUnit; right < snapshot.units.length; right++) boundaries.push(snapshot.units[right].tokenEnd - 1);
    var nextUnits = buildTokenSpanUnits(snapshot.timeline, boundaries);
    // semanticGroupId 必须穿过 snapshot 换入层；否则 display cut 一装载就退化成
    // “每屏各自翻译”，完整语义与短屏又会重新绑死。区间 tokenStart 作为 namespace，
    // 防止不同滑动区间里的 sg0/sg1 相撞。
    var replacementGroupsByEnd = {};
    (replacementCues || []).forEach(function (cue, index) {
      replacementGroupsByEnd[localEnds[index] + 1] = "sem:" + tokenStart + ":" + String(cue.semanticGroupId || "sg" + index);
    });
    nextUnits.forEach(function (unit) {
      if (unit.tokenStart >= tokenStart && unit.tokenEnd <= tokenEnd) {
        unit.semanticGroupId = replacementGroupsByEnd[unit.tokenEnd] || "sem:" + tokenStart + ":sg" + unit.tokenStart;
        return;
      }
      var prior = snapshot.units.find(function (oldUnit) { return oldUnit.tokenStart === unit.tokenStart && oldUnit.tokenEnd === unit.tokenEnd; });
      if (prior && prior.semanticGroupId != null) unit.semanticGroupId = prior.semanticGroupId;
    });

    // 译文继承必须按「词」判定，不能要求 token 跨度逐字节相等。
    //
    // 曾用 oldBySpan[tokenStart+":"+tokenEnd] 精确匹配，但语义恢复的目的**就是
    // 改断句** —— 跨度一变就匹配不上，译文全丢。实测用户轨（BhtgINeaJWg）单次
    // 区间换入丢掉 67.9% 的已翻词，那批单元退回 [未翻译] 后要重新排队再翻一遍，
    // 翻译量凭空翻倍，表现就是「翻译永远追不上播放」。
    //
    // 现在的判据：新单元的 token 跨度若被某条旧译文**完全覆盖**，就继承它。
    // 只有跨越了两条不同旧译文（合并了不同句子）才必须重翻 —— 那时旧译文确实
    // 无法拼接。跨度完全相同是它的一个特例，行为不变。
    var oldByToken = [];
    snapshot.units.forEach(function (unit) {
      var text = snapshot.translations && snapshot.translations[unit.id] || "";
      if (!text) return;
      oldByToken.push({ start: unit.tokenStart, end: unit.tokenEnd, text: text });
    });
    // 两种方向都要处理，否则等于没保留（实测断句变粗时新单元跨越 2 条旧单元，
    // 只做「被包含」判断时命中率为 0，一个词都保不住）：
    //   1. 新单元被某条旧译文完整覆盖 → 直接继承（断句变细，跨度相同是其特例）
    //   2. 新单元由若干条**连续且完整**的旧译文拼成 → 按序拼接
    // 只有边界与旧译文交叉切开（旧句被拦腰截断）时才判定为无法继承，必须重翻 ——
    // 那时旧译文确实对不上新单元的内容。
    function inheritedTranslation(unit) {
      var pieces = [];
      var cursor = unit.tokenStart;
      for (var i = 0; i < oldByToken.length; i++) {
        var old = oldByToken[i];
        if (old.end <= unit.tokenStart || old.start >= unit.tokenEnd) continue;
        // 情形 1：整个新单元落在一条旧译文里
        if (unit.tokenStart >= old.start && unit.tokenEnd <= old.end) return old.text;
        // 情形 2：要求逐段严丝合缝地接上，任何错位都放弃继承
        if (old.start !== cursor || old.end > unit.tokenEnd) return "";
        pieces.push(old.text);
        cursor = old.end;
      }
      // 拼接用已有的语言无关连接器：中日韩等连写文字不插空格，拉丁语族插空格。
      // 不新写一套判定 —— joinRestoredWords 是这件事的唯一权威实现。
      if (pieces.length && cursor === unit.tokenEnd) return joinRestoredWords(pieces);
      return "";
    }
    var nextTranslations = {};
    nextUnits.forEach(function (unit) {
      nextTranslations[unit.id] = inheritedTranslation(unit);
    });
    return createTimelineSnapshot({
      revision: Number(snapshot.revision || 0) + 1,
      videoId: snapshot.videoId,
      trackCode: snapshot.trackCode,
      timeline: snapshot.timeline,
      units: nextUnits,
      translations: nextTranslations,
    });
  }

  function withTimelineTranslations(snapshot, updates) {
    if (!snapshot || !snapshot.timeline || !Array.isArray(snapshot.units)) throw new Error("timeline snapshot required");
    var next = {};
    var current = snapshot.translations || {};
    snapshot.units.forEach(function (unit) {
      var value = Object.prototype.hasOwnProperty.call(updates || {}, unit.id) ? updates[unit.id] : current[unit.id];
      next[unit.id] = String(value == null ? "" : value);
    });
    return createTimelineSnapshot({
      revision: Number(snapshot.revision || 0) + 1,
      videoId: snapshot.videoId,
      trackCode: snapshot.trackCode,
      timeline: snapshot.timeline,
      units: snapshot.units,
      translations: next,
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

  function sameRestoredWords(source, restored) {
    var a = Array.isArray(source) ? source : restoredWords(source);
    var b = restoredWords(restored);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (String(a[i]).toLowerCase() !== String(b[i]).toLowerCase()) return false;
    }
    return true;
  }

  function restoredBoundaryMarks(sourceWords, restored) {
    var words = Array.isArray(sourceWords) ? sourceWords : restoredWords(sourceWords);
    if (!sameRestoredWords(words, restored)) return null;
    var matches = [];
    // 同上:必须与 RESTORE_WORD_RE 同口径,否则连字符复合词会使
    // matches.length 与 words.length 不等,恢复边界被整段丢弃。
    var re = newWordRe();
    var match;
    while ((match = re.exec(String(restored || "")))) matches.push(match);
    if (matches.length !== words.length) return null;
    var marks = [];
    for (var i = 0; i < matches.length; i++) {
      var next = i + 1 < matches.length ? matches[i + 1].index : String(restored || "").length;
      var tail = String(restored || "").slice(matches[i].index + matches[i][0].length, next);
      marks.push(/[.!?]/.test(tail) ? "." : (tail.indexOf("|") >= 0 ? "|" : ""));
    }
    return marks;
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

  // 语义恢复的边界来自模型，但长句 rescue 仍可能在数字/介词/连词处给出
  // 可验证却不适合阅读的边界。这里只合并相邻源 token，绝不改写、重排或删词。
  var CONTINUATION_START_WORDS = {
    from: true, to: true, of: true, in: true, on: true, at: true, with: true, for: true, by: true,
    into: true, over: true, under: true, through: true, throughout: true, during: true, after: true, before: true, without: true,
    up: true, down: true, out: true, off: true, away: true, back: true, around: true, apart: true,
    forward: true, forth: true, ahead: true, along: true, across: true, together: true, aside: true,
    past: true, round: true, behind: true, beyond: true,
    and: true, or: true, but: true, because: true, that: true, which: true, who: true, whose: true,
    when: true, while: true, if: true, than: true, as: true,
  };
  function isContinuationStart(word) {
    return !!CONTINUATION_START_WORDS[String(word || "").toLowerCase()];
  }
  var DANGLING_END_RE = /\b(?:to|of|for|with|from|at|in|on|by|about|into|over|under|between|through|and|or|but|because|that|which|who|whose|when|while|if|than|as|more|less|the|a|an)$/i;
  var NUMBER_END_RE = /(?:^|\s)[+-]?\d[\d,.]*(?:%|[a-z]+)?$/i;
  var NUMBER_WORD_END_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/i;
  var UNIT_START_RE = /^(?:volts?|watts?|amps?|amperes?|hertz|hz|degrees?|celsius|fahrenheit|seconds?|minutes?|hours?|milliseconds?|kilometers?|metres?|meters?|miles?|kilograms?|grams?|pounds?|ohms?|pascals?|psi|newtons?|joules?|kelvin|liters?|litres?|gallons?|inches?|feet|yards?|mph|kph|rpm|decibels?|bytes?|kilobytes?|megabytes?|gigabytes?|terabytes?|percent|dollars?|euros?|yuan)\b/i;
  var MULTIPLIER_END_RE = /\b(?:once|twice|times)$/i;
  var COMPARATIVE_START_RE = /^(?:the|a|an|this|that|these|those|my|our|your|their|his|her|previous|original|more|less|better|worse|faster|slower|higher|lower|larger|smaller|greater|fewer|\w+er)\b/i;
  var REPORTING_CLAUSE_PREFIX_RE = /^(?:let\s+(?:me|us)\s+(?:reiterate|say|note|explain|emphasize|stress|point\s+out|remind\s+you)\s+that|i\s+(?:think|believe|know|mean|guess|suppose)\s+that)\b/i;
  var SUBORDINATE_CLAUSE_PREFIX_RE = /^(?:if|unless|although|though|even\s+if|because|when|while|before|after)\b/i;
  var RELATIVE_SUBJECT_PREFIX_RE = /^(?:the|a|an|this|that|these|those|my|our|your|their|his|her)\b.+\b(?:that|which|who)\b/i;
  var COMPLEMENT_THAT_RE = /\b(?:mean|means|meant|say|says|said|think|thinks|thought|believe|believes|believed|know|knows|knew|show|shows|showed|indicate|indicates|indicated|suggest|suggests|suggested|confirm|confirms|confirmed|ensure|ensures|ensured|explain|explains|explained|report|reports|reported|note|notes|noted)\s+that\b/i;
  var CONTACT_RELATIVE_PRONOUN_RE = /^(?:the|a|an|this|that|these|those|my|our|your|their|his|her)\b.+\b(?:i|we|you|they|he|she)\s+(?:(?:\w+)\s+){0,3}(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i;
  var CONTACT_RELATIVE_PROPER_RE = /^(?:the|a|an|this|that|these|those|my|our|your|their|his|her)\b.+\b[A-Z][a-z]+\s+(?:(?:\w+)\s+){0,3}(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/;
  var MAIN_PREDICATE_START_RE = /^(?:(?:still|also|already|actually|usually|generally|typically|often|sometimes|never|always|then)\s+)?(?!(?:whereas|thus|perhaps|besides|this|these|those|the|a|an|my|our|your|their|his|her|its)\b)(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i;
  // 只识别省略关系代词的 contact clause（如 “camera we tested”）。
  // 显式 that/which/who 从句仍属于主语，不得被 reporting 例外覆盖。
  var EMBEDDED_RELATIVE_PREDICATE_RE = /\b(?:i|we|you|they|he|she)\s+(?:(?:\w+)\s+){0,3}(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i;
  var DETERMINER_END_RE = /\b(?:the|a|an|this|that|these|those|my|our|your|their|his|her)$/i;

  function completedReportingSubjectBoundary(leftText, rightText) {
    if (!REPORTING_CLAUSE_PREFIX_RE.test(leftText) || !MAIN_PREDICATE_START_RE.test(rightText)) return false;
    var tail = leftText.replace(REPORTING_CLAUSE_PREFIX_RE, "").trim();
    return !DETERMINER_END_RE.test(tail) &&
      /^(?:the|a|an|this|that|these|those|my|our|your|their|his|her)\b/i.test(tail) &&
      !RELATIVE_SUBJECT_PREFIX_RE.test(tail) &&
      EMBEDDED_RELATIVE_PREDICATE_RE.test(tail);
  }

  function normalizeBoundaryText(text) {
    return collapseWhitespace(String(text || "")).replace(/[|.!?]+$/g, "");
  }

  function hasFinitePredicateText(text) {
    var value = String(text || "");
    if (/\b(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did)\b/i.test(value)) return true;
    // 并列边界宁可保守：s/ed 也可能是复数名词或分词形容词。只有紧邻 -ly 副词
    // （runs quietly / worked reliably）时才把它当作强谓语证据。
    return /\b\w+(?:s|ed)\s+\w+ly\b/i.test(value);
  }

  function hasComparisonPredicateText(text) {
    return hasFinitePredicateText(text) || /\b\w+(?:s|ed)\b.*\b(?:faster|slower|higher|lower|more|less|better|worse)\b/i.test(String(text || ""));
  }

  function hasExplicitRelativeSubject(text) {
    var value = normalizeBoundaryText(text);
    var complement = value.match(COMPLEMENT_THAT_RE);
    if (!complement) return RELATIVE_SUBJECT_PREFIX_RE.test(value);
    var nested = value.slice((complement.index || 0) + complement[0].length).trim();
    return RELATIVE_SUBJECT_PREFIX_RE.test(nested);
  }

  function isCoordinatedIndependentBoundary(leftText, rightText) {
    var right = normalizeBoundaryText(rightText);
    if (!hasFinitePredicateText(leftText)) return false;
    var pronounClause = /^(?:and|but|or)\s+(?:i|you|he|she|it|we|they|there)\s+(?:(?:still|also|already|actually|usually|generally|typically|often|sometimes|never|always|then)\s+){0,2}(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i.test(right);
    var properClause = /^(?:and|but|or)\s+[A-Z][a-z]+\s+(?:(?:still|also|already|actually|usually|generally|typically|often|sometimes|never|always|then)\s+){0,2}(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/.test(right);
    return pronounClause || properClause;
  }

  function classifySemanticBoundary(leftText, rightText) {
    var left = normalizeBoundaryText(leftText);
    var right = normalizeBoundaryText(rightText);
    if (!left || !right) return { safe: false, reason: "empty-side" };
    var reportingLeft = REPORTING_CLAUSE_PREFIX_RE.test(left);
    var structuralLeft = reportingLeft ? left.replace(REPORTING_CLAUSE_PREFIX_RE, "").trim() : left;
    var lowerInitialStructuralLeft = structuralLeft ? structuralLeft.charAt(0).toLowerCase() + structuralLeft.slice(1) : structuralLeft;
    var contactRelativeSubject = CONTACT_RELATIVE_PRONOUN_RE.test(structuralLeft) || CONTACT_RELATIVE_PROPER_RE.test(lowerInitialStructuralLeft);
    // that 也可能是 means/says/thinks 后的宾语从句引导词；只豁免外层 complement，
    // 继续检查其内部的 “the controller which ...” 显式关系主语。
    var explicitRelativeSubject = hasExplicitRelativeSubject(structuralLeft);
    // 关系主语保护优先于 and/but/or 例外；否则 conjunction 会把仍缺主谓的左屏伪装成完整并列句。
    if (explicitRelativeSubject || (!reportingLeft && contactRelativeSubject)) {
      return { safe: false, reason: "relative-subject-missing-predicate" };
    }
    var first = String(restoredWords(right)[0] || "").toLowerCase();
    // 字幕屏是连续语流，不要求每屏都是脱离上下文的书面句。只有左右均有强谓语证据时，
    // 才允许 and/but/or 开启第二个完整并列分句。
    if (isContinuationStart(first) && !isCoordinatedIndependentBoundary(left, right)) return { safe: false, reason: "continuation-start" };
    if (NUMBER_END_RE.test(left) || (NUMBER_WORD_END_RE.test(left) && UNIT_START_RE.test(right))) return { safe: false, reason: "number-quantity" };
    if (MULTIPLIER_END_RE.test(left) && COMPARATIVE_START_RE.test(right)) return { safe: false, reason: "comparison-continuation" };
    if (DANGLING_END_RE.test(left)) return { safe: false, reason: "dangling-end" };
    if (SUBORDINATE_CLAUSE_PREFIX_RE.test(left)) return { safe: false, reason: "subordinate-clause-missing-main" };
    if (REPORTING_CLAUSE_PREFIX_RE.test(left) && /^(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did)\b/i.test(right)) {
      return { safe: false, reason: "reporting-clause-missing-predicate" };
    }
    return { safe: true, reason: "ok" };
  }

  function unitWordCount(unit) {
    return restoredWords(unit && unit.content).length;
  }

  function mergeNaturalUnits(left, right) {
    var merged = Object.assign({}, left);
    merged.start = Math.min(toInt(left.start, 0), toInt(right.start, 0));
    merged.end = Math.max(toInt(left.end, merged.start), toInt(right.end, merged.start));
    merged.duration = Math.max(0, merged.end - merged.start);
    merged.content = collapseWhitespace(String(left.content || "") + " " + String(right.content || ""));
    if (Array.isArray(left.tokens) || Array.isArray(right.tokens)) {
      merged.tokens = (Array.isArray(left.tokens) ? left.tokens : []).concat(Array.isArray(right.tokens) ? right.tokens : []);
    }
    return merged;
  }

  /**
   * 修复被严格词数 rescue 切坏的英语显示单元：
   * - 小写介词/连词/助动词开头是上句续接；
   * - 小写 1-2 词单元是孤儿，优先回并；
   * - 介词/连词/限定词尾不能悬空。
   * preferredMaxWords 是偏好而非硬断点；为保持自然句界，可合并到 maxNaturalWords。
   */
  function repairNaturalUnitBoundaries(units, opts) {
    opts = opts || {};
    var maxNaturalWords = Math.max(1, Math.floor(Number(opts.maxNaturalWords) || 24));
    var maxVisualWidth = Math.max(12, Math.floor(Number(opts.maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH));
    var maxJoinGapMs = opts.maxJoinGapMs != null ? Math.max(0, Number(opts.maxJoinGapMs)) : 2200;
    var out = [];
    for (var i = 0; i < (units || []).length; i++) {
      var current = Object.assign({}, units[i]);
      if (!current.content) continue;
      // ASR 常漏句号，但保留句首大写。一个单元内出现 “And + 完整主谓” 时，
      // 按 token 时间拆成两个真实 cue，避免把 1800W 与 20A/2400W 偷塞进同一屏。
      var currentWords = restoredWords(current.content);
      var capitalAnd = -1;
      for (var ai = 4; ai < currentWords.length - 4; ai++) {
        if (currentWords[ai] === "And" && /^(?:on|the|a|an|this|that|it|we|you|they|there)$/i.test(currentWords[ai + 1] || "")) { capitalAnd = ai; break; }
      }
      if (capitalAnd > 0 && Array.isArray(current.tokens) && current.tokens.length === currentWords.length) {
        var left = Object.assign({}, current, {
          content: joinRestoredWords(currentWords.slice(0, capitalAnd)),
          tokens: current.tokens.slice(0, capitalAnd),
          end: toInt(current.tokens[capitalAnd - 1].end, current.end),
        });
        left.duration = Math.max(0, left.end - toInt(left.start, 0));
        var right = Object.assign({}, current, {
          content: joinRestoredWords(currentWords.slice(capitalAnd)),
          tokens: current.tokens.slice(capitalAnd),
          start: toInt(current.tokens[capitalAnd].start, left.end),
        });
        right.duration = Math.max(0, toInt(right.end, right.start) - right.start);
        // 这是句内强边界，不再送回“续接词自动合并”，否则 although 又会被并回 And 句。
        out.push(left);
        out.push(right);
        continue;
      }
      var first = currentWords[0] || "";
      var startsContinuation = first === first.toLowerCase() && isContinuationStart(first);
      // despite + being + 过去分词构成可自然译成“尽管受到……”的完整让步字幕片段；
      // 它有自己的非限定谓语，不是需要并回前屏的孤立介词短语。
      if (/^despite\s+being\s+\w+/i.test(String(current.content || "")) && unitWordCount(current) >= 5) startsContinuation = false;
      var isLowercaseOrphan = first === first.toLowerCase() && unitWordCount(current) <= 2;
      var previous = out[out.length - 1];
      var previousTail = previous && DANGLING_END_RE.test(String(previous.content || "").replace(/[.,;:!?]+$/, ""));
      var previousIsSubordinate = previous && SUBORDINATE_CLAUSE_PREFIX_RE.test(normalizeBoundaryText(previous.content));
      var previousIsAndAdverbial = previous && /^And\s+(?:on|in|at|with|for|by)\b/i.test(String(previous.content || "")) && /^\d/.test(String(current.content || ""));
      var isPredicateContinuation = /^(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did)\b/i.test(String(current.content || ""));
      var previousIsReportingUnit = previous && REPORTING_CLAUSE_PREFIX_RE.test(normalizeBoundaryText(previous.content));
      var gapMs = previous ? Math.max(0, toInt(current.start, 0) - toInt(previous.end, 0)) : Infinity;
      var mergedVisualWidth = previous ? semanticDisplayWidth(joinRestoredWords([previous.content, current.content])) : Infinity;
      var sameSemanticGroup = !previous || previous.semanticGroupId == null || current.semanticGroupId == null || previous.semanticGroupId === current.semanticGroupId;
      if (previous && sameSemanticGroup && gapMs <= maxJoinGapMs && (startsContinuation || isLowercaseOrphan || previousTail || previousIsSubordinate || previousIsAndAdverbial) && !(previousIsReportingUnit && isPredicateContinuation) && unitWordCount(previous) + unitWordCount(current) <= maxNaturalWords && mergedVisualWidth <= maxVisualWidth) {
        out[out.length - 1] = mergeNaturalUnits(previous, current);
      } else {
        out.push(current);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * 2. 时间轴清洗
   * ------------------------------------------------------------- */

  /**
   * 对连续字幕单元做小幅视觉尾缩，制造句间消隐空隙。
   * 只改外层 end/duration，保留文本、token 及其它元数据；语义/回退分段共用。
   */
  function applyTailTrim(cues, tailTrimMs) {
    var trim = Number(tailTrimMs);
    if (!(trim > 0)) return (cues || []).map(function (cue) { return Object.assign({}, cue); });
    var minVisibleMs = 300;
    return (cues || []).map(function (cue) {
      var copy = Object.assign({}, cue);
      var start = toInt(copy.start, 0);
      var end = Math.max(start, toInt(copy.end, start));
      if (end - start > trim * 2) {
        var trimmed = Math.max(start + minVisibleMs, end - trim);
        if (trimmed < end) end = trimmed;
      }
      copy.start = start;
      copy.end = end;
      copy.duration = Math.max(0, end - start);
      return copy;
    });
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
      return Math.max(wordCap, Math.floor(visualWidthCap / average));
    }
    var hasExplicitContinuationMaxWords = opts.continuationMaxWords != null;
    var continuationMaxWords = hasExplicitContinuationMaxWords
      ? Math.max(maxWords, Math.floor(Number(opts.continuationMaxWords) || maxWords)) : null;
    var minWords = opts.minWords != null ? opts.minWords : 3;
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
      //    translateClipWithBoundaryRepair 对超限单元直接抛 oversized source unit，
      //    整 clip 变 [未翻译]。所以按「合并逻辑自己允许的最大宽度」兜底拆，
      //    上限口径复用 mergeHardCap（与 orphanCap / continuationCap 同源，
      //    不在这里另算一套，否则两处漂移就是下一个 bug）。
      var wordCap = cur.merged ? (cur.mergeHardCap || maxWords) : maxWords;
      var chunks = splitWordsToCap(cur.words, tokenCapFor(cur.words, wordCap));
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
        var canMerge = !ended || cur.words.length < minWords || orphanPrepMerge;
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
      if (endedNow && curWords >= minWords) {
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
    "你是专业中文字幕翻译。源字幕可以是任意语言。先理解给出的连续语流和上下文，再用自然、准确、简洁的简体中文表达说话者的完整意思。\n" +
    "理解和可读性优先于逐词、逐行对齐；不得遗漏、重复、臆造或把只读上下文的信息提前写入当前译文。\n" +
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
    return preferManualTrack(list, picked);
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
      if (/(?:虽然|尽管|如果|因为|但是|但|可能|以及|而且|所以|就是|从|到|和|与|或|并且)$/.test(s)) {
        return { ok: false, reason: "dangling-tail" };
      }
    }
    return { ok: true, reason: "ok" };
  }

  /** Materialize already-verified 1:1 translations on immutable source cue timing. */
  function buildClipUnits(lines, startMs, endMs, cues, opts) {
    opts = opts || {};
    var list = cues || [];
    var rawLines = lines || [];
    if (rawLines.length !== list.length) throw new Error("translation coverage alignment mismatch");
    return list.map(function (cue, index) {
      var cStart = Number(cue.start);
      var cEnd = Number(cue.end);
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd) || cEnd < cStart) {
        throw new Error("translation coverage cue timing invalid");
      }
      var translation = String(rawLines[index] == null ? "" : rawLines[index]);
      // 运行时 lenient：空译文表示该句回退显示英文原文（parseTranslationCoverageResponse 已把坏句置空）。
      // 导出（lenient=false）时空译文仍是硬错误，成品绝不出现无译文单元。
      if (!translation.trim() && !opts.lenient) throw new Error("translation coverage empty materialized unit");
      return {
        unitId: cue.unitId || "",
        sourceFingerprint: cue.sourceFingerprint || "",
        tokenStart: Number.isInteger(cue.tokenStart) ? cue.tokenStart : null,
        tokenEnd: Number.isInteger(cue.tokenEnd) ? cue.tokenEnd : null,
        srcStart: index + 1,
        srcEnd: index + 1,
        originalText: collapseWhitespace(cue.content || ""),
        translation: translation,
        startMs: cStart,
        endMs: cEnd,
      };
    });
  }

  var DEFAULT_RESTORATION_PROMPT =
    "你是多语言字幕语义边界规划器。源文可能是任意语言；sourceText 是完整连续原文，groups 是按 Unicode 词法边界映射回 canonical token 的原子组。\n" +
    "只决定应在哪些 token 之后结束一个字幕单元；不得回显、改写、添加、删除、合并、拆分或重排任何 token。\n" +
    "只判断完整句、完整分句或自然话语的含义在哪里结束；短屏排版由独立阶段处理。不得在条件与结果、否定范围、因果、转折、指代、短语、修饰关系、数字+单位、专名、URL、复合词或不可分割表达中间结束语义。\n" +
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
  function semanticTokenBudgets(tokens, opts) {
    opts = opts || {};
    var preferredVisualWidth = Math.max(12, Math.floor(Number(opts.preferredVisualWidth) || SOURCE_DISPLAY_PREFERRED_WIDTH));
    var maxVisualWidth = Math.max(preferredVisualWidth, Math.floor(Number(opts.maxVisualWidth) || SOURCE_DISPLAY_MAX_WIDTH));
    var words = (tokens || []).filter(function (t) { return t && String(t.text || "").trim(); });
    if (!words.length) return { preferredTokens: 8, maxTokens: 10, averageVisualWidth: 1, preferredVisualWidth: preferredVisualWidth, maxVisualWidth: maxVisualWidth };
    var joined = joinRestoredWords(words.map(function (t) { return String(t.text); }));
    var average = semanticDisplayWidth(joined) / words.length;
    var preferred = Math.max(6, Math.min(28, Math.floor(preferredVisualWidth / Math.max(1, average))));
    var max = Math.max(8, Math.min(SEMANTIC_MAX_TOKENS, Math.floor(maxVisualWidth / Math.max(1, average))));
    if (max < preferred) max = preferred;
    return { preferredTokens: preferred, maxTokens: max, averageVisualWidth: average, preferredVisualWidth: preferredVisualWidth, maxVisualWidth: maxVisualWidth };
  }

  // 给语义模型看的“词法提示层”。canonical token 仍是唯一时间/覆盖权威；这里仅用
  // 标准 Intl.Segmenter 在重建全文上形成不可切开的候选组，并把每组映射回 canonical
  // token ID。没有 languageCode、脚本名单或逐语言规则；不支持 Segmenter 的运行时则
  // 安全退回一 token 一组。模型只能返回组末 token ID，正文和时间都不能被它改写。
  function semanticPlanningGroups(tokens) {
    var list = (tokens || []).filter(function (t) { return t && String(t.text || "").trim(); });
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
        previous.toId = String(list[previous.tokenEnd - 1].tokenId);
        previous.text = joinRestoredWords(texts.slice(previous.tokenStart, previous.tokenEnd));
        return;
      }
      groups.push({
        fromId: String(list[first].tokenId),
        toId: String(list[last].tokenId),
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

  function tokenWords(tokens) {
    var out = [];
    (tokens || []).forEach(function (t) {
      var words = restoredWords(t && t.text || "");
      for (var i = 0; i < words.length; i++) out.push(words[i]);
    });
    return out;
  }

  function hasNativeTokenTiming(cues, minimumCoverage) {
    var total = 0;
    var timed = 0;
    (cues || []).forEach(function (cue) {
      (cue && cue.tokens || []).forEach(function (token) {
        if (!token || !token.text) return;
        total++;
        if (token.nativeTiming) timed++;
      });
    });
    var min = minimumCoverage == null ? 0.8 : Number(minimumCoverage);
    return total > 0 && timed / total >= min;
  }

  // 语义恢复一次处理多少播放时间。
  //
  // 取值依据（37 分钟真实轨实测，6257 token / 单块 16.4s）：
  // 旧的整轨一次性恢复 = 35 块 ≈ 9.5 分钟，期间预取被降级 → 翻译永远追不上播放；
  // 且无论用户看多久都要先付满 35 块。
  //
  // 改为按播放位置滑动后，区间长度的取舍（数字为模型块数，35 = 旧实现基线）：
  //        看1min  看5min  看10min  看全片
  //   90s     4       8       16       47
  //   120s    3       8       16       42
  //   180s    4      11       14       40
  //   300s    6      11       16       37
  // 取 120s：短时长观看（占绝大多数）最省或持平，看全片也只比 180s 多 5%。
  // 区间边界会切出零头块，因此看全片比整轨基线多约 20% —— 这是换取
  // 「按需付费 + 全程跟得上」的代价，短观看的节省远大于它（看 5 分钟 = 旧的 23%）。
  //
  // 单次恢复 3 块 ≈ 49s，覆盖 120s 播放 → 恢复速度约为播放速度的 2.4 倍，
  // 足以持续领先播放。
  // 首个区间的跨度。取 36s ≈ 一个预取窗口（当前段 + 3 段 × 12s）：
  // 刚好铺满开场预取需要的范围，实测恢复约 6s 完成，不让翻译干等。
  var SEMANTIC_FIRST_INTERVAL_MS = 36000;
  var SEMANTIC_INTERVAL_MS = 120000;

  /**
   * 选出「该恢复哪一段」—— 语义恢复的滑动窗口。
   *
   * 为什么不整轨恢复：整轨要 9.5 分钟（实测），期间无论怎么调度都跟不上播放，
   * 而且无论用户看多久都要为全部 35 块付 token。按播放位置滑动后，
   * token 消耗正比于实际观看时长，且每一段仍是 semantic 断句（质量不降）。
   *
   * 区间必须定义在 **timeline snapshot 的 units 下标空间**上，而不是原始轨 cue 上。
   * 原因（实测踩过，browser-replay 报 replacement token coverage mismatch）：
   * 原始轨 cue 与 snapshot units 是两套下标 —— snapshot 由 fallback 重组产生
   * （197 条原始 cue → 150 条 fallback 单元），拿原始轨下标去调
   * resegmentTimelineSnapshot 会取到完全不同的 token 跨度。
   *
   * 送模型的词流直接取自 snapshot.timeline.tokens 的对应跨度，
   * 与替换校验用的是同一份 token —— 覆盖校验因此天然成立。
   *
   * 返回 { startIndex, endIndex, tokens }（下标为 snapshot.units 下标，
   * endIndex 为开区间）；无可恢复区间时返回 null。
   */
  function planSemanticInterval(snapshot, positionMs, opts) {
    opts = opts || {};
    if (!snapshot || !snapshot.timeline || !Array.isArray(snapshot.units)) return null;
    var units = snapshot.units;
    var tokens = snapshot.timeline.tokens || [];
    if (!units.length || !tokens.length) return null;
    var pos = Number(positionMs);
    if (!Number.isFinite(pos)) pos = 0;
    var spanMs = Number(opts.intervalMs);
    if (!Number.isFinite(spanMs) || spanMs <= 0) {
      // 首个区间刻意更短。
      //
      // 翻译不得越过恢复边界（否则跨边界译文作废重翻），所以开场时预取会一直等
      // 恢复铺路。若首个区间就取满 120s，实测要 31s 才恢复完，这段时间预取被卡在
      // 当前段，真机覆盖率从 93.6% 掉到 83.4%（比不截断更差）。
      //
      // 首屏只需要够用的一小段：实测前 26s（47 token）恢复仅 5.7s，之后恢复以
      // 3.5x 播放速度持续领先，再用满长度区间摊薄每块开销。
      spanMs = pos <= 0 ? SEMANTIC_FIRST_INTERVAL_MS : SEMANTIC_INTERVAL_MS;
    }

    // 起点：当前播放位置所在（或之后的第一个）单元。
    var startIndex = -1;
    for (var i = 0; i < units.length; i++) {
      if (Number(units[i].endMs) > pos) { startIndex = i; break; }
    }
    if (startIndex < 0) return null;

    // 终点：覆盖到起点 + spanMs 为止，且至少含一个单元。
    var limit = Number(units[startIndex].startMs) + spanMs;
    var endIndex = startIndex + 1;
    while (endIndex < units.length && Number(units[endIndex].startMs) < limit) endIndex++;

    var tokenStart = units[startIndex].tokenStart;
    var tokenEnd = units[endIndex - 1].tokenEnd;
    var slice = tokens.slice(tokenStart, tokenEnd);
    if (!slice.length) return null;
    return { startIndex: startIndex, endIndex: endIndex, tokens: slice };
  }

  // JSON3 滚动 event 常会把上一 event 的尾词重复一次。先在严格的词流层
  // 去重，模型看到的才是一条连续语音，而不是 ASR 事件碎片的拼接。
  function collectSemanticTokens(cues) {
    var out = [];
    (cues || []).forEach(function (cue) {
      var next = (cue && cue.tokens || []).filter(function (t) { return t && t.text; });
      var max = Math.min(out.length, next.length, 8);
      var cut = 0;
      for (var k = max; k >= 1; k--) {
        var same = true;
        for (var i = 0; i < k; i++) {
          if (String(out[out.length - k + i].text).toLowerCase() !== String(next[i].text).toLowerCase()) { same = false; break; }
        }
        if (same) { cut = k; break; }
      }
      for (var j = cut; j < next.length; j++) out.push(next[j]);
    });
    return out;
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

  // 以下旧边界判据只供历史诊断测试；生产 semantic 路径不再调用它们。
  // 模型偶尔会给出 "boiling water | than this ..."；删掉这个坏边界后，
  // 同一句仍可保留前面的自然 14/20 分屏，而不是整句退化成 34 词。
  // flow 模式(整轨首遍)只保留破坏词法绑定的硬否决:数字+单位、比较结构。
  // 字幕是连续语流,一屏以介词/连词/从句引导词开头是自然的,首遍必须信任模型
  // 已遵守短语规则的分屏,不能用「每屏都要是独立完整句」的从句级判据整屏否决。
  var FLOW_INTEGRITY_REASONS = { "number-quantity": true, "comparison-continuation": true };
  function filterUnsafeRescueMarks(words, marks, opts) {
    opts = opts || {};
    var flowMode = opts.mode === "flow";
    var out = (marks || []).slice();
    // 先按「原始」边界布局判定全部,再统一应用。绝不读一个改到一半的数组:
    // 边删边读时,删掉一个边界会撑大相邻边界的左右跨度,级联把每个边界都删光。
    var drop = [];
    for (var i = 0; i < out.length - 1; i++) {
      if (out[i] !== "|" && out[i] !== ".") continue;
      var leftStart = 0;
      for (var p = i - 1; p >= 0; p--) {
        if (out[p] === "|" || out[p] === ".") { leftStart = p + 1; break; }
      }
      var rightEnd = words.length;
      for (var n = i + 1; n < out.length; n++) {
        if (out[n] === "|" || out[n] === ".") { rightEnd = n + 1; break; }
      }
      var leftText = words.slice(leftStart, i + 1).join(" ");
      var rightText = words.slice(i + 1, rightEnd).join(" ");
      var verdict = classifySemanticBoundary(leftText, rightText);
      // Reporting 例外只允许“... get my hands on | 主谓”这种已完成修饰链的边界。
      // 不能泛化放过“... adapter | I could get ...”等仍悬空的名词短语。
      var reportingPrefix = REPORTING_CLAUSE_PREFIX_RE.test(leftText);
      var reportingObjectBoundary = completedReportingSubjectBoundary(leftText, rightText);
      var reportingTail = reportingPrefix ? leftText.replace(REPORTING_CLAUSE_PREFIX_RE, "") : "";
      var reportingHasPredicate = MAIN_PREDICATE_START_RE.test(reportingTail) ||
        /\b(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i.test(reportingTail);
      var naturalDespite = /^despite\s+being\s+\w+/i.test(rightText) && restoredWords(rightText).length >= 5;
      var clauseDrop = reportingPrefix && !reportingHasPredicate && !reportingObjectBoundary;
      var verdictDrop = !verdict.safe && !naturalDespite && !reportingObjectBoundary;
      if (!clauseDrop && !verdictDrop) continue;
      if (flowMode) {
        // 首遍信任模型的从句级分屏;仅当切分破坏 number+unit / 比较结构等硬绑定才否决。
        if (clauseDrop) continue;
        if (!FLOW_INTEGRITY_REASONS[verdict.reason]) continue;
      }
      drop.push(i);
    }
    for (var d = 0; d < drop.length; d++) out[drop[d]] = "";
    return out;
  }

  // 连续语流保底切分:当 strict DP 找不到「书面完整句」切点时,用与整轨首遍相同的
  // flow 判据强制把过长单元切到硬上限内。连续字幕本就靠介词/连词/从句引导承接,
  // 一个 13-14 词从句找不到 strict 安全点不该让整轨作废——但绝不在破坏词法硬绑定
  // (number+unit、比较结构、数字)处下刀。只在已验证的原始 token 词边界放 |,不改正文。
  // token 空间保底切分:切点只能落在 token 之间(| 放在某 token 之后),屏长按该屏
  // 内各 token 的词数之和度量。返回数组长度 == token 数,与全系统 marks 契约一致。
  // 入参:tokWordCounts[i] = 第 i 个 token 的词数;tokTexts[i] = 该 token 文本。
  function forceFlowPartition(tokWordCounts, tokTexts, hard, preferred) {
    var T = (tokWordCounts || []).length;
    var out = new Array(T).fill("");
    var total = 0;
    for (var a = 0; a < T; a++) total += tokWordCounts[a];
    if (total <= hard) return out;
    var target = Math.max(1, Math.min(hard, preferred || hard));
    // 累计词数,用于把「理想词位置」映射到 token 边界。
    var cum = new Array(T + 1).fill(0);
    for (var b = 0; b < T; b++) cum[b + 1] = cum[b] + tokWordCounts[b];
    var joinText = function (s, e) { // tokens[s..e) 的文本(词级)拼接
      var parts = [];
      for (var t = s; t < e; t++) parts.push(String(tokTexts[t] || ""));
      return parts.join(" ");
    };
    var runStartTok = 0;
    while (cum[T] - cum[runStartTok] > hard) {
      var baseWords = cum[runStartTok];
      var aimWords = baseWords + target;
      // 该屏最远只能到 hard 词:找满足「起点到该 token 末尾词数 <= hard」的最大 token 边界。
      var maxTok = runStartTok;
      while (maxTok < T && cum[maxTok + 1] - baseWords <= hard) maxTok++;
      if (maxTok <= runStartTok) maxTok = runStartTok + 1; // 单 token 已超 hard,只能整块留
      // 在 [runStartTok+1, maxTok] 里挑不破坏硬绑定、且离 aimWords 最近的 token 边界。
      var chosen = -1, bestDist = Infinity;
      for (var cut = runStartTok + 1; cut <= maxTok && cut < T; cut++) {
        var verdict = classifySemanticBoundary(joinText(runStartTok, cut), joinText(cut, T));
        if (FLOW_INTEGRITY_REASONS[verdict.reason]) continue; // 破坏词法硬绑定,跳过
        var dist = Math.abs(cum[cut] - aimWords);
        if (dist < bestDist) { bestDist = dist; chosen = cut; }
      }
      // 整段都是硬绑定找不到安全边界:退到 maxTok(守住不超 hard),但至少切一个 token。
      if (chosen < 0) chosen = Math.min(maxTok, T - 1);
      if (chosen <= runStartTok || chosen >= T) break;
      out[chosen - 1] = "|"; // | 放在第 (chosen-1) 个 token 之后
      runStartTok = chosen;
    }
    return out;
  }

  /**
   * 对已确认过长的单句做确定性显示分区。候选只能来自已验收的模型 |，或两类
   * 可验证的连续字幕边界：长主语→限定谓语、完整主句→despite being 让步附加语。
   * 动态规划有界于 O(n * hardWords)，无额外模型调用；找不到全程安全路径就返回 null。
   */
  // 在 token 空间做确定性显示分区。切点只落在 token 之间;屏长按屏内各 token 的词数
  // 之和度量(一个 ASR token 可能含多词,如 ".And"、"boily pory")。marks 与返回值都
  // 按 token 索引(长度 == token 数),与 packRestoredTokens 的 marks.length===token 数
  // 契约一致——绝不能用词级长度返回,否则多词 token 会让写回越界撑长整条 marks。
  function partitionReadableTokenUnit(tokens, marks, opts) {
    opts = opts || {};
    var toks = tokens || [];
    var T = toks.length;
    var preferred = Math.max(1, Math.floor(Number(opts.preferredWords) || 14));
    var hard = Math.max(preferred, Math.floor(Number(opts.hardWords) || 16));
    var min = Math.max(1, Math.min(hard, Math.floor(Number(opts.minWords) || 6)));
    // 每个 token 的词数(权重)与文本;累计词数 cum 用于按词度量屏长。
    var wc = new Array(T);
    var txt = new Array(T);
    var totalWords = 0;
    for (var ti = 0; ti < T; ti++) {
      var tw = restoredWords(toks[ti] && toks[ti].text || "");
      wc[ti] = tw.length;
      txt[ti] = tw.join(" ");
      totalWords += tw.length;
    }
    if (!T || totalWords <= hard) return (marks || []).slice();
    var sourceMarks = (marks || []).slice();
    while (sourceMarks.length < T) sourceMarks.push("");
    var cum = new Array(T + 1).fill(0);
    for (var ci = 0; ci < T; ci++) cum[ci + 1] = cum[ci] + wc[ci];
    var joinTok = function (s, e) { // tokens[s..e) 的词级文本
      var parts = [];
      for (var t = s; t < e; t++) parts.push(txt[t]);
      return parts.join(" ");
    };
    // 候选切点 = token 边界 c(| 放在第 c-1 个 token 后,屏为 tokens[start..c))。
    var candidates = {};
    for (var i = 1; i < T; i++) {
      if (sourceMarks[i - 1] === "|") candidates[i] = 0;
      var left = joinTok(0, i);
      var right = joinTok(i, T);
      var leftWordCount = cum[i];
      var reportingMatch = left.match(REPORTING_CLAUSE_PREFIX_RE);
      var progressiveReportingIntro = leftWordCount >= min && reportingMatch &&
        normalizeBoundaryText(left).toLowerCase() === normalizeBoundaryText(reportingMatch[0]).toLowerCase();
      var longSubjectPredicate = leftWordCount >= min && completedReportingSubjectBoundary(left, right);
      var trailingAdjunct = leftWordCount >= min && /^(?:despite\s+being|although|though|even\s+(?:during|after|before)|during|after|before)\b/i.test(right) &&
        hasComparisonPredicateText(left);
      var coordinatedClause = leftWordCount >= min && isCoordinatedIndependentBoundary(left, right);
      if (progressiveReportingIntro || longSubjectPredicate || trailingAdjunct || coordinatedClause) {
        var penalty = longSubjectPredicate ? 1 : (progressiveReportingIntro || coordinatedClause ? 2 : 3);
        if (candidates[i] == null || penalty < candidates[i]) candidates[i] = penalty;
      }
    }
    // DP over token 边界;屏长以词数(cum[end]-cum[start])度量,超 hard 词的段禁止。
    var dp = new Array(T + 1).fill(null);
    dp[0] = { score: 0, prev: -1 };
    for (var end = 1; end <= T; end++) {
      if (end !== T && candidates[end] == null) continue;
      for (var start = 0; start < end; start++) {
        if (!dp[start]) continue;
        var wlen = cum[end] - cum[start];
        if (wlen > hard) continue; // 屏词数不得超硬上限
        if (wlen < min && end !== T) continue;
        var shortNaturalTail = end === T && wlen >= 3 &&
          /^despite\s+being\s+\w+/i.test(joinTok(start, end));
        if (end === T && wlen < min && start !== 0 && !shortNaturalTail) continue;
        var boundaryPenalty = end === T ? 0 : candidates[end];
        var score = dp[start].score + Math.pow(wlen - preferred, 2) + boundaryPenalty;
        if (!dp[end] || score < dp[end].score) dp[end] = { score: score, prev: start };
      }
    }
    var cuts = [];
    var dpOk = !!dp[T];
    if (dpOk) {
      for (var at = T; at > 0;) {
        var prev = dp[at].prev;
        if (prev < 0) { dpOk = false; break; }
        if (at < T) cuts.push(at);
        at = prev;
      }
    }
    // strict DP 找不到全程「书面完整句」路径时,不返回 null 让整轨作废;改用 token 空间
    // 保底切分切到硬上限内(保留原句末 . 边界)。返回长度恒为 T。
    if (!dpOk) {
      var forced = forceFlowPartition(wc, txt, hard, preferred);
      for (var si = 0; si < T; si++) if (sourceMarks[si] === ".") forced[si] = ".";
      return forced;
    }
    var out = sourceMarks.map(function (m) { return m === "." ? "." : ""; });
    cuts.forEach(function (cut) { out[cut - 1] = "|"; });
    return out;
  }

  // 只重切「真正超长的单个屏」,绝不因局部一处超长而重排整轨。修复单位是屏
  // (相邻两个已确认边界 |/. 之间的 token 段),不是「句子」——模型只产出 |、从不
  // 产出句末 .,若按 . 分句会把整轨当成一个巨句,任一处漏切就触发整段 forceFlow
  // 均匀硬切,抹平模型给出的全部自然边界(这正是完整轨退化成 95% 均匀 10 词屏的根因)。
  // 每个屏的长度按其 token 的词数之和度量;仅超 hard 词的屏才交给 partitionReadableTokenUnit
  // 细分,其余屏的模型边界原样保留。
  function normalizeOversizeSentenceMarks(tokens, marks, opts) {
    opts = opts || {};
    var out = (marks || []).slice();
    var hard = Math.max(1, Math.floor(Number(opts.hardWords) || 16));
    var wordsOf = function (t) { return restoredWords(t && t.text || "").length; };
    var segStart = 0;
    for (var i = 0; i <= out.length; i++) {
      var isBoundary = i === out.length || out[i] === "|" || out[i] === ".";
      if (!isBoundary) continue;
      var segEnd = i < out.length ? i + 1 : out.length; // 含边界 token
      if (segEnd <= segStart) { segStart = segEnd; continue; }
      var segWords = 0;
      for (var j = segStart; j < segEnd; j++) segWords += wordsOf(tokens[j]);
      if (segWords > hard) {
        // 只把这个超长屏交给 partition 细分;它在 token 空间工作,返回长度 == 段 token 数。
        var outerBoundary = out[segEnd - 1]; // 段末已确认边界(|/.),partition 会清掉,需恢复
        var local = partitionReadableTokenUnit(tokens.slice(segStart, segEnd), out.slice(segStart, segEnd), opts);
        if (local) {
          for (var k = 0; k < local.length; k++) out[segStart + k] = local[k];
          // partition 不在末位设边界,恢复本段与下一段之间的原始边界,避免两段被 pack 合并。
          if (outerBoundary === "|" || outerBoundary === ".") out[segEnd - 1] = outerBoundary;
        }
      }
      segStart = segEnd;
    }
    return out;
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
    restored.marks = enforceVisualDisplayMarks(restored.tokens, restored.marks, maxVisualWidth);
    var units = packRestoredTokens(restored.tokens, restored.marks, { maxWords: maxWords });
    for (var ri = 0; ri < units.length; ri++) {
      var finalWords = unitWordCount(units[ri]);
      var finalWidth = semanticDisplayWidth(units[ri].content);
      if (finalWords > SEMANTIC_MAX_TOKENS || finalWidth > maxVisualWidth) {
        throw new Error("unresolved oversized semantic unit: " + finalWords + " tokens / " + finalWidth + " width");
      }
    }
    return units;
  }

  function translationCoverageUnitsFromCues(cues) {
    var cursor = 0;
    return (cues || []).map(function (cue, index) {
      var count = Math.max(1, tokenWords(cue && cue.tokens || []).length || restoredWords(cue && cue.content || "").length);
      var start = Number.isInteger(cue && cue.tokenStart) ? cue.tokenStart : cursor;
      var end = Number.isInteger(cue && cue.tokenEnd) ? cue.tokenEnd : start + count;
      cursor = end;
      return {
        unitId: String(cue && cue.unitId || "clip:u" + index + ":" + start + "-" + end),
        tokenStart: start,
        tokenEnd: end,
        sourceText: collapseWhitespace(cue && cue.content || ""),
        sourceFingerprint: String(cue && cue.sourceFingerprint || ""),
        maxVisualWidth: Math.max(1, Math.floor(Number(cue && cue.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH)),
        semanticGroupId: String(cue && cue.semanticGroupId != null ? cue.semanticGroupId : "sg" + index),
      };
    });
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

  function parseTranslationCoverageResponse(raw, expectedUnits, opts) {
    opts = opts || {};
    var payload = extractJsonObject(raw, "translations");
    if (!payload) throw new Error("translation coverage invalid JSON");
    if (typeof payload !== "object" || Array.isArray(payload)) throw new Error("translation coverage response must be an object");
    // 顶层只要求 translations 存在且是数组。
    //
    // 此前要求「顶层恰好只有 translations 一个键」，于是模型顺手带个 usage/notes
    // 就整块拒绝（约 32 秒字幕全丢）。廉价模型加解释字段是高频行为，而多余的顶层
    // 字段对承重的覆盖账本没有任何影响 —— 拒绝它纯属自伤。
    // 真正承重的（数量、unitId 存在性、无重复、无缺口）在下面逐条 fail-closed。
    if (!Array.isArray(payload.translations)) {
      throw new Error("translation coverage response must contain only translations");
    }
    var expected = (expectedUnits || []).map(function (unit) {
      return {
        unitId: String(unit && unit.unitId || ""),
        tokenStart: Number(unit && unit.tokenStart),
        tokenEnd: Number(unit && unit.tokenEnd),
        // sourceText 必须带下来:译文合规性要对照原文判断(见 validateChineseDisplayUnit)。
        // 此前这里只挑了 unitId/tokenStart/tokenEnd,原文被丢掉 → 校验侧永远拿到
        // undefined,只能按「整句结尾」严格判,把句中切开的正确译文judge成违规。
        sourceText: String(unit && unit.sourceText || ""),
        maxVisualWidth: Math.max(1, Math.floor(Number(unit && unit.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH)),
        semanticGroupId: String(unit && unit.semanticGroupId != null ? unit.semanticGroupId : ""),
      };
    });
    var expectedById = {};
    var previousEnd = null;
    expected.forEach(function (unit) {
      if (!unit.unitId || !Number.isInteger(unit.tokenStart) || !Number.isInteger(unit.tokenEnd) || unit.tokenStart < 0 || unit.tokenEnd <= unit.tokenStart) {
        throw new Error("translation coverage expected unit invalid");
      }
      if (expectedById[unit.unitId]) throw new Error("translation coverage duplicate expected unit");
      if (previousEnd != null && unit.tokenStart !== previousEnd) throw new Error("translation coverage expected units have gap or overlap");
      previousEnd = unit.tokenEnd;
      expectedById[unit.unitId] = unit;
    });
    if (payload.translations.length !== expected.length) throw new Error("translation coverage incomplete unit count");
    var translatedById = {};
    payload.translations.forEach(function (item) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("translation coverage entry invalid");
      // 未知字段忽略，不拒绝。
      //
      // 此前是白名单 + 「出现名单外字段就整块抛错」，于是模型加个 notes/confidence
      // 就丢掉整块 32 秒字幕。承重的是 unitId 能否对上程序侧账本，多余字段无害。
      // 弱模型还会把 translation 写成 text/content/translatedText（真实 gpt-5.4-mini
      // 已见 text），所以译文字段名放宽为别名集合，但必须恰好给一个，避免两套文本。
      var textFields = ["translation", "text", "content", "translatedText"].filter(function (k) { return item[k] != null; });
      if (textFields.length !== 1 || item.unitId == null) throw new Error("translation coverage entry fields invalid");
      var unitId = String(item.unitId || "");
      var source = expectedById[unitId];
      if (!source || translatedById[unitId]) throw new Error("translation coverage unknown or duplicate unit");
      // coverFrom/coverTo 不再要求模型回抄 —— 范围由程序侧账本唯一决定（unitId 已编码它）。
      // 但只要模型主动给了，就必须与账本一致：给错说明它在按自己的理解重新划分覆盖，
      // 那正是 v0.9.0 要根除的病灶，必须 fail-closed 而不是默默忽略。
      // 逐字段独立校验：给了哪个就验哪个。不能要求「两个都给」——弱模型只给
      // coverTo 时本无害（范围仍由账本决定），要求成对会把它误判成 span mismatch。
      if (item.coverFrom != null && (!Number.isInteger(item.coverFrom) || item.coverFrom !== source.tokenStart)) {
        throw new Error("translation coverage span mismatch");
      }
      if (item.coverTo != null && (!Number.isInteger(item.coverTo) || item.coverTo !== source.tokenEnd)) {
        throw new Error("translation coverage span mismatch");
      }
      // 结构性违规（JSON 形状 / 字段 / unitId / span / 数量 / 缺口重叠）永远 fail-closed——它们是协议漂移。
      // 但单个单元的“内容”问题（空译文 / 中文单元不合规）在 lenient（运行时）模式下只把该条译文置空
      // （= 该句回退显示英文原文），保留同 clip 其余合规译文，避免一句坏译文连坐整组 clip 全丢。
      // opts.lenient=false（默认，导出 SRT 用）时仍严格 throw，成品绝不半英文半中文。
      var translation = sanitizeSubtitleLine(String(item[textFields[0]] == null ? "" : item[textFields[0]]));
      var contentError = "";
      if (!translation.trim()) {
        contentError = "translation coverage empty translation";
      } else {
        // 该句是否在本屏之后继续。判据只看**本单元原文自身**是否以终止标点收尾:
        // 没有终止标点 = 整句还没说完,此时忠实译文断在句中是正确的。
        //
        // 不能用「本 clip 内是否还有下一单元」来判断:clip 是按时间切的,
        // 一句话完全可能跨 clip —— 首 clip 末条原文 "...for lots of reasons,"
        // 正是这种情况(实测该条被误杀 2/3 次)。也不能只看原文末字符是否逗号:
        // 原文可能以单词结尾却仍未说完(如 "...want to do with")。
        var srcText = String(source.sourceText == null ? "" : source.sourceText).trim();
        var sourceIndex = expected.findIndex(function (unit) { return unit.unitId === source.unitId; });
        var continuesWithinSemanticGroup = sourceIndex >= 0 && sourceIndex + 1 < expected.length && expected[sourceIndex + 1].semanticGroupId === source.semanticGroupId;
        var midSentence = continuesWithinSemanticGroup || (srcText ? !/[.!?。！？…]["'”’)\]]?$/.test(srcText) : false);
        var verdict = validateChineseDisplayUnit(translation, {
          sourceText: source.sourceText,
          continues: midSentence,
          // 宽度不是 coverage ledger 的职责。ledger 只校验结构、覆盖和基本语言合规；
          // 过宽译文交给后续分屏层切开，否则弱模型偶发长句会连坐整 clip 失败。
          maxVisualWidth: Number.MAX_SAFE_INTEGER,
        });
        if (!verdict.ok) contentError = "translation coverage invalid Chinese unit: " + verdict.reason;
      }
      if (contentError) {
        if (!opts.lenient) throw new Error(contentError);
        translation = ""; // 运行时：该单元回退英文，不连坐整个 clip
      }
      translatedById[unitId] = {
        unitId: unitId,
        coverFrom: source.tokenStart,
        coverTo: source.tokenEnd,
        translation: translation,
      };
    });
    return expected.map(function (unit) {
      if (!translatedById[unit.unitId]) throw new Error("translation coverage missing unit: " + unit.unitId);
      return translatedById[unit.unitId];
    });
  }

  /** Translate one immutable token-span clip with an exact coverage ledger. */
  async function translateClipLines(opts) {
    opts = opts || {};
    var cues = opts.cues || [];
    if (!cues.length) return [];
    var units = translationCoverageUnitsFromCues(cues);
    var fingerprints = {};
    units.forEach(function (unit) { if (unit.sourceFingerprint) fingerprints[unit.sourceFingerprint] = true; });
    if (Object.keys(fingerprints).length > 1) throw new Error("translation coverage source fingerprint mismatch");
    // 发给模型的字段只保留「它翻译时真正需要的信息」：哪个单元 + 原文。
    //
    // 此前还发了 coverFrom/coverTo、maxVisualWidth、semanticGroupId，实测占 user
    // payload 的 45.9%，且三者全是冗余：
    //  - coverFrom/coverTo 已编码在 unitId 尾部（"clip:u0:0-8" → 0-8），程序自己能推；
    //    让模型回抄反而制造了一整类失败（弱模型抄 12 组数字必错 → span mismatch 整块丢）。
    //  - maxVisualWidth 全单元恒定，且宽度是显示层职责，不该进翻译请求。
    //  - semanticGroupId 与单元序号 1:1，不携带分组信息；parser 判断句子是否跨屏延续
    //    读的是**程序侧** expectedUnits 的该字段，与发不发给模型无关。
    //
    // 覆盖账本的承重点是「程序定账本」，不是「模型抄账本」——校验一条不减。
    var sys = buildSystemPrompt(opts.targetLang, opts.systemPrompt) +
      "\n协议硬约束：只返回 {\"translations\":[{\"unitId\":\"…\",\"translation\":\"…\"}]}；" +
      "unitId 必须原样复制，每个输入单元恰好一条，不多不少，不要输出其他字段。";
    var userContent = JSON.stringify({
      sourceFingerprint: Object.keys(fingerprints)[0] || "",
      maxVisualWidth: units[0] && units[0].maxVisualWidth || TRANSLATION_DISPLAY_MAX_WIDTH,
      units: units.map(function (unit) {
        return { unitId: unit.unitId, sourceText: unit.sourceText };
      }),
    });
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
      onUsage: opts.onUsage,
      signal: opts.signal,
    });
    var coverage = parseTranslationCoverageResponse(content, units, { maxLineChars: opts.maxLineChars, lenient: !!opts.lenient });
    var lines = coverage.map(function (entry) { return entry.translation; });
    Object.defineProperty(lines, "coverage", { value: coverage, enumerable: false });
    return lines;
  }

  async function translateClipWithBoundaryRepair(opts) {
    opts = opts || {};
    var cues = (opts.cues || []).slice();
    if (!cues.length) return { cues: [], lines: [], coverage: [], repaired: false };
    // 输入卫士只保护模型容量；显示质量由 semanticTokenBudgets + 装载门禁负责。
    // 两者共用 12/14 会把“英文词数”重新变成所有语言的模型输入限制。
    var maxSourceWords = SEMANTIC_MAX_TOKENS;
    for (var i = 0; i < cues.length; i++) {
      var sourceWords = unitWordCount(cues[i]);
      if (sourceWords > maxSourceWords) throw new Error("oversized source unit before translation: " + sourceWords + " words (cap " + maxSourceWords + ")");
    }
    var lines = await translateClipLines(Object.assign({}, opts, { cues: cues, lenient: !!opts.lenient }));
    if (lines.length !== cues.length || !Array.isArray(lines.coverage) || lines.coverage.length !== cues.length) {
      throw new Error("translation coverage alignment mismatch");
    }
    return { cues: cues, lines: lines, coverage: lines.coverage, repaired: false };
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
    "同一源 cue 范围不得翻译两次，不得返回两个 screen 覆盖同一段原文；如果一句话需要两屏，必须把源 cue 范围也切成前后两段。\n" +
    "目标 12-24 个汉字，但这是排版目标而非删减理由 —— 意思单元超长也要完整写出，宁可该屏偏长，绝不省略；" +
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
  var BLOCK_CONTRACT_VERSION = "block-v9";

  var BLOCK_SEGMENT_MAX_GAP_MS = 750;
  var BLOCK_MIN_DISPLAY_MS = 300;
  // 阅读速度上限，来自 Netflix Timed Text Style Guide（简体中文，成人节目 9 字/秒）。
  // https://partnerhelp.netflixstudios.com/hc/en-us/articles/215986007
  // 换算成每字最少显示毫秒数：1000/9 ≈ 111ms。此前代码里用过 180ms/字（5.5 字/秒）
  // 的自拟值，把合格的屏也算成读不完（实测同一批数据 17 屏 vs 4 屏），故以行业标准为准。
  var READING_MS_PER_CHAR = Math.ceil(1000 / 9);
  var BLOCK_MAX_LINES_PER_SEGMENT = 64;

  /**
   * 一段源时长最多装几屏。
   *
   * 这个上限的作用是拦「模型把几十屏塞进一秒语音」，那是协议违规。
   * 但它一度还会在源时长不足一屏（<300ms）时抛错 —— 那是把**源数据事实**
   * 当协议违规处理，代价极不对称：逐 cue 覆盖后一个 segment 只覆盖一条 cue，
   * 于是任何一条 200ms 的短 cue 都会让整块（约 32 秒字幕）翻译失败。
   * CI 全轨实测 7/50 块因此整块丢字幕，而短 cue 在真实 ASR 轨里完全正常。
   *
   * 所以下限恒为 1：短 cue 允许出一屏，读不完由时间层解决（借静音、
   * 与相邻屏合并）—— 那才是可读性该待的地方。真正的越界（屏数多于时长
   * 能装下的）仍然 fail-closed。
   */
  function maxBlockDisplayLines(activeMs) {
    var byTime = Math.floor(Math.max(0, Number(activeMs) || 0) / BLOCK_MIN_DISPLAY_MS);
    return Math.min(BLOCK_MAX_LINES_PER_SEGMENT, Math.max(1, byTime));
  }

  /**
   * 中文定语/状态标记不得留在屏尾而把被修饰成分甩到下一屏。
   *
   * 真实缺陷样本（日语人工轨 300s 内 5 处，约 10% 相邻屏对）：
   *   「各处都饰有凤凰的」→「徽章」
   *   「关上车门后，外面的」→「声音就会被隔绝」
   * 这类断法在中文里明确是错的：读到屏尾时修饰语悬空，观众必须等下一屏才能成句。
   *
   * 判据是目标语言（中文输出）特性，不是源语言特性 —— 与既有设计一致：
   * 只允许对目标语言和 Unicode 书写系统属性做处理，绝不引入源语言名单。
   *
   * 只对**非末行**生效。末行以「的」结尾通常是合法句末语气（「据说就是这样完成的」），
   * 同理「的」后紧跟标点说明该屏已是完整小句。早先一版检测器没区分这两种情况，
   * 在真实产出上产生了 4/9 的假阳性，因此这里的边界条件本身就是回归测试的一部分。
   *
   * prompt 里已写明"不得把词、词组拆到两屏"并额外点明助词不得收尾，实测把英语首次
   * 通过率提到 10/10，但**不能只靠 prompt**：日语真实轨上仍有块连续 6 次都这样断
   * （「车窗部分是类似铝材的」→ 名词甩到下一屏）。
   *
   * 因此这里不抛错拒绝，而是确定性修正：把悬挂行与下一行合并。两行都在手上，
   * 合并是无损的，且宽度由后续 splitTargetDisplayLine 兜底。
   * 早先一版实现选择抛错交给重试，实测导致 1/17 块耗尽 6 次后**整块无字幕** ——
   * 丢字幕比断句难看严重得多，纯拒绝策略在这里是错的。
   */
  var DANGLING_MODIFIER_TAIL = /[的地得把将和与在从对向给为][\s"'”’)）]*$/u;

  function mergeDanglingModifierLines(lines, maxWidth) {
    var merged = [];
    for (var i = 0; i < lines.length; i++) {
      var current = String(lines[i] || "");
      // 只要当前行以助词收尾且还有后继行，就吸收后继行；连续悬挂会持续吸收。
      // 末行以「的」收尾不进入循环，因为那是合法句末语气。
      while (DANGLING_MODIFIER_TAIL.test(current) && i + 1 < lines.length) {
        current += String(lines[i + 1] || "");
        i++;
      }
      merged.push(current);
    }
    // 合并后可能超宽，交回既有词法边界分屏；它按原子选择切点，不会再切在助词后。
    var out = [];
    merged.forEach(function (line) { out = out.concat(splitTargetDisplayLine(line, maxWidth)); });
    return out;
  }

  function blockSegmentIntegrity(segment) {
    return hashCacheIdentity([
      "block-lines-v1",
      String(segment.segmentId || ""),
      Number(segment.sourceFrom),
      Number(segment.sourceTo),
      (segment.lines || []).join("\x1e"),
    ].join("\x1f"));
  }

  function targetDisplayAtoms(text) {
    var source = String(text || "");
    var records = [];
    var cursor = 0;
    var urlRe = /(?:https?:\/\/|www\.)\S+/giu;
    function addPlain(part) {
      if (!part) return;
      if (typeof Intl !== "undefined" && Intl.Segmenter) {
        var seg = new Intl.Segmenter(undefined, { granularity: "word" });
        Array.from(seg.segment(part)).forEach(function (item) {
          records.push({ text: item.segment, wordLike: !!item.isWordLike, protected: false });
        });
      } else {
        var fallback = part.match(/[\p{L}\p{N}\p{M}]+|\s+|[^\p{L}\p{N}\p{M}\s]/gu) || [];
        fallback.forEach(function (piece) { records.push({ text: piece, wordLike: /[\p{L}\p{N}]/u.test(piece), protected: false }); });
      }
    }
    var match;
    while ((match = urlRe.exec(source))) {
      addPlain(source.slice(cursor, match.index));
      records.push({ text: match[0], wordLike: true, protected: true });
      cursor = match.index + match[0].length;
    }
    addPlain(source.slice(cursor));

    var atoms = [];
    var pendingPrefix = "";
    records.forEach(function (record) {
      if (/^\s+$/u.test(record.text)) {
        if (atoms.length) atoms[atoms.length - 1].text += record.text;
        else pendingPrefix += record.text;
      } else if (!record.wordLike && !record.protected) {
        if (atoms.length) atoms[atoms.length - 1].text += record.text;
        else pendingPrefix += record.text;
      } else {
        atoms.push({ text: pendingPrefix + record.text, wordLike: record.wordLike, protected: record.protected });
        pendingPrefix = "";
      }
    });
    if (pendingPrefix) {
      if (atoms.length) atoms[atoms.length - 1].text += pendingPrefix;
      else atoms.push({ text: pendingPrefix, wordLike: false, protected: false });
    }
    for (var i = 0; i + 1 < atoms.length; i++) {
      if (/^\s*[+\-−]?\d[\d.,:/％%]*\s*$/u.test(atoms[i].text) && atoms[i + 1].wordLike) {
        atoms[i].text += atoms[i + 1].text;
        atoms.splice(i + 1, 1);
      }
    }
    // 无空格书写系统（汉字等）里，Intl.Segmenter 会把词切成过细的碎片：实测
    // 「工程师」被切成「工程|师」、「同样贵」被切成「同样|贵」。在这种原子上按
    // 「原子之间断」的规则断屏，看起来合规，实际就是把词切开 —— 这是之前反复
    // 事后搬词救不回来的根源。
    //
    // 因此把跟在汉字原子后面的**单字**汉字原子黏合上去，使其成为不可分整体。
    // 判据只有两条：书写系统（Script=Han，无空格分词）与原子长度（单字），
    // 不含任何词表；对拉丁、日文假名等有空格或有形态标记的书写系统不生效。
    for (var k = 0; k + 1 < atoms.length; k++) {
      var cur = atoms[k];
      var next = atoms[k + 1];
      if (cur.protected || next.protected) continue;
      // 含标点的原子不参与黏合：标点是句读边界，黏过去会把两个小句焊成一屏，
      // 实测产出「它们仍值得使用它们在许多日常任务中依然很实用」。
      if (/[\p{P}\s]/u.test(cur.text) || /[\p{P}\s]/u.test(next.text)) continue;
      if (!/^\p{Script=Han}+$/u.test(cur.text)) continue;
      if (Array.from(next.text).length !== 1 || !/^\p{Script=Han}$/u.test(next.text)) continue;
      cur.text += next.text;
      atoms.splice(k + 1, 1);
      k--;
    }
    return atoms.map(function (atom) { return atom.text; }).filter(Boolean);
  }

  /**
   * 在 atoms[j] 之后断屏的代价 —— 越小越适合作为一屏结尾。
   *
   * 判据是标点，不是字表：目标语言的句读本来就由标点标记，在句末标点后断句永远
   * 读得通，在句内标点（逗号、顿号、分号）后断也成立。没有标点的位置意味着断在
   * 词与词之间，句子结构未完，代价最高。
   *
   * 语言无关：只用 Unicode 标点属性（\p{P}），不含任何语言的词表或语法规则。
   * 惩罚量级与宽度项（(width-target)^2，量级可达数百）刻意可比 —— 让 DP 愿意为
   * 一个好断点牺牲一些宽度均匀性，但不至于为此产出极端窄行。
   */
  /**
   * 可断标点 —— 单一权威定义。
   *
   * Jay 明确：「逗号句号分号没有优先级，都一视同仁处理」。因此不再区分句末/句内两档，
   * 只有「这里可以断」一个概念。字符集在此定义一次，splitIntoClauses（找断点）与
   * stripTrailingBreakPunct（屏尾去标点）共用，避免两处字面量各自漂移。
   */
  // 顿号「、」刻意不在此列：它分隔并列项，不是小句边界。把它当断点会把型号列表劈开
  // （实测「标准的 AA、AAA」/「C 和 D 电池…」）。Jay 说的「一视同仁」指句号逗号分号。
  var BREAKABLE_PUNCT_CHARS = "。！？!?…，；：,;:";
  var BREAKABLE_PUNCT = new RegExp("[" + BREAKABLE_PUNCT_CHARS + "]", "u");
  // 句末标点 —— 断点强弱上与逗号同级（Jay：「一视同仁」），但它额外是**硬边界**：
  // 一件事说完了，下一件不得挤进同一屏。装填时用它强制换屏。
  var SENTENCE_FINAL_PUNCT = /[。！？!?…]\s*$/u;

  /**
   * 在句末标点后断开一屏。
   *
   * 句末标点（。！？…）是无争议的硬边界 —— 两个完整句子不得同屏，这不需要语感判断，
   * 所以放在程序侧执行。其余断点（逗号、分句）一律尊重模型给的语义分屏。
   * 语言中立：只看标点，不看内容。
   */
  function splitAtSentenceEnd(screen) {
    var text = String(screen == null ? "" : screen);
    var parts = [];
    var buf = "";
    for (var i = 0; i < text.length; i++) {
      buf += text[i];
      if (!/[。！？!?…]/u.test(text[i])) continue;
      // 连续的句末标点（「？！」「……」）算同一个边界，全部吞掉再断。
      while (i + 1 < text.length && /[。！？!?…]/u.test(text[i + 1])) { buf += text[++i]; }
      parts.push(buf);
      buf = "";
    }
    if (buf.trim()) parts.push(buf);
    return parts.length ? parts : [text];
  }
  // 屏尾去标点的字符集比断点集多一个顿号：顿号不是断点，但它若恰好落在屏尾（被词组
  // 间断切出来）同样是视觉噪音，要去掉。
  var TRAILING_BREAKABLE_PUNCT = new RegExp("[" + BREAKABLE_PUNCT_CHARS + "、]+$", "u");

  /**
   * 这一屏实际会显示多宽 —— 屏尾标点与句号都不显示，判「装不装得下」必须按显示后的
   * 宽度算。用带标点的宽度判会误断（样例 8 带标点 52、实显 48）。
   */
  function displayedWidth(text) {
    return semanticDisplayWidth(stripTrailingBreakPunct(text));
  }

  /**
   * 为保住词组允许的极小超宽（半角单位）—— 单一权威常量。
   *
   * 用户明确允许「偶尔接受长句」。在无标点可断的长句上，把断点强行压进容量内
   * 往往只能切在词内部（实测「同样|贵」「工程|师」）；宁可让一屏多出一两个字符，
   * 也不要把词切开。只在候选断点是词内部时才动用，正常情况下容量仍是 cap。
   */
  var DISPLAY_SOFT_OVERFLOW = 2;

  /**
   * 一屏最少要有多少显示宽度才不算「碎」（半角单位，10 ≈ 5 个汉字）。
   *
   * 不足此宽度的小句不单独成屏 —— Jay 确认的样例 3「没错。」4 单位、样例 4
   * 「麻烦的是，」8 单位、样例 8「可能到 1.6 伏」都必须与相邻屏合并。
   */
  var DISPLAY_MIN_SCREEN_WIDTH = 10;

  /**
   * 无标点长句多长才对半断（半角单位，40 ≈ 20 汉字）。
   *
   * 这个阈值**只**作用于整句没有任何可断标点的情形，不影响有标点的句子 —— 后者由
   * 「一屏最多两个小句」决定，与字数无关。Jay 2026-07-27 反对追一条字数分界线
   * （「21 假如我说要分开的话 22 呢」），两条路径分开后就不存在「为了断开无标点长句
   * 而连累有标点句子」的牵制，这个数取 40 还是 44 都不改变后者的观感。
   *
   * 取 40：「你还得知道电压下降到什么程度之前电池都还算能用」(46) 对半断成
   * 「你还得知道电压下降到」/「什么程度之前电池都还算能用」（样例 6）；
   * 「所以它已经快没电了」(18) 远在阈值内保持一屏（样例 11）。
   */
  var PUNCTUATIONLESS_SPLIT_WIDTH = 40;

  

  

  

  /**
   * 规则 3：屏尾不留标点符号。
   *
   * 断屏本身已经表达了停顿，屏尾再挂一个逗号/句号是冗余的视觉噪音。只在断屏处
   * 移除，句子内部的标点不受影响。语言无关：只用 Unicode 标点属性。
   *
   * 实现在下方 stripTrailingBreakPunct。
   */

  

  /**
   * 显示末端统一处理标点 —— 分屏之后、交付之前的最后一步。
   *
   * 两件事，顺序固定：
   *   1. 屏尾不留标点：断屏本身已表达停顿，屏尾再挂逗号/句号是冗余噪音。
   *   2. 句号全部移除（产品显示契约）：句号的职责到分屏结束就完成了。屏内残留的
   *      句号（两句被装进同一屏时）换成一个空格，避免「使用它们」这样粘连成词。
   *
   * 问号、感叹号是语义标点，保留在屏内；只有落在屏尾时才由第 1 条移除。
   */
  function stripTrailingBreakPunct(text) {
    var s = String(text).trim().replace(TRAILING_BREAKABLE_PUNCT, "").trim();
    // 屏内句号：删掉后左右若都是文字会粘连，用空格隔开；CJK 之间的空格随后压掉。
    s = s.replace(/。+/gu, " ");
    s = s.replace(/([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])\s+(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])/gu, "$1");
    return collapseWhitespace(s).trim();
  }

  function splitTargetDisplayLine(line, maxVisualWidth) {
    var clean = sanitizeSubtitleLine(String(line == null ? "" : line));
    if (!clean.trim()) throw new Error("block translation line empty");
    var cap = Math.max(8, Math.floor(Number(maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    // 「装得下就不断」按**去掉标点后**的实际显示宽度判 —— 屏尾标点不显示，用带标点的
    // 宽度判会把本可一屏的内容误断（样例 8「…1.5 伏，可能到 1.6 伏」带标点 52、
    // 实显 48）。
    //
    // 无标点长句不走这条早退：它有自己更低的阈值（PUNCTUATIONLESS_SPLIT_WIDTH），
    // 在 cap 之内也可能需要对半断（样例 6，46 单位 < cap 48 但仍要两屏）。
    if (displayedWidth(clean) <= cap && BREAKABLE_PUNCT.test(clean)) return [clean];
    var atoms = targetDisplayAtoms(clean);
    // 原子不可再分。若单个原子本身就超过容量+软超宽，无解 —— 例如一条超长 URL。
    // 汉字黏合后的原子可能略超 cap，此时软超宽正是为它准备的。
    if (!atoms.length || atoms.some(function (atom) { return semanticDisplayWidth(atom) > cap + DISPLAY_SOFT_OVERFLOW; })) {
      throw new Error("block translation line contains an indivisible overwide target phrase");
    }
    // 一趟贪心填满，两个断点优先级，无回溯、无合并、无特判。
    //
    // 此前的实现把「按小句装屏」「短引子往哪并」「超宽后均分」拆成五个互相撤销的函数，
    // 每加一条规则就要给别处加例外，Jay 明确反对这种堆法。改成单趟后规则只有两条：
    //   1. 累到 minFill 且遇标点 → 断（标点是最自然的边界）
    //   2. 超 cap → 回退到本屏最后一个标点；没有标点就退一个原子
    // 均分改填满是关键：均分把断点强推到中点，正好落在词里（「电池|测试器」）；填满让
    // 断点尽量靠后，落在自然边界上。Jay 给的排法「思路是，与其另外用某种电池测试器来
    // 判断电池 / 还有没有电不如…」正是填满的结果。
    // minFill 取 cap 的 5/8，实测 30/34/38 输出完全一致 —— 这个参数不敏感，无需调。
    var minFill = Math.floor(cap * 5 / 8);
    var screens = [];
    var cur = [];
    var lastPunct = -1;
    var curWidth = function () { return displayedWidth(cur.join("")); };

    atoms.forEach(function (atom) {
      cur.push(atom);
      if (BREAKABLE_PUNCT.test(atom)) {
        if (curWidth() >= minFill) {
          screens.push(cur.join(""));
          cur = [];
          lastPunct = -1;
          return;
        }
        lastPunct = cur.length - 1;
      }
      if (curWidth() > cap) {
        if (lastPunct >= 0) {
          var rest = cur.slice(lastPunct + 1);
          screens.push(cur.slice(0, lastPunct + 1).join(""));
          cur = rest;
        } else {
          var last = cur.pop();
          screens.push(cur.join(""));
          cur = [last];
        }
        lastPunct = -1;
      }
    });
    if (cur.length) screens.push(cur.join(""));

    var out = screens.map(stripTrailingBreakPunct)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (!out.length) throw new Error("block translation line cannot be split at target lexical boundaries");
    return out;
  }

  

  /**
   * 无标点可断的长句：断在词法原子之间，两屏长度尽量接近，虚词不留屏尾。
   *
   * 只有这条路径才考虑宽度均衡 —— Jay 确认样例 6「你还得知道电压下降到 / 什么程度
   * 之前电池都还算能用」而非「你还得知道 / 电压下降到什么程度之前电池都还算能用」。
   * 均衡与「断在标点」不共用代价：有标点时根本走不到这里，因此均衡永远压不过标点。
   * 这是 v0.8.3 的教训 —— 那时两者共用一个 cost 标量，屏数/宽度悄悄压过了断句规则。
   */
  function splitClauseByAtoms(text, cap) {
    var atoms = targetDisplayAtoms(text);
    if (atoms.length < 2) return [text];
    var total = semanticDisplayWidth(text);
    var screenCount = Math.max(2, Math.ceil(total / cap));

    // 断点只能落在原子边界上 —— 先枚举所有合法边界及其累计宽度，再挑离理想切点最近的
    // 那个。这个顺序很关键：先定目标宽度再找最近原子，会把「什么|程度」这类词组切开
    // （实测），因为宽度目标压过了原子边界。反过来，边界是硬约束、宽度是软偏好。
    var boundaries = [];
    var acc = "";
    for (var i = 0; i < atoms.length - 1; i++) {
      acc += atoms[i];
      boundaries.push({ index: i + 1, width: semanticDisplayWidth(acc), text: acc });
    }
    if (!boundaries.length) return [text];

    var out = [];
    var startAtom = 0;
    var consumedWidth = 0;
    for (var seg = 1; seg < screenCount; seg++) {
      // 本屏理想终点：把剩余内容均分给剩余屏数。
      var remainingScreens = screenCount - seg + 1;
      var ideal = consumedWidth + (total - consumedWidth) / remainingScreens;
      var best = null;
      boundaries.forEach(function (b) {
        if (b.index <= startAtom) return;
        var width = b.width - consumedWidth;
        if (width <= 0 || width > cap) return;
        // 虚词不许留在屏尾（样例 7）：断点右边第一个原子若是连词/助词，说明这个断点
        // 会把它吊在上一屏末尾 —— 该虚词应当起下一行。
        var penalty = leadsNextScreen(atoms[b.index - 1]) ? cap : 0;
        var score = Math.abs(b.width - ideal) + penalty;
        if (!best || score < best.score) best = { boundary: b, score: score };
      });
      if (!best) break;
      // 按原子下标切片取本屏文本，不用字符串长度反推偏移（那样容易错位）。
      out.push(atoms.slice(startAtom, best.boundary.index).join(""));
      startAtom = best.boundary.index;
      consumedWidth = best.boundary.width;
    }
    // 收尾：剩下的原子构成最后一屏。
    var tail = atoms.slice(startAtom).join("");
    if (tail) out.push(tail);
    return out.filter(function (s) { return s && s.trim(); });
  }

  /**
   * 这个原子该起一行，而不是吊在上一屏屏尾。
   *
   * Jay：「虚词留在下一句观感更好」—— 样例 7「改用同样贵 / 却寿命更短的 AAA」，
   * 「却」若留在屏尾会让上一屏读起来断在半空。这些是**闭合的语法功能词**（连词与
   * 结构助词），不是内容词表：它们数量固定、不随题材增长，与「不引入语言名单」的
   * 约束不冲突 —— 该约束禁止的是靠逐样本扩充字表来打补丁。
   */
  var LEADING_FUNCTION_WORDS = ["却", "但", "而", "不过", "然而", "所以", "因为", "并且", "或者", "以及", "如果", "虽然", "尽管"];

  function leadsNextScreen(atom) {
    var s = String(atom || "").trim();
    if (!s) return false;
    return LEADING_FUNCTION_WORDS.indexOf(s) >= 0;
  }

  function joinLexicalAtoms(atoms) {
    var out = "";
    (atoms || []).forEach(function (atom) {
      var part = String(atom == null ? "" : atom);
      if (!part) return;
      if (!out) { out = part; return; }
      var needsSpace = /[A-Za-z\p{N}]$/u.test(out) && /^[A-Za-z\p{N}]/u.test(part);
      out += (needsSpace ? " " : "") + part;
    });
    return out.trim();
  }

  function blockSourceCues(cues) {
    return (cues || []).map(function (cue, index) {
      var start = Number(cue && cue.start);
      var end = Number(cue && cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("block source cue timing invalid");
      var text = collapseWhitespace(cue && cue.content || "");
      if (!text) throw new Error("block source cue text empty");
      return { id: "c" + index, startMs: start, endMs: end, text: text };
    });
  }

  function parseBlockTranslationResponse(raw, sourceCues, opts) {
    opts = opts || {};
    var source = blockSourceCues(sourceCues);
    var text = String(raw || "").trim();
    var fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();
    var payload;
    try { payload = JSON.parse(text); } catch (_) { throw new Error("block translation invalid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("block translation response must be an object");
    var outerKeys = Object.keys(payload);
    if (outerKeys.length !== 1 || outerKeys[0] !== "segments" || !Array.isArray(payload.segments) || !payload.segments.length) {
      throw new Error("block translation response must contain only non-empty segments");
    }
    var maxWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    var maxInternalGapMs = Math.max(0, Math.floor(Number(opts.maxInternalGapMs) || BLOCK_SEGMENT_MAX_GAP_MS));
    var cursor = 0;
    var screenItems = [];
    function cueIndex(ref) {
      return source.findIndex(function (cue) { return cue.id === String(ref || ""); });
    }
    function activeMsForRange(from, to) {
      var ms = 0;
      for (var i = from; i <= to; i++) ms += Math.max(0, source[i].endMs - source[i].startMs);
      return ms;
    }
    function crossesLongPause(from, to) {
      if (!(maxInternalGapMs > 0)) return false;
      for (var i = from + 1; i <= to; i++) {
        if (source[i].startMs - source[i - 1].endMs >= maxInternalGapMs) return true;
      }
      return false;
    }
    payload.segments.forEach(function (segment) {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error("block translation segment invalid");
      // 契约 block-v8：每个 screen 都必须声明自己的 sourceFrom/sourceTo。
      //
      // v7 的根缺陷是：模型只返回 screens 字符串，程序事后用比例把屏猜配回源词。
      // 模型知道每屏译文覆盖哪段原文，但这个信息在 JSON 里被丢掉；程序只能猜，猜错
      // 就出现整句重译、译文与原文错开几屏、短屏读不完。v8 把覆盖范围变成显式契约：
      //   screens: [{sourceFrom:"c0", sourceTo:"c2", text:"…"}, ...]
      // 顶层 segment 仍只负责大块连续覆盖；屏级覆盖必须在块内连续、无重叠、无缺口。
      var keys = Object.keys(segment).sort().join("|");
      if (keys !== "screens|sourceFrom|sourceTo") throw new Error("block translation segment fields invalid");
      var from = cueIndex(segment.sourceFrom);
      var to = cueIndex(segment.sourceTo);
      if (from !== cursor || to < from) throw new Error("block translation source coverage gap, overlap, or reorder");
      if (!Array.isArray(segment.screens) || !segment.screens.length) throw new Error("block translation screens invalid");
      var screenCursor = from;
      segment.screens.forEach(function (screen) {
        if (!screen || typeof screen !== "object" || Array.isArray(screen)) throw new Error("block translation screen invalid");
        if (Object.keys(screen).sort().join("|") !== "sourceFrom|sourceTo|text") throw new Error("block translation screen fields invalid");
        var sf = cueIndex(screen.sourceFrom);
        var st = cueIndex(screen.sourceTo);
        if (sf !== screenCursor || st < sf || st > to) throw new Error("block translation screen coverage gap, overlap, or reorder");
        if (crossesLongPause(sf, st)) throw new Error("block translation screen crosses long pause");
        var textLine = collapseWhitespace(String(screen.text == null ? "" : screen.text));
        if (!textLine) throw new Error("block translation screen text empty");
        screenItems.push({ from: sf, to: st, text: textLine });
        screenCursor = st + 1;
      });
      if (screenCursor !== to + 1) throw new Error("block translation screen coverage incomplete");
      cursor = to + 1;
    });
    if (cursor !== source.length) throw new Error("block translation source coverage incomplete");

    var out = [];
    screenItems.forEach(function (item) {
      var lines = [];
      // 句末标点是无争议的硬边界：两个完整句子不得同屏。实测 gpt-5.5 会交回
      // 「确实就是这么做的事实上，这个版本的想法」——把上句尾和下句头焊在一屏。
      splitAtSentenceEnd(item.text).forEach(function (part) {
        if (displayedWidth(part) <= maxWidth) { lines.push(part); return; }
        splitTargetDisplayLine(part, maxWidth).forEach(function (p) { lines.push(p); });
      });
      lines = mergeDanglingModifierLines(lines, maxWidth);
      // 屏尾去标点必须是最后一步。
      lines = lines.map(stripTrailingBreakPunct).filter(Boolean);
      if (!lines.length) {
        // lenient 运行态：译文为空表示该单元未翻译（回退显示原文），不是协议违规。
        if (opts.lenient && !item.text) { lines = [""]; }
        else throw new Error("block translation produced no display lines");
      }
      if (lines.length > maxBlockDisplayLines(activeMsForRange(item.from, item.to))) throw new Error("block translation has too many display lines for source duration");
      var normalized = { segmentId: "b" + out.length, sourceFrom: item.from, sourceTo: item.to, lines: lines };
      normalized.integrity = blockSegmentIntegrity(normalized);
      out.push(normalized);
    });
    return out;
  }

  /**
   * 按长停顿把源 cue 切成若干连续组。
   *
   * 长停顿（≥ maxInternalGapMs 的静音）是真实的语音结构边界，一屏字幕不得跨越它 ——
   * 跨越的结果是这一屏被钳到停顿的一侧，停顿另一侧的语音就没有字幕可显示。
   * 语言无关：只用 cue 时间。
   */
  function groupSourceByLongPause(source, maxInternalGapMs) {
    var groups = [{ from: 0, to: 0 }];
    for (var i = 1; i < source.length; i++) {
      var gap = source[i].startMs - source[i - 1].endMs;
      if (maxInternalGapMs > 0 && gap >= maxInternalGapMs) groups.push({ from: i, to: i });
      else groups[groups.length - 1].to = i;
    }
    // activeMs 是该组的实际语音时长（不含组内短间隙），译文按它的比例分配。
    groups.forEach(function (group) {
      var activeMs = 0;
      for (var i = group.from; i <= group.to; i++) activeMs += Math.max(0, source[i].endMs - source[i].startMs);
      group.activeMs = activeMs;
    });
    return groups;
  }

  /**
   * 把整块译文分配给各个源组，切点落在词法原子边界上。
   *
   * 按各组的语音时长比例切分：译文的推进速度大致跟随语音。只有一组时直接整块返回
   * （最常见情形，不做任何切分）。切点吸附到最近的原子边界，绝不切在词内部。
   */
  /**
   * 把模型给的屏按各组语音时长比例分配到长停顿分组。
   *
   * 屏是不可分单位 —— 模型的语义断点必须保留，所以只在屏之间分界，不切开屏内文本。
   * 每组至少拿一屏（组是真实语音段，无字幕会导致该段画面吊着上一句）。
   * 复杂度 O(屏数)，无原子级遍历。
   */
  function allocateScreensToGroups(screens, groups) {
    if (groups.length === 1) return [screens.slice()];
    // 屏数少于组数时无法每组分一屏 —— 把最宽的屏在标点处拆开补足。
    // 不这样做后面的组会拿到空数组，那一段语音就没有字幕。
    while (screens.length < groups.length) {
      var widest = 0;
      for (var w = 1; w < screens.length; w++) {
        if (displayedWidth(screens[w]) > displayedWidth(screens[widest])) widest = w;
      }
      var halves = splitTargetDisplayLine(screens[widest], Math.max(8, Math.ceil(displayedWidth(screens[widest]) / 2)));
      if (halves.length < 2) break; // 无可拆之处，接受组数不足
      screens = screens.slice(0, widest).concat(halves, screens.slice(widest + 1));
    }
    var durations = groups.map(function (g) { return Math.max(1, g.activeMs || 1); });
    var totalDuration = durations.reduce(function (a, b) { return a + b; }, 0);
    var totalWidth = screens.reduce(function (sum, s) { return sum + displayedWidth(s); }, 0);
    var out = [];
    var cursor = 0;
    for (var g = 0; g < groups.length; g++) {
      var remainingGroups = groups.length - g - 1;
      if (!remainingGroups) { out.push(screens.slice(cursor)); break; }
      var target = totalWidth * durations[g] / totalDuration;
      var acc = 0;
      var take = cursor;
      // 每组至少留一屏给后面每个组，否则后面的组会拿到空数组。
      while (take < screens.length - remainingGroups && acc < target) {
        acc += displayedWidth(screens[take]);
        take++;
      }
      take = Math.max(cursor + 1, Math.min(take, screens.length - remainingGroups));
      out.push(screens.slice(cursor, take));
      cursor = take;
    }
    return out;
  }

  function activeOffsetToTime(cues, offset, startSide) {
    var remaining = Math.max(0, Number(offset) || 0);
    for (var i = 0; i < cues.length; i++) {
      var duration = Math.max(0, Number(cues[i].end) - Number(cues[i].start));
      if (remaining < duration) return Number(cues[i].start) + remaining;
      if (remaining === duration) {
        if (startSide && i + 1 < cues.length) return Number(cues[i + 1].start);
        return Number(cues[i].end);
      }
      remaining -= duration;
    }
    return Number(cues[cues.length - 1].end);
  }

  /**
   * 把「第几个源词」换算成时间。
   *
   * 词序号落在某个 cue 内部时按该 cue 内的词比例插值；正好落在 cue 边界上就直接取
   * 该边界。这样一屏的时间范围严格等于它实际取用的那几个源 cue 的时间范围，字幕与
   * 音轨不会错位，也不会侵入下一句。语言无关：只用词数与 cue 时间。
   */
  function wordOffsetToTime(cues, cursor, wordOffset, startSide) {
    var boundaries = cursor.cueBoundaries;
    if (!cues.length) return 0;
    var prevBoundary = 0;
    for (var i = 0; i < boundaries.length && i < cues.length; i++) {
      var cueWords = boundaries[i] - prevBoundary;
      var cueStart = Number(cues[i].start);
      var cueEnd = Number(cues[i].end);
      // 词序号正好落在 cue 分界上时，start 与 end 的正确答案不同：
      // 上一屏的 end 是前一个 cue 的**结束**（语音到此为止），下一屏的 start 是这个
      // cue 的**开始**（语音从此恢复）。两者之间就是静音，不属于任何一屏。
      // 早先两侧都返回同一个值，导致下一屏的 start 被放到静音起点（实测 2200 而非 2800）。
      if (wordOffset <= prevBoundary) return cueStart;
      if (wordOffset < boundaries[i]) {
        // cue 内部：按词比例插值。
        var ratio = cueWords > 0 ? (wordOffset - prevBoundary) / cueWords : 0;
        return cueStart + (cueEnd - cueStart) * ratio;
      }
      if (wordOffset === boundaries[i]) {
        if (!startSide) return cueEnd;
        // start 侧：落在分界上说明本屏从下一个 cue 开始说话。
        var next = cues[i + 1];
        return next ? Number(next.start) : cueEnd;
      }
      prevBoundary = boundaries[i];
    }
    return Number(cues[cues.length - 1].end);
  }

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

  /**
   * 一屏文字整体横跨了某个停顿时（start 在停顿前、end 在停顿后），只钳边界是不够的
   * —— 边界都在停顿外，字幕会硬挺过整段静音。实测真实英语轨 3/405 屏是这种情况
   * （最长 6802ms 覆盖一整个停顿）。这里把 end 收到第一个被跨越停顿的起点，
   * 让字幕在静音开始时消失。
   *
   * 若停顿前的说话时间不足可读下限（这一屏只摊到 <300ms 的真实语音），
   * 就退让到 startMs + minDisplayMs：仍然会探进静音一点，但**有界**（最多
   * minDisplayMs，且因停顿本身 ≥750ms 必然仍落在该停顿内），绝不会像早先那样
   * 保留原 end 而横跨整段静音。宁可多显示 300ms，也不给一闪而过的字幕；
   * 但"多显示"必须是常数级，不能是任意长的静音。
   */
  function trimSpannedPause(pauses, startMs, endMs, minDisplayMs) {
    for (var i = 0; i < pauses.length; i++) {
      if (startMs <= pauses[i][0] && endMs >= pauses[i][1]) {
        if (pauses[i][0] - startMs >= minDisplayMs) return pauses[i][0];
        return Math.min(endMs, startMs + minDisplayMs);
      }
    }
    return endMs;
  }

  /**
   * 从段内源词游标顺序取出本屏原文，永不回头。
   *
   * 取多少按本屏译文占整段的显示宽度比例估算 —— 只让原文与译文推进节奏大致一致，
   * 不追求逐屏严格对应（严格对应会把源文切在语法中间，反而更难读）。切点在 ±2 词
   * 内吸附到最近的源 cue 边界：那是上游按词法与停顿切好的自然断点。末屏兜掉余下
   * 全部源词，段内无损。语言无关：只用词边界与源 cue 边界，无源语言判定。
   */
  function takeForwardSourceWords(cursor, lineIndex, lineCount) {
    var words = cursor.words;
    if (!words.length) return "";
    var remaining = words.length - cursor.index;
    if (remaining <= 0) return "";
    if (lineIndex + 1 === lineCount) {
      var tail = words.slice(cursor.index);
      cursor.index = words.length;
      // 必须用权威 joinRestoredWords：words 现在由 restoredWords() 切出，连写文字
      // 一字一词，无脑 join(" ") 会把 45 字日文撑成 89 字散字（见其函数注释）。
      return joinRestoredWords(tail);
    }
    var linesLeftAfter = lineCount - lineIndex - 1;
    // 按整段总量算 share，不要"改成剩余量占比"。
    //
    // 我试过改成 remaining * weights[i] / weightLeft，动机是让每屏吸收前面累积的
    // 偏差。真实轨实测反而更差：字/词异常屏 8 → 14。原因是剩余量占比会把边界吸附
    // 造成的偶发偏差立刻转嫁给下一屏，形成振荡（实测出现 1词/4字 与 25词/18字
    // 相邻）；整段总量虽然不补偿，但每屏目标独立，偏差不会被放大传播。
    var share = words.length * cursor.weights[lineIndex] / cursor.totalWeight;
    var maxTake = remaining - linesLeftAfter;
    var take = Math.max(1, Math.min(Math.round(share), maxTake));
    var best = take;
    var bestDist = Infinity;
    for (var bi = 0; bi < cursor.cueBoundaries.length; bi++) {
      var boundary = cursor.cueBoundaries[bi] - cursor.index;
      if (boundary < 1 || boundary > maxTake) continue;
      var dist = Math.abs(boundary - take);
      if (dist <= 2 && dist < bestDist) { bestDist = dist; best = boundary; }
    }
    var slice = words.slice(cursor.index, cursor.index + best);
    cursor.index += best;
    return joinRestoredWords(slice);
  }

  function materializeBlockTranslation(parsedSegments, sourceCues, opts) {
    opts = opts || {};
    var source = blockSourceCues(sourceCues);
    var raw = sourceCues || [];
    var units = [];
    var coverageCursor = 0;
    var maxWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth) || TRANSLATION_DISPLAY_MAX_WIDTH));
    var minDisplayMs = Math.max(1, Math.floor(Number(opts.minDisplayMs) || BLOCK_MIN_DISPLAY_MS));
    var maxInternalGapMs = Math.max(0, Math.floor(Number(opts.maxInternalGapMs) || BLOCK_SEGMENT_MAX_GAP_MS));
    var pauses = longPauseRanges(raw, maxInternalGapMs);
    var pauseGroups = [];
    raw.forEach(function (cue, index) {
      if (index === 0) { pauseGroups.push(0); return; }
      var gap = Number(cue.start) - Number(raw[index - 1].end);
      pauseGroups.push(gap >= maxInternalGapMs ? pauseGroups[index - 1] + 1 : pauseGroups[index - 1]);
    });
    (parsedSegments || []).forEach(function (segment, segmentIndex) {
      var cachedKeys = segment && typeof segment === "object" && !Array.isArray(segment) ? Object.keys(segment).sort().join("|") : "";
      if (!segment || typeof segment !== "object" || Array.isArray(segment) ||
          (cachedKeys !== "lines|segmentId|sourceFrom|sourceTo" && cachedKeys !== "integrity|lines|segmentId|sourceFrom|sourceTo") ||
          segment.segmentId !== "b" + segmentIndex ||
          !Number.isInteger(segment.sourceFrom) || segment.sourceFrom !== coverageCursor ||
          !Number.isInteger(segment.sourceTo) || segment.sourceTo < segment.sourceFrom || segment.sourceTo >= source.length) {
        throw new Error("block translation cached coverage invalid");
      }
      if (!Array.isArray(segment.lines) || !segment.lines.length) throw new Error("block translation cached lines invalid");
      var cues = raw.slice(segment.sourceFrom, segment.sourceTo + 1);
      var totalActive = cues.reduce(function (sum, cue) { return sum + Math.max(0, Number(cue.end) - Number(cue.start)); }, 0);
      var maxLines = maxBlockDisplayLines(totalActive);
      if (segment.lines.length > maxLines) throw new Error("block translation cached lines exceed duration capacity");
      if (opts.requireIntegrity && segment.integrity !== blockSegmentIntegrity(segment)) {
        throw new Error("block translation cache integrity mismatch");
      }
      // 跨长停顿的语义段合法：钳到停顿一侧由下面的 clampToPauseSide 完成，
      // 静音处永不显示字幕，而语义完整性不因毫秒级时间事实被牺牲。
      var cleanLines = segment.lines.map(function (line) {
        // 末端标点处理必须在装载路径上也执行：sanitizeSubtitleLine 不再删句号
        // （句号要留给分屏做断句判据），所以显示契约由 stripTrailingBreakPunct 收口。
        // 缓存里存的是已分屏的 lines，对已处理过的文本再跑一次是幂等的。
        var clean = stripTrailingBreakPunct(sanitizeSubtitleLine(String(line == null ? "" : line)));
        if (!clean.trim()) throw new Error("block translation cached line empty");
        if (semanticDisplayWidth(clean) > maxWidth + DISPLAY_SOFT_OVERFLOW) throw new Error("block translation cached line exceeds visual width");
        return clean;
      });
      coverageCursor = segment.sourceTo + 1;
      if (!(totalActive > 0)) throw new Error("block translation segment has no active duration");
      var weights = cleanLines.map(function (line) { return Math.max(1, semanticDisplayWidth(line)); });
      var totalWeight = weights.reduce(function (a, b) { return a + b; }, 0);
      // 每屏原文顺序往前取，不回头重播。
      //
      // 原先按「本屏时间区间与哪些源 cue 重叠」反查原文。源 cue 通常比一屏译文长，
      // 同一个 cue 会同时命中相邻两屏，其原文被逐屏重播 —— 画面上就是「中文推进
      // 一屏、英文把整句重新滚一遍」，拼接后单屏原文可达 26 词并被浏览器折成 3 行。
      // 真实轨 zsA3X40nz9w 已译区实测 52/75 相邻屏重复、平均重叠 9.2 词。
      //
      // 译文分屏由 splitTargetDisplayLine 独立决定，这里不参与、不干预：原文只是
      // 跟着往前推进，位置大致对应即可，不追求逐屏严格对齐 —— 中英信息密度不同，
      // 硬绑固定词数只会逼出切词或丢词（红线）。
      //
      // 但"不严格"不等于"误差可以累积"：取词量必须按剩余量占比算，让每屏吸收前面
      // 的偏差（见 takeForwardSourceWords）。否则松对齐不闭环，会漂出几屏的错位。
      // 分词必须走全系统唯一权威 restoredWords()，不能用 /\s+/ 自己切。
      //
      // 真机故障（日语轨 pczh.ja，两个模型同现，clip 5/6/10）：/\s+/ 对无词间空格的
      // 语言（日/中/泰）每个 cue 只得到 1 个"词"。一旦模型给的译文屏数多于源词数，
      // 末尾屏取到 0 词 → 游标停在 cue 分界 → start 取「下一 cue 起点」、end 取
      // 「本 cue 终点」→ start > end → 抛错丢掉整块 32 秒字幕并退避重试重烧 token。
      // restoredWords 对连写文字一字一词（见 RESTORE_WORD_RE），源词数与屏数量级
      // 匹配，零词屏在真实轨上不再出现；同时消灭了这里自写的第 4 份分词实现。
      // 必须用 splitDisplayWords 而不是 restoredWords：这里切出来的词要原样拼回**显示
      // 用原文**，标点不能丢。restoredWords 走的是纯词边界（canonical 对齐用），会把
      // "person," 变成 "person" —— 我第一版用了它，e2e coverage ledger 立刻 FAIL，
      // 相当于把原文标点全吃掉。splitDisplayWords 同样以唯一权威 newWordRe() 定边界，
      // 只是额外把标点附着回相邻 token，正是显示路径要的语义。
      var cueWordLists = cues.map(function (cue) {
        return splitDisplayWords(cue.content || "");
      });
      var cueBoundaries = [];
      var boundaryAcc = 0;
      var allWords = [];
      cueWordLists.forEach(function (list) {
        boundaryAcc += list.length;
        cueBoundaries.push(boundaryAcc);
        for (var wi = 0; wi < list.length; wi++) allWords.push(list[wi]);
      });
      var sourceCursor = {
        index: 0,
        words: allWords,
        cueBoundaries: cueBoundaries,
        weights: weights,
        totalWeight: totalWeight,
      };
      cleanLines.forEach(function (line, lineIndex) {
        // 时间源只有一个：本屏实际取用的源词范围。
        //
        // 早先按「本屏译文宽度占整段的比例」换算时间，但译文宽度与语音时长不成比例
        // ——实测两屏宽度 38:30、源时长各 2200ms，第一屏 end 被算到 3059ms，越过第二句
        // 起点占了它的语音时间。takeForwardSourceWords 已经把取词切点吸附到源 cue
        // 边界（真实语音断点），所以先取词、再用游标位置定时间，两者必然一致。
        var fromOffset = sourceCursor.index;
        var original = takeForwardSourceWords(sourceCursor, lineIndex, cleanLines.length);
        var toOffset = sourceCursor.index;
        // 零词屏必须两侧同向取时间，否则跨 cue 分界时 start 取「下一 cue 起点」、
        // end 取「本 cue 终点」→ start > end。根因已在上游修掉（分词改走权威
        // restoredWords，连写文字一字一词，源词数与屏数量级匹配），这里只保留同向
        // 求值这一条不变式，不再靠它兜整块字幕。
        var startMs = clampToPauseSide(pauses, wordOffsetToTime(cues, sourceCursor, fromOffset, true), true);
        var endMs = toOffset === fromOffset
          ? startMs
          : clampToPauseSide(pauses, wordOffsetToTime(cues, sourceCursor, toOffset, false), false);
        endMs = trimSpannedPause(pauses, startMs, endMs, minDisplayMs);
        if (endMs < startMs) throw new Error("block translation materialized timing invalid");
        var roundedStart = Math.round(startMs);
        var roundedEnd = Math.round(endMs);
        // 短于最小显示时长不是协议违规，而是源 cue 本身就短（真实 ASR 轨常见）。
        // 抛错的代价是整块 32 秒字幕全丢（CI 全轨实测 7/50 块），而正确处理是
        // 给它最小显示时长、后续由 enforceDisplayMonotonicity 保证不侵占下一屏。
        if (roundedEnd - roundedStart < minDisplayMs) roundedEnd = roundedStart + minDisplayMs;
        units.push({
          blockSegmentId: segment.segmentId,
          // 可读性合并的唯一分组依据：长停顿分组。segmentId 只表示缓存覆盖序号，
          // 两者必须分开 —— 逐 cue 覆盖时 segmentId 每屏都不同，用它当分组会让
          // mergeUnreadableUnits 一屏都合不了（实测 8/30 屏读不完）。
          pauseGroupId: pauseGroups[segment.sourceFrom] || 0,
          srcStart: segment.sourceFrom + 1,
          srcEnd: segment.sourceTo + 1,
          originalText: original,
          translation: line,
          startMs: roundedStart,
          endMs: roundedEnd,
        });
      });
    });
    if (coverageCursor !== source.length) throw new Error("block translation cached coverage incomplete");
    // 顺序固定：先合并读不完的屏（会改变相邻关系），再借静音，最后去重叠。
    // 反过来则合并后又产生新的重叠没人处理。
    return enforceDisplayMonotonicity(
      extendIntoSilence(mergeUnreadableUnits(units, { maxVisualWidth: maxWidth }), pauses), minDisplayMs);
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
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var cur = units[i];
      // 反复尝试把后继屏并进来，直到读得完或撞上任一硬约束。
      while (shortfall(cur) > 0 && i + 1 < units.length) {
        var next = units[i + 1];
        // 不跨长停顿：判据是 pauseGroupId（真实静音边界），不是 segmentId（缓存序号）。
        if ((next.pauseGroupId || 0) !== (cur.pauseGroupId || 0)) break;
        if (endsWithSentenceFinal(cur.translation)) break;     // 不并两个完整句
        var mergedText = joinDisplayScreens(cur.translation, next.translation);
        if (semanticDisplayWidth(mergedText) > maxWidth) break; // 不制造超宽屏
        var mergedUnit = {
          blockSegmentId: cur.blockSegmentId,
          pauseGroupId: cur.pauseGroupId || 0,
          srcStart: cur.srcStart,
          srcEnd: next.srcEnd,
          originalText: joinDisplayScreens(cur.originalText, next.originalText),
          translation: mergedText,
          startMs: cur.startMs,   // 红线：出现时刻取前屏，绝不前推
          endMs: next.endMs,      // 红线：结束取后屏，绝不越过它
        };
        // 只在确实改善时接受：合并后每字可用时间必须变多，否则原样保留模型的断点。
        var before = shortfall(cur);
        var after = shortfall(mergedUnit);
        if (!(after < before)) break;
        cur = mergedUnit;
        i++;
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
      var ceiling = index + 1 < units.length ? units[index + 1].startMs : unit.startMs + needed;
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
    var maxWidth = Math.max(8, Math.floor(Number(opts.maxVisualWidth || opts.maxLineChars) || TRANSLATION_DISPLAY_MAX_WIDTH));
    // 根修复：运行态不再使用 block screens 契约。
    //
    // block-v7/v8 的根问题是让模型同时决定「怎么翻译」和「每屏覆盖哪段源文」。模型
    // 一旦把覆盖范围声明错，程序即使严格校验 JSON 也只是在校验错误声明，仍会出现
    // 整句重译、译文提前/滞后和短屏读不完。真正的权威覆盖必须由程序先定：每个 cue
    // 生成一个 unitId + token span，模型只复制 ledger 并翻译该 unit。parseTranslationCoverageResponse
    // 会 fail-closed 校验 unitId、coverFrom、coverTo、数量、重复和缺口。
    var lines = await translateClipLines(Object.assign({}, opts, {
      cues: cues.map(function (cue, index) {
        var c = Object.assign({}, cue);
        c.maxVisualWidth = maxWidth;
        c.semanticGroupId = cue && cue.semanticGroupId != null ? cue.semanticGroupId : "block:" + index;
        return c;
      }),
      maxLineChars: maxWidth,
      lenient: !!opts.lenient,
    }));
    if (lines.length !== cues.length) throw new Error("translation coverage alignment mismatch");
    // 分屏/宽度兜底/句末拆分/悬挂助词合并/屏尾去标点只有一条权威实现：
    // parseBlockTranslationResponse。这里把程序侧 ledger 结果编成同一份 v8 契约再过
    // 那条路径，而不是在本函数里复制一遍同样的行整形逻辑（那正是双实现漂移的来源，
    // browser-replay 就是被这种漂移打红的）。
    var payload = { segments: cues.map(function (cue, index) {
      return {
        sourceFrom: "c" + index,
        sourceTo: "c" + index,
        screens: [{ sourceFrom: "c" + index, sourceTo: "c" + index, text: String(lines[index] || "") }],
      };
    }) };
    var segments = parseBlockTranslationResponse(JSON.stringify(payload), cues, {
      maxVisualWidth: maxWidth,
      lenient: !!opts.lenient,
    });
    return { segments: segments, units: materializeBlockTranslation(segments, cues, { maxVisualWidth: maxWidth }) };
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
    if (re && re !== "default" && re !== "none") body.reasoning_effort = String(re);
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

  /** 将连续任务合成不超过 maxUnits 个 source units 的后台批次；超大单项 fail-closed。 */
  function planCoverageBatches(items, maxUnits) {
    var limit = Math.floor(Number(maxUnits) || 8);
    if (limit < 1) limit = 1;
    var out = [];
    var batch = [];
    var size = 0;
    (items || []).forEach(function (item) {
      var count = item && Array.isArray(item.cues) ? item.cues.length : 0;
      if (count > limit) throw new Error("item exceeds coverage batch limit");
      if (batch.length && size + count > limit) {
        out.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(item);
      size += count;
      if (size >= limit) {
        out.push(batch);
        batch = [];
        size = 0;
      }
    });
    if (batch.length) out.push(batch);
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

  function semanticTokenFingerprint(tokens) {
    var parts = [];
    (tokens || []).forEach(function (token) {
      parts.push([
        String(token && token.text || ""),
        Number(token && token.start) || 0,
        Number(token && token.end) || 0,
      ].join("\x1f"));
    });
    return parts.length + ":" + hashCacheIdentity(parts.join("\x1e"));
  }

  /** 严格词流语义恢复缓存 key；不把网关 URL 原文写入 storage key。 */
  function makeSemanticCacheKey(parts) {
    parts = parts || {};
    return [
      "dss-v8",
      parts.videoId || "",
      parts.trackCode || "",
      parts.apiModel || "",
      hashCacheIdentity(String(parts.apiBaseUrl || "").replace(/\/+$/, "")),
      semanticTokenFingerprint(parts.tokens || []),
      hashCacheIdentity(parts.systemPrompt || DEFAULT_RESTORATION_PROMPT),
      Number(parts.chunkWords) || SEMANTIC_CHUNK_WORDS,
      Number(parts.overlapWords) || SEMANTIC_OVERLAP_WORDS,
      Number(parts.preferredMaxWords) || 14,
      Number(parts.maxWords) || 16,
    ].join("|");
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
    applyTailTrim: applyTailTrim,
    resegmentCues: resegmentCues,
    segmentTokensByBoundaries: segmentTokensByBoundaries,
    buildCanonicalTokenTimeline: buildCanonicalTokenTimeline,
    buildCueTokenSpanUnits: buildCueTokenSpanUnits,
    buildTokenSpanUnits: buildTokenSpanUnits,
    cuesFromTimelineSnapshot: cuesFromTimelineSnapshot,
    resegmentTimelineSnapshot: resegmentTimelineSnapshot,
    withTimelineTranslations: withTimelineTranslations,
    validateTokenSpanCoverage: validateTokenSpanCoverage,
    createTimelineSnapshot: createTimelineSnapshot,
    hasNativeTokenTiming: hasNativeTokenTiming,
    collectSemanticTokens: collectSemanticTokens,
    semanticPlanningGroups: semanticPlanningGroups,
    enforceVisualDisplayMarks: enforceVisualDisplayMarks,
    restoredWords: restoredWords,
    TRANSLATE_TIMEOUT_MS: TRANSLATE_TIMEOUT_MS,
    BLOCK_CONTRACT_VERSION: BLOCK_CONTRACT_VERSION,
    joinRestoredWords: joinRestoredWords,
    sameRestoredWords: sameRestoredWords,
    restoredBoundaryMarks: restoredBoundaryMarks,
    chunkTokenRanges: chunkTokenRanges,
    SEMANTIC_CHUNK_WORDS: SEMANTIC_CHUNK_WORDS,
    SEMANTIC_OVERLAP_WORDS: SEMANTIC_OVERLAP_WORDS,
    packRestoredTokens: packRestoredTokens,
    repairNaturalUnitBoundaries: repairNaturalUnitBoundaries,
    filterUnsafeRescueMarks: filterUnsafeRescueMarks,
    partitionReadableTokenUnit: partitionReadableTokenUnit,
    normalizeOversizeSentenceMarks: normalizeOversizeSentenceMarks,
    classifySemanticBoundary: classifySemanticBoundary,
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
    SOURCE_DISPLAY_PREFERRED_WIDTH: SOURCE_DISPLAY_PREFERRED_WIDTH,
    SOURCE_DISPLAY_MAX_WIDTH: SOURCE_DISPLAY_MAX_WIDTH,
    READING_MS_PER_CHAR: READING_MS_PER_CHAR,
    mergeUnreadableUnits: mergeUnreadableUnits,
    extendIntoSilence: extendIntoSilence,
    enforceDisplayMonotonicity: enforceDisplayMonotonicity,
    isNonSpeechMarker: isNonSpeechMarker,
    BLOCK_MIN_DISPLAY_MS: BLOCK_MIN_DISPLAY_MS,
    pickTrack: pickTrack,
    TRANSLATION_DISPLAY_MAX_WIDTH: TRANSLATION_DISPLAY_MAX_WIDTH,
    PREFETCH_AHEAD: PREFETCH_AHEAD,
    planSemanticInterval: planSemanticInterval,
    SEMANTIC_INTERVAL_MS: SEMANTIC_INTERVAL_MS,
    SEMANTIC_FIRST_INTERVAL_MS: SEMANTIC_FIRST_INTERVAL_MS,
    prioritizePrefetch: prioritizePrefetch,
    planCoverageBatches: planCoverageBatches,
    makeSemaphore: makeSemaphore,
    makeAdaptiveGate: makeAdaptiveGate,
    errorKind: errorKind,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_RESTORATION_PROMPT: DEFAULT_RESTORATION_PROMPT,
    DEFAULT_DISPLAY_PROMPT: DEFAULT_DISPLAY_PROMPT,
    semanticDisplayWidth: semanticDisplayWidth,
    semanticTokenBudgets: semanticTokenBudgets,
    buildSystemPrompt: buildSystemPrompt,
    sanitizeSubtitleLine: sanitizeSubtitleLine,
    // 中文显示契约的收口点（屏尾去标点 + 句号不显示）。与 sanitizeSubtitleLine 同级：
    // 都是对外可见的产品契约，不是内部辅助，因此可直接断言。
    stripTrailingBreakPunct: stripTrailingBreakPunct,
    // 中文分屏契约的唯一实现者。Jay 逐条确认过 11 组「输入 → 期望分屏」样例，那些
    // 样例就是本函数的产品规格，必须能直接断言 —— 经公开入口测会被时间层与屏数
    // 上限干扰，测不到排版本身。同 stripTrailingBreakPunct：契约点，不是内部辅助。
    splitTargetDisplayLine: splitTargetDisplayLine,
    validateChineseDisplayUnit: validateChineseDisplayUnit,
    buildClipUnits: buildClipUnits,
    preferManualTrack: preferManualTrack,
    translationCoverageUnitsFromCues: translationCoverageUnitsFromCues,
    parseTranslationCoverageResponse: parseTranslationCoverageResponse,
    extractJsonObject: extractJsonObject,
    DEFAULT_BLOCK_TRANSLATION_PROMPT: DEFAULT_BLOCK_TRANSLATION_PROMPT,
    blockSourceCues: blockSourceCues,
    parseBlockTranslationResponse: parseBlockTranslationResponse,
    materializeBlockTranslation: materializeBlockTranslation,
    translateContextBlock: translateContextBlock,
    translateClipLines: translateClipLines,
    translateClipWithBoundaryRepair: translateClipWithBoundaryRepair,
    parseBoundaryPlanResponse: parseBoundaryPlanResponse,
    parseDisplayCutsResponse: parseDisplayCutsResponse,
    suggestDisplayTokenBoundaries: suggestDisplayTokenBoundaries,
    restoreTokenBoundaries: restoreTokenBoundaries,
    restoreAndPackTokens: restoreAndPackTokens,
    chatCompletion: chatCompletion,
    chatCompletionsUrl: chatCompletionsUrl,
    sliceClips: sliceClips,
    sliceClipsByCue: sliceClipsByCue,
    makeCacheKey: makeCacheKey,
    makeSemanticCacheKey: makeSemanticCacheKey,
    validateTrackManifest: validateTrackManifest,
    SITE_ADAPTERS: SITE_ADAPTERS,
    siteAdapterFor: siteAdapterFor,
    pageVideoId: pageVideoId,
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
    buildProgressSrt: buildProgressSrt,
    progressSrtStats: progressSrtStats,
  };

  return EXPORTS;
});
