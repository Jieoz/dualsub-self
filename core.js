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
        var priorStart = Number(prior.start), priorEnd = Number(prior.end);
        var currentStart = Number(current.start), currentEnd = Number(current.end);
        var timedOverlap = Number.isFinite(priorStart) && Number.isFinite(priorEnd) &&
          Number.isFinite(currentStart) && Number.isFinite(currentEnd) &&
          Math.max(priorStart, currentStart) < Math.min(priorEnd, currentEnd);
        if (!sameText || !timedOverlap) { sameRollingSpan = false; break; }
      }
      if (sameRollingSpan) { cut = n; break; }
    }
    for (var i = cut; i < next.length; i++) out.push(next[i]);
  }

  function fallbackCueTokens(cue) {
    var words = restoredWords(cue && cue.content || "");
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
      return {
        text: collapseWhitespace(token.text),
        start: Math.round(start),
        end: Math.round(end),
        nativeTiming: token.nativeTiming !== false,
      };
    });
    return native.length ? native : fallbackCueTokens(cue);
  }

  function buildCanonicalTokenTimeline(cues) {
    var raw = [];
    (cues || []).forEach(function (cue) {
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
    return { version: "token-v1", sourceFingerprint: fingerprint, tokens: tokens };
  }

  function buildCueTokenSpanUnits(timeline, cues) {
    var accumulated = [];
    var boundaries = [];
    (cues || []).forEach(function (cue) {
      var before = accumulated.length;
      appendTimelineTokens(accumulated, timelineTokensForCue(cue));
      if (accumulated.length > before) boundaries.push(accumulated.length - 1);
    });
    var tokens = timeline && Array.isArray(timeline.tokens) ? timeline.tokens : [];
    if (accumulated.length !== tokens.length) throw new Error("cue tokens do not match canonical timeline");
    for (var i = 0; i < tokens.length; i++) {
      if (collapseWhitespace(accumulated[i].text) !== tokens[i].text) {
        throw new Error("cue token provenance mismatch at " + i);
      }
    }
    return buildTokenSpanUnits(timeline, boundaries);
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
    return ends.map(function (last, index) {
      var span = tokens.slice(first, last + 1);
      var unit = {
        id: timeline.sourceFingerprint + ":u" + index + ":" + first + "-" + (last + 1),
        sourceFingerprint: timeline.sourceFingerprint,
        tokenStart: first,
        tokenEnd: last + 1,
        startMs: span[0].startMs,
        endMs: Math.max(span[span.length - 1].endMs, span[0].startMs),
        originalText: collapseWhitespace(span.map(function (token) { return token.text; }).join(" ")),
      };
      first = last + 1;
      return unit;
    });
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
      var original = collapseWhitespace(span.map(function (token) { return token.text; }).join(" "));
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
    var renderUnits = units.map(function (unit) {
      var translation = String(translations[unit.id] == null ? "" : translations[unit.id]);
      translationMap[unit.id] = translation;
      return {
        unitId: unit.id,
        sourceFingerprint: unit.sourceFingerprint,
        tokenStart: unit.tokenStart,
        tokenEnd: unit.tokenEnd,
        originalText: unit.originalText,
        translation: translation,
        startMs: unit.startMs,
        endMs: unit.endMs,
      };
    });
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
        unitId: unit.unitId,
        tokenStart: unit.tokenStart,
        tokenEnd: unit.tokenEnd,
        sourceFingerprint: unit.sourceFingerprint,
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
    var sourceWords = snapshot.timeline.tokens.slice(tokenStart, tokenEnd).map(function (token) { return token.text; });
    var replacementWords = [];
    var localEnds = [];
    (replacementCues || []).forEach(function (cue) {
      var words = restoredWords(cue && cue.content || "");
      if (!words.length) throw new Error("replacement token unit empty");
      for (var i = 0; i < words.length; i++) replacementWords.push(words[i]);
      localEnds.push(tokenStart + replacementWords.length - 1);
    });
    if (replacementWords.length !== sourceWords.length) throw new Error("replacement token coverage mismatch");
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
    var oldBySpan = {};
    snapshot.units.forEach(function (unit) {
      oldBySpan[unit.tokenStart + ":" + unit.tokenEnd] = snapshot.translations && snapshot.translations[unit.id] || "";
    });
    var nextTranslations = {};
    nextUnits.forEach(function (unit) {
      nextTranslations[unit.id] = oldBySpan[unit.tokenStart + ":" + unit.tokenEnd] || "";
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
    var hasExplicitMaxWords = opts.maxWords != null;
    var maxWords = hasExplicitMaxWords ? opts.maxWords : 12;
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
        var orphanCap = hasExplicitContinuationMaxWords
          ? continuationMaxWords : maxWords + (hasExplicitMaxWords ? 8 : 2);
        var orphanPrepMerge = ended && startsOrphanPrepositionalPhrase(words) &&
          gap < grammarContinuationMaxGapMs && wouldWords <= orphanCap &&
          wouldDur <= grammarContinuationMaxDurationMs;
        var canMerge = !ended || cur.words.length < minWords || orphanPrepMerge;
        var normalMerge = gap < longPauseMs && wouldWords <= maxWords && wouldDur <= maxDur;
        var continuationCap = hasExplicitContinuationMaxWords
          ? continuationMaxWords
          : (hasExplicitMaxWords ? maxWords + Math.max(4, Math.ceil(maxWords * 0.75)) : maxWords + 2);
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

  // 已验证 system prompt（直接写死规则 + 压 reasoning）。{TARGET_LANG} 仅在调用方
  // 传自定义 prompt 时替换；默认 prompt 面向简体中文，无占位符（替换为 no-op）。
  var DEFAULT_SYSTEM_PROMPT =
    "你是专业中文字幕翻译。输入是同一段连续语流中已经过本地 token 边界验证的英文字幕单元。先结合前后文理解整段，再逐单元翻译为简体中文。\n" +
    "每条译文只能承载对应 sourceText 的信息，不得把信息挪到相邻单元，不得遗漏、重复或补入源文没有的意思。\n" +
    "每条译文必须自然闭合、简洁、适合单行字幕；可用代词或自然改写承接上下文，但不得返回悬空逗号半句。\n" +
    "中文字幕不得输出中文句号“。”；疑问句和感叹句保留问号或感叹号。不要输出英文、解释或思考过程。\n" +
    "只返回严格 JSON：{\"translations\":[{\"unitId\":\"...\",\"coverFrom\":0,\"coverTo\":1,\"translation\":\"...\"}]}。" +
    "每个输入 unitId 必须恰好返回一次，coverFrom/coverTo 必须原样复制，不得返回其它字段。";

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

  function sanitizeSubtitleLine(line) {
    var s = String(line == null ? "" : line);
    if (!s) return "";
    // 保留：CJK 统一表意、扩展A常见区粗略、数字、空白、中文/通用标点。
    // 产品显示契约：中文字幕不显示中文句号“。”；问号、感叹号等语义标点保留。
    s = s.replace(/[^一-鿿㐀-䶿0-9\s，。！？、：；“”‘’（）()\-–—…·℃°%\/.，]/gu, "");
    s = s.replace(/。/gu, "");
    s = collapseWhitespace(s).trim();
    // 去掉拉丁串后可能留下「个 瓶子」：仅压 CJK 之间的空格，数字两侧空格保留（「功率是 8.8 千瓦」）。
    s = s.replace(/([一-鿿])\s+([一-鿿])/gu, "$1$2");
    return s;
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

  /** Materialize already-verified 1:1 translations on immutable source cue timing. */
  function buildClipUnits(lines, startMs, endMs, cues) {
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
      if (!translation.trim()) throw new Error("translation coverage empty materialized unit");
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
    "你是英语字幕边界规划器。输入是按顺序排列的不可修改 token，每个 token 都有唯一 id 和 text。\n" +
    "只决定应在哪些 token 之后结束一个字幕单元；不得回显、改写、添加、删除、合并、拆分或重排任何 token。\n" +
    "每个单元优先 4–11 词，最多 12 词。不得切开限定词+名词、名词短语、动词短语、短语动词、介词短语、不定式、助动词+动词、比较结构、数字+单位、专名、URL 或复合词。\n" +
    "只返回严格 JSON：{\"cutsAfter\":[\"token-id\",...]}; cutsAfter 必须按输入顺序严格递增，不要返回其它字段、正文、Markdown 或解释。";

  function parseBoundaryCutsResponse(raw, allowedTokenIds) {
    var text = String(raw || "").trim();
    var fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();
    var value;
    try { value = JSON.parse(text); } catch (_) { throw new Error("invalid boundary response JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("boundary response must be an object");
    Object.keys(value).forEach(function (key) {
      if (key !== "cutsAfter") throw new Error("unexpected boundary response field: " + key);
    });
    if (!Array.isArray(value.cutsAfter)) throw new Error("cutsAfter must be an array");
    var allowed = (allowedTokenIds || []).map(String);
    var positions = {};
    allowed.forEach(function (id, index) { positions[id] = index; });
    var previous = -1;
    return value.cutsAfter.map(function (rawId) {
      if (typeof rawId !== "string" && typeof rawId !== "number") throw new Error("cut token ID must be a string or number");
      var id = String(rawId);
      if (!Object.prototype.hasOwnProperty.call(positions, id)) throw new Error("unknown cut token ID: " + id);
      var position = positions[id];
      if (position <= previous) throw new Error("cutsAfter must be strictly increasing");
      previous = position;
      return id;
    });
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
      copy.tokenId = String(token.tokenId != null ? token.tokenId : "t" + index);
      return copy;
    });
    if (!tokens.length) return { tokens: [], marks: [] };
    var seenIds = {};
    tokens.forEach(function (token) {
      if (seenIds[token.tokenId]) throw new Error("duplicate boundary token ID: " + token.tokenId);
      seenIds[token.tokenId] = true;
    });
    var ranges = chunkTokenRanges(tokens, opts.chunkWords || 120, opts.overlapWords || 30);
    var marks = new Array(tokens.length).fill("");
    var prompt = opts.systemPrompt || DEFAULT_RESTORATION_PROMPT;
    for (var ri = 0; ri < ranges.length; ri++) {
      var range = ranges[ri];
      var chunk = tokens.slice(range.start, range.end);
      var ids = chunk.map(function (token) { return token.tokenId; });
      var request = JSON.stringify({
        tokens: chunk.map(function (token) { return { id: token.tokenId, text: String(token.text) }; }),
        preferredWords: Math.max(1, Math.floor(Number(opts.preferredMaxWords) || 10)),
        maxWords: Math.max(1, Math.floor(Number(opts.maxWords) || 12)),
      });
      var cuts = null;
      var attempts = opts.attempts != null ? Math.max(1, Number(opts.attempts)) : 2;
      for (var attempt = 0; attempt < attempts; attempt++) {
        try {
          var response = await chatCompletion({
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
          cuts = parseBoundaryCutsResponse(response, ids);
          break;
        } catch (error) {
          if (error && /translate aborted|translate timeout|translate network|translate HTTP/i.test(String(error.message || error))) throw error;
          cuts = null;
        }
      }
      if (!cuts) throw new Error("invalid boundary cuts chunk " + ri);
      var cutSet = {};
      cuts.forEach(function (id) { cutSet[id] = true; });
      for (var pos = range.commitStart; pos < range.commitEnd; pos++) {
        if (cutSet[tokens[pos].tokenId]) marks[pos] = "|";
      }
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
      var reportingMatch = left.match(REPORTING_CLAUSE_PREFIX_RE);
      // 行长优先时，允许把完整 reporting 引导语（Let me point out that / I think that）
      // 单独作为渐进屏。后续长主语仍必须落在 completedReportingSubjectBoundary，
      // 因而这里只新增 5/10/8 这类可读路径，不泛化放过名词短语或关系从句硬切。
      var progressiveReportingIntro = i + 1 >= min && reportingMatch &&
        normalizeBoundaryText(left).toLowerCase() === normalizeBoundaryText(reportingMatch[0]).toLowerCase();
      var longSubjectPredicate = i + 1 >= min && completedReportingSubjectBoundary(left, right);
      var trailingAdjunct = i + 1 >= min && /^(?:despite\s+being|although|though|even\s+(?:during|after|before)|during|after|before)\b/i.test(right) &&
        hasComparisonPredicateText(left);
      var coordinatedClause = i + 1 >= min && isCoordinatedIndependentBoundary(left, right);
      if (progressiveReportingIntro || longSubjectPredicate || trailingAdjunct || coordinatedClause) {
        var penalty = longSubjectPredicate ? 1 : (progressiveReportingIntro || coordinatedClause ? 2 : 3);
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
        var shortNaturalTail = end === n && len >= 3 &&
          /^despite\s+being\s+\w+/i.test(words.slice(start, end).join(" "));
        if (end === n && len < min && start !== 0 && !shortNaturalTail) continue;
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
    var maxWords = opts.maxWords || 12;
    var preferredMaxWords = opts.preferredMaxWords || 10;
    // 首轮模型的 | 与局部 rescue 使用同一安全门禁；不能让 which/because/than 等
    // 弱续接开屏仅因它来自首轮恢复就绕过运行时验证。
    restored.marks = filterUnsafeRescueMarks(tokenWords(restored.tokens), restored.marks);
    // 先按整句纠正模型的“4词碎屏 + 21词长屏”等坏组合。确定性分区能同时看见
    // reporting 主语、限定谓语与 trailing adjunct，避免局部 rescue 丢失句首上下文。
    restored.marks = normalizeOversizeSentenceMarks(restored.tokens, restored.marks, {
      preferredWords: Math.min(preferredMaxWords, 10), hardWords: Math.min(maxWords, 12), minWords: 4,
    });
    var units = packRestoredTokens(restored.tokens, restored.marks, { maxWords: maxWords });
    // 第一轮保守只恢复全文句末；少数仍超长的完整句才做局部 clause rescue。
    // 同样只接受逐词完全等价的结果，且每个 rescue 至多一次，避免无界模型调用。
    var prompt = opts.oversizeSystemPrompt ||
      "你是长字幕单元的边界规划器。输入仍是不可修改的 {id,text} token 数组。\n" +
      "只返回严格 JSON：{\"cutsAfter\":[\"token-id\",...]}; 不得回显正文或返回其它字段。优先形成约 6–" + preferredMaxWords + " 词的单元，每段最多 " + maxWords + " 词。\n" +
      "不得切开名词短语、动词短语、短语动词、复合词、限定词+名词、介词短语、不定式、助动词+动词、比较结构、数字+单位、专名或 URL。";
    for (var ui = 0; ui < units.length; ui++) {
      var unit = units[ui];
      var unitWords = restoredWords(unit.content);
      // 10 词是舒适目标，不是为 11 词自然屏再花一次模型调用的硬断点；
      // 12 词屏才进入一次有界 rescue，最终仍受 hard maxWords 门禁。
      if (unitWords.length <= Math.min(maxWords, preferredMaxWords + 1)) continue;
      var begin = -1;
      for (var i = 0; i < restored.tokens.length; i++) {
        if (restored.tokens[i].start === unit.start && restored.tokens[i].end <= unit.end) { begin = i; break; }
      }
      if (begin < 0) continue;
      var end = begin + unitWords.length;
      var outerBoundary = restored.marks[end - 1];
      var rescue = await restoreTokenBoundaries(Object.assign({}, opts, {
        tokens: restored.tokens.slice(begin, end),
        systemPrompt: prompt,
        preferredMaxWords: preferredMaxWords,
        maxWords: maxWords,
      }));
      var marked = filterUnsafeRescueMarks(tokenWords(rescue.tokens), rescue.marks);
      var safe = true;
      for (var mi = 0, run = 0; mi < marked.length; mi++) {
        run++;
        if (marked[mi] === "." || marked[mi] === "|") run = 0;
        if (run > maxWords) { safe = false; break; }
      }
      if (!safe) {
        marked = partitionReadableTokenUnit(restored.tokens.slice(begin, end), marked, {
          preferredWords: Math.min(preferredMaxWords, 10), hardWords: Math.min(maxWords, 12), minWords: 4,
        });
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
      };
    });
  }

  function parseTranslationCoverageResponse(raw, expectedUnits, opts) {
    opts = opts || {};
    var text = String(raw || "").trim();
    var fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) text = fenced[1].trim();
    var payload;
    try { payload = JSON.parse(text); } catch (_) { throw new Error("translation coverage invalid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("translation coverage response must be an object");
    var outerKeys = Object.keys(payload);
    if (outerKeys.length !== 1 || outerKeys[0] !== "translations" || !Array.isArray(payload.translations)) {
      throw new Error("translation coverage response must contain only translations");
    }
    var expected = (expectedUnits || []).map(function (unit) {
      return {
        unitId: String(unit && unit.unitId || ""),
        tokenStart: Number(unit && unit.tokenStart),
        tokenEnd: Number(unit && unit.tokenEnd),
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
      var keys = Object.keys(item).sort();
      if (keys.join("|") !== "coverFrom|coverTo|translation|unitId") throw new Error("translation coverage entry fields invalid");
      var unitId = String(item.unitId || "");
      var source = expectedById[unitId];
      if (!source || translatedById[unitId]) throw new Error("translation coverage unknown or duplicate unit");
      if (!Number.isInteger(item.coverFrom) || !Number.isInteger(item.coverTo) || item.coverFrom !== source.tokenStart || item.coverTo !== source.tokenEnd) {
        throw new Error("translation coverage span mismatch");
      }
      var translation = sanitizeSubtitleLine(String(item.translation == null ? "" : item.translation));
      if (!translation.trim()) throw new Error("translation coverage empty translation");
      var verdict = validateChineseDisplayUnit(translation);
      if (!verdict.ok) throw new Error("translation coverage invalid Chinese unit: " + verdict.reason);
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
    var sys = buildSystemPrompt(opts.targetLang, opts.systemPrompt) +
      "\n协议硬约束：只返回 translations JSON；unitId、coverFrom、coverTo 必须逐项原样复制，所有输入单元必须恰好覆盖一次。";
    var userContent = JSON.stringify({
      sourceFingerprint: Object.keys(fingerprints)[0] || "",
      units: units.map(function (unit) {
        return { unitId: unit.unitId, coverFrom: unit.tokenStart, coverTo: unit.tokenEnd, sourceText: unit.sourceText };
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
    var coverage = parseTranslationCoverageResponse(content, units, { maxLineChars: opts.maxLineChars });
    var lines = coverage.map(function (entry) { return entry.translation; });
    Object.defineProperty(lines, "coverage", { value: coverage, enumerable: false });
    return lines;
  }

  async function translateClipWithBoundaryRepair(opts) {
    opts = opts || {};
    var cues = (opts.cues || []).slice();
    if (!cues.length) return { cues: [], lines: [], coverage: [], repaired: false };
    var maxSourceWords = opts.segmentationMode === "fallback-translation" ? 14 : 12;
    for (var i = 0; i < cues.length; i++) {
      var sourceWords = unitWordCount(cues[i]);
      if (sourceWords > maxSourceWords) throw new Error("oversized source unit before translation: " + sourceWords + " words (cap " + maxSourceWords + ")");
    }
    var lines = await translateClipLines(Object.assign({}, opts, { cues: cues }));
    if (lines.length !== cues.length || !Array.isArray(lines.coverage) || lines.coverage.length !== cues.length) {
      throw new Error("translation coverage alignment mismatch");
    }
    return { cues: cues, lines: lines, coverage: lines.coverage, repaired: false };
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
    var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20000;
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
      "dss-v1",
      parts.videoId || "",
      parts.trackCode || "",
      parts.apiModel || "",
      hashCacheIdentity(String(parts.apiBaseUrl || "").replace(/\/+$/, "")),
      semanticTokenFingerprint(parts.tokens || []),
      hashCacheIdentity(parts.systemPrompt || DEFAULT_RESTORATION_PROMPT),
      Number(parts.chunkWords) || 120,
      Number(parts.overlapWords) || 30,
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
      "dsc-v70",
      parts.contractVersion || "cue-v1",
      parts.segmentationMode || "fallback",
      parts.videoId || "",
      parts.trackCode || "",
      parts.targetLang || "",
      parts.apiModel || "",
      hashCacheIdentity(normalizedBase),
      hashCacheIdentity(parts.systemPrompt || DEFAULT_SYSTEM_PROMPT),
      parts.reasoningEffort || "default",
      parts.maxLineChars != null ? Number(parts.maxLineChars) : "",
      parts.clipStartMs != null ? parts.clipStartMs : "",
      parts.cueFingerprint || "",
    ].join("|");
  }

  /**
   * 校验 MAIN world 送来的字幕轨道清单。DOM CustomEvent 是不可信边界：
   * 这里只允许 YouTube HTTPS timedtext URL，并限制所有字段和数组大小。
   * 返回去除未知字段的新对象；任一轨道非法时整包拒绝。
   */
  function validateTrackManifest(content, options) {
    options = options || {};
    if (!content || typeof content !== "object" || !Array.isArray(content.files)) return null;
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
      var trustedHost = host === "youtube.com" || /\.youtube\.com$/.test(host);
      if (parsed.protocol !== "https:" || !trustedHost || !/^\/api\/timedtext\/?$/.test(parsed.pathname)) return null;
      var code = String(raw.code == null ? "" : raw.code);
      var languageCode = String(raw.languageCode == null ? "" : raw.languageCode);
      var name = String(raw.name == null ? code : raw.name);
      var kind = String(raw.kind == null ? "" : raw.kind);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(languageCode) || name.length > 256 || (kind !== "" && kind !== "asr")) return null;
      var urlVideo = parsed.searchParams.getAll("v");
      var urlLang = parsed.searchParams.getAll("lang");
      var urlKind = parsed.searchParams.getAll("kind");
      var pot = parsed.searchParams.get("pot");
      if (urlVideo.length !== 1 || urlVideo[0] !== videoId || urlLang.length !== 1 || urlLang[0] !== languageCode) return null;
      if (!pot || parsed.searchParams.has("tlang")) return null;
      if (kind === "asr") {
        if (urlKind.length !== 1 || urlKind[0] !== "asr" || code !== languageCode + "-asr") return null;
      } else if (urlKind.length !== 0 || code !== languageCode) {
        return null;
      }
      var identity = [code, languageCode, kind].join("\x1f");
      if (identities[identity]) return null;
      identities[identity] = true;
      files.push({ name: name, code: code, languageCode: languageCode, kind: kind, url: parsed.toString() });
    }
    return { videoId: videoId, files: files };
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
  var EXPORTS = {
    parseJson3: parseJson3,
    parseVtt: parseVtt,
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
    normalizeTargetLang: normalizeTargetLang,
    migrateConfig: migrateConfig,
    computeFontPx: computeFontPx,
    planPrefetch: planPrefetch,
    prioritizePrefetch: prioritizePrefetch,
    planCoverageBatches: planCoverageBatches,
    makeSemaphore: makeSemaphore,
    makeAdaptiveGate: makeAdaptiveGate,
    errorKind: errorKind,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_RESTORATION_PROMPT: DEFAULT_RESTORATION_PROMPT,
    buildSystemPrompt: buildSystemPrompt,
    sanitizeSubtitleLine: sanitizeSubtitleLine,
    validateChineseDisplayUnit: validateChineseDisplayUnit,
    buildClipUnits: buildClipUnits,
    isChineseLangCode: isChineseLangCode,
    shouldSkipChineseSource: shouldSkipChineseSource,
    translationCoverageUnitsFromCues: translationCoverageUnitsFromCues,
    parseTranslationCoverageResponse: parseTranslationCoverageResponse,
    translateClipLines: translateClipLines,
    translateClipWithBoundaryRepair: translateClipWithBoundaryRepair,
    parseBoundaryCutsResponse: parseBoundaryCutsResponse,
    restoreTokenBoundaries: restoreTokenBoundaries,
    restoreAndPackTokens: restoreAndPackTokens,
    chatCompletion: chatCompletion,
    chatCompletionsUrl: chatCompletionsUrl,
    sliceClips: sliceClips,
    sliceClipsByCue: sliceClipsByCue,
    makeCacheKey: makeCacheKey,
    makeSemanticCacheKey: makeSemanticCacheKey,
    validateTrackManifest: validateTrackManifest,
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
