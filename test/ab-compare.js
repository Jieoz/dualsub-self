/*
 * test/ab-compare.js — 翻译质量打磨「改前 vs 改后」离线对照
 * =============================================================
 * 不需要真网络。用一段内置的、模拟 ASR(无标点 + 滚动碎片)的英文 cue 样本，
 * 直观对照本次三项改动的效果，给 Jay 看：
 *   ① system prompt：改前(瘦身 3 句) vs 改后(加料换质量) 全文对照
 *   ② resegment 分段：改前(maxWords=12,只标点) vs 改后(maxWords=16,+长停顿) 对照
 *   ③ contextTail：改前(少/句中才带) vs 改后(每批前 3 句) 的 user message 结构对照
 *
 * 用法：node test/ab-compare.js
 *       node test/ab-compare.js > /tmp/ab.txt   # 存可读文本
 */
"use strict";
const Core = require("../core.js");

function hr(title) {
  console.log("\n" + "=".repeat(72));
  console.log("  " + title);
  console.log("=".repeat(72));
}
function sub(title) {
  console.log("\n--- " + title + " " + "-".repeat(Math.max(0, 66 - title.length)));
}
function wc(s) {
  return Core.collapseWhitespace(s).split(" ").filter(Boolean).length;
}
function fmtSeg(s, i) {
  return (
    "  [" + i + "] " +
    "(" + s.start + "→" + s.end + "ms, " + (s.end - s.start) + "ms, " + wc(s.content) + "词) " +
    s.content
  );
}

/* =============================================================
 * 内置样本：模拟 YouTube ASR —— 无句末标点、滚动重叠词、碎片化。
 * 含两处自然停顿：1200→2000ms(800ms 长停顿)、3400→4300ms(900ms 长停顿)。
 * ============================================================= */
const RAW_ASR = [
  { start: 0,    end: 600,  content: "so today we are gonna" },
  { start: 600,  end: 1200, content: "gonna take a look at how" },     // 滚动重叠 "gonna"
  { start: 1250, end: 1800, content: "how large language models work" }, // 重叠 "how"；与上 50ms
  // —— 800ms 长停顿（1800→2600 之间 gap，下条 start=2600）——
  { start: 2600, end: 3100, content: "they predict the next token" },
  { start: 3150, end: 3700, content: "one step at a time" },           // 50ms
  // —— 900ms 长停顿（3700→4600）——
  { start: 4600, end: 5200, content: "and that is basically it" },
  { start: 5250, end: 5800, content: "pretty simple right" },          // 50ms，全程无标点
];
const SAMPLE = Core.cleanupCues(RAW_ASR);

/* =============================================================
 * 改前 system prompt（瘦身 3 句版）—— 仅用于对照展示。
 * 改后取自 core.js 单一真源 Core.DEFAULT_SYSTEM_PROMPT。
 * ============================================================= */
const OLD_SYSTEM_PROMPT =
  "Translate each numbered subtitle line to natural {TARGET_LANG}. " +
  "Fragments may lack punctuation; use context to infer meaning. " +
  "Keep the same line numbers, one translation per line, no extra text.";

/* =============================================================
 * 改前 resegment（maxWords=12、只靠标点/maxGap、无长停顿）——
 * 内联一份「旧逻辑」副本用于对照（旧版合并门槛 gap<=maxGap(300)）。
 * 改后直接调 Core.resegmentCues（maxWords=16 + longPauseMs=700）。
 * ============================================================= */
