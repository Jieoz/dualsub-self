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
   * 除 event 的粗粒度时间外，保留 seg.tOffsetMs 推导出的 token 时间。后续语义
   * 重分段可以自由跨 ASR event 重组，仍准确落回原音频区间。
   */
  function parseJson3(json) {
    const out = [];
    if (!json || !Array.isArray(json.events)) return out;
    for (const ev of json.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const start = toInt(ev.tStartMs, 0);
      const duration = toInt(ev.dDurationMs, 0);
      const eventEnd = start + duration;
      const rawSegs = ev.segs.filter((seg) => seg && typeof seg.utf8 === "string" && seg.utf8.trim());
      const content = collapseWhitespace(rawSegs.map((seg) => seg.utf8).join(""));
      if (!content) continue;
      const tokens = [];
      for (let i = 0; i < rawSegs.length; i++) {
        const seg = rawSegs[i];
        const next = rawSegs[i + 1];
        const offset = Number(seg.tOffsetMs);
        const nextOffset = next ? Number(next.tOffsetMs) : NaN;
        const tokenStart = Number.isFinite(offset) ? start + Math.max(0, offset) : start;
        const tokenEnd = Number.isFinite(nextOffset)
          ? start + Math.max(Math.max(0, offset) || 0, nextOffset)
          : eventEnd;
        // ASR 自带的标点不是词流的一部分。丢掉它后，恢复器才可以安全地
        // 重建句末而不把错误的 event 标点带入新显示单元。
        const words = String(seg.utf8).match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || [];
        for (let j = 0; j < words.length; j++) {
          const partStart = tokenStart + Math.round((tokenEnd - tokenStart) * j / words.length);
          const partEnd = tokenStart + Math.round((tokenEnd - tokenStart) * (j + 1) / words.length);
          tokens.push({ text: words[j], start: partStart, end: partEnd, nativeTiming: Number.isFinite(offset) });
        }
      }
      out.push({ start: start, end: eventEnd, duration: duration, content: content, tokens: tokens });
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
        content: collapseWhitespace(group.map(function (token) { return token.text; }).join(" ")),
        tokens: group,
      });
      first = last + 1;
    }
    return out;
  }

  // 语义恢复协议：模型只可在源词之间加入 .?!|，绝不拥有正文所有权。
  // 逐词归一化后必须完全相等，否则整个 chunk 无效并由调用方重试/回退。
  var RESTORE_WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;

  function restoredWords(text) {
    return String(text || "").match(RESTORE_WORD_RE) || [];
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
    var re = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;
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
    return segmentTokensByBoundaries(list, ends);
  }

  // 语义恢复的边界来自模型，但长句 rescue 仍可能在数字/介词/连词处给出
  // 可验证却不适合阅读的边界。这里只合并相邻源 token，绝不改写、重排或删词。
  var CONTINUATION_START_WORDS = {
    from: true, to: true, of: true, in: true, on: true, at: true, with: true, for: true, by: true,
    into: true, over: true, under: true, through: true, during: true, after: true, before: true, without: true,
    up: true, down: true, out: true, off: true, away: true, back: true, around: true, apart: true,
    forward: true, forth: true, ahead: true, along: true, across: true, together: true, aside: true,
    past: true, round: true, behind: true, beyond: true, through: true,
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
  var MAIN_PREDICATE_START_RE = /^(?:(?:still|also|already|actually|usually|generally|typically|often|sometimes|never|always|then)\s+)?(?!(?:whereas|thus|perhaps|besides)\b)(?:is|are|was|were|has|have|had|can|could|will|would|may|might|must|should|does|do|did|\w+(?:s|ed))\b/i;
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
          content: currentWords.slice(0, capitalAnd).join(" "),
          tokens: current.tokens.slice(0, capitalAnd),
          end: toInt(current.tokens[capitalAnd - 1].end, current.end),
        });
        left.duration = Math.max(0, left.end - toInt(left.start, 0));
        var right = Object.assign({}, current, {
          content: currentWords.slice(capitalAnd).join(" "),
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
      if (previous && gapMs <= maxJoinGapMs && (startsContinuation || isLowercaseOrphan || previousTail || previousIsSubordinate || previousIsAndAdverbial) && !(previousIsReportingUnit && isPredicateContinuation) && unitWordCount(previous) + unitWordCount(current) <= maxNaturalWords) {
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
    var maxDur = opts.maxDurationMs != null ? opts.maxDurationMs : 6000;
    var maxWords = opts.maxWords != null ? opts.maxWords : 16;
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

    var list = [];
    (cues || []).filter(function (c) { return c && c.content; }).forEach(function (c) {
      var pieces = splitCueAtSentenceEnds(c);
      for (var i = 0; i < pieces.length; i++) list.push(pieces[i]);
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

    function flush() {
      if (!cur) return;
      var content = collapseWhitespace(cur.words.join(" "));
      if (content) {
        var endMs = cur.end;
        if (tailTrimMs > 0 && cur.end - cur.start > tailTrimMs * 2) {
          var trimmed = cur.end - tailTrimMs;
          if (trimmed - cur.start < TAIL_TRIM_MIN_VISIBLE_MS) trimmed = cur.start + TAIL_TRIM_MIN_VISIBLE_MS;
          if (trimmed < endMs) endMs = trimmed;
        }
        out.push({ start: cur.start, end: endMs, duration: Math.max(0, endMs - cur.start), content: content });
      }
      cur = null;
    }

    for (var idx = 0; idx < list.length; idx++) {
      var c = list[idx];
      var words = collapseWhitespace(c.content).split(" ").filter(Boolean);
      if (!words.length) continue;

      if (!cur) {
        cur = { start: c.start, end: c.end, words: words.slice(), fragmentChain: startsSyntacticFragmentChain(words) };
      } else {
        var gap = c.start - cur.end;
        var added = stripOverlap(cur.words, words);
        var ended = SENTENCE_END_RE.test(cur.words.join(" "));
        var wouldWords = cur.words.length + added.length;
        var wouldDur = c.end - cur.start;
        var orphanPrepMerge = ended && startsOrphanPrepositionalPhrase(words) &&
          gap < grammarContinuationMaxGapMs && wouldWords <= maxWords + 8 &&
          wouldDur <= grammarContinuationMaxDurationMs;
        var canMerge = !ended || cur.words.length < minWords || orphanPrepMerge;
        var normalMerge = gap < longPauseMs && wouldWords <= maxWords && wouldDur <= maxDur;
        var continuationCap = maxWords + Math.max(4, Math.ceil(maxWords * 0.75));
        // 下一 cue 若在内部很快出现句号，只需把第一个完整句并入；其后的新句已由
        // splitCueAtSentenceEnds 拆成独立 piece，不应计入这次续接的词数预算。
        var addedEndsSentence = SENTENCE_END_RE.test(added.join(" "));
        var effectiveContinuationCap = addedEndsSentence ? continuationCap + 4 : continuationCap;
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
        } else {
          flush();
          cur = { start: c.start, end: c.end, words: words.slice(), fragmentChain: startsSyntacticFragmentChain(words) };
        }
      }

      var curWords = cur.words.length;
      var endedNow = SENTENCE_END_RE.test(cur.words.join(" "));
      if (endedNow && curWords >= minWords) {
        flush();
      } else if (!cur.fragmentChain && !hasEnglishContinuationTail(cur.words) &&
        (curWords >= maxWords || cur.end - cur.start >= maxDur)) {
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
    sourceLang: "auto", // auto = 优先非中文 ASR / 非中文轨，再退回第一条
    // 源字幕轨语言是中文（zh/zh-Hans/zh-CN/yue…）时自动跳过：不拉轨、不翻译、不叠加。
    // 默认开：目标常为 zh-Hans，中文片再翻中文既浪费又挡画面。手动指定 sourceLang=zh* 时仍会跑。
    skipChineseSource: true,
    targetLang: "zh-Hans",
    systemPrompt: "", // 空 = 用 core 默认「源 cue 1:1 对齐」prompt
    sentencePrompt: "", // 已废弃；保留键仅为兼容旧导出配置，不再使用
    waitForFirstTranslation: true,
    waitForFirstTranslationMs: 8000,
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
    minLineChars: 10,
    // 字幕行目标上限（字）。后处理 splitLongLines 用；只在短语标记边界拆，绝不切词。
    maxLineChars: 0, // 双语对照固定一行：不在中文语义单元内部插入换行。
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

  // 已验证 system prompt（直接写死规则 + 压 reasoning）。{TARGET_LANG} 仅在调用方
  // 传自定义 prompt 时替换；默认 prompt 面向简体中文，无占位符（替换为 no-op）。
  var DEFAULT_SYSTEM_PROMPT =
    "你是专业中文字幕翻译。输入是同一段连续语流中带序号的完整英文语义单元。请先结合前后文理解整段，再严格按相同序号输出简体中文。\n" +
    "规则如下：\n" +
    "1) 输出行数、序号和顺序必须与输入完全一致；每行以相同序号开头，例如 `1. …`。\n" +
    "2) 第 N 行只承载第 N 个完整语义单元的信息，不把信息挪到相邻编号，不合并、不遗漏、不重复。\n" +
    "3) 每条译文必须是该英文字幕屏在连续语流中的自然中文表达，不得输出悬空或截断的半句话，也不得补入源文没有的意思；允许用“它/这/尽管”等承接相邻屏，使每屏简洁可读。\n" +
    "4) 译文应简洁、自然、适合字幕显示；绝不把一个中文词切成两半。每条中文必须严格保持单行，不得在单元内部换行。若某输入结合相邻行仍无法译成自然可读的连续字幕片段，必须只返回 [MERGE_PREV]，不得硬翻成逗号半句。若当前英文以从属连接词开头（如 but/although/than/despite），只有它自身具备完整主谓、能改写成自然完整中文时才翻译；否则返回 [MERGE_PREV]。\n" +
    "5) 每条都必须在本屏收束并以句号、问号或感叹号结束；即使英文语法延续到下一屏，也要用代词或自然改写让本屏中文完整，绝不能以逗号、顿号、冒号、分号或省略号结尾。\n" +
    "6) 不要输出英文、其它字母、解释或思考过程。只输出带编号的中文字幕行。直接给结果。";

  /** 是否中文相关 BCP47 / YouTube languageCode（zh, zh-Hans, zh-CN, yue, cmn…） */
  function isChineseLangCode(code) {
    var s = String(code || "").trim().toLowerCase();
    if (!s) return false;
    // 去掉 -asr 后缀再判
    s = s.replace(/-asr$/, "");
    var base = s.split(/[-_]/)[0];
    if (base === "zh" || base === "yue" || base === "cmn" || base === "zhx") return true;
    // 少数轨道直接标 chinese
    if (/chinese|中文|普通话|粤语|国语/.test(s)) return true;
    return false;
  }

  /**
   * 该源轨是否应跳过翻译（中文片保护）。
   *  - skipChineseSource 关闭 → 永不跳
   *  - 用户手动指定 sourceLang 且其本身是中文 → 不跳（尊重显式选择）
   *  - 否则看轨 languageCode / code
   */
  function shouldSkipChineseSource(track, opts) {
    opts = opts || {};
    if (!opts.skipChineseSource) return false;
    var sourceLang = opts.sourceLang;
    // 用户显式选了中文源轨：不跳
    if (sourceLang && sourceLang !== "auto" && isChineseLangCode(sourceLang)) return false;
    if (!track) return false;
    if (isChineseLangCode(track.languageCode) || isChineseLangCode(track.code)) return true;
    // name 兜底（无 languageCode 时）
    if (isChineseLangCode(track.name)) return true;
    return false;
  }

  function buildSystemPrompt(targetLang, customPrompt) {
    var tpl = customPrompt && String(customPrompt).trim() ? customPrompt : DEFAULT_SYSTEM_PROMPT;
    return tpl.replace(/\{TARGET_LANG\}/g, targetLang || "简体中文");
  }

  /** 把 cue 拼成带序号的 user message；模型必须按相同序号 1:1 返回。 */
  function buildNumberedSourceLines(lines) {
    return (lines || [])
      .map(function (t, i) {
        return i + 1 + ". " + collapseWhitespace(t);
      })
      .join("\n");
  }

  // 保留有语义的行尾标点，仅折叠模型偶发重复输出的同类尾部标点与空白。
  var TRAILING_SPACE_RE = /\s+$/u;
  var REPEATED_TRAILING_PUNCT_RE = /([，。！？,.!?])\1+$/u;

  function cleanSubtitleBody(text) {
    var body = collapseWhitespace(text).replace(TRAILING_SPACE_RE, "").trim();
    body = body.replace(/([，。！？、：；,.!?:;])\s+/gu, "$1");
    while (REPEATED_TRAILING_PUNCT_RE.test(body)) {
      body = body.replace(REPEATED_TRAILING_PUNCT_RE, "$1");
    }
    return body;
  }
  // 漏网的行号前缀（模型偶尔违反规则4）：「1. 」「1、」「1) 」「1）」等。
  var LEADING_NUM_RE = /^\s*\d{1,3}\s*[.、)）:：]\s*/u;

  /**
   * 解析模型输出为「干净的中文字幕行数组」（后处理兜底，纯函数）。
   *  - 按换行切；逐行剥离漏网行号前缀、保留必要标点并折叠格式噪声、trim。
   *  - 丢空行；合并连续完全相同的重复行（ASR 回声/模型复读兜底）。
   * 不做任何按词/按字切割 —— 模型已分好行，代码只清洗，不动行边界。
   */
  function parseSubtitleLines(text) {
    if (typeof text !== "string") return [];
    var raw = text.replace(/\r/g, "").split("\n");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var ln = raw[i].replace(LEADING_NUM_RE, "");
      ln = cleanSubtitleBody(ln);
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

  function parseAlignedSubtitleLines(text, expectedCount) {
    var n = expectedCount > 0 ? expectedCount : 0;
    var slots = new Array(n).fill("");
    if (!n || typeof text !== "string") return slots;
    var raw = text.replace(/\r/g, "").split("\n");
    var sequential = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (line == null) continue;
      var m = String(line).match(/^\s*(\d{1,3})\s*[.、)）:：]\s*(.*)$/u);
      var body = "", idx = -1;
      if (m) { idx = parseInt(m[1], 10) - 1; body = m[2]; } else { body = line; }
      body = cleanSubtitleBody(body);
      if (isMergePrevMarker(body)) {
        body = "[MERGE_PREV]";
      } else {
        body = sanitizeSubtitleLine(body);
      }
      if (!body) continue;
      if (idx >= 0 && idx < n) { if (!slots[idx]) slots[idx] = body; }
      else sequential.push(body);
    }
    var filled = 0;
    for (var k = 0; k < n; k++) if (slots[k]) filled++;
    // 无编号输出只有在数量恰好等于 cue 数时才可按顺序接受；数量不足/过多
    // 都无法证明对应关系。只要已有编号行，也绝不拿未编号行猜填缺号。
    if (filled === 0 && sequential.length === n) {
      for (var s = 0; s < n; s++) slots[s] = sequential[s];
    }
    return slots;
  }

  function shapeAlignedLine(line) {
    // 双语对照的显示契约：每个英文语义 cue 对应一条中文，二者各占一行。
    // 这里只清洗模型偶发的空白/换行，不再做中文单元内的视觉折行。
    return collapseWhitespace(line);
  }

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
    // 拉丁词之间、句读后接下一段英文，都要空格；CJK 相连不加空格。
    var sep = "";
    if (/[0-9A-Za-z]/.test(lastCh) && /[0-9A-Za-z]/.test(firstCh)) sep = " ";
    else if (/[.!?;,:%)]/.test(lastCh) && /[0-9A-Za-z"'(]/.test(firstCh)) sep = " ";
    return x + sep + y;
  }

  function validateChineseDisplayUnit(text) {
    var raw = String(text == null ? "" : text);
    var s = raw.trim();
    if (!s) return { ok: false, reason: "empty" };
    if (/\r|\n/.test(raw)) return { ok: false, reason: "internal-newline" };
    if (/[，、：；,……]$/.test(s)) return { ok: false, reason: "non-terminal-punctuation" };
    if (/(?:虽然|尽管|如果|因为|但是|但|可能|以及|而且|所以|就是|从|到|和|与|或|并且)$/.test(s)) {
      return { ok: false, reason: "dangling-tail" };
    }
    return { ok: true, reason: "ok" };
  }

  function isMergePrevMarker(line) {
    return /^\s*\[MERGE_PREV\]\s*$/i.test(String(line == null ? "" : line));
  }

  function mergeRejectedTranslationCues(cues, lines) {
    var source = cues || [];
    var translated = lines || [];
    var out = [];
    for (var i = 0; i < source.length; i++) {
      var cue = Object.assign({}, source[i]);
      cue.tokens = Array.isArray(source[i] && source[i].tokens) ? source[i].tokens.slice() : source[i] && source[i].tokens;
      if (isMergePrevMarker(translated[i])) {
        if (out.length) out[out.length - 1] = mergeNaturalUnits(out[out.length - 1], cue);
        else out.push(cue);
      } else {
        out.push(cue);
      }
    }
    return out;
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
    var src = (lines || []).slice();
    if (!max || !src.length) return src;

    function trySplit(line) {
      var s = String(line == null ? "" : line);
      var n = charLen(s);
      // 中文规范优先保持完整一行；只有超过每行上限才进入安全断行。
      if (n <= max) return [s];
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
   *  - cues: 该 clip 的原始 cue（v0.4.4：标点切段后按时序分配到各输出行 + 空槽最近邻回填；可空）。
   * 复用 layoutTimeline（字符数为占比权重 + SEG_MIN_VISIBLE_MS 可视地板 + 句间留白），
   * 但输入是【不可再切的整行】—— 行长就是权重，layoutTimeline 不会、也无需碰行内字符。
   * 返回：[{ srcStart, srcEnd, originalText, translation, startMs, endMs }]（与渲染单元同构）。
   *   srcStart/srcEnd 为 1-based 输出行号（仅排序用，不再回映 cue 时间）。
   */
  function buildClipUnits(lines, startMs, endMs, cues) {
    var list = cues || [];
    var rawLines = lines || [];
    // v0.5 主路径：源 cue 1:1。lines[i] 对应 cues[i]；时间轴用 cue 原时间，英文用 cue.content。
    if (list.length && rawLines.length === list.length) {
      var out1 = [];
      for (var i = 0; i < list.length; i++) {
        var cue = list[i];
        var zh = rawLines[i] == null ? "" : String(rawLines[i]);
        var cStart = Number(cue.start);
        var cEnd = Number(cue.end);
        if (!Number.isFinite(cStart)) cStart = startMs;
        if (!Number.isFinite(cEnd)) cEnd = endMs;
        if (cEnd < cStart) { var tmp = cStart; cStart = cEnd; cEnd = tmp; }
        out1.push({
          srcStart: i + 1,
          srcEnd: i + 1,
          originalText: collapseWhitespace(cue.content || ""),
          translation: zh,
          startMs: cStart,
          endMs: cEnd,
        });
      }
      return out1;
    }
    var arr = rawLines.filter(function (l) { return l != null && String(l).trim() !== ""; });
    if (!arr.length) return [];
    var lens = arr.map(function (l) { return Math.max(1, charLen(String(l).replace(/\n/g, ""))); });
    var times = layoutTimeline(lens, startMs, endMs, SEG_MIN_VISIBLE_MS, TARGET_CPS);
    var origByLine = assignOriginalsToLines(times, list, arr.length, startMs, endMs);
    var out = [];
    for (var j = 0; j < arr.length; j++) {
      out.push({
        srcStart: j + 1,
        srcEnd: j + 1,
        originalText: origByLine[j] || "",
        translation: arr[j],
        startMs: times[j].startMs,
        endMs: times[j].endMs,
      });
    }
    return out;
  }

  /**
   * 英文/原文显示切段（本地、零 token）：在句读标点后断开。
   *  - 强切：. ! ? ;（保留标点在左段；不在小数 12.5 处切；... 视为一体）
   *  - 弱切：单段超过 maxChunk 时在逗号后补切
   *  - 仍过长：按词边界硬切到 maxChunk（只断空格，不拆单词）
   */
  function splitOriginalByPunct(text, maxChunk) {
    var s = collapseWhitespace(text);
    if (!s) return [];
    var limit = maxChunk > 0 ? maxChunk : 64;

    function strongSplit(str) {
      var parts = [];
      var buf = "";
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        buf += ch;
        var isStrong = ch === "!" || ch === "?" || ch === ";";
        if (ch === ".") {
          var prev = i > 0 ? str[i - 1] : "";
          var next = i + 1 < str.length ? str[i + 1] : "";
          if (/\d/.test(prev) && /\d/.test(next)) {
            // 小数点
          } else {
            while (i + 1 < str.length && str[i + 1] === ".") {
              i++;
              buf += ".";
            }
            isStrong = true;
          }
        }
        if (isStrong) {
          while (i + 1 < str.length && /["')\]]/.test(str[i + 1])) {
            i++;
            buf += str[i];
          }
          parts.push(buf.trim());
          buf = "";
          while (i + 1 < str.length && /\s/.test(str[i + 1])) i++;
        }
      }
      if (buf.trim()) parts.push(buf.trim());
      return parts.length ? parts : [str];
    }

    function commaSplit(str) {
      if (str.length <= limit) return [str];
      var pieces = [];
      var b = "";
      for (var j = 0; j < str.length; j++) {
        b += str[j];
        if (str[j] === "," && b.length >= Math.floor(limit * 0.4)) {
          var nextCh = j + 1 < str.length ? str[j + 1] : "";
          if (!nextCh || /\s/.test(nextCh)) {
            pieces.push(b.trim());
            b = "";
            while (j + 1 < str.length && /\s/.test(str[j + 1])) j++;
          }
        }
      }
      if (b.trim()) pieces.push(b.trim());
      return pieces.length ? pieces : [str];
    }

    function wordWrap(str) {
      if (str.length <= limit) return [str];
      var words = str.split(/\s+/).filter(Boolean);
      if (words.length <= 1) return [str];
      var out = [];
      var b = "";
      for (var w = 0; w < words.length; w++) {
        var cand = b ? b + " " + words[w] : words[w];
        if (b && cand.length > limit) {
          out.push(b);
          b = words[w];
        } else {
          b = cand;
        }
      }
      if (b) out.push(b);
      // 吞掉过短尾巴（如 "water."），避免 "…boil" / "water." 这种难看硬切
      if (out.length >= 2) {
        var last = out[out.length - 1];
        var prev = out[out.length - 2];
        if (last.length <= 12 && prev.length + 1 + last.length <= Math.floor(limit * 1.25)) {
          out[out.length - 2] = prev + " " + last;
          out.pop();
        }
      }
      return out;
    }

    var out = [];
    var strong = strongSplit(s);
    for (var a = 0; a < strong.length; a++) {
      var mid = commaSplit(strong[a]);
      for (var b = 0; b < mid.length; b++) {
        var wrap = wordWrap(mid[b]);
        for (var c = 0; c < wrap.length; c++) if (wrap[c]) out.push(wrap[c]);
      }
    }
    return out;
  }

  // 把 cue 归到输出行（v0.4.4）：标点/逗号/词边界切段 → 按时间比例落到时隙 → 空槽填最近邻段。
  // 目标：长英文不再「全文复制到每一行中文」；本地零 token。
  function assignOriginalsToLines(times, cues, n, startMs, endMs) {
    var origByLine = new Array(n).fill("");
    var list = cues || [];
    if (!list.length || n <= 0) return origByLine;

    var bound = [];
    for (var k = 0; k < n; k++) bound.push(times[k].startMs);
    bound.push(endMs);

    function slotIndexAt(ms) {
      var idx = 0;
      for (var j = 0; j < n; j++) {
        if (ms >= bound[j]) idx = j;
        else break;
      }
      if (idx > n - 1) idx = n - 1;
      if (idx < 0) idx = 0;
      return idx;
    }

    function put(i, piece) {
      if (i < 0 || i >= n || !piece) return;
      if (!origByLine[i]) origByLine[i] = piece;
      else if (origByLine[i].indexOf(piece) === -1) origByLine[i] = joinLine(origByLine[i], piece);
    }

    // 收集带时间戳的原文段
    var timed = []; // {text, mid, start, end}
    for (var c = 0; c < list.length; c++) {
      var cue = list[c];
      var text = collapseWhitespace(cue.content);
      if (!text) continue;
      var cStart = Number(cue.start);
      var cEnd = Number(cue.end);
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd)) continue;
      if (cEnd < cStart) {
        var tmp = cStart;
        cStart = cEnd;
        cEnd = tmp;
      }
      if (cEnd === cStart) cEnd = cStart + 1;
      var segs = splitOriginalByPunct(text);
      if (!segs.length) continue;
      var totalW = 0;
      var weights = [];
      for (var s0 = 0; s0 < segs.length; s0++) {
        var w = Math.max(1, segs[s0].length);
        weights.push(w);
        totalW += w;
      }
      var acc = 0;
      for (var s = 0; s < segs.length; s++) {
        var frac0 = acc / totalW;
        acc += weights[s];
        var frac1 = acc / totalW;
        var segStart = cStart + frac0 * (cEnd - cStart);
        var segEnd = cStart + frac1 * (cEnd - cStart);
        timed.push({
          text: segs[s],
          mid: (segStart + segEnd) / 2,
          start: segStart,
          end: segEnd,
        });
      }
    }

    // 按时序把每段落到对应时隙
    for (var t = 0; t < timed.length; t++) {
      put(slotIndexAt(timed[t].mid), timed[t].text);
    }

    // 空槽回填：优先最近「未占用」段，减少相邻行全文重复；实在没有再退回邻行。
    var used = {};
    for (var z = 0; z < n; z++) {
      if (origByLine[z]) used[origByLine[z]] = true;
    }
    for (var e = 0; e < n; e++) {
      if (origByLine[e]) continue;
      var slotMid = (bound[e] + bound[e + 1]) / 2;
      var best = null;
      var bestDist = Infinity;
      var bestAny = null;
      var bestAnyDist = Infinity;
      for (var u = 0; u < timed.length; u++) {
        var d = Math.abs(timed[u].mid - slotMid);
        if (d < bestAnyDist) {
          bestAnyDist = d;
          bestAny = timed[u].text;
        }
        if (!used[timed[u].text] && d < bestDist) {
          bestDist = d;
          best = timed[u].text;
        }
      }
      var pick = best || bestAny || "";
      if (!pick) {
        for (var p = e - 1; p >= 0; p--) {
          if (origByLine[p]) {
            pick = origByLine[p];
            break;
          }
        }
      }
      if (!pick) {
        for (var q = e + 1; q < n; q++) {
          if (origByLine[q]) {
            pick = origByLine[q];
            break;
          }
        }
      }
      if (pick) {
        origByLine[e] = pick;
        used[pick] = true;
      }
    }
    return origByLine;
  }

  var DEFAULT_RESTORATION_PROMPT =
    "恢复这段英语口语的句末标点。只返回原词，且原词的拼写、顺序和数量必须完全一致。\n" +
    "你只能在词之间加入空格和 . ? ! |。 .?! 仅表示真实句末。完整句超过约 16 词时，也必须在自然、两侧均可独立翻译的从句边界加入 |；优先形成约 6–16 词的屏幕单元，每段最多 20 词。\n" +
    "不得在名词短语、动词短语、短语动词、复合词、限定词+名词、介词短语、不定式、助动词+动词之间加入 |。不得添加、删除、替换、合并、拆分或重排任何词。不要解释。";

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
    var tokens = (opts.tokens || []).filter(function (t) { return t && t.text; });
    if (!tokens.length) return { tokens: [], marks: [] };
    var ranges = chunkTokenRanges(tokens, opts.chunkWords || 120, opts.overlapWords || 30);
    var marks = new Array(tokens.length).fill("");
    var prompt = opts.systemPrompt || DEFAULT_RESTORATION_PROMPT;
    for (var ri = 0; ri < ranges.length; ri++) {
      var range = ranges[ri];
      var chunk = tokens.slice(range.start, range.end);
      var source = tokenWords(chunk).join(" ");
      var chunkMarks = null;
      var attempts = opts.attempts != null ? Math.max(1, Number(opts.attempts)) : 2;
      for (var attempt = 0; attempt < attempts; attempt++) {
        var restored = await chatCompletion({
          apiBaseUrl: opts.apiBaseUrl,
          apiKey: opts.apiKey,
          apiModel: opts.apiModel,
          temperature: opts.temperature,
          reasoningEffort: opts.reasoningEffort,
          systemContent: prompt,
          userContent: source,
          timeoutMs: opts.timeoutMs,
          fetchImpl: opts.fetchImpl,
        });
        chunkMarks = restoredBoundaryMarks(tokenWords(chunk), restored);
        if (chunkMarks) break;
      }
      if (!chunkMarks) throw new Error("invalid sentence restoration chunk " + ri);
      for (var pos = range.commitStart; pos < range.commitEnd; pos++) marks[pos] = chunkMarks[pos - range.start];
    }
    return { tokens: tokens, marks: marks };
  }

  // 局部 rescue 的 | 只在两侧都可作为连续字幕阅读时保留。
  // 模型偶尔会给出 "boiling water | than this ..."；删掉这个坏边界后，
  // 同一句仍可保留前面的自然 14/20 分屏，而不是整句退化成 34 词。
  function filterUnsafeRescueMarks(words, marks) {
    var out = (marks || []).slice();
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
      if (reportingPrefix && !reportingHasPredicate && !reportingObjectBoundary) {
        out[i] = "";
      } else if (!verdict.safe && !naturalDespite && !reportingObjectBoundary) {
        out[i] = "";
      }
    }
    return out;
  }

  /**
   * 对已确认过长的单句做确定性显示分区。候选只能来自已验收的模型 |，或两类
   * 可验证的连续字幕边界：长主语→限定谓语、完整主句→despite being 让步附加语。
   * 动态规划有界于 O(n * hardWords)，无额外模型调用；找不到全程安全路径就返回 null。
   */
  function partitionReadableTokenUnit(tokens, marks, opts) {
    opts = opts || {};
    var words = tokenWords(tokens || []);
    var n = words.length;
    var preferred = Math.max(1, Math.floor(Number(opts.preferredWords) || 14));
    var hard = Math.max(preferred, Math.floor(Number(opts.hardWords) || 16));
    var min = Math.max(1, Math.min(hard, Math.floor(Number(opts.minWords) || 6)));
    if (!n || n <= hard) return (marks || []).slice();
    var sourceMarks = (marks || []).slice();
    while (sourceMarks.length < n) sourceMarks.push("");
    var candidates = {};
    for (var i = 0; i < n - 1; i++) {
      if (sourceMarks[i] === "|") candidates[i + 1] = 0;
      var left = words.slice(0, i + 1).join(" ");
      var right = words.slice(i + 1).join(" ");
      var rightFirst = words[i + 1] || "";
      var longSubjectPredicate = i + 1 >= min && completedReportingSubjectBoundary(left, right);
      var trailingAdjunct = i + 1 >= min && /^(?:despite\s+being|although|though|even\s+(?:during|after|before)|during|after|before)\b/i.test(right) &&
        hasComparisonPredicateText(left);
      var coordinatedClause = i + 1 >= min && isCoordinatedIndependentBoundary(left, right);
      if (longSubjectPredicate || trailingAdjunct || coordinatedClause) {
        var penalty = longSubjectPredicate ? 1 : (coordinatedClause ? 2 : 3);
        if (candidates[i + 1] == null || penalty < candidates[i + 1]) candidates[i + 1] = penalty;
      }
    }
    var dp = new Array(n + 1).fill(null);
    dp[0] = { score: 0, prev: -1 };
    for (var end = 1; end <= n; end++) {
      if (end !== n && candidates[end] == null) continue;
      for (var start = Math.max(0, end - hard); start < end; start++) {
        if (!dp[start]) continue;
        var len = end - start;
        if (len < min && end !== n) continue;
        if (end === n && len < min && start !== 0) continue;
        var boundaryPenalty = end === n ? 0 : candidates[end];
        var score = dp[start].score + Math.pow(len - preferred, 2) + boundaryPenalty;
        if (!dp[end] || score < dp[end].score) dp[end] = { score: score, prev: start };
      }
    }
    if (!dp[n]) return null;
    var cuts = [];
    for (var at = n; at > 0;) {
      var prev = dp[at].prev;
      if (prev < 0) return null;
      if (at < n) cuts.push(at);
      at = prev;
    }
    var out = sourceMarks.map(function (m) { return m === "." ? "." : ""; });
    cuts.forEach(function (cut) { out[cut - 1] = "|"; });
    return out;
  }

  function normalizeOversizeSentenceMarks(tokens, marks, opts) {
    opts = opts || {};
    var out = (marks || []).slice();
    var hard = Math.max(1, Math.floor(Number(opts.hardWords) || 16));
    var sentenceStart = 0;
    for (var i = 0; i <= out.length; i++) {
      if (i < out.length && out[i] !== ".") continue;
      var sentenceEnd = i < out.length ? i + 1 : out.length;
      if (sentenceEnd <= sentenceStart) { sentenceStart = sentenceEnd; continue; }
      var run = 0, oversize = false;
      for (var j = sentenceStart; j < sentenceEnd; j++) {
        run++;
        if (out[j] === "|" || out[j] === ".") { if (run > hard) oversize = true; run = 0; }
      }
      if (run > hard) oversize = true;
      if (oversize) {
        var local = partitionReadableTokenUnit(tokens.slice(sentenceStart, sentenceEnd), out.slice(sentenceStart, sentenceEnd), opts);
        if (local) for (var k = 0; k < local.length; k++) out[sentenceStart + k] = local[k];
      }
      sentenceStart = sentenceEnd;
    }
    return out;
  }

  async function restoreAndPackTokens(opts) {
    opts = opts || {};
    var restored = await restoreTokenBoundaries(opts);
    var maxWords = opts.maxWords || 20;
    var preferredMaxWords = opts.preferredMaxWords || 16;
    // 首轮模型的 | 与局部 rescue 使用同一安全门禁；不能让 which/because/than 等
    // 弱续接开屏仅因它来自首轮恢复就绕过运行时验证。
    restored.marks = filterUnsafeRescueMarks(tokenWords(restored.tokens), restored.marks);
    // 先按整句纠正模型的“4词碎屏 + 21词长屏”等坏组合。确定性分区能同时看见
    // reporting 主语、限定谓语与 trailing adjunct，避免局部 rescue 丢失句首上下文。
    restored.marks = normalizeOversizeSentenceMarks(restored.tokens, restored.marks, {
      preferredWords: Math.min(preferredMaxWords, 14), hardWords: Math.min(maxWords, 16), minWords: 6,
    });
    var units = packRestoredTokens(restored.tokens, restored.marks, { maxWords: maxWords });
    // 第一轮保守只恢复全文句末；少数仍超长的完整句才做局部 clause rescue。
    // 同样只接受逐词完全等价的结果，且每个 rescue 至多一次，避免无界模型调用。
    var prompt = opts.oversizeSystemPrompt ||
      "以下是一条已验证的英语长句。只返回完全相同的词，拼写、顺序、数量均不得变化。\n" +
      "只在自然、连续可读且可译成自然中文字幕片段的边界加入 |；字幕屏是连续语流，不要求每段脱离上下文成为完整书面句。优先形成约 6–" + preferredMaxWords + " 词的屏幕单元，每段最多 " + maxWords + " 词。\n" +
      "不得在名词短语、动词短语、短语动词、复合词、限定词+名词、介词短语、不定式、助动词+动词之间加入 |。不得解释。";
    for (var ui = 0; ui < units.length; ui++) {
      var unit = units[ui];
      var unitWords = restoredWords(unit.content);
      if (unitWords.length <= preferredMaxWords) continue;
      var begin = -1;
      for (var i = 0; i < restored.tokens.length; i++) {
        if (restored.tokens[i].start === unit.start && restored.tokens[i].end <= unit.end) { begin = i; break; }
      }
      if (begin < 0) continue;
      var end = begin + unitWords.length;
      var outerBoundary = restored.marks[end - 1];
      var source = tokenWords(restored.tokens.slice(begin, end)).join(" ");
      var marked = null;
      var attempts = opts.attempts != null ? Math.max(1, Number(opts.attempts)) : 2;
      for (var attempt = 0; attempt < attempts; attempt++) {
        var answer = await chatCompletion({
          apiBaseUrl: opts.apiBaseUrl, apiKey: opts.apiKey, apiModel: opts.apiModel,
          temperature: opts.temperature, reasoningEffort: opts.reasoningEffort,
          systemContent: prompt, userContent: source, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl,
        });
        var localMarks = restoredBoundaryMarks(tokenWords(restored.tokens.slice(begin, end)), answer);
        if (!localMarks) continue;
        localMarks = filterUnsafeRescueMarks(tokenWords(restored.tokens.slice(begin, end)), localMarks);
        var safe = true;
        for (var mi = 0, run = 0; mi < localMarks.length; mi++) {
          run++;
          if (localMarks[mi] === "." || localMarks[mi] === "|") run = 0;
          if (run > maxWords) { safe = false; break; }
        }
        if (!safe) {
          localMarks = partitionReadableTokenUnit(restored.tokens.slice(begin, end), localMarks, {
            preferredWords: Math.min(preferredMaxWords, 14), hardWords: Math.min(maxWords, 16), minWords: 6,
          });
          safe = !!localMarks;
        }
        if (safe) { marked = localMarks; break; }
      }
      if (!marked) continue; // 宁可保持完整句，也不接受未校验/仍过长的局部模型输出。
      for (var m = 0; m < marked.length; m++) restored.marks[begin + m] = marked[m];
      // 局部 rescue 只能细分当前单元，不能删除它与后一单元之间已确认的外边界。
      if (outerBoundary === "." || outerBoundary === "|") restored.marks[end - 1] = outerBoundary;
      units = packRestoredTokens(restored.tokens, restored.marks, { maxWords: maxWords });
    }
    var repairedUnits = repairNaturalUnitBoundaries(units, {
      preferredMaxWords: maxWords,
      maxNaturalWords: Math.min(maxWords, opts.maxNaturalWords || maxWords),
    });
    for (var ri = 0; ri < repairedUnits.length; ri++) {
      if (unitWordCount(repairedUnits[ri]) > maxWords) {
        throw new Error("unresolved oversized semantic unit: " + unitWordCount(repairedUnits[ri]) + " words");
      }
    }
    return repairedUnits;
  }

  /**
   * 翻译一个 clip：一次 chat 调用，让模型按 cue 编号 1:1 返回中文字幕。
   * 入参（opts）：
   *  - cues: 该 clip 的碎片 cue[]（带 content，顺序即源行号）
   *  - apiBaseUrl, apiKey, apiModel, targetLang
   *  - systemPrompt: 可选自定义（覆盖默认行级 prompt）
   *  - reasoningEffort: 透传 chatCompletion（默认配置 "low" 压 reasoning 爆点）
   *  - maxLineChars: 单个字幕单元的建议显示行长；超长时只在安全短语边界换行
   *  - temperature, timeoutMs, fetchImpl
   * 返回：string[] 中文字幕行（可能为空数组=模型空响应，调用方兜底显原文）。
   * 网络/HTTP/超时错误向上抛出（与旧 chatCompletion 一致），调用方兜底 + 退避。
   */
  async function translateClipLines(opts) {
    var cues = opts.cues || [];
    if (!cues.length) return [];
    var sys = buildSystemPrompt(opts.targetLang, opts.systemPrompt);
    var userContent = buildNumberedSourceLines(cues.map(function (c) { return c.content; }));
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
    var n = cues.length;
    var maxLine = opts.maxLineChars != null ? opts.maxLineChars : DEFAULT_CONFIG.maxLineChars || 20;
    var aligned = parseAlignedSubtitleLines(content, n);
    var lines = [];
    var complete = 0;
    for (var i = 0; i < n; i++) {
      var shaped = shapeAlignedLine(aligned[i] || "", maxLine);
      lines.push(shaped);
      if (shaped && String(shaped).trim()) complete++;
    }
    if (complete === n) return lines;

    var loose = parseSubtitleLines(content);
    // 仅当完全没有可用编号槽、且未编号输出数量严格等于 cue 数时，才可安全顺序接受。
    if (complete === 0 && loose.length === n) {
      var shapedLoose = [];
      for (var l = 0; l < n; l++) {
        var looseLine = shapeAlignedLine(loose[l], maxLine);
        if (!looseLine || !String(looseLine).trim()) break;
        shapedLoose.push(looseLine);
      }
      if (shapedLoose.length === n) return shapedLoose;
    }
    // 真正空响应沿用既有语义：返回 []，由渲染层暂显原文并进入重试。
    if (complete === 0 && loose.length === 0) return [];
    // 部分编号/数量异常绝不接受、猜填或缓存；抛给既有 clip 退避调度整包重试。
    throw new Error("incomplete translation: " + complete + "/" + n + " aligned lines");
  }
  async function translateClipWithBoundaryRepair(opts) {
    opts = opts || {};
    var cues = (opts.cues || []).slice();
    if (!cues.length) return { cues: [], lines: [], repaired: false };
    var first = await translateClipLines(Object.assign({}, opts, { cues: cues }));
    var repairLines = first.slice();
    var needsMerge = false;
    for (var i = 0; i < first.length; i++) {
      var verdict = validateChineseDisplayUnit(first[i]);
      if (isMergePrevMarker(first[i])) {
        repairLines[i] = "[MERGE_PREV]";
        needsMerge = true;
      } else if (!verdict.ok) {
        // 中文硬门禁失败与模型显式拒绝同义：当前英文边界不能独立承载自然译文。
        // 只向前合并相邻 cue，并整包重翻一次；首行无前项可并时才保留原错误。
        if (i === 0) {
          // 下一 cue 已显式要求向前合并时，首行会随之被修复，无需提前失败。
          if (!(first.length > 1 && isMergePrevMarker(first[1]))) {
            throw new Error("invalid translation unit 1: " + verdict.reason);
          }
        } else {
          repairLines[i] = "[MERGE_PREV]";
        }
        needsMerge = true;
      }
    }
    if (!needsMerge) return { cues: cues, lines: first, repaired: false };
    var merged = mergeRejectedTranslationCues(cues, repairLines);
    if (merged.length >= cues.length) throw new Error("boundary repair made no progress");
    var maxSourceWords = Math.max(1, Math.floor(Number(opts.maxSourceWords) || 16));
    for (var mi = 0; mi < merged.length; mi++) {
      if (unitWordCount(merged[mi]) > maxSourceWords) {
        throw new Error("oversized source unit after boundary repair: " + unitWordCount(merged[mi]) + " words");
      }
    }
    var second = await translateClipLines(Object.assign({}, opts, { cues: merged }));
    if (second.some(isMergePrevMarker)) throw new Error("boundary repair still rejected after one retry");
    for (var j = 0; j < second.length; j++) {
      var finalVerdict = validateChineseDisplayUnit(second[j]);
      if (!finalVerdict.ok) throw new Error("invalid repaired translation unit " + (j + 1) + ": " + finalVerdict.reason);
    }
    return { cues: merged, lines: second, repaired: true };
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
   * 生成缓存 key：架构版本 + 视频/轨道/语言/model + clip 起点 + cue 边界/正文指纹。
   * cue 指纹确保语义边界回修前后不碰撞，缓存中的译文与共享时间轴始终同批 1:1。
   */
  function makeCacheKey(parts) {
    parts = parts || {};
    return [
      "dsc-v59",
      parts.segmentationMode || "fallback",
      parts.videoId || "",
      parts.trackCode || "",
      parts.targetLang || "",
      parts.apiModel || "",
      parts.clipStartMs != null ? parts.clipStartMs : "",
      parts.cueFingerprint || "",
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
          // shapeAlignedLine 会在安全短语边界插入同一字幕单元内的换行；SRT 必须保留它，
          // 否则 collapseWhitespace 会把换行压成空格，形成「， 就是」这类伪异常。
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
    applyTailTrim: applyTailTrim,
    resegmentCues: resegmentCues,
    segmentTokensByBoundaries: segmentTokensByBoundaries,
    hasNativeTokenTiming: hasNativeTokenTiming,
    collectSemanticTokens: collectSemanticTokens,
    restoredWords: restoredWords,
    sameRestoredWords: sameRestoredWords,
    restoredBoundaryMarks: restoredBoundaryMarks,
    chunkTokenRanges: chunkTokenRanges,
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
    migrateConfig: migrateConfig,
    computeFontPx: computeFontPx,
    planPrefetch: planPrefetch,
    prioritizePrefetch: prioritizePrefetch,
    makeSemaphore: makeSemaphore,
    makeAdaptiveGate: makeAdaptiveGate,
    errorKind: errorKind,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_RESTORATION_PROMPT: DEFAULT_RESTORATION_PROMPT,
    buildSystemPrompt: buildSystemPrompt,
    buildNumberedSourceLines: buildNumberedSourceLines,
    parseSubtitleLines: parseSubtitleLines,
    parseAlignedSubtitleLines: parseAlignedSubtitleLines,
    shapeAlignedLine: shapeAlignedLine,
    sanitizeSubtitleLine: sanitizeSubtitleLine,
    validateChineseDisplayUnit: validateChineseDisplayUnit,
    mergeRejectedTranslationCues: mergeRejectedTranslationCues,
    mergeShortLines: mergeShortLines,
    mergeDanglingLines: mergeDanglingLines,
    splitLongLines: splitLongLines,
    charLen: charLen,
    layoutTimeline: layoutTimeline,
    buildClipUnits: buildClipUnits,
    splitOriginalByPunct: splitOriginalByPunct,
    joinLine: joinLine,
    isChineseLangCode: isChineseLangCode,
    shouldSkipChineseSource: shouldSkipChineseSource,
    translateClipLines: translateClipLines,
    translateClipWithBoundaryRepair: translateClipWithBoundaryRepair,
    restoreTokenBoundaries: restoreTokenBoundaries,
    restoreAndPackTokens: restoreAndPackTokens,
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