var OLD_SENTENCE_END_RE = /[.!?。！？…]+["'”’)\]]*$/;
function oldWordKey(w) {
  return String(w || "").toLowerCase().replace(/^[^0-9a-z一-鿿]+|[^0-9a-z一-鿿]+$/g, "");
}
function oldStripOverlap(prevWords, nextWords) {
  var maxK = Math.min(prevWords.length, nextWords.length, 8);
  for (var k = maxK; k >= 1; k--) {
    var match = true;
    for (var i = 0; i < k; i++) {
      if (oldWordKey(prevWords[prevWords.length - k + i]) !== oldWordKey(nextWords[i])) { match = false; break; }
    }
    if (match) return nextWords.slice(k);
  }
  return nextWords;
}
function legacyResegment(cues, opts) {
  opts = opts || {};
  var maxGap = 300, maxDur = opts.maxDurationMs || 6000, maxWords = opts.maxWords || 12, minWords = 3;
  var list = (cues || []).filter(function (c) { return c && c.content; });
  if (!list.length) return [];
  var out = [], cur = null;
  function flush() {
    if (!cur) return;
    var content = Core.collapseWhitespace(cur.words.join(" "));
    if (content) out.push({ start: cur.start, end: cur.end, duration: Math.max(0, cur.end - cur.start), content: content });
    cur = null;
  }
  for (var idx = 0; idx < list.length; idx++) {
    var c = list[idx];
    var words = Core.collapseWhitespace(c.content).split(" ").filter(Boolean);
    if (!words.length) continue;
    if (!cur) { cur = { start: c.start, end: c.end, words: words.slice() }; }
    else {
      var gap = c.start - cur.end;
      var added = oldStripOverlap(cur.words, words);
      var ended = OLD_SENTENCE_END_RE.test(cur.words.join(" "));
      var wouldWords = cur.words.length + added.length;
      var wouldDur = c.end - cur.start;
      var canMerge = !ended || cur.words.length < minWords;
      if (gap <= maxGap && canMerge && wouldWords <= maxWords && wouldDur <= maxDur) {
        for (var w = 0; w < added.length; w++) cur.words.push(added[w]);
        cur.end = Math.max(cur.end, c.end);
      } else { flush(); cur = { start: c.start, end: c.end, words: words.slice() }; }
    }
    var endedNow = OLD_SENTENCE_END_RE.test(cur.words.join(" "));
    if (cur.words.length >= maxWords || cur.end - cur.start >= maxDur || (endedNow && cur.words.length >= minWords)) flush();
  }
  flush();
  return out;
}

/* =============================================================
 * 用 capturing mock fetch 跑 translateCues，捕获实际发出的 user message。
 * 不真调 API：mock 回显行号即可。返回每批的 user message 文本数组。
 * ============================================================= */
async function captureUserMessages(opts) {
  const msgs = [];
  const mockFetch = async (url, o) => {
    const body = JSON.parse(o.body);
    msgs.push(body.messages[1].content);
    const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\.\s/.test(l));
    const content = userLines.map((l) => l.match(/^(\d+)\./)[1] + ". <译>").join("\n");
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
  };
  await Core.translateCues(
    Object.assign(
      {
        apiBaseUrl: "https://gw.example/v1",
        apiModel: "gpt-4o-mini",
        targetLang: "zh-Hans",
        concurrency: 1, // 串行，批顺序稳定便于展示
        fetchImpl: mockFetch,
      },
      opts
    )
  );
  return msgs;
}

async function main() {
  /* ① system prompt 对照 */
  hr("① system prompt：改前(瘦身 3 句) vs 改后(加料换质量)");
  const oldFilled = OLD_SYSTEM_PROMPT.replace(/\{TARGET_LANG\}/g, "zh-Hans");
  const newFilled = Core.buildSystemPrompt("zh-Hans");
  sub("改前（填充 zh-Hans，长度 " + oldFilled.length + " 字符）");
  console.log(oldFilled);
  sub("改后（填充 zh-Hans，长度 " + newFilled.length + " 字符）");
  console.log(newFilled);
  console.log("\n  → 固定开销 +" + (newFilled.length - oldFilled.length) + " 字符；换来口语化/连贯/语序自由/术语约束（经 Jay 确认的取舍）。");

  /* ② resegment 分段对照 */
  hr("② resegment 分段：改前(maxWords=12,只标点) vs 改后(maxWords=16,+长停顿700ms)");
  sub("样本原始 ASR 碎片（" + SAMPLE.length + " 条，无标点、含滚动重叠、两处长停顿)");
  SAMPLE.forEach((c, i) => console.log(fmtSeg(c, i)));

  const before = legacyResegment(SAMPLE, { maxWords: 12 });
  const after = Core.resegmentCues(SAMPLE, { maxWords: 16, longPauseMs: 700 });
  sub("改前分段（共 " + before.length + " 段）—— 无标点只能靠 maxWords=12 硬切，断在半句");
  before.forEach(fmtSeg2);
  sub("改后分段（共 " + after.length + " 段）—— 长停顿(>=700ms)处自然断句，段落更均匀完整");
  after.forEach(fmtSeg2);
  function fmtSeg2(s, i) { console.log(fmtSeg(s, i)); }

  /* ③ contextTail 对照 */
  hr("③ contextTail：改前(少/句中才带) vs 改后(每批前 3 句) — 实际发给模型的 user message");
  // 用改后分段结果当作要翻译的 cue，batchSize=2 制造多批以凸显跨批上下文。
  const cuesForBatch = after;
  console.log("\n  待翻译 cue（取改后分段，共 " + cuesForBatch.length + " 条），batchSize=2：");
  cuesForBatch.forEach((c, i) => console.log("    #" + i + " " + c.content));

  const beforeMsgs = await captureUserMessages({ cues: cuesForBatch, batchSize: 2 }); // 不传 contextLines → 旧行为
  const afterMsgs = await captureUserMessages({ cues: cuesForBatch, batchSize: 2, contextLines: 3 });

  sub("改前（contextLines 未启用：仅当批起点上一条无句末标点才带 1 句；clip 首批不带）");
  beforeMsgs.forEach((m, i) => { console.log("\n  ▼ 批 " + i + " 的 user message:"); console.log(indent(m)); });
  sub("改后（contextLines=3：每批都带前 3 条原文作「参考不翻译」前缀，跨批不再孤立）");
  afterMsgs.forEach((m, i) => { console.log("\n  ▼ 批 " + i + " 的 user message:"); console.log(indent(m)); });

  console.log("\n  → 改后每个非首批都带最多 3 条上下文（编号区仍只含本批、行数不变 → 不破坏时间轴对齐）。");
  console.log("");
}

function indent(s) {
  return String(s).split("\n").map((l) => "      | " + l).join("\n");
}

main();
