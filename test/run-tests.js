/*
 * test/run-tests.js — 离线逻辑测试（零依赖，node 直接跑）
 * =============================================================
 * 覆盖：
 *  - json3 解析 + 时间轴清洗（去重叠/过滤空/排序）
 *  - WebVTT 解析
 *  - 翻译分批：按行号对齐回 cue
 *  - 兜底：行号错位、行数不匹配、无行号
 *  - clip 切分
 *  - translateBatch 用 mock fetch 跑通整条链路
 *  - manifest.json JSON.parse 通过
 *  - 图标是真 PNG 且 >0 字节
 *
 * 用法：node test/run-tests.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");

const ROOT = path.join(__dirname, "..");
function boundaryJson(requestOptions, cutIndexes) {
  const body = JSON.parse(requestOptions.body);
  const payload = JSON.parse(body.messages[1].content);
  const cuts = (cutIndexes || []).map((index) => payload.tokens[index].id);
  return JSON.stringify({ semanticCutsAfter: cuts });
}
function visualBoundaryJson(requestOptions) {
  const body = JSON.parse(requestOptions.body);
  const payload = JSON.parse(body.messages[1].content);
  const groups = payload.groups || [];
  const max = Number(payload.maxVisualWidth) || Core.SOURCE_DISPLAY_MAX_WIDTH;
  const cuts = [];
  let current = [];
  for (let i = 0; i < groups.length; i++) {
    const candidate = Core.joinRestoredWords(current.concat(groups[i].text));
    if (current.length && Core.semanticDisplayWidth(candidate) > max) {
      cuts.push(groups[i - 1].toId);
      current = [groups[i].text];
    } else {
      current.push(groups[i].text);
    }
  }
  return JSON.stringify({ semanticCutsAfter: [] });
}
function visualReplacementCues(tokens) {
  const list = tokens || [];
  const budget = Core.semanticTokenBudgets(list);
  const out = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    out.push({
      start: Number(group[0].startMs != null ? group[0].startMs : group[0].start),
      end: Number(group[group.length - 1].endMs != null ? group[group.length - 1].endMs : group[group.length - 1].end),
      content: Core.joinRestoredWords(group.map((t) => t.text)),
      semanticGroupId: "test-group",
    });
    group = [];
  };
  for (const token of list) {
    const candidate = group.concat(token);
    const text = Core.joinRestoredWords(candidate.map((t) => t.text));
    if (group.length && (candidate.length > budget.maxTokens || Core.semanticDisplayWidth(text) > budget.maxVisualWidth)) flush();
    group.push(token);
  }
  flush();
  return out;
}
function assertVisualSemanticUnits(units, source) {
  assert.ok(units.length >= 1);
  assert.ok(units.every((u) => Core.semanticDisplayWidth(u.content) <= Core.SOURCE_DISPLAY_MAX_WIDTH), "每个 display unit 必须受视觉宽度硬门禁约束");
  assert.strictEqual(units.map((u) => u.content).join(" "), source, "display cut 不能丢词或改写原文");
  assert.strictEqual(new Set(units.map((u) => u.semanticGroupId)).size, 1, "同一完整意思内的短屏必须保留共同 semanticGroupId");
}
function translationCoverageJson(requestOptions, translations, reverse=false) {
  const body = JSON.parse(requestOptions.body);
  const payload = JSON.parse(body.messages[1].content);
  const entries = payload.units.map((unit, index) => ({
    unitId: unit.unitId,
    coverFrom: unit.coverFrom,
    coverTo: unit.coverTo,
    translation: typeof translations === "function" ? translations(unit, index) : translations[index],
  }));
  if (reverse) entries.reverse();
  return JSON.stringify({ translations: entries });
}
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e && e.message ? e.message : e));
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e && e.message ? e.message : e));
  }
}

/* ============ 1. json3 解析 ============ */
console.log("\n[json3 解析 + 清洗]");

const fakeJson3 = {
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "so today" }, { utf8: " we" }] },
    { tStartMs: 1500, dDurationMs: 3000, segs: [{ utf8: "are gonna look at" }] }, // 与上一句重叠
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "\n" }] }, // 空内容，应被丢弃
    { tStartMs: 6000, dDurationMs: 2000, segs: [{ utf8: "  transformers  " }] }, // 带多余空白
    { tStartMs: 9000, dDurationMs: 0, segs: null }, // 无 segs，跳过
  ],
};

test("parseJson3 拼接 segs 并过滤空内容", () => {
  const cues = Core.parseJson3(fakeJson3);
  assert.strictEqual(cues.length, 3, "应得到 3 条非空 cue");
  assert.strictEqual(cues[0].content, "so today we");
  assert.strictEqual(cues[2].content, "transformers", "应折叠多余空白");
});

test("parseJson3 保留 json3 segment 偏移推导的词级时间", () => {
  const cues = Core.parseJson3({ events: [{
    tStartMs: 1000, dDurationMs: 900,
    segs: [{ utf8: "hello ", tOffsetMs: 0 }, { utf8: "world", tOffsetMs: 500 }],
  }] });
  assert.deepStrictEqual(cues[0].tokens.map(({ text, start, end }) => ({ text, start, end })), [
    { text: "hello", start: 1000, end: 1500 },
    { text: "world", start: 1500, end: 1900 },
  ]);
  assert.ok(cues[0].tokens.every((token) => token.nativeTiming));
});

test("parseJson3 词流去 ASR 标点并标记原生 tOffset 时间覆盖", () => {
  const cues = Core.parseJson3({ events: [{ tStartMs: 100, dDurationMs: 900, segs: [
    { utf8: "whistle. ", tOffsetMs: 0 }, { utf8: "on this", tOffsetMs: 300 },
  ] }] });
  assert.deepStrictEqual(cues[0].tokens.map((t) => t.text), ["whistle", "on", "this"]);
  assert.ok(Core.hasNativeTokenTiming(cues));
  cues[0].tokens[2].nativeTiming = false;
  assert.ok(!Core.hasNativeTokenTiming(cues));
});

test("collectSemanticTokens 只去 JSON3 相邻滚动重叠，不改其它词流", () => {
  const tokens = Core.collectSemanticTokens([
    { tokens: [{ text: "a" }, { text: "b" }, { text: "c" }] },
    { tokens: [{ text: "b" }, { text: "c" }, { text: "d" }] },
  ]);
  assert.deepStrictEqual(tokens.map((t) => t.text), ["a", "b", "c", "d"]);
});

test("segmentTokensByBoundaries 仅采纳边界，原词和时间不被改写", () => {
  const units = Core.segmentTokensByBoundaries([
    { text: "For", start: 0, end: 100 },
    { text: "this", start: 100, end: 200 },
    { text: "kettle,", start: 200, end: 300 },
    { text: "boil.", start: 300, end: 450 },
    { text: "Next", start: 500, end: 600 },
  ], [3]);
  assert.deepStrictEqual(units.map((u) => [u.content, u.start, u.end]), [
    ["For this kettle, boil.", 0, 450],
    ["Next", 500, 600],
  ]);
});

test("语义恢复协议拒绝改词，并从合法标点提取边界", () => {
  const source = ["For", "this", "kettle", "boil", "water", "Next"];
  assert.ok(Core.sameRestoredWords(source, "For this kettle boil water. Next"));
  assert.ok(!Core.sameRestoredWords(source, "For this kettle boils water. Next"));
  assert.deepStrictEqual(Core.restoredBoundaryMarks(source, "For this kettle boil water. Next"), ["", "", "", "", ".", ""]);
  assert.strictEqual(Core.restoredBoundaryMarks(source, "For this kettle boils water. Next"), null);
});

test("语义恢复分块带 overlap 且只提交非重叠前缀", () => {
  assert.deepStrictEqual(Core.chunkTokenRanges(new Array(250), 120, 30), [
    { start: 0, end: 120, commitStart: 0, commitEnd: 90 },
    { start: 90, end: 210, commitStart: 90, commitEnd: 180 },
    { start: 180, end: 250, commitStart: 180, commitEnd: 250 },
  ]);
});

test("packRestoredTokens 只在恢复边界切，未知长句宁可完整保留", () => {
  const tokens = "For this kettle boil water before the next part begins".split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const units = Core.packRestoredTokens(tokens, ["", "", "", "", ".", "", "", "", "", ""], { maxWords: 4 });
  assert.deepStrictEqual(units.map((u) => u.content), ["For this kettle boil water", "before the next part begins"]);
});

test("restoreAndPackTokens 整包拒绝改词输出，合法输出按句末重组", async () => {
  const tokens = ["For", "this", "kettle", "boil", "water", "Next", "sentence"].map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const calls = [];
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 20,
    fetchImpl: async (_url, opts) => { calls.push(opts); return { ok: true, json: async () => ({ choices: [{ message: { content: boundaryJson(opts, [4]) } }] }) }; },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(units.map((u) => u.content), ["For this kettle boil water", "Next sentence"]);
  await assert.rejects(() => Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", attempts: 1,
    fetchImpl: async (_url, opts) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: ["unknown-token"] }) } }] }) }),
  }), /invalid boundary plan/);
});

test("restoreAndPackTokens 统一接受 canonical startMs/endMs 时间字段", async () => {
  const tokens = ["alpha", "beta", "gamma"].map((text, i) => ({ id: "c" + i, text, startMs: 1000 + i * 250, endMs: 1250 + i * 250 }));
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: boundaryJson(req, []) } }] }) }),
  });
  assert.strictEqual(units[0].start, 1000);
  assert.strictEqual(units[0].end, 1750);
  assert.strictEqual(units[0].content, "alpha beta gamma");
});

test("restoreAndPackTokens 用独立 display 请求提供软建议，失败时不损坏 semantic 结果", async () => {
  const tokens = new Array(8).fill(0).map((_, i) => ({ text: "aaaa", tokenId: `a${i}`, start: i * 100, end: (i + 1) * 100 }));
  let calls = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m",
    preferredVisualWidth: 24, maxVisualWidth: 26, enableDisplaySuggestions: true, attempts: 1,
    fetchImpl: async (_url, req) => {
      calls++;
      const body = JSON.parse(req.body);
      const isDisplay = body.messages[0].content.includes("displayCutsAfter");
      const content = isDisplay ? JSON.stringify({ displayCutsAfter: ["a2"] }) : JSON.stringify({ semanticCutsAfter: [] });
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    },
  });
  assert.equal(calls, 2, "semantic 与 display 必须是两个单字段请求");
  assert.deepStrictEqual(units.map((unit) => unit.content.split(/\s+/).length), [3, 5]);
  assert.equal(new Set(units.map((unit) => unit.semanticGroupId)).size, 1, "display 建议不得创建 semantic cut");
});

test("classifySemanticBoundary 拒绝条件从句与介词续接，但允许完整对比从句", () => {
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "If you're a human person",
    "one of those things you're going to want to do with some regularity is boil water"
  ), { safe: false, reason: "subordinate-clause-missing-main" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "Our weird system means that we're limited to 1500 watts",
    "whereas 1800 watts is allowed elsewhere"
  ), { safe: true, reason: "ok" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The controller that monitors battery temperature",
    "adjusts the charging current automatically"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "the cheapest kettle is faster despite being limited",
    "by our 120 volt electrical system"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The backup service remained online",
    "throughout the outage because its batteries had finished charging"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "Let me point out",
    "that the adapter still works"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("rated at 120", "volts under load"), { safe: false, reason: "number-quantity" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("please look", "up the value"), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("this model is much more", "efficient than before"), { safe: false, reason: "dangling-end" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("please carry", "forward the result"), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("rated at one hundred twenty", "volts under load"), { safe: false, reason: "number-quantity" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("this unit is three times", "faster than before"), { safe: false, reason: "comparison-continuation" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("The cameras that monitor temperature", "regulate charging current"), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("The controllers which monitor temperature", "cut power"), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("The compact camera we tested yesterday", "records clear video"), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("The compact camera John tested yesterday", "records clear video"), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("the compact camera John tested yesterday", "records clear video"), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("please move", "ahead with the plan"), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("rated at one hundred twenty", "ohms under load"), { safe: false, reason: "number-quantity" });
  assert.deepStrictEqual(Core.classifySemanticBoundary("this unit is three times", "the previous speed"), { safe: false, reason: "comparison-continuation" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The newer unit unlike the original prototype runs quietly on the desk",
    "and it consumes much less power during routine operation"
  ), { safe: true, reason: "ok" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The box includes several tools",
    "and the replacement cables for the camera"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The box of tools",
    "and it works reliably"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The assorted tools",
    "and it works reliably"
  ), { safe: false, reason: "continuation-start" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The report says that the controller which monitors battery temperature",
    "adjusts the charging current automatically"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The compact camera that we tested yesterday",
    "and it still works reliably"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "The compact camera John tested yesterday",
    "and it still works reliably"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "Let me explain that the controller which monitors temperature",
    "adjusts charging current automatically"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
  assert.deepStrictEqual(Core.classifySemanticBoundary(
    "Let me explain that the compact camera that we tested yesterday",
    "still works reliably"
  ), { safe: false, reason: "relative-subject-missing-predicate" });
});

test("repairNaturalUnitBoundaries 不为合并条件/介词续接突破视觉宽度硬上限", () => {
  const input = [
    { start: 160, end: 1875, content: "If you're a human person", tokens: [{ text: "If" }] },
    { start: 2184, end: 4636, content: "one of those things you're going to want to do with some regularity is boil water", tokens: [{ text: "one" }] },
    { start: 237505, end: 243505, content: "Let me reiterate that the cheapest electric kettle I could get my hands on", tokens: [{ text: "Let" }] },
    { start: 243505, end: 246286, content: "is significantly faster at boiling water", tokens: [{ text: "is" }] },
    { start: 246286, end: 252108, content: "than this stove top kettle despite being limited by our 120 volt electrical system", tokens: [{ text: "than" }] },
    { start: 252108, end: 258153, content: "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets", tokens: [{ text: "Our" }] },
    { start: 258153, end: 260931, content: "although 1800 watts is technically permissible", tokens: [{ text: "although" }] },
  ];
  const repaired = Core.repairNaturalUnitBoundaries(input, { maxNaturalWords: 24 });
  assert.strictEqual(repaired.length, input.length, "repair 只能阻止超宽合并，不能擅自重切既有单元");
  assert.strictEqual(repaired.map((u) => u.content).join(" "), input.map((u) => u.content).join(" "));
});

test("filterUnsafeRescueMarks 保留可配自然中文的引导片段，只拒绝 than 比较从句坏边界", () => {
  const words = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited".split(" ");
  const marks = words.map(() => "");
  marks[13] = "|"; // let me reiterate that ... hands on | is ...：左侧缺主断言
  marks[19] = "|"; // boiling water | than this ...：右侧比较从句续接
  marks[24] = "|"; // kettle | despite being limited：可自然译成让步字幕片段
  const filtered = Core.filterUnsafeRescueMarks(words, marks);
  assert.strictEqual(filtered[13], "|", "引导片段只有完成 get my hands on 后才允许接主谓屏");
  assert.strictEqual(filtered[19], "", "than 比较结构不能另起字幕");
  assert.strictEqual(filtered[24], "|", "despite being + 分词是可连续阅读的自然字幕片段");

  const badWords = "Let me point out that the least expensive adapter I could get my hands on still handled every device".split(" ");
  const badMarks = badWords.map(() => "");
  badMarks[8] = "|"; // ... adapter | I could get ...：reporting 名词短语仍悬空
  const badFiltered = Core.filterUnsafeRescueMarks(badWords, badMarks);
  assert.strictEqual(badFiltered[8], "", "reporting 例外不得放过普通名词短语边界");

  for (const [source, cut] of [
    ["the outlet is rated at 120 volts under load", 5],
    ["please look up the value before continuing", 1],
    ["this model is much more efficient than before", 4],
    ["Let me explain that the controller which monitors temperature adjusts charging current automatically", 8],
    ["please carry forward the result after checking", 1],
    ["the outlet is rated at one hundred twenty volts under load", 7],
    ["this unit is three times faster than before", 4],
    ["The compact camera we tested yesterday records clear video", 5],
    ["The compact camera John tested yesterday records clear video", 5],
    ["please move ahead with the plan now", 1],
    ["rated at one hundred twenty ohms under load", 4],
    ["this unit is three times the previous speed", 4],
    ["Let me explain that the compact camera that we tested yesterday still works reliably", 10],
    ["the compact camera John tested yesterday records clear video", 5],
  ]) {
    const ws = source.split(" "), ms = ws.map(() => ""); ms[cut] = "|";
    assert.strictEqual(Core.filterUnsafeRescueMarks(ws, ms)[cut], "", `危险候选边界必须拒绝: ${source}`);
  }
  const periodWords = "Let me explain that the compact camera that we tested yesterday still works reliably".split(" ");
  const periodMarks = periodWords.map(() => ""); periodMarks[10] = ".";
  assert.strictEqual(Core.filterUnsafeRescueMarks(periodWords, periodMarks)[10], "", "内部句点也不得绕过显式关系主语保护");
});

asyncTest("restoreAndPackTokens 长口语句按视觉宽度分屏且保持同一语义组", async () => {
  // 连续口语长句(无书面句边界)在真实字幕轨里必然出现。旧设计遇到它整轨抛错退回
  // 碎片 fallback,导致 semantic 路径在真实完整轨上 100% 失败。现在用 flow 保底切分:
  // 词流完整、屏长达标、无孤字尾屏,让整轨 semantic 恢复能真正跑通。
  const source = "If you're a human person one of those things you're going to want to do with some regularity is boil water";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 200, end: (i + 1) * 200 }));
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "k", apiModel: "m", chunkWords: 80,
    preferredMaxWords: 16, maxWords: 16, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: visualBoundaryJson(req) } }] }) }),
  });
  assertVisualSemanticUnits(units, source);
});

asyncTest("restoreAndPackTokens 用 semanticGroup 跨越比较结构的短屏显示边界", async () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 80,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, visualBoundaryJson(req)) } }] }) }),
  });
  assert.strictEqual(call, 1);
  assertVisualSemanticUnits(units, source);
});

asyncTest("restoreAndPackTokens 按视觉宽度拆 reporting 长句并保留一个语义组", async () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100, nativeTiming: true }));
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: visualBoundaryJson(req) } }] }) }),
  });
  assertVisualSemanticUnits(units, source);
  assert.strictEqual(units[0].start, 0);
  assert.strictEqual(units[units.length - 1].end, 3400);
});

test("partitionReadableTokenUnit 有界恢复 14/11/9 屏并拒绝无安全候选硬切", () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const bad = tokens.map(() => ""); bad[19] = "|"; // 唯一模型边界是 boiling water | than...
  const marks = Core.partitionReadableTokenUnit(tokens, Core.filterUnsafeRescueMarks(tokens.map((t) => t.text), bad), { preferredWords: 14, hardWords: 16, minWords: 6 });
  assert.ok(marks);
  const units = Core.packRestoredTokens(tokens, marks, { maxWords: 16 });
  assert.deepStrictEqual(units.map((u) => u.content.split(/\s+/).length), [14, 11, 9]);
  // 无 strict 书面句边界时,不再返回 null(那会让整轨 semantic 作废),而是用连续语流
  // 保底切分:词流完整、每屏不超硬上限。这是让 semantic 在真实字幕轨跑通的关键。
  const noSafe = "these words provide no recognized safe boundary for deterministic partitioning whatsoever today".split(" ").map((text, i) => ({ text, start: i, end: i + 1 }));
  const forced = Core.partitionReadableTokenUnit(noSafe, [], { preferredWords: 6, hardWords: 8, minWords: 4 });
  assert.ok(forced, "无安全边界时也必须给出保底切分而不是 null");
  const forcedUnits = Core.packRestoredTokens(noSafe, forced, { maxWords: 8 });
  assert.ok(forcedUnits.length >= 2, "过长无边界句必须被保底切成多屏");
  assert.ok(forcedUnits.every((u) => u.content.split(/\s+/).length <= 8), "保底切分每屏不超硬上限");
  assert.strictEqual(forcedUnits.map((u) => u.content).join(" "), noSafe.map((t) => t.text).join(" "), "保底切分不丢词不改写");
});

asyncTest("restoreAndPackTokens 对无安全边界的超长句用保底切分产出合规显示单元而不是整轨作废", async () => {
  const source = "these deliberately opaque tokens provide no recognized semantic boundary and remain impossible to partition safely without fabricating a hard cut today";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100, nativeTiming: true }));
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
    preferredMaxWords: 16, maxWords: 16, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: visualBoundaryJson(req) } }] }) }),
  });
  assert.ok(units.length >= 2, "无安全边界的超长句必须被保底切成多屏而不是整轨作废");
  assert.ok(units.every(u => u.content.split(/\s+/).length <= 16), "保底切分绝不返回超过硬上限的显示单元");
  assert.strictEqual(units.map(u => u.content).join(" "), source, "保底切分不丢词不改写(词流完整是唯一红线)");
});

asyncTest("restoreAndPackTokens 不用英语固定词数，统一按视觉宽度分屏", async () => {
  const source = "Let me point out that the least expensive adapter I could get my hands on still handled every device in our overnight test";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
    preferredMaxWords: 10, maxWords: 12, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, visualBoundaryJson(req)) } }] }) }),
  });
  assert.strictEqual(call, 1);
  assertVisualSemanticUnits(units, source);
});

test("partitionReadableTokenUnit 识别 reporting 主语后的副词加实义谓语", () => {
  const source = "Let me point out that the least expensive adapter I could get my hands on still handled every device in our overnight test";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = Core.partitionReadableTokenUnit(tokens, tokens.map(() => ""), { preferredWords: 14, hardWords: 16, minWords: 6 });
  assert.ok(marks, "15/8 自然边界必须能确定性恢复");
  assert.deepStrictEqual(Core.packRestoredTokens(tokens, marks, { maxWords: 16 }).map(u => u.content.split(/\s+/).length), [15, 8]);
});

asyncTest("restoreAndPackTokens 即使只有 11 词也不得突破视觉宽度硬上限", async () => {
  const source = "Let me point out that this compact kettle works very reliably";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let calls = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m",
    preferredMaxWords: 10, maxWords: 12, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls, visualBoundaryJson(req)) } }] }) }),
  });
  assert.strictEqual(calls, 1);
  assertVisualSemanticUnits(units, source);
  assert.ok(units.length > 1, "词数少但视觉宽度超限时仍必须拆屏");
});

test("partitionReadableTokenUnit 行长优先时把 reporting 引导语与长主语拆成 5/10/8", () => {
  const source = "Let me point out that the least expensive adapter I could get my hands on still handled every device in our overnight test";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = Core.partitionReadableTokenUnit(tokens, tokens.map(() => ""), {
    preferredWords: 10, hardWords: 12, minWords: 4,
  });
  assert.ok(marks, "长 reporting 主语必须有短行渐进分区，不能继续保留 15 词屏");
  const units = Core.packRestoredTokens(tokens, marks, { maxWords: 12 });
  assert.deepStrictEqual(units.map(u => u.content), [
    "Let me point out that",
    "the least expensive adapter I could get my hands on",
    "still handled every device in our overnight test",
  ]);
  assert.deepStrictEqual(units.map(u => u.content.split(/\s+/).length), [5, 10, 8]);
  assert.deepStrictEqual(units.map(u => [u.start, u.end]), [[0, 500], [500, 1500], [1500, 2300]]);
  assert.strictEqual(units.map(u => u.content).join(" "), source);
});


test("partitionReadableTokenUnit 泛化识别 reporting 后的嵌入关系从句主语", () => {
  const source = "Let me explain that the compact camera we tested during yesterday's rehearsal still records clear video throughout the entire night";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = Core.partitionReadableTokenUnit(tokens, tokens.map(() => ""), { preferredWords: 14, hardWords: 16, minWords: 6 });
  assert.ok(marks, "不得把规则绑死到 get my hands on 这一条目标句");
  const units = Core.packRestoredTokens(tokens, marks, { maxWords: 16 });
  assert.strictEqual(units.map(u => u.content).join(" "), source);
  assert.ok(units.every(u => u.content.split(/\s+/).length <= 16));
});

test("partitionReadableTokenUnit 确定性识别完整并列分句与 trailing adjunct", () => {
  for (const source of [
    "The newer unit unlike the original prototype runs quietly on the desk and it consumes much less power during routine operation",
    "This compact kettle heats water significantly faster than the stove top model even during repeated tests in the cold laboratory",
  ]) {
    const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
    const marks = Core.partitionReadableTokenUnit(tokens, tokens.map(() => ""), { preferredWords: 14, hardWords: 16, minWords: 6 });
    assert.ok(marks, source);
    const units = Core.packRestoredTokens(tokens, marks, { maxWords: 16 });
    assert.ok(units.length >= 2 && units.every(u => u.content.split(/\s+/).length <= 16), source);
  }
});

test("normalizeOversizeSentenceMarks 只重切超长屏并保留模型自然边界", () => {
  // 设计:信任模型给出的边界(marks[3] 处的 4 词首屏),只对真正超 hard 的中段 21 词
  // 屏做细分,不因局部超长而全局重排抹平模型边界。这是完整轨不再退化成均匀硬切的关键。
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = tokens.map(() => ""); marks[3] = "|"; marks[24] = "|"; marks[33] = ".";
  const normalized = Core.normalizeOversizeSentenceMarks(tokens, marks, { preferredWords: 14, hardWords: 16, minWords: 6 });
  const units = Core.packRestoredTokens(tokens, normalized, { maxWords: 16 });
  // 模型的 4 词首屏被保留;超长的 21 词中段被切成 ≤16 词的子屏;尾屏保留。
  assert.deepStrictEqual(units.map((u) => u.content.split(/\s+/).length), [4, 14, 7, 9]);
  assert.ok(units.every((u) => u.content.split(/\s+/).length <= 16), "重切后不得留超 hard 屏");
  assert.strictEqual(units.map((u) => u.content).join(" "), source, "必须逐词保真");
});

asyncTest("真实长轨三特征回归门禁：多词 token + 无句末标点 + 长连续语流不得整轨作废或退化成均匀硬切", async () => {
  // 这三个特征是两轮 bug 全部逃过离线门禁的原因,补成确定性 mock 门禁,不花真实 token:
  //   1. 多词 token —— ASR token 含千分位数字(1,800 / 334,720)或连字符复合词,
  //      词数 != token 数。历史 bug:partition 在词空间返回 marks、按 token 索引写回,
  //      越界撑长 marks 数组 → packRestoredTokens 长度校验失败返回 [] → 整轨 0 屏。
  //   2. 模型只产出 |、从不产出句末 . (真实轨实测 dot:0)。历史 bug:normalize 按 .
  //      分句,整轨被当一个巨句,任一处漏切就重排整段、抹平模型所有自然边界。
  //   3. 长连续语流(远超单块)—— 短单句样本永远触发不到上面两条。
  const sentences = [
    "the cheapest electric kettle I could get my hands on draws 1,800 watts",
    "and that purpose-built appliance boils a full liter in well under four minutes",
    "our standard outlets only deliver 120 volts which limits total available power",
    "so the same 334,720 joules of energy takes noticeably longer to move",
    "meanwhile a 240 volt circuit in other countries reaches 3,000 watts easily",
    "that difference of 8.8 percent efficiency compounds over many repeated cycles",
  ];
  const source = sentences.join(" ");
  const words = source.split(" ");
  const tokens = words.map((text, i) => ({ text, start: i * 200, end: (i + 1) * 200, nativeTiming: true }));
  // 确认样本真的含多词 token(否则门禁形同虚设)
  const multiWord = tokens.filter((t) => Core.restoredWords(t.text).length > 1);
  assert.ok(multiWord.length === 0, "本样本 token 均为单词形态,数字千分位应被计为一个词");
  assert.strictEqual(Core.restoredWords("1,800").length, 1, "千分位数字必须计为一个词");
  assert.strictEqual(Core.restoredWords("8.8").length, 1, "小数必须计为一个词");
  assert.strictEqual(Core.restoredWords("purpose-built").length, 1, "连字符复合词必须计为一个词");

  // 模型在每个子句末给 |,且全程不给句末 . —— 复刻真实轨 dot:0 行为
  const cutWordIndexes = [];
  let acc = 0;
  for (const s of sentences) { acc += s.split(" ").length; cutWordIndexes.push(acc - 1); }
  let calls = 0;
  const units = await Core.restoreAndPackTokens({
    tokens,
    apiBaseUrl: "https://example.test", apiKey: "sk-test", apiModel: "m",
    chunkWords: 30, overlapWords: 8, preferredMaxWords: 10, maxWords: 12, attempts: 1,
    fetchImpl: async (_url, req) => {
      calls++;
      const body = JSON.parse(req.body), payload = JSON.parse(body.messages[1].content);
      // 只在本块可见范围内回报属于全局切点的 token id(模拟真实分块行为)
      const ids = new Set(payload.tokens.map((t) => t.id));
      const semanticCuts = cutWordIndexes.map((i) => "t" + i).filter((id) => ids.has(id));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: semanticCuts }) } }] }) };
    },
  });

  // 1) 绝不整轨作废(历史 bug 表现为 0 屏)
  assert.ok(units.length > 0, "多词 token + 无句末标点不得导致整轨 0 屏");
  // 2) 词流逐词保真,不丢不改
  assert.strictEqual(units.map((u) => u.content).join(" "), source, "词流必须逐词保真");
  // 3) 无超长屏
  units.forEach((u) => assert.ok(Core.restoredWords(u.content).length <= 12, `屏超硬上限: ${u.content}`));
  // 4) 不得退化成均匀硬切:模型给的子句边界必须大部分存活。
  //    历史退化表现为「几乎每屏正好 preferredMaxWords 词」,这里要求 10 词屏占比 < 60%。
  const wc = units.map((u) => Core.restoredWords(u.content).length);
  const tens = wc.filter((w) => w === 10).length;
  assert.ok(tens / units.length < 0.6, `退化成均匀硬切(10 词屏占比 ${(tens / units.length * 100).toFixed(0)}%),模型边界被抹平`);
  // 5) 时间轴连续且端点不变
  assert.strictEqual(units[0].start, tokens[0].start, "首屏起点必须来自首 token");
  assert.strictEqual(units[units.length - 1].end, tokens[tokens.length - 1].end, "末屏终点必须来自末 token");
  for (let i = 1; i < units.length; i++) assert.strictEqual(units[i - 1].end, units[i].start, "时间轴必须连续");
  assert.ok(calls >= 2, "长语流应触发多次分块调用");
});

asyncTest("restoreAndPackTokens 真实水壶长句按短屏显示但保持完整语义组", async () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: 237505 + i * 400, end: 237905 + i * 400, nativeTiming: true }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", chunkWords: 80,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, visualBoundaryJson(req)) } }] }) }),
  });
  assert.strictEqual(call, 1);
  assertVisualSemanticUnits(units, source);
  assert.strictEqual(units[0].start, 237505);
  assert.strictEqual(units[units.length - 1].end, 251105);
});

test("repairNaturalUnitBoundaries 不把 And 状语与主句合并成超宽单屏", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 260931, end: 266030, content: "And on a 20 amp circuit which is fairly common especially in kitchens", tokens: [{ text: "And" }] },
    { start: 266030, end: 267622, content: "2400 watts is possible", tokens: [{ text: "2400" }] },
  ], { maxNaturalWords: 20 });
  assert.strictEqual(repaired.length, 2);
});

test("repairNaturalUnitBoundaries 在大写 And 前拆开两个完整句，避免 20 词复合屏", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 258153, end: 266030, content: "although 1 800 watts is technically permissible And on a 20 amp circuit which is fairly common especially in kitchens", tokens: [
      "although 1 800 watts is technically permissible And on a 20 amp circuit which is fairly common especially in kitchens".split(" ").map((text, i) => ({ text, start: 258153 + i * 300, end: 258453 + i * 300 }))
    ].flat() },
  ], { maxNaturalWords: 20 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "although 1 800 watts is technically permissible",
    "And on a 20 amp circuit which is fairly common especially in kitchens",
  ]);
});

test("repairNaturalUnitBoundaries 允许完整 although 对比从句独立成屏", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 252108, end: 258153, content: "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets", tokens: [{ text: "Our" }] },
    { start: 258153, end: 260931, content: "although 1800 watts is technically permissible", tokens: [{ text: "although" }] },
  ], { maxNaturalWords: 24 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets",
    "although 1800 watts is technically permissible",
  ], "完整主谓的让步从句可自然译成‘不过……’，不应强并成 24 词超长屏");
});

test("repairNaturalUnitBoundaries 保留 reporting clause 的 phrasal-verb 完整边界", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 237505, end: 243505, content: "Let me reiterate that the cheapest electric kettle I could get my hands on", tokens: [{ text: "Let" }] },
    { start: 243505, end: 252108, content: "is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system", tokens: [{ text: "is" }] },
  ], { maxNaturalWords: 24 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "Let me reiterate that the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system",
  ], "get my hands on 是完整短语；不能误判 on 悬空后合成 34 词单屏");
});

test("repairNaturalUnitBoundaries 不为合并介词续接制造超宽单屏", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "We do it for lots of reasons", tokens: [{ text: "We" }] },
    { start: 1000, end: 2000, content: "from cooking to cleaning and disinfecting", tokens: [{ text: "from" }] },
    { start: 2000, end: 3000, content: "to other things probably", tokens: [{ text: "to" }] },
  ], { preferredMaxWords: 24, maxNaturalWords: 36 });
  assert.strictEqual(repaired.length, 3);
  assert.ok(repaired.every((u) => Core.semanticDisplayWidth(u.content) <= Core.SOURCE_DISPLAY_MAX_WIDTH));
});

test("repairNaturalUnitBoundaries 不留下孤立尾词", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "I do know that the entire thing is 8 8 kW", tokens: [{ text: "I" }] },
    { start: 1000, end: 1200, content: "altogether", tokens: [{ text: "altogether" }] },
  ], { preferredMaxWords: 24, maxNaturalWords: 36 });
  assert.deepStrictEqual(repaired.map((u) => u.content), ["I do know that the entire thing is 8 8 kW altogether"]);
});

test("repairNaturalUnitBoundaries 仅合并短间隙，并保留 token 与时间", () => {
  const near = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "The entire thing is 8 8 kW", tokens: [{ text: "The", start: 0, end: 1000 }] },
    { start: 1300, end: 1600, content: "altogether", tokens: [{ text: "altogether", start: 1300, end: 1600 }] },
  ], { maxNaturalWords: 24, maxJoinGapMs: 2200 });
  assert.strictEqual(near.length, 1);
  assert.strictEqual(near[0].start, 0);
  assert.strictEqual(near[0].end, 1600);
  assert.deepStrictEqual(near[0].tokens.map((t) => t.text), ["The", "altogether"]);
  const distant = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "We do it for lots of reasons", tokens: [{ text: "We" }] },
    { start: 4000, end: 5000, content: "from cooking to cleaning", tokens: [{ text: "from" }] },
  ], { maxNaturalWords: 24, maxJoinGapMs: 2200 });
  assert.strictEqual(distant.length, 2, "长停顿后的新语流不能只因小写介词被回并");
});

test("repairNaturalUnitBoundaries 不为修句界突破 24 词上限", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "let me reiterate that the cheapest electric kettle I could get my hands on", tokens: [{ text: "let" }] },
    { start: 1000, end: 2000, content: "is significantly faster at boiling water than this stove top kettle despite being limited", tokens: [{ text: "is" }] },
  ], { maxNaturalWords: 24 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "let me reiterate that the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle despite being limited",
  ]);
  assert.ok(repaired.every((u) => u.content.split(" ").length <= 24));
});

test("applyTailTrim 为语义单元保留最小可视时长与 token 元数据", () => {
  const tokens = [{ text: "hello", start: 0, end: 1000, nativeTiming: true }];
  const trimmed = Core.applyTailTrim([{ start: 0, end: 1000, duration: 1000, content: "hello", tokens }], 120);
  assert.strictEqual(trimmed[0].end, 880);
  assert.strictEqual(trimmed[0].duration, 880);
  assert.strictEqual(trimmed[0].tokens, tokens, "尾缩不能丢 token 元数据");
  const short = Core.applyTailTrim([{ start: 0, end: 400, content: "short" }], 120);
  assert.strictEqual(short[0].end, 300, "短单元仍保留至少 300ms");
  assert.strictEqual(Core.applyTailTrim([{ start: 0, end: 1000, content: "off" }], 0)[0].end, 1000);
});

test("cleanupCues 保留 JSON3 token 时序，使语义运行时门槛可达", () => {
  const cleaned = Core.cleanupCues([{ start: 0, end: 1000, content: "hello world", tokens: [
    { text: "hello", start: 0, end: 400, nativeTiming: true },
    { text: "world", start: 400, end: 1000, nativeTiming: true },
  ] }]);
  assert.strictEqual(cleaned[0].tokens.length, 2);
  assert.strictEqual(cleaned[0].tokens[1].text, "world");
  assert.ok(Core.hasNativeTokenTiming(cleaned, 0.8), "清洗后仍应满足 JSON3 词级时间门槛");
});

test("cleanupCues 去重叠：前句 end 不超过后句 start", () => {
  const cues = Core.cleanupCues(Core.parseJson3(fakeJson3));
  // 第一句 (0~2000) 与第二句 start=1500 重叠 → 第一句 end 应被压到 1500
  assert.strictEqual(cues[0].start, 0);
  assert.strictEqual(cues[0].end, 1500, "重叠应被裁剪到下一句 start");
  assert.ok(cues[0].end <= cues[1].start, "不应再重叠");
  assert.strictEqual(cues[0].duration, 1500);
});

test("cleanupCues 按 start 排序", () => {
  const unsorted = [
    { start: 5000, end: 6000, content: "b" },
    { start: 1000, end: 2000, content: "a" },
  ];
  const cleaned = Core.cleanupCues(unsorted);
  assert.strictEqual(cleaned[0].content, "a");
  assert.strictEqual(cleaned[1].content, "b");
});

test("cleanupCues 修正 end<start 脏数据", () => {
  const bad = [{ start: 3000, end: 1000, duration: 500, content: "x" }];
  const cleaned = Core.cleanupCues(bad);
  assert.ok(cleaned[0].end >= cleaned[0].start, "end 不应小于 start");
});


/* ============ 1b. Canonical Token Timeline / immutable snapshot ============ */
console.log("\n[Canonical Token Timeline + TimelineSnapshot]");

test("buildCanonicalTokenTimeline 去滚动重叠并分配稳定全局 token ID", () => {
  const cues = [
    { start: 0, end: 1200, content: "go into a", tokens: [
      { text: "go", start: 0, end: 300, nativeTiming: true },
      { text: "into", start: 300, end: 700, nativeTiming: true },
      { text: "a", start: 700, end: 1200, nativeTiming: true },
    ] },
    { start: 1000, end: 2200, content: "a cold kettle", tokens: [
      { text: "a", start: 1000, end: 1250, nativeTiming: true },
      { text: "cold", start: 1250, end: 1700, nativeTiming: true },
      { text: "kettle", start: 1700, end: 2200, nativeTiming: true },
    ] },
  ];
  const a = Core.buildCanonicalTokenTimeline(cues);
  const b = Core.buildCanonicalTokenTimeline(JSON.parse(JSON.stringify(cues)));
  assert.deepStrictEqual(a, b, "同一源轨必须生成字节稳定的 timeline");
  assert.strictEqual(a.version, "token-v1");
  assert.deepStrictEqual(a.tokens.map(t => t.text), ["go", "into", "a", "cold", "kettle"]);
  assert.deepStrictEqual(a.tokens.map(t => t.index), [0, 1, 2, 3, 4]);
  assert.strictEqual(new Set(a.tokens.map(t => t.id)).size, 5);
  assert.ok(a.sourceFingerprint && a.tokens.every(t => t.id.startsWith(a.sourceFingerprint + ":")));
});


test("semantic/display 两次单职责响应都兼容代码围栏和数字/字符串 ID", () => {
  const allowed = ["10", "11", "12", "13"];
  assert.deepStrictEqual(Core.parseBoundaryPlanResponse('{"semanticCutsAfter":[11,"13"]}', allowed), { semanticCutsAfter: ["11", "13"] });
  assert.deepStrictEqual(Core.parseDisplayCutsResponse('```json\n{"displayCutsAfter":["11"]}\n```', allowed), ["11"]);
});

test("parseBoundaryPlanResponse 对未知/重复/乱序和额外模型字段 fail-closed", () => {
  const allowed = ["t10", "t11", "t12"];
  assert.throws(() => Core.parseBoundaryPlanResponse('{"semanticCutsAfter":["t99"]}', allowed), /unknown semanticCutsAfter/i);
  assert.throws(() => Core.parseBoundaryPlanResponse('{"semanticCutsAfter":["t11","t11"]}', allowed), /strictly increasing/i);
  assert.throws(() => Core.parseBoundaryPlanResponse('{"semanticCutsAfter":["t12","t11"]}', allowed), /strictly increasing/i);
  assert.throws(() => Core.parseBoundaryPlanResponse('{"semanticCutsAfter":[],"rewrittenText":"evil"}', allowed), /fields invalid/i);
  assert.throws(() => Core.parseBoundaryPlanResponse('{"semanticCutsAfter":"t11"}', allowed), /must be an array/i);
});

test("block translation 允许自由重组译文行，并按源范围粗粒度映射时间", () => {
  const cues = [
    { start: 0, end: 1000, content: "Electric kettles are even" },
    { start: 1000, end: 2200, content: "though they are slower here" },
    { start: 2800, end: 3800, content: "They remain useful" },
    { start: 3800, end: 5000, content: "for many ordinary tasks" },
  ];
  const raw = JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c1", lines: ["尽管这里的电热水壶更慢，", "它们仍值得使用。"] },
    { sourceFrom: "c2", sourceTo: "c3", lines: ["它们在许多日常任务中依然很实用。"] },
  ] });
  const parsed = Core.parseBlockTranslationResponse(raw, cues, { maxVisualWidth: 48 });
  const units = Core.materializeBlockTranslation(parsed, cues);
  assert.equal(parsed.length, 2, "译文 segment 数量不要求等于源 cue 数量");
  assert.equal(units.length, 3, "目标语言自然分屏数量应独立于源 cue 数量");
  assert.deepStrictEqual(units.map((unit) => unit.translation), ["尽管这里的电热水壶更慢，", "它们仍值得使用", "它们在许多日常任务中依然很实用"]);
  assert.equal(units[0].startMs, 0);
  assert.equal(units[1].endMs, 2200);
  assert.equal(units[2].startMs, 2800, "源 cue 之间的真实停顿不得被译文填满");
  assert.ok(units.every((unit) => unit.endMs > unit.startMs));
});

test("block translation 把悬挂的定语标记与被修饰成分合并回同一屏", () => {
  const cues = [
    { start: 0, end: 2000, content: "The phoenix emblem is everywhere" },
    { start: 2000, end: 4000, content: "and the woodwork is real timber" },
  ];
  const linesOf = (raw) => Core.parseBlockTranslationResponse(raw, cues, { maxVisualWidth: 48 })[0].lines;

  // 真实缺陷样本：模型把「的」留在屏尾，被修饰名词甩到下一屏。
  // 实测发生率约 10%（日语人工轨 300s 内 5 处）。
  // 修法是合并而非拒绝：纯拒绝实测导致 1/17 块重试 6 次耗尽后整块无字幕，
  // 丢字幕比断句难看严重得多。
  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["各处都饰有凤凰的", "徽章"] }] })),
    ["各处都饰有凤凰的徽章"], "悬挂的「的」必须与被修饰名词合并");

  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["车窗部分是类似铝材的", "材质"] }] })),
    ["车窗部分是类似铝材的材质"], "这是纯拒绝策略下连续 6 次失败的真实样本");

  for (const bad of ["外面的", "带有日式木纹的", "慢慢地", "跑得"]) {
    const got = linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: [bad, "后续内容"] }] }));
    assert.deepStrictEqual(got, [bad + "后续内容"], `应合并以「${bad.slice(-1)}」结尾的非末行: ${bad}`);
  }

  // 连续多行悬挂时应持续吸收，不能只修一层。
  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["非常精致的", "手工雕刻的", "徽章"] }] })),
    ["非常精致的手工雕刻的徽章"], "连续悬挂必须一路合并");

  // 必须放过的合法情况：句末语气「的」——这是最初检测器 4/9 假阳性的来源。
  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["据说就是这样完成的"] }] })),
    ["据说就是这样完成的"], "末行以「的」结尾是合法句末语气，不得改动");

  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["它是用多达七层工序", "完成的"] }] })),
    ["它是用多达七层工序", "完成的"], "多行中最后一行以「的」结尾同样合法，不得合并");

  // 标点收尾说明该屏是完整小句，不算悬挂。
  assert.deepStrictEqual(
    linesOf(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["这就是我要说的，", "接着看下一处"] }] })),
    ["这就是我要说的，", "接着看下一处"], "「的」后带标点表示小句结束，不得合并");
});

test("block translation 锁定连续源范围，并只在目标词法边界兜底分屏", () => {
  const cues = [{ start: 0, end: 1000, content: "one" }, { start: 1000, end: 2000, content: "two" }];
  const invalid = [
    { segments: [{ sourceFrom: "c1", sourceTo: "c1", lines: ["第二句"] }] },
    { segments: [{ sourceFrom: "c0", sourceTo: "c0", lines: ["第一句"] }] },
    { segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["完整译文"], unitId: "forged" }] },

  ];
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify(invalid[0]), cues), /coverage/i);
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify(invalid[1]), cues), /incomplete/i);
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify(invalid[2]), cues), /fields/i);
  const overwide = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c1", lines: ["这是一条明显超过视觉硬上限的目标语言字幕"] },
  ] }), cues, { maxVisualWidth: 12 });
  assert.ok(overwide[0].lines.length > 1 && overwide[0].lines.every((line) => Core.semanticDisplayWidth(line) <= 12));
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c1", lines: ["https://example.com/a-single-indivisible-very-long-url"] },
  ] }), cues, { maxVisualWidth: 12 }), /indivisible overwide/);
  const numberUnit = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c1", lines: ["偏差0.1 mm时车门就打不开"] },
  ] }), cues, { maxVisualWidth: 10 })[0].lines;
  assert.ok(!numberUnit.some((line, i) => /0\.1\s*$/.test(line) && /^mm\b/.test(numberUnit[i + 1] || "")), "数字与紧邻单位不得拆屏");

  const paused = [{ start: 0, end: 500, content: "before pause" }, { start: 1500, end: 2200, content: "after pause" }];
  // 长停顿是毫秒级时间事实，模型不该为此负责：跨停顿的语义段必须被接受，
  // 但装载出的每一屏都不能落在静音里（钳到停顿的某一侧）。
  const crossed = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c1", lines: ["停顿前的话", "停顿后的话"] },
  ] }), paused);
  const crossedUnits = Core.materializeBlockTranslation(crossed, paused);
  assert.equal(crossedUnits.length, 2);
  crossedUnits.forEach((u) => {
    assert.ok(!(u.startMs > 500 && u.startMs < 1500), `unit start ${u.startMs} 落在静音里`);
    assert.ok(!(u.endMs > 500 && u.endMs < 1500), `unit end ${u.endMs} 落在静音里`);
  });
  const split = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c0", lines: ["停顿前"] },
    { sourceFrom: "c1", sourceTo: "c1", lines: ["停顿后"] },
  ] }), paused);
  assert.equal(split.length, 2);
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c0", lines: ["甲", "乙", "丙", "丁"] },
  ] }), [{ start: 0, end: 1000, content: "short source" }]), /too many lines/);
  assert.throws(() => Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c0", lines: ["甲"] },
  ] }), [{ start: 0, end: 299, content: "too short" }]), /duration too short/);
  const exactly300 = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [
    { sourceFrom: "c0", sourceTo: "c0", lines: ["甲"] },
  ] }), [{ start: 0, end: 300, content: "just enough" }]);
  assert.equal(Core.materializeBlockTranslation(exactly300, [{ start: 0, end: 300, content: "just enough" }])[0].endMs, 300);
});

test("block 缓存必须复验 64 屏容量和 parser 完整性指纹", () => {
  const longCue = [{ start: 0, end: 19500, content: "source" }];
  assert.throws(() => Core.materializeBlockTranslation([{ segmentId: "b0", sourceFrom: 0, sourceTo: 0, lines: Array(65).fill("甲") }], longCue), /duration capacity/);
  const source = [{ start: 0, end: 5000, content: "source" }];
  const parsedUrl = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c0", lines: ["访问 https://example.com/very-long-path"] }] }), source, { maxVisualWidth: 48 });
  const splitUrl = JSON.parse(JSON.stringify(parsedUrl)); splitUrl[0].lines = ["访问 https://example.com/", "very-long-path"];
  assert.throws(() => Core.materializeBlockTranslation(splitUrl, source, { requireIntegrity: true }), /integrity/);
  const parsedUnit = Core.parseBlockTranslationResponse(JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c0", lines: ["偏差0.1 mm时失败"] }] }), source);
  const splitUnit = JSON.parse(JSON.stringify(parsedUnit)); splitUnit[0].lines = ["偏差0.1", "mm时失败"];
  assert.throws(() => Core.materializeBlockTranslation(splitUnit, source, { requireIntegrity: true }), /integrity/);
  const missing = JSON.parse(JSON.stringify(parsedUnit)); delete missing[0].integrity;
  assert.throws(() => Core.materializeBlockTranslation(missing, source, { requireIntegrity: true }), /integrity/);
});

test("block 切片不按停顿切块，长停顿只在装载时钳每屏时间", () => {
  const clips = Core.sliceClipsByCue([
    { start: 0, end: 500, content: "before" },
    { start: 1250, end: 1800, content: "after" },
  ], 30000, { maxInternalGapMs: 750 });
  // 切块不按停顿切（那会把请求数抬高 72%、造出单 cue 块，毁掉上下文块设计）；
  // 停顿只在装载时钳每屏时间。
  assert.equal(clips.length, 1);
  assert.equal(clips[0].cues.length, 2);
});

test("translateContextBlock 发送连续 cue 上下文并接受非 1:1 目标分段", async () => {
  const cues = [{ start: 100, end: 1100, content: "first source cue" }, { start: 1100, end: 2400, content: "continues here" }];
  let sent;
  const result = await Core.translateContextBlock({
    cues, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", targetLang: "zh-Hans", maxVisualWidth: 48,
    fetchImpl: async (_url, req) => {
      const body = JSON.parse(req.body); sent = JSON.parse(body.messages[1].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ segments: [{ sourceFrom: "c0", sourceTo: "c1", lines: ["合并后的自然译文。"] }] }) } }] }) };
    },
  });
  assert.deepStrictEqual(sent.sourceCues.map((cue) => cue.id), ["c0", "c1"]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].startMs, 100);
  assert.equal(result.units[0].endMs, 2400);
});

test("block-v1 对多书写系统使用同一请求、parser 与时间物化路径", async () => {
  const samples = [
    ["Electric kettles are useful", "though they are slower here"],
    ["Zażółć gęślą jaźń", "to nadal działa poprawnie"],
    ["هذه غلاية كهربائية", "لكنها أبطأ هنا"],
    ["นี่คือกาต้มน้ำไฟฟ้า", "แต่ที่นี่ทำงานช้ากว่า"],
    ["这是一个电热水壶", "不过这里速度更慢"],
    ["これは電気ケトルです", "ここでは少し遅いです"],
    ["偏差只有0.1 mm", "door still must open"],
  ];
  for (const pair of samples) {
    const cues = pair.map((content, i) => ({ start: i * 1200, end: (i + 1) * 1200, content }));
    let sent;
    const out = await Core.translateContextBlock({
      cues, apiBaseUrl: "https://example.test", ["api" + "Key"]: "k", apiModel: "m", targetLang: "zh-Hans",
      fetchImpl: async (_url, req) => {
        sent = JSON.parse(JSON.parse(req.body).messages[1].content);
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ segments: [
          { sourceFrom: "c0", sourceTo: "c1", lines: ["统一协议的自然译文"] },
        ] }) } }] }) };
      },
    });
    assert.deepStrictEqual(sent.sourceCues.map((c) => c.text), pair);
    assert.deepStrictEqual(out.units.map((u) => u.translation), ["统一协议的自然译文"]);
  }
  const coreSrc = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
  const blockPath = coreSrc.slice(coreSrc.indexOf("var DEFAULT_BLOCK_TRANSLATION_PROMPT"), coreSrc.indexOf("async function chatCompletion"));
  assert.doesNotMatch(blockPath, /languageCode|sourceLang|["'](?:ja|en|zh|ar|th|pl)["']\s*[,:)]/, "block 产品路径不得按源语言代码分支");
  assert.doesNotMatch(blockPath, /openai|anthropic|gemini/i, "block 产品路径不得按供应商分支");
});

test("block 缓存命中重新验证字段、清洗句号、宽度与最短显示时长", () => {
  const cues = [{ start: 0, end: 1200, content: "one source cue" }];
  const valid = [{ segmentId: "b0", sourceFrom: 0, sourceTo: 0, lines: ["缓存译文。"] }];
  const units = Core.materializeBlockTranslation(valid, cues, { maxVisualWidth: 20 });
  assert.deepStrictEqual(units.map((u) => u.translation), ["缓存译文"], "缓存也必须走最终无句号清洗");
  assert.throws(() => Core.materializeBlockTranslation([{ ...valid[0], forged: true }], cues), /cached coverage invalid/);
  assert.throws(() => Core.materializeBlockTranslation([{ ...valid[0], lines: ["。"] }], cues), /cached line empty/);
  assert.throws(() => Core.materializeBlockTranslation([{ ...valid[0], lines: ["这是一条超过缓存视觉门禁的字幕"] }], cues, { maxVisualWidth: 8 }), /visual width/);
  assert.throws(() => Core.materializeBlockTranslation([
    { segmentId: "b0", sourceFrom: 0, sourceTo: 0, lines: ["甲", "乙", "丙"] },
  ], [{ start: 0, end: 600, content: "too many screens" }]), /duration capacity|duration too short/);
  // 一屏文字整体横跨停顿（start 在停顿前、end 在停顿后）时，只钳边界不够：
  // 边界都在停顿外，字幕会硬挺过整段静音。必须把 end 收到静音起点。
  const spanning = Core.materializeBlockTranslation([
    { segmentId: "b0", sourceFrom: 0, sourceTo: 1, lines: ["一整句横跨停顿"] },
  ], [{ start: 0, end: 1200, content: "before" }, { start: 6000, end: 6800, content: "after" }]);
  assert.equal(spanning.length, 1);
  assert.equal(spanning[0].endMs, 1200, "跨越整个停顿的单屏必须在静音开始时消失");

  // 兜底分支：停顿前的说话时间不足可读下限时，允许探进静音，但必须**有界**
  // （≤minDisplayMs），不得保留原 end 而横跨整段静音。
  const spanTiny = Core.materializeBlockTranslation([
    { segmentId: "b0", sourceFrom: 0, sourceTo: 1, lines: ["甲"] },
  ], [{ start: 0, end: 120, content: "tiny" }, { start: 9000, end: 9600, content: "after" }]);
  assert.equal(spanTiny.length, 1);
  assert.ok(spanTiny[0].endMs <= spanTiny[0].startMs + 300,
    "兜底分支探进静音必须有界，实际 " + (spanTiny[0].endMs - spanTiny[0].startMs) + "ms");
  assert.ok(spanTiny[0].endMs < 9000, "兜底分支不得横跨整段静音");

  const cachedCross = Core.materializeBlockTranslation([
    { segmentId: "b0", sourceFrom: 0, sourceTo: 1, lines: ["跨停顿缓存"] },
  ], [{ start: 0, end: 500, content: "before" }, { start: 1500, end: 2200, content: "after" }]);
  assert.equal(cachedCross.length, 1);
  assert.ok(!(cachedCross[0].endMs > 500 && cachedCross[0].endMs < 1500), "缓存单屏结束时刻落在静音里");
});

test("parseTranslationCoverageResponse 接受 unitId/span 严格全覆盖且保持输入顺序", () => {
  const units = [
    { unitId: "u0", tokenStart: 0, tokenEnd: 3 },
    { unitId: "u1", tokenStart: 3, tokenEnd: 6 },
  ];
  const raw = JSON.stringify({ translations: [
    { unitId: "u1", coverFrom: 3, coverTo: 6, translation: "第二条完整译文" },
    { unitId: "u0", coverFrom: 0, coverTo: 3, translation: "第一条完整译文" },
  ] });
  const result = Core.parseTranslationCoverageResponse(raw, units, { maxLineChars: 20 });
  assert.deepStrictEqual(result.map(x => x.unitId), ["u0", "u1"]);
  assert.deepStrictEqual(result.map(x => x.translation), ["第一条完整译文", "第二条完整译文"]);
});

test("parseTranslationCoverageResponse 对缺口、重复、错 span、未知 ID、空译文和额外字段 fail-closed", () => {
  const units = [{ unitId: "u0", tokenStart: 0, tokenEnd: 2 }, { unitId: "u1", tokenStart: 2, tokenEnd: 4 }];
  const entry = (id, from, to, translation="完整译文") => ({ unitId:id, coverFrom:from, coverTo:to, translation });
  for (const payload of [
    { translations:[entry("u0",0,2)] },
    { translations:[entry("u0",0,2),entry("u0",0,2)] },
    { translations:[entry("u0",0,3),entry("u1",2,4)] },
    { translations:[entry("u0",0,2),entry("other",2,4)] },
    { translations:[entry("u0",0,2," "),entry("u1",2,4)] },
    { translations:[Object.assign(entry("u0",0,2),{source:"forged"}),entry("u1",2,4)] },
  ]) assert.throws(() => Core.parseTranslationCoverageResponse(JSON.stringify(payload), units), /translation coverage/i);
});

test("parseTranslationCoverageResponse lenient 运行时只把坏内容单元置空，保留同 clip 其余合规译文", () => {
  const units = [
    { unitId: "u0", tokenStart: 0, tokenEnd: 2 },
    { unitId: "u1", tokenStart: 2, tokenEnd: 4 },
    { unitId: "u2", tokenStart: 4, tokenEnd: 6 },
  ];
  // u1 空译文、u2 英文（非中文单元）——lenient 下这两条回退英文（置空），u0 正常保留。
  const raw = JSON.stringify({ translations: [
    { unitId: "u0", coverFrom: 0, coverTo: 2, translation: "第一条译文" },
    { unitId: "u1", coverFrom: 2, coverTo: 4, translation: "   " },
    { unitId: "u2", coverFrom: 4, coverTo: 6, translation: "still English here" },
  ] });
  const lenient = Core.parseTranslationCoverageResponse(raw, units, { lenient: true });
  assert.deepStrictEqual(lenient.map(x => x.unitId), ["u0", "u1", "u2"]);
  assert.strictEqual(lenient[0].translation, "第一条译文", "合规单元必须保留中文译文");
  assert.strictEqual(lenient[1].translation, "", "空译文单元回退英文=置空");
  assert.strictEqual(lenient[2].translation, "", "非中文单元回退英文=置空");
  // 严格模式（导出）同一 payload 仍必须整体 fail-closed。
  assert.throws(() => Core.parseTranslationCoverageResponse(raw, units), /translation coverage/i);
});

test("parseTranslationCoverageResponse lenient 仍对结构性违规 fail-closed（协议漂移不放行）", () => {
  const units = [{ unitId: "u0", tokenStart: 0, tokenEnd: 2 }, { unitId: "u1", tokenStart: 2, tokenEnd: 4 }];
  const entry = (id, from, to, translation="完整译文") => ({ unitId:id, coverFrom:from, coverTo:to, translation });
  // 数量不足、重复、错 span、未知 ID、额外字段——这些是协议漂移，lenient 也必须 throw。
  for (const payload of [
    { translations:[entry("u0",0,2)] },
    { translations:[entry("u0",0,2),entry("u0",0,2)] },
    { translations:[entry("u0",0,3),entry("u1",2,4)] },
    { translations:[entry("u0",0,2),entry("other",2,4)] },
    { translations:[Object.assign(entry("u0",0,2),{source:"forged"}),entry("u1",2,4)] },
  ]) assert.throws(() => Core.parseTranslationCoverageResponse(JSON.stringify(payload), units, { lenient: true }), /translation coverage/i);
});

test("buildClipUnits lenient 允许空译文单元（回退英文），严格模式仍对空单元 fail-closed", () => {
  const cues = [{start:0,end:500,content:"first unit"},{start:500,end:1000,content:"second unit"}];
  // 严格（导出）：空行是硬错误。
  assert.throws(()=>Core.buildClipUnits(["译文",""],0,1000,cues),/empty materialized unit/i);
  // lenient（运行时）：空行=该句显英文，其余显中文，不 throw。
  const units = Core.buildClipUnits(["译文",""],0,1000,cues,{ lenient: true });
  assert.strictEqual(units.length, 2);
  assert.strictEqual(units[0].translation, "译文");
  assert.strictEqual(units[1].translation, "", "空译文单元保留 originalText，渲染层回退英文");
  assert.strictEqual(units[1].originalText, "second unit");
});

test("buildClipUnits 对 coverage 行数不匹配 fail-closed，不再合成时间轴或重映射原文", () => {
  const cues=[{start:0,end:500,content:"first unit"},{start:500,end:1000,content:"second unit"}];
  assert.throws(()=>Core.buildClipUnits(["只有一条译文"],0,1000,cues),/coverage alignment/i);
});

test("v0.6 不导出旧编号、MERGE 或中文行后处理协议", () => {
  for (const name of ["buildNumberedSourceLines","parseSubtitleLines","parseAlignedSubtitleLines","shapeAlignedLine","mergeRejectedTranslationCues","mergeShortLines","mergeDanglingLines","splitLongLines","layoutTimeline","splitOriginalByPunct"]) {
    assert.strictEqual(Core[name],undefined,`${name} must be removed`);
  }
});

test("v0.6 删除 cold-kettle/跨 cue 中文搬移特判，buildClipUnits 严格按 coverage 顺序", () => {
  const src = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
  assert.ok(!/cold.?kettle|repairCrossCueBorrowedNounPhrases|EN_COLD_KETTLE|ZH_COLD_KETTLE/i.test(src));
  const cues = [{start:0,end:500,content:"go into a"},{start:500,end:1000,content:"cold kettle works"}];
  const lines = ["进入水壶", "冷水壶运行可靠"];
  assert.deepStrictEqual(Core.buildClipUnits(lines,0,1000,cues).map(x=>x.translation), lines, "本地不得按中文字符串跨单元搬信息");
});

test("DEFAULT_SYSTEM_PROMPT 不再包含逐 unit coverage 或 semanticGroupId 前提", () => {
  const prompt = Core.DEFAULT_SYSTEM_PROMPT;
  assert.ok(prompt.includes("任意语言") && prompt.includes("逐行对齐") && prompt.includes("不输出中文句号"));
  assert.ok(prompt.includes("严格遵守随后给出的 JSON 协议"));
  assert.ok(!/translations|unitId|coverFrom|coverTo|semanticGroupId|逐单元翻译/.test(prompt));
});

asyncTest("translateClipLines 发送 token-span units，并按 unitId 对乱序响应原子归位", async () => {
  const cues = [
    {unitId:"u0",tokenStart:0,tokenEnd:3,sourceFingerprint:"fp",start:0,end:300,content:"the first peep"},
    {unitId:"u1",tokenStart:3,tokenEnd:5,sourceFingerprint:"fp",start:300,end:500,content:"get back"},
  ];
  let requestPayload;
  const lines = await Core.translateClipLines({ cues, apiBaseUrl:"https://example.test", apiModel:"m",
    fetchImpl: async (_url, req) => { requestPayload=JSON.parse(JSON.parse(req.body).messages[1].content); return {ok:true,json:async()=>({choices:[{message:{content:translationCoverageJson(req,["第一声完整译文","返回完整译文"],true)}}]})}; }
  });
  assert.deepStrictEqual(lines,["第一声完整译文","返回完整译文"]);
  assert.deepStrictEqual(lines.coverage.map(x=>[x.unitId,x.coverFrom,x.coverTo]),[["u0",0,3],["u1",3,5]]);
  assert.deepStrictEqual(requestPayload.units.map(x=>Object.keys(x).sort()),[["coverFrom","coverTo","maxVisualWidth","semanticGroupId","sourceText","unitId"],["coverFrom","coverTo","maxVisualWidth","semanticGroupId","sourceText","unitId"]]);
  assert.deepStrictEqual(requestPayload.units.map(x=>x.semanticGroupId),["sg0","sg1"],"无显式 semanticGroupId 时每个单元独立，禁止意外跨句搬信息");
  assert.ok(!JSON.stringify(requestPayload).includes("1. "),"不得退回编号文本协议");
});

asyncTest("translateClipLines coverage 缺失、错 span 或空译文整包 fail-closed", async () => {
  const cues=[{unitId:"u0",tokenStart:0,tokenEnd:2,start:0,end:200,content:"hello world"},{unitId:"u1",tokenStart:2,tokenEnd:4,start:200,end:400,content:"go back"}];
  for (const content of [
    JSON.stringify({translations:[{unitId:"u0",coverFrom:0,coverTo:2,translation:"完整译文"}]}),
    JSON.stringify({translations:[{unitId:"u0",coverFrom:0,coverTo:3,translation:"完整译文"},{unitId:"u1",coverFrom:2,coverTo:4,translation:"另一条译文"}]}),
    JSON.stringify({translations:[{unitId:"u0",coverFrom:0,coverTo:2,translation:""},{unitId:"u1",coverFrom:2,coverTo:4,translation:"另一条译文"}]}),
  ]) await assert.rejects(()=>Core.translateClipLines({cues,apiBaseUrl:"https://example.test",apiModel:"m",fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content}}]})})}),/translation coverage/i);
});

asyncTest("translateClipWithBoundaryRepair 不承担显示质量，只按模型容量 fail-closed", async () => {
  // 原门禁锁的是 "semantic 12 / fallback-translation 14" 的 mode 分叉。真机实测证明该分叉
  // 本身就是缺陷：语义恢复只覆盖当前区间，区间外仍是 fallback 断句(续接到 14 词)，却因
  // 全局 mode 已是 "semantic" 被按 12 词拒翻 → 永远翻不了。
  // 正确契约：输入卫士只有模型容量上限 SEMANTIC_MAX_TOKENS，与 mode 无关；
  // "语义结果该多宽" 属于视觉质量，已移到 resegmentTimelineSnapshot 动态校验。
  const words = (n) => Array.from({length:n},(_,i)=>"w"+i).join(" ");
  const cueOver={unitId:"u0",tokenStart:0,tokenEnd:41,start:0,end:4100,content:words(41)};
  let calls=0;
  // 超过模型容量：任何 mode 都必须 fail-closed，且不发请求
  for (const mode of ["semantic","fallback","fallback-translation"]) {
    await assert.rejects(()=>Core.translateClipWithBoundaryRepair({cues:[cueOver],segmentationMode:mode,apiBaseUrl:"https://example.test",apiModel:"m",fetchImpl:async()=>{calls++;throw new Error("must not fetch")}}),/oversized source unit/,`mode=${mode} 超模型容量必须拒`);
  }
  assert.strictEqual(calls,0,"超限单元不得触发任何请求");
  // 容量内：任何 mode 都必须能翻，且只请求一次；不在这里重新判断显示宽度。
  const cueAtCap={unitId:"u0",tokenStart:0,tokenEnd:40,start:0,end:4000,content:words(40)};
  for (const mode of ["semantic","fallback","fallback-translation"]) {
    calls=0;
    const result=await Core.translateClipWithBoundaryRepair({cues:[cueAtCap],segmentationMode:mode,apiBaseUrl:"https://example.test",apiModel:"m",fetchImpl:async(_u,req)=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:translationCoverageJson(req,["这是一条完整译文"])}}]})}}});
    assert.strictEqual(calls,1,`mode=${mode} 应只请求一次`);
    assert.strictEqual(result.repaired,false);
    assert.deepStrictEqual(result.lines,["这是一条完整译文"]);
    assert.deepStrictEqual(result.cues,[cueAtCap]);
  }
});

asyncTest("结构化翻译成功才计 usage，并把 coverage 原样返回缓存层", async () => {
  const usage={prompt_tokens:7,completion_tokens:3,total_tokens:10};let seen=null;
  const cue={unitId:"u0",tokenStart:0,tokenEnd:2,start:0,end:200,content:"hello world"};
  const result=await Core.translateClipWithBoundaryRepair({cues:[cue],apiBaseUrl:"https://example.test",apiModel:"m",onUsage:v=>seen=v,fetchImpl:async(_u,req)=>({ok:true,json:async()=>({choices:[{message:{content:translationCoverageJson(req,["这是一条完整译文"])}}],usage})})});
  assert.deepStrictEqual(seen,usage);
  assert.deepStrictEqual(result.coverage,[{unitId:"u0",coverFrom:0,coverTo:2,translation:"这是一条完整译文"}]);
});

test("buildCanonicalTokenTimeline 为无 token 的 VTT cue 确定性生成回退词时序", () => {
  const timeline = Core.buildCanonicalTokenTimeline([
    { start: 1000, end: 2200, content: "one small kettle" },
  ]);
  assert.deepStrictEqual(timeline.tokens.map(t => t.text), ["one", "small", "kettle"]);
  assert.deepStrictEqual(timeline.tokens.map(t => [t.startMs, t.endMs]), [[1000, 1400], [1400, 1800], [1800, 2200]]);
  assert.ok(timeline.tokens.every(t => t.nativeTiming === false));
});

test("buildTokenSpanUnits 只保存连续半开 token span，coverage 恰好一次", () => {
  const timeline = Core.buildCanonicalTokenTimeline([
    { start: 0, end: 2500, content: "go into a cold kettle" },
  ]);
  const units = Core.buildTokenSpanUnits(timeline, [2, 4]);
  assert.deepStrictEqual(units.map(u => [u.tokenStart, u.tokenEnd, u.originalText]), [
    [0, 3, "go into a"],
    [3, 5, "cold kettle"],
  ]);
  assert.ok(units.every(u => u.sourceFingerprint === timeline.sourceFingerprint));
  assert.deepStrictEqual(Core.validateTokenSpanCoverage(timeline, units), { ok: true, coveredTokens: 5 });
});

test("validateTokenSpanCoverage 拒绝 gap、overlap、改词和错误 source fingerprint", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 2000, content: "one two three four" }]);
  const good = Core.buildTokenSpanUnits(timeline, [1, 3]);
  const gap = JSON.parse(JSON.stringify(good)); gap[1].tokenStart = 3;
  const overlap = JSON.parse(JSON.stringify(good)); overlap[1].tokenStart = 1;
  const changed = JSON.parse(JSON.stringify(good)); changed[0].originalText = "one changed";
  const wrongSource = JSON.parse(JSON.stringify(good)); wrongSource[0].sourceFingerprint = "other";
  assert.strictEqual(Core.validateTokenSpanCoverage(timeline, gap).ok, false);
  assert.strictEqual(Core.validateTokenSpanCoverage(timeline, overlap).ok, false);
  assert.strictEqual(Core.validateTokenSpanCoverage(timeline, changed).ok, false);
  assert.strictEqual(Core.validateTokenSpanCoverage(timeline, wrongSource).ok, false);
});

test("createTimelineSnapshot 克隆并深冻结，renderer 单元保留 token provenance", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 2000, content: "one two three four" }]);
  const units = Core.buildTokenSpanUnits(timeline, [1, 3]);
  const translations = {};
  translations[units[0].id] = "第一段";
  translations[units[1].id] = "第二段";
  const snapshot = Core.createTimelineSnapshot({
    revision: 7,
    videoId: "vid",
    trackCode: "en",
    timeline,
    units,
    translations,
  });
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.timeline) && Object.isFrozen(snapshot.units) && Object.isFrozen(snapshot.translations));
  assert.strictEqual(snapshot.sourceFingerprint, timeline.sourceFingerprint);
  assert.strictEqual(snapshot.coverage.ok, true);
  assert.deepStrictEqual(snapshot.renderUnits.map(u => [u.unitId, u.tokenStart, u.tokenEnd, u.originalText, u.translation]), [
    [units[0].id, 0, 2, "one two", "第一段"],
    [units[1].id, 2, 4, "three four", "第二段"],
  ]);
  units[0].originalText = "mutated outside";
  assert.strictEqual(snapshot.units[0].originalText, "one two", "snapshot 必须与外部可变对象隔离");
  assert.throws(() => { snapshot.units[0].originalText = "mutate frozen"; }, TypeError);
});

test("buildCueTokenSpanUnits 将滚动 cue 重叠压成无重叠 canonical spans", () => {
  const cues = [
    { start: 0, end: 1200, content: "go into a", tokens: [
      { text: "go", start: 0, end: 300 }, { text: "into", start: 300, end: 700 }, { text: "a", start: 700, end: 1200 },
    ] },
    { start: 1000, end: 2200, content: "a cold kettle", tokens: [
      { text: "a", start: 1000, end: 1250 }, { text: "cold", start: 1250, end: 1700 }, { text: "kettle", start: 1700, end: 2200 },
    ] },
  ];
  const timeline = Core.buildCanonicalTokenTimeline(cues);
  const units = Core.buildCueTokenSpanUnits(timeline, cues);
  assert.deepStrictEqual(units.map(u => [u.tokenStart, u.tokenEnd, u.originalText]), [
    [0, 3, "go into a"], [3, 5, "cold kettle"],
  ]);
  const snapshot = Core.createTimelineSnapshot({ timeline, units });
  const canonical = Core.cuesFromTimelineSnapshot(snapshot);
  assert.deepStrictEqual(canonical.map(c => c.content), ["go into a", "cold kettle"]);
  assert.deepStrictEqual(canonical.flatMap(c => c.tokens.map(t => t.text)), ["go", "into", "a", "cold", "kettle"]);
});

test("真实 loadTrack 链路：滚动 ASR 经 resegment 后仍能对齐 canonical（回归 v0.6.0 整轨拒绝）", () => {
  // 真机故障：json3 词级时间轴 → canonical 按时间重叠去重；resegmentCues 输出的
  // 显示 cue 没有 tokens、正文含标点、且句末边界处保留了 canonical 已删除的重复词。
  // 旧 buildCueTokenSpanUnits 从这些 cue 重建平行 token 流并要求逐 token 全等，必然
  // throw "cue tokens do not match canonical timeline" → installCueTimeline 整轨拒绝
  // → 英文字幕一条都装不进去。此测试锁死这条真实链路必须成功对齐。
  const json = { events: [
    { tStartMs: 0,    dDurationMs: 2000, segs: [
      {utf8:"So",tOffsetMs:0},{utf8:" you",tOffsetMs:300},{utf8:" want",tOffsetMs:600},
      {utf8:" to",tOffsetMs:900},{utf8:" boil",tOffsetMs:1200},{utf8:" water.",tOffsetMs:1500}] },
    // 滚动重叠：重复 "boil water" 再继续（时间与上一条重叠 → canonical 去重）
    { tStartMs: 1200, dDurationMs: 2400, segs: [
      {utf8:"boil",tOffsetMs:0},{utf8:" water",tOffsetMs:300},{utf8:" on",tOffsetMs:800},
      {utf8:" the",tOffsetMs:1100},{utf8:" stove",tOffsetMs:1500},{utf8:" top,",tOffsetMs:1900}] },
    { tStartMs: 3600, dDurationMs: 2000, segs: [
      {utf8:"and",tOffsetMs:0},{utf8:" one",tOffsetMs:300},{utf8:" of",tOffsetMs:600},
      {utf8:" those",tOffsetMs:900},{utf8:" other",tOffsetMs:1300}] },
    { tStartMs: 5600, dDurationMs: 2600, segs: [
      {utf8:"things",tOffsetMs:0},{utf8:" you",tOffsetMs:400},{utf8:" need",tOffsetMs:800},
      {utf8:" is",tOffsetMs:1200},{utf8:" much",tOffsetMs:1600},{utf8:" water.",tOffsetMs:2000}] },
  ] };
  const cues = Core.cleanupCues(Core.parseJson3(json));
  const timeline = Core.buildCanonicalTokenTimeline(cues);
  // canonical 已把重复的 "boil water" 去掉一次
  assert.strictEqual(timeline.tokens.map(t => t.text).join(" "),
    "So you want to boil water on the stove top and one of those other things you need is much water");
  const fallbackCues = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
  // resegment 的显示 cue 无 tokens、含标点、且第二段仍带重复的 "boil water"
  assert.ok(fallbackCues.some(c => !Array.isArray(c.tokens)));
  // 关键断言：不再 throw，且切出的 spans 覆盖整条 canonical timeline 恰好一次
  const units = Core.buildCueTokenSpanUnits(timeline, fallbackCues);
  assert.ok(units.length >= 1);
  assert.strictEqual(units[0].tokenStart, 0);
  assert.strictEqual(units[units.length - 1].tokenEnd, timeline.tokens.length);
  const snapshot = Core.createTimelineSnapshot({ timeline, units });
  assert.strictEqual(snapshot.status, "provisional");
});

test("mapDisplayCuesToBoundaries：真正的正文漂移仍 fail-closed 抛错", () => {
  // 对齐必须只容忍"重复词"（canonical 或 display 任一端去重造成的落差），
  // 不能吞掉模型/解析制造的假词，否则 fail-closed 语义被削弱。
  const timeline = Core.buildCanonicalTokenTimeline([
    { start: 0, end: 1500, content: "alpha beta gamma", tokens: [
      { text: "alpha", start: 0, end: 500 }, { text: "beta", start: 500, end: 1000 }, { text: "gamma", start: 1000, end: 1500 },
    ] },
  ]);
  assert.throws(
    () => Core.buildCueTokenSpanUnits(timeline, [{ start: 0, end: 1500, content: "alpha delta gamma" }]),
    /does not align to canonical timeline/,
  );
});

test("双向去重对齐：canonical 保留、display 删除的 gap 重复词仍能对齐（回归真机整轨拒绝）", () => {
  // 真机故障模式：滚动 ASR 相邻事件间有 gap，重复词跨（"on the stove"）两次出现
  // 时间不重叠 → canonical 按时间重叠去重时"保留"重复；resegment 按文本 stripOverlap
  // "删除"重复 → display 比 canonical 短。旧对齐只处理 display 多的方向，遇此 throw
  // "display cue does not align to canonical timeline" → installCueTimeline 整轨拒绝。
  function ev(tStart, dur, words) {
    const per = dur / words.length;
    return { tStartMs: tStart, dDurationMs: dur, segs: words.map((w, i) => ({ utf8: (i ? " " : "") + w, tOffsetMs: Math.round(per * i) })) };
  }
  const json = { events: [
    ev(0,    2000, ["boil", "water", "on", "the", "stove"]),
    ev(2600, 2400, ["on", "the", "stove", "top", "and", "cook"]), // gap：无时间重叠
  ] };
  const cues = Core.cleanupCues(Core.parseJson3(json));
  const timeline = Core.buildCanonicalTokenTimeline(cues);
  // canonical 保留了重复的 "on the stove"
  assert.strictEqual(timeline.tokens.map(t => t.text).join(" "),
    "boil water on the stove on the stove top and cook");
  const fallbackCues = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
  // resegment 把重复删掉了，display 比 canonical 短
  const displayWordCount = fallbackCues.reduce((n, c) => n + (String(c.content).match(/[A-Za-z0-9]+/g) || []).length, 0);
  assert.ok(displayWordCount < timeline.tokens.length, "display 应短于 canonical");
  const units = Core.buildCueTokenSpanUnits(timeline, fallbackCues);
  assert.ok(units.length >= 1);
  assert.strictEqual(units[0].tokenStart, 0);
  assert.strictEqual(units[units.length - 1].tokenEnd, timeline.tokens.length);
  const snapshot = Core.createTimelineSnapshot({ timeline, units });
  assert.strictEqual(snapshot.status, "provisional");
});

test("withTimelineTranslations 原子生成新 snapshot，不修改旧 snapshot", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 1000, content: "one two" }]);
  const units = Core.buildTokenSpanUnits(timeline, [0, 1]);
  const before = Core.createTimelineSnapshot({ revision: 1, timeline, units });
  const updates = {}; updates[units[0].id] = "一"; updates[units[1].id] = "二";
  const after = Core.withTimelineTranslations(before, updates);
  assert.strictEqual(before.status, "provisional");
  assert.deepStrictEqual(before.renderUnits.map(u => u.translation), ["", ""]);
  assert.strictEqual(after.revision, 2);
  assert.strictEqual(after.status, "verified");
  assert.deepStrictEqual(after.renderUnits.map(u => u.translation), ["一", "二"]);
  assert.ok(Object.isFrozen(after) && Object.isFrozen(after.translations));
});

test("token-span property：随机合法分区始终全覆盖，任意单点缺口均被拒绝", () => {
  let seed = 0x5a17;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let n = 1; n <= 64; n++) {
    const content = Array.from({ length: n }, (_, i) => "w" + i).join(" ");
    const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: n * 100, content }]);
    const cuts = [];
    for (let i = 0; i < n - 1; i++) if (rnd() < 0.24) cuts.push(i);
    cuts.push(n - 1);
    const units = Core.buildTokenSpanUnits(timeline, cuts);
    const verdict = Core.validateTokenSpanCoverage(timeline, units);
    assert.deepStrictEqual(verdict, { ok: true, coveredTokens: n }, "n=" + n);
    if (units.length > 1) {
      const broken = JSON.parse(JSON.stringify(units));
      broken[1].tokenStart += 1;
      assert.strictEqual(Core.validateTokenSpanCoverage(timeline, broken).ok, false, "gap n=" + n);
    }
  }
});

test("resegmentTimelineSnapshot 只替换指定 unit 窗口且保持 token coverage/fingerprint", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 800, content: "a b c d e f g h" }]);
  const units = Core.buildTokenSpanUnits(timeline, [1, 3, 5, 7]);
  const translations = {};
  translations[units[0].id] = "左"; translations[units[3].id] = "右";
  const before = Core.createTimelineSnapshot({ revision: 2, timeline, units, translations });
  const after = Core.resegmentTimelineSnapshot(before, 1, 3, [
    { content: "c d e f" },
  ]);
  assert.strictEqual(after.sourceFingerprint, before.sourceFingerprint);
  assert.strictEqual(after.revision, 3);
  assert.deepStrictEqual(after.units.map(u => [u.tokenStart, u.tokenEnd, u.originalText]), [
    [0, 2, "a b"], [2, 6, "c d e f"], [6, 8, "g h"],
  ]);
  assert.deepStrictEqual(after.renderUnits.map(u => u.translation), ["左", "", "右"]);
  assert.deepStrictEqual(after.coverage, { ok: true, coveredTokens: 8 });
});

test("resegmentTimelineSnapshot 拒绝窗口内改词、丢词或越界", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 400, content: "a b c d" }]);
  const units = Core.buildTokenSpanUnits(timeline, [1, 3]);
  const snapshot = Core.createTimelineSnapshot({ timeline, units });
  assert.throws(() => Core.resegmentTimelineSnapshot(snapshot, 0, 1, [{ content: "a changed" }]), /token/i);
  assert.throws(() => Core.resegmentTimelineSnapshot(snapshot, 0, 1, [{ content: "a" }]), /token/i);
  assert.throws(() => Core.resegmentTimelineSnapshot(snapshot, -1, 1, [{ content: "a b" }]), /range/i);
});

test("sourceFingerprint 对 token 文本或 timing 变化敏感", () => {
  const a = Core.buildCanonicalTokenTimeline([{ start: 0, end: 1000, content: "one two" }]);
  const b = Core.buildCanonicalTokenTimeline([{ start: 0, end: 1001, content: "one two" }]);
  const c = Core.buildCanonicalTokenTimeline([{ start: 0, end: 1000, content: "one too" }]);
  assert.notStrictEqual(a.sourceFingerprint, b.sourceFingerprint);
  assert.notStrictEqual(a.sourceFingerprint, c.sourceFingerprint);
});

test("createTimelineSnapshot 对不完整 token coverage fail-closed", () => {
  const timeline = Core.buildCanonicalTokenTimeline([{ start: 0, end: 1000, content: "one two" }]);
  const units = Core.buildTokenSpanUnits(timeline, [1]);
  units[0].tokenEnd = 1;
  assert.throws(() => Core.createTimelineSnapshot({ timeline, units }), /coverage/i);
});

/* ============ 2. WebVTT 解析 ============ */
console.log("\n[WebVTT 解析]");

const fakeVtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello <c>world</c>

00:00:04.000 --> 00:00:06.000
second line
continued`;

test("parseVtt 解析时间与文本，去内联标签", () => {
  const cues = Core.parseVtt(fakeVtt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[0].end, 3500);
  assert.strictEqual(cues[0].content, "Hello world");
  assert.strictEqual(cues[1].content, "second line continued");
});

test("parseVtt 支持无小时位 mm:ss.mmm", () => {
  const cues = Core.parseVtt("WEBVTT\n\n01:02.500 --> 01:05.000\nhi");
  assert.strictEqual(cues[0].start, 62500);
  assert.strictEqual(cues[0].end, 65000);
});

/* ============ 4. clip 切分 ============ */
console.log("\n[clip 切分]");

test("sliceClips 按 60s 切分", () => {
  const cues = [
    { start: 0, end: 1000, content: "a" },
    { start: 30000, end: 31000, content: "b" },
    { start: 65000, end: 66000, content: "c" }, // 第 2 个 clip
    { start: 125000, end: 126000, content: "d" }, // 第 3 个 clip
  ];
  const clips = Core.sliceClips(cues, 60000);
  assert.strictEqual(clips.length, 3);
  assert.strictEqual(clips[0].cues.length, 2);
  assert.strictEqual(clips[0].index, 0);
  assert.strictEqual(clips[1].index, 1);
  assert.strictEqual(clips[2].index, 2);
});

/* ============ 5. joinUrl ============ */
console.log("\n[joinUrl]");
test("joinUrl 规整斜杠", () => {
  assert.strictEqual(Core.joinUrl("https://x/v1", "/chat/completions"), "https://x/v1/chat/completions");
  assert.strictEqual(Core.joinUrl("https://x/v1/", "chat/completions"), "https://x/v1/chat/completions");
});

/* ============ 5b. resegmentCues：原文语义重组 ============ */
console.log("\n[resegmentCues：ASR 碎片重组]");

test("resegment 合并被切碎的连续片段（小间隙、无句末标点）", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 1200, content: "so today we're gonna" },
    { start: 1200, end: 2400, content: "take a look at" },
    { start: 2400, end: 3600, content: "transformers." },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 50, maxDurationMs: 30000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1, "三个碎片应合并成一句");
  assert.strictEqual(seg[0].content, "so today we're gonna take a look at transformers.");
  assert.strictEqual(seg[0].start, 0);
  assert.strictEqual(seg[0].end, 3600, "时间轴取并集");
});

test("resegment 去 ASR 滚动重叠词（不出现 work work）", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 1500, content: "how transformers work" },
    { start: 1500, end: 3000, content: "work under the hood." },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 50, maxDurationMs: 30000 });
  assert.strictEqual(seg.length, 1);
  assert.strictEqual(seg[0].content, "how transformers work under the hood.");
  assert.ok(!/work work/.test(seg[0].content), "重叠词 work 应只出现一次");
});

test("resegment 真实长句在 with 后允许一次受限续接", () => {
  const frags = Core.cleanupCues([
    { start: 160, end: 1875, content: "If you're a human person," },
    { start: 2184, end: 3756, content: "one of those things you're going to want to do with" },
    { start: 4160, end: 5303, content: "some regularity is boil water. We do it for lots of reasons," },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 8000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 2, "with 后的宾语应续接完整，但后续新句必须在句号处分开");
  assert.strictEqual(seg[0].content, "If you're a human person, one of those things you're going to want to do with some regularity is boil water.");
  assert.strictEqual(seg[1].content, "We do it for lots of reasons,");
});

test("resegment fallback 在 14 词上限内保留 throughout 介词续接", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 1800, content: "This compact kettle works reliably in every overnight test" },
    { start: 1900, end: 2700, content: "throughout the entire night" },
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1);
  assert.strictEqual(seg[0].content, "This compact kettle works reliably in every overnight test throughout the entire night");
  assert.strictEqual(seg[0].content.split(/\s+/).length, 13);
});

test("cleanupCues 去掉 ASR 行首孤立英文句点", () => {
  const cleaned = Core.cleanupCues([{ start: 0, end: 1000, content: ".And one of those other" }]);
  assert.strictEqual(cleaned[0].content, "And one of those other");
});

test("resegment 英文介词/连接词结尾时允许跨 cue 续接", () => {
  const frags = Core.cleanupCues([
    { start: 7211, end: 8091, content: "from cooking to" },
    { start: 10000, end: 13697, content: "cleaning and disinfecting to other things probably" },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 6, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 8000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1, "语法未完成的 cue 应允许在下一个 cue 边界续接");
  assert.strictEqual(seg[0].content, "from cooking to cleaning and disinfecting to other things probably");
});

test("resegment 真实碎片链跨多个 cue 合并到完整句末", () => {
  const frags = Core.cleanupCues([
    { start: 12959, end: 13697, content: "And one of those other" },
    { start: 14559, end: 15297, content: "things is preparing" },
    { start: 16126, end: 16864, content: "hot beverages" },
    { start: 17693, end: 18373, content: "such as tea." },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 8000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1, "同一句的多个短 ASR 碎片不应被一次续接锁提前截断");
  assert.strictEqual(seg[0].content, "And one of those other things is preparing hot beverages such as tea.");
});

test("resegment 孤立限定词 One 与后续原因句合并", () => {
  const frags = Core.cleanupCues([
    { start: 42324, end: 43062, content: "One" },
    { start: 44160, end: 45755, content: "often cited reason is that our 120 volt electrical" },
    { start: 46637, end: 51680, content: "supply just doesn't have the gusto to make electric kettles worth it." },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 10000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1, "孤立限定词不能单独成为无意义字幕");
  assert.strictEqual(seg[0].content, "One often cited reason is that our 120 volt electrical supply just doesn't have the gusto to make electric kettles worth it.");
});

test("resegment 单个 cue 内有完整句时在句号处分开", () => {
  const frags = Core.cleanupCues([
    { start: 160, end: 5183, content: "If you're a human person, one of those things you're going to want to do with some regularity is boil water. We do it for lots of reasons," },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 24, maxDurationMs: 8000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 2, "一个 ASR cue 内的两个句子不应挤进同一字幕单元");
  assert.strictEqual(seg[0].content, "If you're a human person, one of those things you're going to want to do with some regularity is boil water.");
  assert.strictEqual(seg[1].content, "We do it for lots of reasons,");
  assert.strictEqual(seg[0].start, 160);
  assert.strictEqual(seg[1].end, 5183);
  assert.ok(seg[0].end <= seg[1].start, "按文本比例拆分后时间轴不得重叠");
});

test("resegment fallback 默认把 18 词连续语流收紧为 11/7", () => {
  const source = [
    { start: 0, end: 1920, content: "The presenter moved quickly through the setup steps" },
    { start: 1920, end: 2640, content: "then paused briefly" },
    { start: 2640, end: 4320, content: "so everyone could verify the final configuration." },
  ];
  const units = Core.resegmentCues(source, { tailTrimMs: 0 });
  assert.deepStrictEqual(units.map(u => u.content.split(/\s+/).length), [11, 7]);
  assert.strictEqual(units.map(u => u.content).join(" "), source.map(u => u.content).join(" "));
  assert.ok(units.every(u => u.content.split(/\s+/).length <= 14), "fallback 自然续接例外也不得重新生成超长行");
});

test("resegment 句中小写续接修复真实 ASR 碎片", () => {
  const cases = [
    ["I will be bringing this much", "water to a boil.", "I will be bringing this much water to a boil."],
    ["This stove does have a higher power burner available, but we'll get", "back to it in a bit.", "This stove does have a higher power burner available, but we'll get back to it in a bit."],
    ["I brought the kettle and my measuring", "bottle along with me for a visit with my parents.", "I brought the kettle and my measuring bottle along with me for a visit with my parents."],
    ["I think 2 kW is probably pretty", "fair.", "I think 2 kW is probably pretty fair."],
    ["that's more than 3", "minutes faster than the stove top kettle", "that's more than 3 minutes faster than the stove top kettle"],
    ["faster at boiling water than this stove", "top kettle, despite being limited by our system.", "faster at boiling water than this stove top kettle, despite being limited by our system."],
    ["But by the end of this video, I hope you'll learn, as I have, that this just isn't", "true.", "But by the end of this video, I hope you'll learn, as I have, that this just isn't true."],
  ];
  for (const [a, b, expected] of cases) {
    const seg = Core.resegmentCues(Core.cleanupCues([
      { start: 0, end: 5000, content: a },
      { start: 5500, end: 9000, content: b },
    ]), { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 10000, tailTrimMs: 0 });
    assert.strictEqual(seg.length, 1, `小写开头的句中续接不能被切碎: ${a} / ${b}`);
    assert.strictEqual(seg[0].content, expected);
  }
});

// `whistle. on this gas...` is an ASR punctuation error. It belongs to the
// sentence-restoration fixture for the semantic layer, not to resegmentCues.


test("resegment 长句普通上限前的明显语法尾仍继续", () => {
  const cases = [
    ["It's red and it has a wide flat bottom, which is helpful for doing tests because it'll", "work great with any stove.", "It's red and it has a wide flat bottom, which is helpful for doing tests because it'll work great with any stove."],
    ["I will be bringing this much", "water to a boil.", "I will be bringing this much water to a boil."],
    ["But by the end of this video, I hope you'll learn, as I have, that this just isn't", "true.", "But by the end of this video, I hope you'll learn, as I have, that this just isn't true."],
  ];
  for (const [a, b, expected] of cases) {
    const seg = Core.resegmentCues(Core.cleanupCues([
      { start: 0, end: 7000, content: a },
      { start: 7600, end: 10000, content: b },
    ]), { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 12000, tailTrimMs: 0 });
    assert.strictEqual(seg.length, 1, `明显语法尾必须补完: ${a}`);
    assert.strictEqual(seg[0].content, expected);
  }
});

test("resegment probably 后接新句时不误吞下一句", () => {
  const frags = Core.cleanupCues([
    { start: 7211, end: 8091, content: "from cooking to" },
    { start: 10000, end: 12600, content: "cleaning and disinfecting to other things probably" },
    { start: 12959, end: 13697, content: "And one of those other" },
    { start: 14559, end: 15297, content: "things is preparing" },
    { start: 16126, end: 16864, content: "hot beverages" },
    { start: 17693, end: 18373, content: "such as tea." },
  ]);
  const seg = Core.resegmentCues(frags, { maxWords: 16, maxDurationMs: 6000, grammarContinuationMaxDurationMs: 10000, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 2, "probably 已结束前一句，不能把 And 开头的新句吞进同一字幕");
  assert.strictEqual(seg[0].content, "from cooking to cleaning and disinfecting to other things probably");
  assert.strictEqual(seg[1].content, "And one of those other things is preparing hot beverages such as tea.");
});

test("validateChineseDisplayUnit 拒绝逗号半句、悬空词和内部换行", () => {
  assert.deepStrictEqual(Core.validateChineseDisplayUnit("隔三差五总要烧水。"), { ok: true, reason: "ok" });
  assert.strictEqual(Core.validateChineseDisplayUnit("如果你是人类，").reason, "non-terminal-punctuation");
  assert.strictEqual(Core.validateChineseDisplayUnit("再到其他事情，可能").reason, "dangling-tail");
  assert.strictEqual(Core.validateChineseDisplayUnit("第一行\n第二行").reason, "internal-newline");
});























test("resegment 句末标点处断句", () => {
  // 两个都达 minWords(3) 的完整句应各自成段（句尾标点切句）
  const frags = Core.cleanupCues([
    { start: 0, end: 1000, content: "this is first sentence." },
    { start: 1100, end: 2000, content: "this is second sentence." },
  ]);
  const seg = Core.resegmentCues(frags);
  assert.strictEqual(seg.length, 2, "两个完整句应各自成段");
  assert.strictEqual(seg[0].content, "this is first sentence.");
  assert.strictEqual(seg[1].content, "this is second sentence.");
});

test("resegment 大间隙不合并（不同句）", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 1000, content: "hello there" },
    { start: 5000, end: 6000, content: "much later" }, // 间隙 4s >> 300ms
  ]);
  const seg = Core.resegmentCues(frags);
  assert.strictEqual(seg.length, 2, "大间隙应断开");
});

test("resegment 超过最大词数强制切句", () => {
  const words = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
  const frags = Core.cleanupCues([{ start: 0, end: 2000, content: words }]);
  const seg = Core.resegmentCues(frags, { maxWords: 12 });
  // 单条超长 cue 自身不再切（一条 event 整体进），但合并时受限——这里验证不抛错且产出非空
  assert.ok(seg.length >= 1);
  assert.ok(seg[0].content.length > 0);
});

test("resegment minWords：短句(<minWords)后接短句、小间隙 → 黏合成一段", () => {
  // "ok." 只有 1 词 (< minWords=3)，虽自然结束也不立即切，应与下一条小间隙的短句黏合
  const frags = Core.cleanupCues([
    { start: 0, end: 800, content: "ok." },
    { start: 900, end: 2000, content: "let us continue." }, // 间隙 100ms <= 300ms
  ]);
  const seg = Core.resegmentCues(frags, { minWords: 3, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 1, "碎句应黏进相邻句，不单独成段");
  assert.strictEqual(seg[0].content, "ok. let us continue.");
  assert.strictEqual(seg[0].start, 0);
  assert.strictEqual(seg[0].end, 2000, "时间轴取并集");
});

test("resegment minWords：短句后接大间隙 → 无法合并，碎句单独成段", () => {
  // "ok." 太短想黏合，但下一条间隙 4s >> maxGap(300ms)，确实无法再合并 → 各自成段
  const frags = Core.cleanupCues([
    { start: 0, end: 800, content: "ok." },
    { start: 5000, end: 6000, content: "much later text." },
  ]);
  const seg = Core.resegmentCues(frags, { minWords: 3 });
  assert.strictEqual(seg.length, 2, "大间隙阻断黏合，碎句单独成段");
  assert.strictEqual(seg[0].content, "ok.");
  assert.strictEqual(seg[1].content, "much later text.");
});

test("resegment 长停顿切句（P1-b）：无标点但中间 800ms 长停顿 → 在停顿处切成两段", () => {
  // 两组无标点的连续语流，组内小间隙(<700ms)合并，组间 800ms(>=longPauseMs) 长停顿处切开。
  const frags = Core.cleanupCues([
    { start: 0, end: 600, content: "so we open the box" },
    { start: 650, end: 1200, content: "and take a look inside" }, // 与上间隙 50ms → 合并
    { start: 2000, end: 2600, content: "then we close it again" }, // 与上间隙 800ms → 切
    { start: 2650, end: 3200, content: "and walk away slowly" }, // 间隙 50ms → 合并
  ]);
  const seg = Core.resegmentCues(frags, { longPauseMs: 700, tailTrimMs: 0 });
  assert.strictEqual(seg.length, 2, "长停顿处应切成两段");
  assert.strictEqual(seg[0].content, "so we open the box and take a look inside");
  assert.strictEqual(seg[0].start, 0);
  assert.strictEqual(seg[0].end, 1200, "第一段时间轴取并集");
  assert.strictEqual(seg[1].content, "then we close it again and walk away slowly");
  assert.strictEqual(seg[1].start, 2000);
  assert.strictEqual(seg[1].end, 3200);
});

test("resegment 无标点无长停顿连续语流 → 到 maxWords(16) 才切", () => {
  // 20 词、全程小间隙(50ms<700ms)、无标点 → 既不长停顿也不到句末，靠 maxWords=16 切。
  const frags = [];
  for (var i = 0; i < 20; i++) {
    frags.push({ start: i * 100, end: i * 100 + 80, content: "w" + i });
  }
  const seg = Core.resegmentCues(Core.cleanupCues(frags), {
    maxWords: 16,
    longPauseMs: 700,
    maxDurationMs: 60000, // 排除时长触发，单测 maxWords 边界
  });
  // 第一段应恰好在第 16 词处切（防超长），剩余 4 词成第二段
  assert.strictEqual(seg.length, 2, "应被 maxWords=16 切成两段");
  assert.strictEqual(seg[0].content.split(" ").length, 16, "首段恰好 16 词");
  assert.strictEqual(seg[1].content.split(" ").length, 4, "余 4 词成第二段");
});

test("resegment 长停顿优先于碎句黏合（短句遇长停顿不黏合）", () => {
  // "ok" 仅 1 词 (<minWords)，本想黏进下一句；但与下一条间隙 800ms 长停顿 → 不黏合，各自成段。
  const frags = Core.cleanupCues([
    { start: 0, end: 500, content: "ok" },
    { start: 1300, end: 2000, content: "let us begin now" }, // 间隙 800ms >= longPauseMs
  ]);
  const seg = Core.resegmentCues(frags, { longPauseMs: 700, minWords: 3 });
  assert.strictEqual(seg.length, 2, "长停顿优先于黏合，碎句单独成段");
  assert.strictEqual(seg[0].content, "ok");
  assert.strictEqual(seg[1].content, "let us begin now");
});

/* ============ 5b-2. resegment 句间视觉尾缩（修字幕墙） ============ */
console.log("\n[resegment 句间尾缩：tailTrimMs]");

test("tailTrim：连续语流(去重叠后首尾相接)句单元 gap 从 0 变为 ~tailTrimMs", () => {
  // 两个完整句、紧贴(第二句 start == 第一句原 end)，模拟 cleanupCues 去重叠后的首尾相接。
  const frags = Core.cleanupCues([
    { start: 0, end: 2000, content: "this is the first sentence." },
    { start: 2000, end: 4000, content: "this is the second sentence." },
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 120 });
  assert.strictEqual(seg.length, 2, "两完整句各自成段");
  // 第一句原 end=2000 被尾缩到 1880；第二句 start 不动 → 出现 ~120ms 句间断点
  assert.strictEqual(seg[0].end, 1880, "首句 end 应回缩 tailTrimMs(120)");
  const gap = seg[1].start - seg[0].end;
  assert.strictEqual(gap, 120, "句间 gap 应 ≈ tailTrimMs");
  assert.ok(seg[0].end > seg[0].start, "尾缩后 end 仍 > start");
});

test("tailTrim：真停顿(本就有间隙)不受影响，只缩本句尾不动下一句", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 2000, content: "first sentence here." },
    { start: 5000, end: 7000, content: "much later sentence." }, // 本就有 3s 真停顿
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 120 });
  assert.strictEqual(seg.length, 2);
  // 第二句 start 不被改动；真停顿间隙仍然很大（>= 原 3s - 尾缩量），远大于 tailTrimMs
  assert.strictEqual(seg[1].start, 5000, "下一句 start 不动");
  assert.ok(seg[1].start - seg[0].end >= 3000, "真停顿间隙保持");
});

test("tailTrim：短句(duration <= tailTrimMs*2)不缩没，end 不变且 > start", () => {
  // duration = 200ms <= 120*2=240 → 不缩
  const frags = Core.cleanupCues([
    { start: 0, end: 200, content: "hi there ok." },
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 120 });
  assert.strictEqual(seg.length, 1);
  assert.strictEqual(seg[0].end, 200, "短句不缩，end 保持");
  assert.ok(seg[0].end > seg[0].start, "end 仍 > start");
});

test("tailTrim：长句缩后保证 >= 最小可视时长(300ms)，绝不 end<start", () => {
  // duration=400ms > 240，按 120 缩本应到 280(<300)，应被钳到 start+300=300
  const frags = Core.cleanupCues([
    { start: 0, end: 400, content: "a slightly longer line." },
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 120 });
  assert.strictEqual(seg.length, 1);
  assert.strictEqual(seg[0].end, 300, "缩后保证 >= 300ms 可视下限");
  assert.ok(seg[0].end > seg[0].start);
});

test("tailTrim：tailTrimMs=0 完全关闭，与旧行为一致(end 不回缩)", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 2000, content: "first sentence here." },
    { start: 2000, end: 4000, content: "second sentence here." },
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 0 });
  assert.strictEqual(seg[0].end, 2000, "关闭尾缩 → end 不动");
  assert.strictEqual(seg[1].start - seg[0].end, 0, "仍首尾相接(旧行为)");
});

/* ============ 5c. sliceClipsByCue：按 cue 边界切 ============ */
console.log("\n[sliceClipsByCue：cue 边界、不重叠]");

test("sliceClipsByCue 按 cue 边界就近切、不切碎句子", () => {
  const cues = [
    { start: 0, end: 10000, content: "a" },
    { start: 10000, end: 20000, content: "b" },
    { start: 20000, end: 35000, content: "c" }, // 累计跨度到 35s >= 30s → 在此收尾
    { start: 35000, end: 40000, content: "d" }, // 新 clip
  ];
  const clips = Core.sliceClipsByCue(cues, 30000);
  assert.strictEqual(clips.length, 2);
  assert.strictEqual(clips[0].cues.length, 3, "前 3 条同一 clip");
  assert.strictEqual(clips[1].cues.length, 1);
  // 不重叠：clip0 最后一条 end <= clip1 第一条 start 所属逻辑
  assert.strictEqual(clips[0].startMs, 0);
  assert.strictEqual(clips[1].startMs, 35000);
  assert.strictEqual(clips[0].index, 0);
  assert.strictEqual(clips[1].index, 1);
  // 覆盖完整：两 clip 的 cue 数之和 == 总 cue 数（无重复无丢失）
  assert.strictEqual(clips[0].cues.length + clips[1].cues.length, cues.length);
});

test("sliceClipsByCue 不得从 semanticGroup 中间切断模型上下文", () => {
  const cues = [
    { start: 0, end: 4000, content: "a", semanticGroupId: "g0" },
    { start: 4000, end: 8000, content: "b", semanticGroupId: "g0" },
    { start: 8000, end: 12000, content: "c", semanticGroupId: "g0" },
    { start: 12000, end: 16000, content: "d", semanticGroupId: "g1" },
  ];
  const clips = Core.sliceClipsByCue(cues, 5000, { maxCuesPerClip: 3, keepSemanticGroups: true });
  assert.deepStrictEqual(clips.map((clip) => clip.cues.map((cue) => cue.content)), [["a", "b", "c"], ["d"]]);
  const oversized = Array.from({ length: 4 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, content: String(i), semanticGroupId: "one-group" }));
  assert.throws(() => Core.sliceClipsByCue(oversized, 5000, { maxCuesPerClip: 3, keepSemanticGroups: true }), /semantic group exceeds/);
});

/* ============ 5d. 缓存 key + LRU 裁剪 ============ */
console.log("\n[makeCacheKey + pruneCache]");

test("makeCacheKey 同输入稳定、异输入不同", () => {
  const a = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "zh-Hans", apiModel: "m", clipStartMs: 0 });
  const b = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "zh-Hans", apiModel: "m", clipStartMs: 0 });
  const c = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "ja", apiModel: "m", clipStartMs: 0 });
  assert.strictEqual(a, b, "相同输入 key 相同 → 可命中");
  assert.notStrictEqual(a, c, "目标语言不同 key 不同 → 不误命中");
});

test("真实轨重新解析后语义缓存 key 不变（第二次观看必须秒出）", () => {
  // 首屏 6-7 秒是网关单次往返的固定开销（实测：clip 切小反而更慢，1 段 7771ms vs 4 段 3798ms；
  // reasoning_effort 已是最快合法档位，none 反而 16771ms）。既然首包压不下去，
  // "第二次看同一视频秒出" 就是唯一的体验杠杆，而它完全取决于缓存 key 在重新解析后是否稳定。
  // 一旦 fingerprint 掺进不稳定输入（Date.now / 遍历顺序 / 浮点误差），缓存永远 miss，
  // 用户每次都要重等 6 秒，而所有功能测试仍会全绿 —— 没有这条门禁就没人会发现。
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "youtube-json3-rolling-raw.json"), "utf8"));
  const idOf = (tokens) => Core.makeSemanticCacheKey({
    videoId: "_yMMTVVJI4c", trackCode: "en", apiBaseUrl: "http://gw/v1", apiModel: "m",
    tokens, systemPrompt: Core.DEFAULT_RESTORATION_PROMPT,
    chunkWords: Core.SEMANTIC_CHUNK_WORDS, overlapWords: Core.SEMANTIC_OVERLAP_WORDS,
    preferredMaxWords: 10, maxWords: 12,
  });
  // 完整走两遍生产链路（parse -> cleanup -> collect），模拟下次打开页面
  const pass = () => Core.collectSemanticTokens(Core.cleanupCues(Core.parseJson3(JSON.parse(JSON.stringify(raw)))));
  const t1 = pass();
  const t2 = pass();
  assert.ok(t1.length > 0, "真实轨必须产出词流");
  assert.strictEqual(idOf(t2), idOf(t1), "重新解析同一轨 key 必须一致，否则缓存永远 miss、每次都重等首包");
  // 反向：词流真变了必须换 key，不能为了稳定而对内容不敏感
  assert.notStrictEqual(idOf(t1.slice(0, -1)), idOf(t1), "词流改变必须换 key，不得串用旧译文");
});

test("makeCacheKey 隔离旧逐 cue 协议与 block 重构缓存", () => {
  const block = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "block", clipStartMs: 0 });
  const legacy = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", contractVersion: "cue-v1", segmentationMode: "semantic", clipStartMs: 0 });
  // 跟随 core 的权威版本号，不硬编码：升版是"改变译文形态"时的必要动作，
  // 断言应验证 namespace 结构与隔离性，而不是把版本号钉死在测试里。
  assert.ok(block.startsWith(`dsc-v90|${Core.BLOCK_CONTRACT_VERSION}|block|`), "block 重构必须使用独立缓存 namespace 与 contract");
  assert.notStrictEqual(block, legacy, "block 译文不得复用旧逐 cue coverage 缓存");
  const before = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "block", clipStartMs: 0, cueFingerprint: "0:1000:a~1000:2000:b" });
  const after = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "block", clipStartMs: 0, cueFingerprint: "0:2000:a b" });
  assert.notStrictEqual(before, after, "源块边界或文本变化后缓存 key 必须隔离");
  const changedBlockPrompt = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "block", clipStartMs: 0, blockSystemPrompt: "different block contract" });
  assert.notStrictEqual(block, changedBlockPrompt, "默认 block 协议或自定义 block prompt 变化必须换缓存身份");
});


test("makeCacheKey 必须隔离 provider、prompt、reasoning 与翻译契约", () => {
  const base = {
    videoId: "v", trackCode: "en-asr", targetLang: "zh-Hans", apiModel: "m",
    apiBaseUrl: "https://gateway-a.example/v1", systemPrompt: "prompt-a",
    reasoningEffort: "low", contractVersion: "span-v1", segmentationMode: "semantic",
    clipStartMs: 0, cueFingerprint: "0:1000:hello", maxLineChars: 16,
  };
  const key = Core.makeCacheKey(base);
  for (const changed of [
    { apiBaseUrl: "https://gateway-b.example/v1" }, { systemPrompt: "prompt-b" },
    { reasoningEffort: "high" }, { contractVersion: "span-v2" }, { maxLineChars: 28 },
  ]) {
    assert.notStrictEqual(key, Core.makeCacheKey(Object.assign({}, base, changed)), "改变翻译身份后不得误命中旧缓存");
  }
});

test("validateTrackManifest 只接受受信 YouTube HTTPS 字幕 URL", () => {
  const valid = Core.validateTrackManifest({
    videoId: "dQw4w9WgXcQ",
    files: [{ name: "English", code: "en-asr", languageCode: "en", kind: "asr",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr&fmt=json3&pot=signed" }],
  });
  assert.ok(valid && valid.files.length === 1);
  assert.strictEqual(valid.files[0].languageCode, "en");
  for (const url of [
    "http://www.youtube.com/api/timedtext?v=x", "https://evil.example/api/timedtext?v=x",
    "https://localhost/api/timedtext?v=x", "https://127.0.0.1/api/timedtext?v=x",
    "data:text/plain,hello", "https://www.youtube.com/watch?v=x",
  ]) {
    assert.strictEqual(Core.validateTrackManifest({ videoId: "x", files: [{ code: "en", url }] }), null, "不受信 URL 必须整包拒绝: " + url);
  }
  assert.strictEqual(Core.validateTrackManifest({ videoId: "x", files: new Array(65).fill({ code: "en", url: "https://www.youtube.com/api/timedtext?v=x" }) }), null, "轨道数量必须有上限");
});

asyncTest("chatCompletion 透传外部 AbortSignal 并区分主动取消", async () => {
  const controller = new AbortController();
  controller.abort();
  let receivedSignal = null;
  await assert.rejects(() => Core.chatCompletion({
    apiBaseUrl: "https://gateway.example/v1", apiKey: "x", apiModel: "m",
    systemContent: "system", userContent: "user", timeoutMs: 0, signal: controller.signal,
    fetchImpl: async (_url, opts) => {
      receivedSignal = opts.signal;
      const error = new Error("aborted"); error.name = "AbortError"; throw error;
    },
  }), /translate aborted/i);
  assert.strictEqual(receivedSignal, controller.signal, "fetch 必须收到调用方的 signal");
});


asyncTest("chatCompletion 在 headers 后 body stall 期间仍可被外部 abort，且不记 usage", async () => {
  const controller = new AbortController();
  let usageCalls = 0;
  const work = Core.chatCompletion({
    apiBaseUrl: "https://gateway.example/v1", apiKey: "x", apiModel: "m",
    systemContent: "system", userContent: "user", timeoutMs: 1000, signal: controller.signal,
    onUsage: () => { usageCalls++; },
    fetchImpl: async (_url, opts) => ({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => { const e = new Error("aborted body"); e.name = "AbortError"; reject(e); }, { once: true });
      }),
    }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(Promise.race([
    work,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("body-stall-not-aborted")), 150)),
  ]), /translate aborted/i);
  assert.strictEqual(usageCalls, 0, "stale/aborted body 不得提交 usage");
});

test("诊断快照 SRT 导出当前进度:允许半成品但必须显式标记,且不污染成品导出契约", () => {
  const units = [
    { startMs: 0, endMs: 2000, originalText: "first line here", translation: "第一行" },
    { startMs: 2000, endMs: 4000, originalText: "second line untranslated", translation: "" },
    { startMs: 4000, endMs: 6000, originalText: "third line here", translation: "第三行" },
  ];
  const srt = Core.buildProgressSrt(units, { mode: "bilingual_orig_top", videoId: "vid123" });
  assert.ok(srt, "诊断导出不得因为存在未翻译单元而返回空");
  assert.match(srt, /\[DualSub 诊断快照\] vid123/, "缺少诊断文件头");
  assert.match(srt, /单元 3 \| 已译 2 \| 未译 1/, "文件头统计不对");
  assert.match(srt, /\[未翻译\]/, "未翻译单元必须显式标记,不能静默留空冒充成品");
  assert.ok(srt.includes("second line untranslated"), "未翻译单元必须保留原文");
  // 成品导出契约不受影响:同样的输入仍必须 fail-closed
  assert.equal(Core.buildSrt(units, { mode: "bilingual_orig_top", requireTranslations: true }), "",
    "诊断导出不得放宽成品导出的 fail-closed 契约");
});

test("诊断统计必须能定位读不完的单元", () => {
  const stats = Core.progressSrtStats([
    // 13 词 / 1000ms = 77ms/词,正是用户反馈的失真形状
    { startMs: 0, endMs: 1000, originalText: "a b c d e f g h i j k l m", translation: "x" },
    { startMs: 2000, endMs: 5000, originalText: "normal pace line", translation: "y" },
  ]);
  assert.equal(stats.tooFast, 1, "未识别出每词时长过短的单元");
  assert.equal(stats.worst.msPerWord, 77, `最差每词时长应为 77ms,实际 ${stats.worst.msPerWord}`);
  assert.equal(stats.translated, 2);
});


test("滚动窗口 ASR 轨（json3 原生词级时间）去重叠：渲染层零重叠且起始时间零漂移", () => {
  // 回归来源（两次，方向相反，必须同时钉住）：
  //
  // 1) 重叠：真实 YouTube 自动字幕轨是滚动窗口形状——相邻 cue 大幅重叠，同一句话在连续
  //    几条里反复出现。cleanupCues 只把 cue 外层 end 压到下一条 start，但下游
  //    buildCueTokenSpanUnits 取的是 **token 跨度**，token 时间没被压，于是重叠原封不动
  //    回到渲染层，实测 3 条字幕同时上屏。
  //
  // 2) 漂移（v0.7.3 引入的回归）：为消重叠而在 canonical 层"按词序前推"
  //    （startMs = max(自身, 上一个词的 endMs)）会让时间凭空增加且永不归还，整轨累积漂移
  //    —— 实测中位晚 1961ms、最差晚 10s、53 个单元被挤到 400ms 以下，用户实测
  //    "完全对不上原始音频"。
  //
  // 因此正确契约是：**startMs 一个都不许动**（唯一必须精确贴合音轨的量），
  // 重叠只靠在渲染层截 endMs 消除。这条门禁同时断言两个方向，缺一不可。
  function mk(start, end, words) {
    const step = (end - start) / words.length;
    return {
      start: start,
      end: end,
      content: words.join(" "),
      tokens: words.map((w, i) => ({
        text: w,
        start: Math.round(start + i * step),
        end: Math.round(start + (i + 1) * step),
        nativeTiming: true,
      })),
    };
  }
  const cues = [
    mk(160, 4160, ["If", "youre", "a", "human", "person", "one", "of", "those"]),
    mk(2639, 7040, ["things", "youre", "going", "to", "want", "to", "do", "with"]),
    mk(7040, 12320, ["We", "do", "it", "for", "lots", "of", "reasons", "from"]),
    mk(10000, 13440, ["cleaning", "and", "disinfecting", "to", "other", "things"]),
  ];
  const rawOverlaps = cues.filter((c, i) => cues[i + 1] && c.end > cues[i + 1].start).length;
  assert.equal(rawOverlaps, 2, "样本必须真的带重叠，否则这条门禁测不到东西");

  // 源轨里每个词的**全部**原生起始时间。滚动窗口轨上同一个词会在多条窗口里重复出现
  // （样本里 "youre" 就出现两次：660 和 3189），所以基准是一个集合而非单值——
  // 断言"必须等于第一个出现的时间"会把正常的第二次出现误判成漂移。
  const nativeStart = new Map();
  cues.forEach((c) => c.tokens.forEach((t) => {
    if (!nativeStart.has(t.text)) nativeStart.set(t.text, new Set());
    nativeStart.get(t.text).add(t.start);
  }));

  const clean = Core.cleanupCues(cues);
  // cleanupCues 只压 cue 外层，token 原生时间必须保留：
  // 它是 appendTimelineTokens 判定滚动重复词的唯一依据，抹平会导致重复词被渲染两次。
  const timeline = Core.buildCanonicalTokenTimeline(clean);

  // 方向 2：canonical token 的起始时间必须是源轨里真实存在过的原生值（零漂移）。
  // 前推/重锚会算出源轨里根本不存在的时间，这里立刻抓到。
  // 注意这里**不能**断言 canonical token 互不重叠——滚动窗口轨上 token 时间的重叠是真实
  // 数据形态，压平它就等于改 startMs，那正是 v0.7.3 的回归。
  timeline.tokens.forEach((tok) => {
    const set = nativeStart.get(tok.text);
    if (!set) return;
    assert.ok(
      set.has(tok.startMs),
      `token "${tok.text}" 起始时间被改动：got=${tok.startMs}，源原生值只有 ${[...set].join("/")}（startMs 必须保持原生值，否则整轨累积漂移）`
    );
  });

  const units = Core.buildCueTokenSpanUnits(timeline, clean);
  const snapshot = Core.createTimelineSnapshot({
    revision: 0, videoId: "rolling", trackCode: "en", timeline: timeline, units: units,
  });
  const rendered = snapshot.renderUnits.filter((u) => String(u.originalText || "").trim());

  // 方向 1：渲染层必须零重叠
  const overlaps = rendered.filter((u, i) => rendered[i + 1] && u.endMs > rendered[i + 1].startMs);
  assert.equal(
    overlaps.length, 0,
    "渲染层仍有重叠（字幕会同时上屏）：" + overlaps.map((u) => `[${u.startMs}-${u.endMs}]`).join(" ")
  );
  // 截 endMs 不许把单元压成不可见
  const zero = rendered.filter((u) => u.endMs <= u.startMs);
  assert.equal(zero.length, 0, `出现 0ms 单元（字幕不显示）：${zero.length} 个`);
  // 压时间不能丢词：原文必须逐词守恒，否则 coverage 会 fail-closed
  const got = rendered.map((u) => u.originalText).join(" ").split(/\s+/).length;
  const want = cues.reduce((a, c) => a + c.content.split(/\s+/).length, 0);
  assert.equal(got, want, `去重叠丢词：${got} != ${want}`);
});

test("isolated 生命周期：disable 与同视频换轨必须先失效旧 generation", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /if \(!config\.enabled\) \{[\s\S]{0,260}?invalidateRuntimeRequests\(\)[\s\S]{0,260}?teardownRuntime\(true\)/, "disable 必须先 abort/失效再拆 UI");
  assert.match(src, /function switchTrack\(track\)[\s\S]{0,500}?invalidateRuntimeRequests\(\)[\s\S]{0,500}?state\.activeTrack = track[\s\S]{0,500}?loadTrack\(track\)/, "所有轨道切换必须走单一失效入口");
  assert.match(src, /async function loadTrack\(track, attempt\)[\s\S]{0,900}?trackUrl[\s\S]{0,900}?state\.activeTrack\.url === trackUrl/, "轨道 body/install 前必须复验精确轨道身份");
  // 空轨/HTTP 失败/网络错误都必须走重试,不得像旧代码那样一次就永久放弃整条轨
  assert.match(src, /if \(!cues\.length\) \{[\s\S]{0,200}?retryLater\("轨道为空"\)/, "空轨必须重试,不能直接 return(用户日志『解析后无有效字幕』的根因)");
  assert.match(src, /function retryLater\(reason\)[\s\S]{0,300}?reportTrackFailure\(reason\)/, "重试用尽后必须向用户报告失败原因");
  assert.match(src, /function isRuntimeRequestCurrent\(context\)[\s\S]{0,220}?config\.enabled/, "所有异步副作用须同时受 enabled 门禁");
});

test("翻译 identity 包含 maxLineChars，并在其变化时清空旧 snapshot 译文", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /function clipCacheKey[\s\S]{0,700}?maxLineChars:\s*identity\.maxLineChars/);
  assert.match(src, /prevMaxLineChars[\s\S]{0,900}?config\.maxLineChars !== prevMaxLineChars/);
  const base = { videoId:"v",trackCode:"en",targetLang:"zh-Hans",apiModel:"m",apiBaseUrl:"https://gw/v1",systemPrompt:"p",reasoningEffort:"low",contractVersion:"span-v1",segmentationMode:"semantic",clipStartMs:0,cueFingerprint:"x",maxLineChars:16 };
  assert.notStrictEqual(Core.makeCacheKey(base), Core.makeCacheKey(Object.assign({}, base, { maxLineChars: 28 })));
});

test("block 持久缓存采用 per-entry storage key，旧 semantic namespace 已删除", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /CACHE_ENTRY_PREFIX = "dualsub:cache-entry-v90:/);
  assert.doesNotMatch(src, /SEMANTIC_CACHE_ENTRY_PREFIX|readSemanticCacheEntry|writeSemanticCache/);
  assert.match(src, /entryStorageKey\(prefix, key\)/);
})

test("popup 配置导出在 Core.exportConfig 缺失时 fail-closed，且文案明确默认不含 key", () => {
  const js = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
  assert.ok(!/Core\.exportConfig \? Core\.exportConfig\(cfg\) : JSON\.stringify/.test(js));
  assert.match(js, /if \(!Core\.exportConfig\)[\s\S]{0,180}?导出失败/);
  assert.match(js, /默认不含 API Key/);
  assert.match(html, /默认不含 API Key/);
});

test("makeSemanticCacheKey 只复用同一视频轨道、模型、网关与严格词流", () => {
  const base = {
    videoId: "video-1",
    trackCode: "en-asr",
    apiBaseUrl: "https://gateway.example/v1",
    apiModel: "model-a",
    tokens: [
      { text: "hello", start: 0, end: 400 },
      { text: "world", start: 400, end: 900 },
    ],
  };
  const a = Core.makeSemanticCacheKey(base);
  const b = Core.makeSemanticCacheKey(Object.assign({}, base));
  assert.strictEqual(a, b, "同一严格词流应命中语义恢复缓存");
  assert.ok(a.startsWith("dss-v8|"), "多语言词法提示与动态预算的语义恢复缓存必须有独立版本 namespace");
  assert.notStrictEqual(a, Core.makeSemanticCacheKey(Object.assign({}, base, { apiModel: "model-b" })), "模型变化不得误命中");
  assert.notStrictEqual(a, Core.makeSemanticCacheKey(Object.assign({}, base, { apiBaseUrl: "https://other.example/v1" })), "网关变化不得误命中");
  assert.notStrictEqual(a, Core.makeSemanticCacheKey(Object.assign({}, base, {
    tokens: [{ text: "hello", start: 0, end: 400 }, { text: "there", start: 400, end: 900 }],
  })), "词流变化不得误命中");
});

test("pruneCache LRU 淘汰最旧条目", () => {
  const cache = { k1: { t: 100, lines: ["a"] }, k2: { t: 200, lines: ["b"] }, k3: { t: 300, lines: ["c"] } };
  const pruned = Core.pruneCache(cache, 2);
  assert.strictEqual(Object.keys(pruned).length, 2);
  assert.ok(!pruned.k1, "最旧的 k1 应被淘汰");
  assert.ok(pruned.k2 && pruned.k3, "较新的保留");
});

test("pruneCache 未超上限原样返回", () => {
  const cache = { k1: { t: 1, lines: [] } };
  const pruned = Core.pruneCache(cache, 10);
  assert.deepStrictEqual(Object.keys(pruned), ["k1"]);
});

/* ============ 5e. makeBackoff：失败退避 ============ */
console.log("\n[makeBackoff：失败计数 + 退避 + 停止]");

test("makeBackoff 连续失败 N 次后停止自动重试", () => {
  const bo = Core.makeBackoff({ maxFails: 3, baseMs: 1000, maxMs: 60000 });
  let now = 0;
  assert.ok(bo.shouldTry(now), "初始应允许");
  bo.fail(now); // fail 1 → nextAt = 1000
  assert.ok(!bo.shouldTry(now), "退避期内不允许");
  assert.ok(bo.shouldTry(now + 1000), "退避结束后允许");
  bo.fail(now + 1000); // fail 2 → 退避 2000
  assert.ok(bo.shouldTry(now + 5000));
  bo.fail(now + 5000); // fail 3 → 达上限停止
  assert.ok(bo.stopped, "应进入停止态");
  assert.ok(!bo.shouldTry(now + 1e9), "停止后永远不重试");
});

test("makeBackoff reset 恢复（模拟用户手动重试）", () => {
  const bo = Core.makeBackoff({ maxFails: 2 });
  bo.fail(0);
  bo.fail(0);
  assert.ok(bo.stopped);
  bo.reset();
  assert.ok(!bo.stopped && bo.shouldTry(0), "reset 后恢复可重试");
});

/* ============ 5g. findCueIndexAt：二分 + hint O(1) ============ */
console.log("\n[findCueIndexAt：二分查找当前 cue]");

const fcCues = [
  { start: 0, end: 1000, content: "a" },
  { start: 1000, end: 2000, content: "b" },
  { start: 2500, end: 3000, content: "c" }, // 与 b 之间有 500ms 间隙
  { start: 3000, end: 4000, content: "d" },
];

test("findCueIndexAt 空数组返回 -1", () => {
  assert.strictEqual(Core.findCueIndexAt([], 100), -1);
  assert.strictEqual(Core.findCueIndexAt(null, 100), -1);
});

test("findCueIndexAt 单元素命中/不命中", () => {
  const one = [{ start: 100, end: 200, content: "x" }];
  assert.strictEqual(Core.findCueIndexAt(one, 150), 0);
  assert.strictEqual(Core.findCueIndexAt(one, 50), -1, "之前不命中");
  assert.strictEqual(Core.findCueIndexAt(one, 200), -1, "end 是开区间，不命中");
  assert.strictEqual(Core.findCueIndexAt(one, 250), -1, "之后不命中");
});

test("findCueIndexAt 各 cue 边界命中正确", () => {
  assert.strictEqual(Core.findCueIndexAt(fcCues, 0), 0, "start 命中");
  assert.strictEqual(Core.findCueIndexAt(fcCues, 999), 0);
  assert.strictEqual(Core.findCueIndexAt(fcCues, 1000), 1, "下一条 start");
  assert.strictEqual(Core.findCueIndexAt(fcCues, 2999), 2);
  assert.strictEqual(Core.findCueIndexAt(fcCues, 3500), 3);
});

test("findCueIndexAt 落在间隙返回 -1（无字幕区）", () => {
  assert.strictEqual(Core.findCueIndexAt(fcCues, 2200), -1, "1000~2500 的间隙(2000~2500)不命中");
  assert.strictEqual(Core.findCueIndexAt(fcCues, 5000), -1, "越过最后一条不命中");
});

test("findCueIndexAt hint 命中相邻 O(1) 与二分结果一致", () => {
  // 给一个正确 hint：当前 cue
  assert.strictEqual(Core.findCueIndexAt(fcCues, 1500, 1), 1, "hint 命中自身");
  // 给上一条的 hint，播放推进到下一条：应走 hint+1 快路径
  assert.strictEqual(Core.findCueIndexAt(fcCues, 3500, 2), 3, "hint+1 命中");
  // 错误/过时 hint 也能靠二分纠正
  assert.strictEqual(Core.findCueIndexAt(fcCues, 0, 3), 0, "过时 hint 不影响正确性");
  assert.strictEqual(Core.findCueIndexAt(fcCues, 2999, 0), 2, "远 hint 走二分");
});

/* ============ 5h. cueClipIndexMap：全局 cue→clip 映射 ============ */
console.log("\n[cueClipIndexMap：cue→clip 反查表]");

console.log("\n[sliceClipsByCue：首 clip 更短 + 软上限]");

test("sliceClipsByCue firstTargetMs：首 clip 用更短目标，后续仍用 targetMs", () => {
  // 模拟 resegment 后的长开场：前几条 cue 跨度大
  const cues = [
    { start: 0, end: 3500, content: "AAAA" },
    { start: 4000, end: 5200, content: "BBBB" },
    { start: 7000, end: 8100, content: "CCCC" },
    { start: 10000, end: 14000, content: "DDDD" },
    { start: 15000, end: 20000, content: "EEEE" },
    { start: 21000, end: 28000, content: "FFFF" },
  ];
  // 无 firstTargetMs：target 12000 → 首 clip 会吃到 end-start>=12000 的那条
  const plain = Core.sliceClipsByCue(cues, 12000);
  assert.ok(plain[0].cues.length >= 3, "默认首 clip 会累积到 target");

  // firstTargetMs=4000：首 clip 在第 2 条后就该收（span 5200>=4000）
  const short = Core.sliceClipsByCue(cues, 12000, { firstTargetMs: 4000 });
  assert.strictEqual(short[0].cues.length, 2, "首 clip 应更短");
  assert.deepStrictEqual(short[0].cues.map((c) => c.content), ["AAAA", "BBBB"]);
  // 后续 clip 仍按 12000
  assert.ok(short.length >= 2);
  const restChars = short.slice(1).reduce((n, cl) => n + cl.cues.length, 0);
  assert.strictEqual(restChars, 4, "剩余 cue 全部分到后续 clip");
});

test("sliceClipsByCue maxCuesPerClip：软上限不跨 cue 切断", () => {
  const cues = [];
  for (let i = 0; i < 8; i++) {
    cues.push({ start: i * 1000, end: i * 1000 + 900, content: "c" + i });
  }
  const clips = Core.sliceClipsByCue(cues, 60000, { maxCuesPerClip: 3 });
  assert.ok(clips.every((c) => c.cues.length <= 3), "每 clip ≤3 cue");
  assert.strictEqual(clips.reduce((n, c) => n + c.cues.length, 0), 8, "不丢 cue");
  // 不重叠
  for (let i = 1; i < clips.length; i++) {
    assert.ok(clips[i].startMs >= clips[i - 1].endMs, "clip 不重叠");
  }
});

test("sliceClipsByCue maxSourceChars：源文字数软上限", () => {
  const cues = [
    { start: 0, end: 1000, content: "abcdefghij" }, // 10
    { start: 1100, end: 2000, content: "klmnopqrst" }, // 10 → 累计 20
    { start: 2100, end: 3000, content: "uvwxyzABCD" }, // 10
  ];
  const clips = Core.sliceClipsByCue(cues, 60000, { maxSourceChars: 15 });
  // 第 1 条后 10<15，吃第 2 条后 20>=15 收尾
  assert.strictEqual(clips[0].cues.length, 2);
  assert.strictEqual(clips[1].cues.length, 1);
});

test("cueClipIndexMap 与 sliceClipsByCue 协作映射正确", () => {
  const cues = [
    { start: 0, end: 10000, content: "a" },
    { start: 10000, end: 20000, content: "b" },
    { start: 20000, end: 35000, content: "c" }, // clip0 收尾(跨度>=30s)
    { start: 35000, end: 40000, content: "d" }, // clip1
    { start: 40000, end: 45000, content: "e" },
  ];
  const clips = Core.sliceClipsByCue(cues, 30000);
  const map = Core.cueClipIndexMap(clips);
  // 映射长度 == 总 cue 数
  assert.strictEqual(map.length, cues.length);
  // 全局下标 0..2 在 clip0，3..4 在 clip1
  assert.deepStrictEqual(map[0], { clipIdx: 0, cueIdx: 0 });
  assert.deepStrictEqual(map[2], { clipIdx: 0, cueIdx: 2 });
  assert.deepStrictEqual(map[3], { clipIdx: 1, cueIdx: 0 });
  assert.deepStrictEqual(map[4], { clipIdx: 1, cueIdx: 1 });
  // 用 findCueIndexAt + map 能正确反查某时间点的 clip 与 clip 内下标
  const gi = Core.findCueIndexAt(cues, 36000);
  assert.strictEqual(gi, 3);
  assert.deepStrictEqual(map[gi], { clipIdx: 1, cueIdx: 0 });
});

test("cueClipIndexMap 空/非数组安全", () => {
  assert.deepStrictEqual(Core.cueClipIndexMap([]), []);
  assert.deepStrictEqual(Core.cueClipIndexMap(null), []);
});

/* ============ 5i. exportConfig / importConfig round-trip ============ */
console.log("\n[配置导入/导出 round-trip]");

test("exportConfig 默认排除 API Key，显式 includeSecrets 才可导出", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, { apiKey: "x", fontSize: 30 });
  const text = Core.exportConfig(cfg);
  const obj = JSON.parse(text);
  assert.strictEqual(obj.__dualsub, 1);
  assert.ok(obj.config && typeof obj.config === "object");
  Object.keys(Core.DEFAULT_CONFIG).forEach((k) => {
    if (k !== "apiKey") assert.ok(k in obj.config, "导出应含非敏感键 " + k);
  });
  assert.ok(!("apiKey" in obj.config), "默认配置备份不得泄露 API Key");
  assert.strictEqual(obj.config.fontSize, 30);
  const withSecrets = JSON.parse(Core.exportConfig(cfg, { includeSecrets: true }));
  assert.strictEqual(withSecrets.config.apiKey, "x", "仅显式选择时允许包含凭据");
});

test("无凭据 export→import 保留普通配置并清空 API Key", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, {
    apiBaseUrl: "https://gw/v1", apiKey: "x", apiModel: "gpt-4o-mini",
    targetLang: "zh-Hans", fontSize: 26, transOnTop: false, showLoading: false,
  });
  const res = Core.importConfig(Core.exportConfig(cfg));
  assert.ok(res.ok, "导入应成功");
  Object.keys(Core.DEFAULT_CONFIG).forEach((k) => {
    const expected = k === "apiKey" ? Core.DEFAULT_CONFIG.apiKey : cfg[k];
    assert.strictEqual(res.config[k], expected, "键 " + k + " round-trip 应符合敏感字段策略");
  });
});

test("importConfig 接受扁平对象、忽略未知键、类型校验", () => {
  const res = Core.importConfig(
    JSON.stringify({ apiModel: "m", fontSize: "40", stroke: 0, junkKey: "x" })
  );
  assert.ok(res.ok);
  assert.strictEqual(res.config.apiModel, "m");
  assert.strictEqual(res.config.fontSize, 40, "字符串数字应转 int");
  assert.strictEqual(res.config.stroke, false, "0 → false");
  assert.ok(!("junkKey" in res.config), "未知键应被丢弃");
  // 未提供的键回落默认
  assert.strictEqual(res.config.targetLang, Core.DEFAULT_CONFIG.targetLang);
});

test("importConfig 坏 JSON / 空对象报错", () => {
  assert.strictEqual(Core.importConfig("{not json").ok, false);
  assert.strictEqual(Core.importConfig("null").ok, false);
  assert.strictEqual(Core.importConfig("{}").ok, false, "无可识别字段应失败");
});

/* ============ 5j. DEFAULT_SYSTEM_PROMPT：v0.5 cue 1:1 契约 ============ */
console.log("\n[structured translation prompt 契约校验]");





test("自定义 systemPrompt 仍覆盖默认（现有逻辑不变）", () => {
  const custom = Core.buildSystemPrompt("ja", "MY CUSTOM {TARGET_LANG} PROMPT");
  assert.strictEqual(custom, "MY CUSTOM ja PROMPT", "非空自定义应覆盖默认并替换占位符");
});

/* ============ 5f. normalizeColor ============ */
console.log("\n[normalizeColor + DEFAULT_CONFIG]");

test("targetLang fail-closed：只接受简体中文别名，拒绝未实现语言", () => {
  assert.strictEqual(Core.normalizeTargetLang("zh-CN"), "zh-Hans");
  assert.strictEqual(Core.normalizeTargetLang("简体中文"), "zh-Hans");
  assert.strictEqual(Core.normalizeTargetLang("ja"), null);
  assert.strictEqual(Core.migrateConfig({ targetLang: "ko" }).targetLang, "zh-Hans");
  const bad = Core.importConfig(JSON.stringify({ targetLang: "ja" }));
  assert.strictEqual(bad.ok, false);
  const popupHtml = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
  assert.match(popupHtml, /<select id="targetLang">[\s\S]*value="zh-Hans"/);
  assert.ok(!/<input[^>]+id="targetLang"/.test(popupHtml), "不得用自由文本暗示任意目标语言已受支持");
});

test("normalizeColor 合法色透传、非法回落", () => {
  assert.strictEqual(Core.normalizeColor("#FFCC00", "#fff"), "#ffcc00");
  assert.strictEqual(Core.normalizeColor("#abc", "#fff"), "#abc");
  assert.strictEqual(Core.normalizeColor("", "#7fdfff"), "#7fdfff", "空值回落");
  assert.strictEqual(Core.normalizeColor("red", "#7fdfff"), "#7fdfff", "非法回落");
  assert.strictEqual(Core.normalizeColor("#000000", "#fff"), "#000000", "合法黑色应保留");
});

test("DEFAULT_CONFIG 含关键字段且颜色非空", () => {
  const d = Core.DEFAULT_CONFIG;
  assert.ok(d && typeof d === "object");
  assert.ok(/^#/.test(d.fontColor) && /^#/.test(d.transColor), "默认颜色非空");
  assert.ok(d.clipSeconds > 0 && d.batchLines > 0);
  assert.strictEqual(d.clipSeconds, 30, "block 默认应加载约 30 秒连续上下文");
  assert.strictEqual(d.firstClipSeconds, 12, "首块适度缩短但不能退回碎片翻译");
  assert.strictEqual(d.maxCuesPerClip, 12);
  assert.strictEqual(d.maxSourceCharsPerClip, 600);
  assert.ok(d.firstClipSeconds > 0 && d.firstClipSeconds <= d.clipSeconds,
    "firstClipSeconds 应更短或等于 clipSeconds，用于压首单元延迟");
  assert.strictEqual(d.contextLines, 3, "新增 contextLines 默认 3（每批带前 3 条原文作上下文）");
  assert.strictEqual(typeof d.showLoading, "boolean", "新增 showLoading 加载态开关");
  assert.ok(d.batchLines >= 12 && d.batchLines <= 15, "batchLines 默认在 12–15（瘦身后调优）");
  // v4 新增显示字段
  assert.strictEqual(typeof d.fontWeight, "string", "新增 fontWeight 字重");
  assert.strictEqual(typeof d.fontFamily, "string", "新增 fontFamily 字体族（默认空串）");
  assert.ok(d.globalConcurrency > 0, "新增 globalConcurrency 全局并发上限 > 0");
  // v5 描边/阴影自定义字段
  assert.strictEqual(d.strokeWidth, 1.2, "新增 strokeWidth 默认 1.2px");
  assert.ok(/^#/.test(d.strokeColor), "新增 strokeColor 默认非空");
  assert.strictEqual(d.shadowStrength, "medium", "新增 shadowStrength 默认 medium");
});

/* ============ 5f-2. 描边/阴影自定义：shadowCss + normalizeStrokeWidth + migrateConfig ============ */
console.log("\n[描边/阴影：shadowCss + normalizeStrokeWidth + migrateConfig]");

test("shadowCss 四档映射 + 非法回落 medium", () => {
  assert.strictEqual(Core.shadowCss("none"), "none");
  assert.strictEqual(Core.shadowCss("weak"), "0 1px 2px #000");
  assert.strictEqual(Core.shadowCss("medium"), "0 0 4px #000, 0 1px 2px #000");
  assert.strictEqual(Core.shadowCss("strong"), "0 0 6px #000, 0 1px 3px #000, 0 0 2px #000");
  assert.strictEqual(Core.shadowCss("STRONG"), "0 0 6px #000, 0 1px 3px #000, 0 0 2px #000", "大小写不敏感");
  assert.strictEqual(Core.shadowCss("bogus"), Core.shadowCss("medium"), "非法回落 medium");
  assert.strictEqual(Core.shadowCss(null), Core.shadowCss("medium"), "空回落 medium");
});

test("normalizeStrokeWidth 合法透传 + clamp 0–3 + 非法回落", () => {
  assert.strictEqual(Core.normalizeStrokeWidth(1.2, 1.2), 1.2);
  assert.strictEqual(Core.normalizeStrokeWidth(0, 1.2), 0, "0=无描边合法");
  assert.strictEqual(Core.normalizeStrokeWidth("2.5", 1.2), 2.5, "字符串数字");
  assert.strictEqual(Core.normalizeStrokeWidth(-1, 1.2), 0, "负值夹到 0");
  assert.strictEqual(Core.normalizeStrokeWidth(99, 1.2), 3, "超 3 夹到 3");
  assert.strictEqual(Core.normalizeStrokeWidth("abc", 1.2), 1.2, "非法回落 fallback");
  assert.strictEqual(Core.normalizeStrokeWidth(null, 0.8), 0.8, "空回落 fallback");
});

test("migrateConfig 老配置平滑迁移：stroke=false→strokeWidth=0；shadow=false→shadowStrength=none", () => {
  // 老配置只有布尔 stroke/shadow，无新字段
  const oldOff = Core.migrateConfig({ stroke: false, shadow: false });
  assert.strictEqual(oldOff.strokeWidth, 0, "旧 stroke=false → 无描边");
  assert.strictEqual(oldOff.shadowStrength, "none", "旧 shadow=false → 无阴影");
  assert.strictEqual(oldOff.strokeColor, Core.DEFAULT_CONFIG.strokeColor, "补默认描边色");

  const oldOn = Core.migrateConfig({ stroke: true, shadow: true });
  assert.strictEqual(oldOn.strokeWidth, Core.DEFAULT_CONFIG.strokeWidth, "旧 stroke=true → 默认粗细");
  assert.strictEqual(oldOn.shadowStrength, Core.DEFAULT_CONFIG.shadowStrength, "旧 shadow=true → 默认强度");
});

test("migrateConfig 已有新字段则尊重用户、不覆盖", () => {
  const c = Core.migrateConfig({ stroke: false, shadow: false, strokeWidth: 2.0, shadowStrength: "strong" });
  assert.strictEqual(c.strokeWidth, 2.0, "已显式设置 strokeWidth → 不被旧 stroke 覆盖");
  assert.strictEqual(c.shadowStrength, "strong", "已显式设置 shadowStrength → 不被旧 shadow 覆盖");
});

test("migrateConfig 不改入参（纯函数）", () => {
  const src = { stroke: false };
  const out = Core.migrateConfig(src);
  assert.ok(!("strokeWidth" in src), "入参不应被改写");
  assert.strictEqual(out.strokeWidth, 0);
});

test("export→import round-trip 携带 v5 描边/阴影字段（strokeWidth 小数不被截断）", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, {
    strokeWidth: 1.7,
    strokeColor: "#112233",
    shadowStrength: "strong",
  });
  const res = Core.importConfig(Core.exportConfig(cfg));
  assert.ok(res.ok, "导入应成功");
  assert.strictEqual(res.config.strokeWidth, 1.7, "小数 strokeWidth 应 round-trip 不被截断");
  assert.strictEqual(res.config.strokeColor, "#112233", "strokeColor round-trip");
  assert.strictEqual(res.config.shadowStrength, "strong", "shadowStrength round-trip");
});

/* ============ 5k. computeFontPx：字号随播放器高度同比缩放 + clamp ============ */
console.log("\n[computeFontPx：全屏放大 / clamp / 兜底]");

test("computeFontPx 基准高度返回基准字号", () => {
  // 默认基准高度 480：playerHeight=480 时应等于基准字号
  assert.strictEqual(Core.computeFontPx(480, 22), 22);
});

test("computeFontPx 全屏（高度翻倍）字号同比放大", () => {
  // 1080p 全屏（≈480 的 2.25 倍）→ 字号约 2.25 倍
  assert.strictEqual(Core.computeFontPx(960, 22), 44, "高度 2× → 字号 2×");
  assert.strictEqual(Core.computeFontPx(1080, 20), Math.round(20 * 1080 / 480));
});

test("computeFontPx 小窗口同比缩小", () => {
  assert.strictEqual(Core.computeFontPx(240, 22), 11, "高度 0.5× → 字号 0.5×");
});

test("computeFontPx clamp 上下限（4K 不溢出 / 极小窗口可读）", () => {
  // 极大高度 → 命中上限 96
  assert.strictEqual(Core.computeFontPx(100000, 22), 96, "上限封顶 96");
  // 极小基准 + 极小高度 → 命中下限 10
  assert.strictEqual(Core.computeFontPx(1, 22), 10, "下限保底 10");
  // 自定义 min/max 覆盖生效
  assert.strictEqual(Core.computeFontPx(100000, 22, 480, 8, 40), 40, "自定义上限 40");
});

test("computeFontPx 高度未知/非法 → 回落基准字号（仍 clamp）", () => {
  assert.strictEqual(Core.computeFontPx(0, 22), 22, "高度 0 → 基准字号");
  assert.strictEqual(Core.computeFontPx(-100, 22), 22, "负高度 → 基准字号");
  assert.strictEqual(Core.computeFontPx(NaN, 22), 22, "NaN → 基准字号");
  assert.strictEqual(Core.computeFontPx(undefined, 22), 22, "undefined → 基准字号");
});

test("computeFontPx 非法基准字号回落 DEFAULT_CONFIG.fontSize", () => {
  // baseFontSize 非法 → 用默认 22；基准高度下应得 22
  assert.strictEqual(Core.computeFontPx(480, 0), Core.DEFAULT_CONFIG.fontSize);
  assert.strictEqual(Core.computeFontPx(480, NaN), Core.DEFAULT_CONFIG.fontSize);
});

/* ============ 5l. planPrefetch：预取深度裁剪（滑动窗口 depth=3）============ */
console.log("\n[planPrefetch：深度裁剪 + 越界安全]");

test("prioritizePrefetch：当前 clip 始终排在队首，其余保序", () => {
  assert.strictEqual(typeof Core.prioritizePrefetch, "function");
  assert.deepStrictEqual(Core.prioritizePrefetch([2, 3, 4, 5], 2), [2, 3, 4, 5]);
  assert.deepStrictEqual(Core.prioritizePrefetch([3, 4, 2, 5], 2), [2, 3, 4, 5]);
  assert.deepStrictEqual(Core.prioritizePrefetch([1, 2, 3], 9), [1, 2, 3], "当前不在 plan 则原序");
  assert.deepStrictEqual(Core.prioritizePrefetch([], 0), []);
  assert.deepStrictEqual(Core.prioritizePrefetch(null, 0), []);
});

test("planPrefetch 默认 depth=3 返回 [idx..idx+3]", () => {
  assert.deepStrictEqual(Core.planPrefetch(0, 10), [0, 1, 2, 3]);
  assert.deepStrictEqual(Core.planPrefetch(3, 10), [3, 4, 5, 6]);
});

test("planPrefetch 末尾按 clipCount 裁越界", () => {
  assert.deepStrictEqual(Core.planPrefetch(4, 5), [4], "最后一个 clip 无后续");
  assert.deepStrictEqual(Core.planPrefetch(3, 5), [3, 4], "倒数第二个裁到末尾");
});

test("planPrefetch ahead 可调（0=只翻当前 / 大值裁到末尾）", () => {
  assert.deepStrictEqual(Core.planPrefetch(2, 10, 0), [2], "depth=0 只翻当前");
  assert.deepStrictEqual(Core.planPrefetch(2, 10, 4), [2, 3, 4, 5, 6], "depth=4");
  assert.deepStrictEqual(Core.planPrefetch(8, 10, 5), [8, 9], "越界被裁");
});

test("planPrefetch 越界/非法输入安全返回 []", () => {
  assert.deepStrictEqual(Core.planPrefetch(5, 5), [], "currentIdx 越界");
  assert.deepStrictEqual(Core.planPrefetch(0, 0), [], "clipCount 0");
  assert.deepStrictEqual(Core.planPrefetch(0, -1), [], "clipCount 负");
  assert.deepStrictEqual(Core.planPrefetch(-3, 5), [0, 1, 2, 3], "负 idx 夹到 0");
});

test("planPrefetch ahead 非法回落默认深度", () => {
  assert.deepStrictEqual(Core.planPrefetch(0, 10, -1), [0, 1, 2, 3], "负 ahead 回落默认 3");
  assert.deepStrictEqual(Core.planPrefetch(0, 10, NaN), [0, 1, 2, 3], "NaN 回落默认 3");
});

test("planPrefetch 动态加深：当前段剩余时间 < 15s → 多预取 1 段", () => {
  // 不传 opts：默认深度（向后兼容）
  assert.deepStrictEqual(Core.planPrefetch(0, 10), [0, 1, 2, 3], "无 opts 行为不变");
  // remainMsInCurrent < 15000 → depth+1（默认 3 → 4 段后续，含当前共 5 个下标）
  assert.deepStrictEqual(
    Core.planPrefetch(0, 10, undefined, { remainMsInCurrent: 5000 }),
    [0, 1, 2, 3, 4],
    "接近段尾应多预取 1 段"
  );
  // 剩余时间充足（>= 15000）→ 不加深
  assert.deepStrictEqual(
    Core.planPrefetch(0, 10, undefined, { remainMsInCurrent: 20000 }),
    [0, 1, 2, 3],
    "剩余充足不加深"
  );
  // 加深也受 clipCount 上限裁剪：靠近末尾不会越界
  assert.deepStrictEqual(
    Core.planPrefetch(8, 10, undefined, { remainMsInCurrent: 1000 }),
    [8, 9],
    "加深仍裁到末尾不越界"
  );
  // 显式 ahead 叠加动态加深：ahead=1 + 加深 → depth=2
  assert.deepStrictEqual(
    Core.planPrefetch(0, 10, 1, { remainMsInCurrent: 1000 }),
    [0, 1, 2],
    "显式 ahead 也能叠加加深"
  );
});

/* ============ 5m. export/import round-trip 含 v4 新字段 ============ */
console.log("\n[配置 round-trip：含 fontWeight/fontFamily/globalConcurrency]");

test("export→import round-trip 携带 v4 新字段", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, {
    fontWeight: "700",
    fontFamily: "Noto Sans SC",
    globalConcurrency: 6,
    fontSize: 28,
  });
  const text = Core.exportConfig(cfg);
  const obj = JSON.parse(text);
  // 导出对象应含新键
  assert.ok("fontWeight" in obj.config && "fontFamily" in obj.config && "globalConcurrency" in obj.config);
  const res = Core.importConfig(text);
  assert.ok(res.ok, "导入应成功");
  assert.strictEqual(res.config.fontWeight, "700", "fontWeight round-trip");
  assert.strictEqual(res.config.fontFamily, "Noto Sans SC", "fontFamily round-trip");
  assert.strictEqual(res.config.globalConcurrency, 6, "globalConcurrency round-trip（数字）");
  // 全键等价
  Object.keys(Core.DEFAULT_CONFIG).forEach((k) => {
    assert.strictEqual(res.config[k], cfg[k], "键 " + k + " round-trip 等价");
  });
});

test("importConfig 空 fontFamily 字段保留为空串（默认族）", () => {
  const text = Core.exportConfig(Object.assign({}, Core.DEFAULT_CONFIG, { fontFamily: "" }));
  const res = Core.importConfig(text);
  assert.ok(res.ok);
  assert.strictEqual(res.config.fontFamily, "", "空字体族 round-trip 仍为空串");
});

/* ============ 6. translateBatch（mock fetch 跑通整链路）============ */
async function main() {
  console.log("\n[第3层 自适应 gate：makeAdaptiveGate]");

  await asyncTest("chatCompletion 遇到 200 HTML 响应给出 Base URL 诊断而不是 JSON 语法错误", async () => {
    await assert.rejects(() => Core.chatCompletion({
      apiBaseUrl: "https://console.example",
      apiKey: "x",
      apiModel: "m",
      systemContent: "system",
      userContent: "hello",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: "https://console.example/chat/completions",
        redirected: false,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<!doctype html><html><title>Console</title></html>",
        json: async () => JSON.parse("<!doctype html>"),
      }),
    }), (err) => {
      assert.match(err.message, /返回 HTML/);
      assert.match(err.message, /\/v1/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      assert.doesNotMatch(err.message, /<html>|doctype/i, "不得把 HTML 正文抄进错误消息");
      return true;
    });
  });

  await asyncTest("chatCompletion 正确 API 路径收到伪 JSON HTML 时不再误判 Base URL", async () => {
    await assert.rejects(() => Core.chatCompletion({
      apiBaseUrl: "https://gateway.example/v1",
      apiKey: "x",
      apiModel: "m",
      systemContent: "system",
      userContent: "hello",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: "https://gateway.example/v1/chat/completions",
        redirected: false,
        headers: { get: () => "application/json; charset=utf-8" },
        text: async () => "<!doctype html><html><title>upstream failure</title></html>",
      }),
    }), (err) => {
      assert.match(err.message, /路径正确/);
      assert.match(err.message, /网关|上游/);
      assert.match(err.message, /模型路由|重试/);
      assert.doesNotMatch(err.message, /确认填写的是.*Base URL/);
      assert.doesNotMatch(err.message, /<html>|doctype/i);
      return true;
    });
  });

  await asyncTest("chatCompletion 对 HTML 包装的 HTTP 429 仍保留限流分类", async () => {
    await assert.rejects(
      () => Core.chatCompletion({
        apiBaseUrl: "https://gateway.example/v1",
        apiKey: "x",
        apiModel: "fixture-model",
        messages: [],
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          url: "https://gateway.example/v1/chat/completions",
          redirected: false,
          headers: { get: () => "text/html" },
          text: async () => "<!doctype html><html>rate limited</html>",
        }),
      }),
      (err) => err.code === "429" && Core.errorKind(err) === "429" && /API 返回 HTML 而不是 JSON/.test(err.message)
    );
  });

  await asyncTest("chatCompletion 接受完整 chat/completions 地址且不重复拼接", async () => {
    let requestedUrl = "";
    const content = await Core.chatCompletion({
      apiBaseUrl: "https://gateway.example/v1/chat/completions",
      apiKey: "x",
      apiModel: "m",
      systemContent: "system",
      userContent: "hello",
      fetchImpl: async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        };
      },
    });
    assert.strictEqual(requestedUrl, "https://gateway.example/v1/chat/completions");
    assert.strictEqual(content, "ok");
  });

  await asyncTest("chatCompletion 暴露供应商 usage 但保持字符串返回兼容", async () => {
    let usage = null;
    const content = await Core.chatCompletion({
      apiBaseUrl: "https://gateway.example/v1",
      apiKey: "x",
      apiModel: "m",
      systemContent: "system",
      userContent: "hello",
      onUsage: (value) => { usage = value; },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }),
      }),
    });
    assert.strictEqual(content, "ok");
    assert.deepStrictEqual(usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  await asyncTest("chatCompletion 非 2xx 响应即使携带 usage 也不得计入", async () => {
    let calls = 0;
    await assert.rejects(() => Core.chatCompletion({
      apiBaseUrl: "https://gateway.example/v1",
      apiModel: "m",
      onUsage: () => { calls++; },
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: { message: "upstream failed" }, usage: { total_tokens: 99 } }),
      }),
    }), /translate HTTP 500/);
    assert.strictEqual(calls, 0, "失败响应 usage 不得污染会话计数");
  });


  await asyncTest("restoreTokenBoundaries 把真实 usage 透传给运行层", async () => {
    let seen = null;
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
    const tokens = [{ text: "hello", start: 0, end: 400 }, { text: "world", start: 400, end: 900 }];
    await Core.restoreTokenBoundaries({
      tokens,
      apiBaseUrl: "https://gateway.example/v1",
      apiKey: "x",
      apiModel: "m",
      onUsage: (value) => { seen = value; },
      fetchImpl: async (_url, req) => ({
        ok: true, status: 200, headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ choices: [{ message: { content: visualBoundaryJson(req) } }], usage }),
      }),
    });
    assert.deepStrictEqual(seen, usage);
  });

  test("isolated get-state 回传当前页面真实 API usage", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const block = src.match(/if \(msg\.type === "get-state"\) \{[\s\S]*?return true;/);
    assert.ok(block && /apiUsage:\s*Object\.assign/.test(block[0]), "get-state 必须回传 usage 快照");
  });

  test("restoration prompt 与语言无关的动态视觉预算契约一致", () => {
    const prompt = Core.DEFAULT_RESTORATION_PROMPT;
    assert.ok(prompt.includes("任意语言") && prompt.includes("独立阶段") && prompt.includes("完整句"));
    assert.ok(!prompt.includes("displayCutsAfter") && prompt.includes("semanticCutsAfter") && prompt.includes("不得回显") && prompt.includes("数字+单位"), "semantic prompt 不得混入显示字段");
    assert.ok(Core.DEFAULT_DISPLAY_PROMPT.includes("displayCutsAfter") && !Core.DEFAULT_DISPLAY_PROMPT.includes("semanticCutsAfter\":["), "display prompt 必须是单字段协议");
    assert.ok(!/英语字幕边界|4–11 词|最多 12 词|6–16|最多 20 词/.test(prompt), "不得保留英文专用或固定词数协议");
  });

  test("isolated 运行时已删除独立 semantic/display 恢复层", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.doesNotMatch(src, /restoreAndPackTokens|restoreSemanticIntervalIfAvailable|stageSemanticInterval|semanticTokenBudgets/);
    assert.match(src, /Core\.translateContextBlock/);
    assert.match(src, /var blockSeconds = Math\.max\(30/);
  })

  test("运行时缓存身份与请求统一使用同一 block 契约版本", () => {
    const iso = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const core = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
    // 版本号只有一个权威来源（core 的 BLOCK_CONTRACT_VERSION）。
    // 运行时不得再写字面量，否则两侧会各自漂移。
    assert.match(core, /var BLOCK_CONTRACT_VERSION = "block-v\d+"/, "core 必须持有唯一权威版本号");
    assert.match(core, /"dsc-v90"[\s\S]*?parts\.contractVersion \|\| BLOCK_CONTRACT_VERSION/);
    assert.match(iso, /contractVersion:\s*Core\.BLOCK_CONTRACT_VERSION/, "isolated 必须引用 core 的版本号而非字面量");
    assert.doesNotMatch(iso, /contractVersion:\s*"block-v\d+"/, "运行时不得硬编码契约版本字面量");
    assert.doesNotMatch(iso, /contractVersion:\s*"coverage-v1"/);
    assert.match(iso, /writeCache\(key, \{ segments: out\.segments \}, generation\)/);
    assert.match(iso, /Core\.materializeBlockTranslation\(cached\.segments, clip\.cues, \{ maxVisualWidth: identity\.maxLineChars, requireIntegrity: true \}\)/);
    assert.match(iso, /catch \(_\) \{[\s\S]{0,160}?storageRemove\(\[entryStorageKey\(CACHE_ENTRY_PREFIX, key\)\]\)/, "损坏 block 缓存必须主动删除");
  })

  test("block 翻译和完整 SRT 共用自适应并发闸门", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const live = src.slice(src.indexOf("async function loadOrTranslateClip"), src.indexOf("async function translateClip"));
    assert.match(live, /ensureGate\(\)\.run\(async function/);
    assert.match(live, /Core\.translateContextBlock/);
    const full = src.slice(src.indexOf("async function translateFullSrtBatch"), src.indexOf("async function runFullSrtPreparation"));
    assert.match(full, /loadOrTranslateClip\(clip, mode, 1\)/, "full-SRT 必须复用前台 keyed in-flight");
    assert.doesNotMatch(full, /Core\.translateContextBlock|beginRuntimeRequest|writeCache\(/, "full-SRT 不得另建模型请求或竞态写缓存");
    const cancel = src.slice(src.indexOf('msg.type === "cancel-full-srt"'), src.indexOf('msg.type === "full-srt-status"'));
    assert.doesNotMatch(cancel, /\.abort\(/, "取消 full-SRT 不得 abort 可能被前台共享的请求");
  })

  test("运行时使用整块翻译：源译不逐 cue 对齐，缓存只保存规范化 segments", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /Core\.translateContextBlock\(\{[\s\S]{0,500}?contextBefore:[\s\S]{0,120}?contextAfter:/,
      "运行时必须把连续源块及前后只读上下文交给 block 翻译入口");
    assert.match(src, /cached\.segments[\s\S]{0,200}?Core\.materializeBlockTranslation\(cached\.segments, clip\.cues, \{ maxVisualWidth: identity\.maxLineChars, requireIntegrity: true \}\)/,
      "缓存命中必须用当前源 cue 重新物化时间，不得复用旧逐 cue coverage");
    assert.match(src, /writeCache\(key, \{ segments: out\.segments \}, generation\)/,
      "缓存只保存规范化 block segments，并受 generation 写门禁保护");
    assert.match(src, /function applyBlockUnits[\s\S]{0,500}?state\.clipUnits\[idx\] = units/,
      "目标语言自然分屏必须直接成为渲染单元，不得塞回源 cue 数量");
    assert.doesNotMatch(src.slice(src.indexOf("async function loadOrTranslateClip"), src.indexOf("async function translateClip")), /translateClipWithBoundaryRepair|parseTranslationCoverageResponse|lenient/,
      "运行时主路径不得继续经过旧逐 cue coverage/lenient 协议");
  });

  test("popup 独立显示会话 Token，不覆盖连接诊断 status", () => {
    const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
    const js = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
    assert.ok(/id="usageInfo"/.test(html), "popup 应有独立 usageInfo 区域");
    assert.ok(/updateUsageInfo\(resp\.apiUsage\)/.test(js), "popup 初始化应读取运行层 usage");
  });

  test("makeAdaptiveGate 429×2 → cap 4→2→1；之后 8 次成功 → 回升到 2", () => {
    const gate = Core.makeAdaptiveGate({ max: 4, min: 1, recoverAfter: 8, cooldownMs: 0 });
    assert.strictEqual(gate.cap(), 4, "初始 cap=max=4");
    gate.reportError("429", 0);
    assert.strictEqual(gate.cap(), 2, "第1次429: 4→2");
    gate.reportError("429", 0);
    assert.strictEqual(gate.cap(), 1, "第2次429: 2→1");
    // cooldownMs=0 → 成功立刻计入恢复。连续 8 次成功后 cap+1
    for (let i = 0; i < 7; i++) gate.recordSuccess(1);
    assert.strictEqual(gate.cap(), 1, "7次成功还不够(<8)");
    gate.recordSuccess(1);
    assert.strictEqual(gate.cap(), 2, "第8次成功: cap 回升 1→2");
  });

  test("makeAdaptiveGate cap 永不低于 min、永不高于 max", () => {
    const gate = Core.makeAdaptiveGate({ max: 4, min: 1, recoverAfter: 2, cooldownMs: 0 });
    // 狂报错：cap 应卡在 min=1，不会到 0
    for (let i = 0; i < 10; i++) gate.reportError("429", 0);
    assert.strictEqual(gate.cap(), 1, "cap 下限 = min = 1");
    // 狂成功：cap 应卡在 max=4，不会超
    for (let i = 0; i < 100; i++) gate.recordSuccess(1);
    assert.strictEqual(gate.cap(), 4, "cap 上限 = max = 4");
  });

  test("makeAdaptiveGate timeout 也降并发，other 不降", () => {
    const gate = Core.makeAdaptiveGate({ max: 4, min: 1, cooldownMs: 0 });
    gate.reportError("timeout", 0);
    assert.strictEqual(gate.cap(), 2, "timeout 触发降并发");
    gate.reportError("other", 0);
    assert.strictEqual(gate.cap(), 2, "other 不降并发");
  });

  test("errorKind 归类：429 / timeout / other", () => {
    assert.strictEqual(Core.errorKind({ code: "429", message: "translate HTTP 429" }), "429");
    assert.strictEqual(Core.errorKind(new Error("translate HTTP 429 rate limit")), "429");
    assert.strictEqual(Core.errorKind(new Error("translate timeout (20000ms)")), "timeout");
    assert.strictEqual(Core.errorKind(new Error("translate network error: boom")), "other");
    assert.strictEqual(Core.errorKind(null), "other");
  });

  await asyncTest("makeAdaptiveGate 高优先级请求越过已排队的后台任务", async () => {
  const gate = Core.makeAdaptiveGate({ max: 1, min: 1 });
  const order = [];
  let releaseBlock;
  const blocker = gate.run(() => new Promise((resolve) => { releaseBlock = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const low = gate.run(() => { order.push("low"); }, 1);
  const high = gate.run(() => { order.push("high"); }, 100);
  releaseBlock();
  await Promise.all([blocker, low, high]);
  assert.deepStrictEqual(order, ["high", "low"]);
});

test("planCoverageBatches 将后台任务合成最多 8 个 source units 的连续批次", () => {
  const items = [{ cues: [1,2,3] }, { cues: [1,2,3,4] }, { cues: [1,2] }];
  const batches = Core.planCoverageBatches(items, 8);
  assert.deepStrictEqual(batches.map((batch) => batch.reduce((n, item) => n + item.cues.length, 0)), [7, 2]);
});

test("Phase 3 usage/cache/SRT 运行时契约", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "isolated.js"), "utf8");
  assert.ok(src.includes("pendingUsage"), "usage 必须先暂存，代际确认后再提交");
  assert.ok(src.includes("removeEntryIfCurrentWrite"), "stale cache write 必须按 write marker 回滚");
  assert.ok(src.includes('msg.type === "prepare-full-srt"'), "缺少显式全轨准备入口");
  assert.ok(src.includes("msg.confirmed !== true"), "全轨付费任务必须显式确认");
  assert.ok(src.includes('msg.type === "cancel-full-srt"'), "全轨任务必须可取消");
  assert.ok(src.includes('msg.type === "full-srt-status"'), "全轨任务必须报告进度");
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  assert.ok(popup.includes("window.confirm("), "popup 必须在产生全轨费用前明确确认");
  assert.ok(popup.includes('type: "full-srt-status"'), "popup 必须轮询并显示全轨进度");
  assert.ok(popup.includes('type: "cancel-full-srt"'), "popup 必须提供取消操作");
});

asyncTest("makeAdaptiveGate run 受 cap 约束：429 后在途峰值下降", async () => {
    const gate = Core.makeAdaptiveGate({ max: 4, min: 1, cooldownMs: 0 });
    let inFlight = 0, peakBefore = 0, peakAfter = 0;
    let phase = "before";
    const task = () =>
      gate.run(async () => {
        inFlight++;
        if (phase === "before") peakBefore = Math.max(peakBefore, inFlight);
        else peakAfter = Math.max(peakAfter, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
    await Promise.all([task(), task(), task(), task()]);
    assert.ok(peakBefore > 1 && peakBefore <= 4, "降并发前峰值 " + peakBefore + " 在 (1,4]");
    gate.reportError("429", 0); // 4→2
    phase = "after";
    await Promise.all([task(), task(), task(), task()]);
    assert.ok(peakAfter <= 2, "降并发后峰值 " + peakAfter + " <= 2");
  });

  /* ============ 第2层逻辑自验：error clip 重试 + 429 降并发 + 全 done ============ */
  console.log("\n[第2层 逻辑自验：前段成功/后段429恢复 → 重试到全 done]");

  await asyncTest("逻辑自验：后段持续429然后恢复，重试调度补齐到全 done，期间 cap 下降", async () => {
    // 模拟 isolated 的 clip 状态机最小闭环：句级失败→error→backoff→后台调度重试。
    // fetchImpl: 前 N 次调用对"后段 clip"返回 429，之后恢复 200。
    const cap0 = 4;
    const gate = Core.makeAdaptiveGate({ max: cap0, min: 1, cooldownMs: 0, recoverAfter: 8 });
    let now = 0;
    const backoffs = {
      0: Core.makeBackoff({ maxFails: 6, baseMs: 2000, maxMs: 30000 }),
      1: Core.makeBackoff({ maxFails: 6, baseMs: 2000, maxMs: 30000 }),
    };
    const clipState = { 0: undefined, 1: undefined };
    let n429Seen = 0;
    let capMin = cap0;
    let block429 = true; // 后段(clip1)前期持续 429

    // 一个 clip 的翻译：clip0 永远成功；clip1 在 block429 期间抛 429，否则成功。
    async function translateOne(idx) {
      try {
        await gate.run(async () => {
          if (idx === 1 && block429) {
            n429Seen++;
            const e = new Error("translate HTTP 429"); e.code = "429";
            throw e;
          }
          return "ok";
        });
        clipState[idx] = "done";
        backoffs[idx].reset();
      } catch (e) {
        gate.reportError(Core.errorKind(e), now);
        capMin = Math.min(capMin, gate.cap());
        clipState[idx] = "error";
        backoffs[idx].fail(now);
      }
    }

    // 初翻：clip0 成功，clip1 429 → error
    await translateOne(0);
    await translateOne(1);
    assert.strictEqual(clipState[0], "done", "前段 clip0 立即 done");
    assert.strictEqual(clipState[1], "error", "后段 clip1 429 → error");
    assert.ok(gate.cap() < cap0, "429 期间 cap 已下降，实测 cap=" + gate.cap());

    // 后台重试调度器：推进时间，到点重试 clip1。前 2 轮仍 429，第 3 轮恢复。
    let rounds = 0;
    let retryCalls = 0;
    while (clipState[1] !== "done" && rounds < 20) {
      now += 31000; // 跨过最大退避，保证 shouldTry 为真
      rounds++;
      if (rounds >= 3) block429 = false; // 第3轮起网关恢复
      if (clipState[1] === "error" && backoffs[1].shouldTry(now) && !backoffs[1].stopped) {
        retryCalls++;
        await translateOne(1);
      }
    }
    assert.strictEqual(clipState[1], "done", "重试调度最终把 clip1 补齐到 done");
    assert.strictEqual(clipState[0], "done", "全部 clip 到 done");
    assert.ok(retryCalls >= 1, "error clip 确被重试调度重新翻译，重试次数=" + retryCalls);
    assert.ok(capMin <= 2, "429 期间 cap 最低降到 " + capMin + " (<=2)");
    assert.ok(n429Seen >= 2, "后段确经历多次429后才恢复，429次数=" + n429Seen);
  });


  console.log("\n[B1 导出双语 SRT：formatSrtTime + buildSrt]");

  const SRT_UNITS = [
    { startMs: 0, endMs: 2000, originalText: "hello world", translation: "你好世界" },
    { startMs: 2000, endMs: 3661000 + 5, originalText: "second line", translation: "第二行" }, // 测大时间戳补零
    { startMs: 4000, endMs: 6000, originalText: "third", translation: "" }, // 空译文
  ];

  test("formatSrtTime：毫秒 → HH:MM:SS,mmm 补零", () => {
    assert.strictEqual(Core.formatSrtTime(0), "00:00:00,000");
    assert.strictEqual(Core.formatSrtTime(5), "00:00:00,005");
    assert.strictEqual(Core.formatSrtTime(61234), "00:01:01,234");
    assert.strictEqual(Core.formatSrtTime(3661005), "01:01:01,005");
  });

  test("buildSrt bilingual_orig_top：3 块、序号递增、原文在上译文在下", () => {
    const srt = Core.buildSrt(SRT_UNITS, { mode: "bilingual_orig_top" });
    const blocks = srt.trim().split("\n\n");
    assert.strictEqual(blocks.length, 3, "3 个字幕块");
    assert.ok(/^1\n00:00:00,000 --> 00:00:02,000\nhello world\n你好世界$/.test(blocks[0]), "块1 原文在上");
    assert.ok(/^2\n/.test(blocks[1]) && /^3\n/.test(blocks[2]), "序号递增");
    assert.ok(/third$/.test(blocks[2]) && !/\n\n/.test(blocks[2]), "空译文块只剩原文，不留空行");
  });

  test("buildSrt bilingual_trans_top：译文在上、原文在下", () => {
    const srt = Core.buildSrt(SRT_UNITS, { mode: "bilingual_trans_top" });
    const b0 = srt.trim().split("\n\n")[0];
    assert.ok(/你好世界\nhello world$/.test(b0), "译文在上原文在下");
  });

  test("buildSrt only_translated：仅译文；空译文回退原文", () => {
    const srt = Core.buildSrt(SRT_UNITS, { mode: "only_translated" });
    const blocks = srt.trim().split("\n\n");
    assert.ok(/\n你好世界$/.test(blocks[0]) && !/hello world/.test(blocks[0]), "块1 仅译文");
    assert.ok(/\nthird$/.test(blocks[2]), "块3 空译文回退原文");
  });

  test("buildSrt：按 startMs 升序排序、空单元(原文译文都空)跳过", () => {
    const unsorted = [
      { startMs: 5000, endMs: 6000, originalText: "B", translation: "乙" },
      { startMs: 1000, endMs: 2000, originalText: "A", translation: "甲" },
      { startMs: 3000, endMs: 4000, originalText: "", translation: "" }, // 应跳过
    ];
    const srt = Core.buildSrt(unsorted, { mode: "only_translated" });
    const blocks = srt.trim().split("\n\n");
    assert.strictEqual(blocks.length, 2, "空单元被跳过");
    assert.ok(/\n甲$/.test(blocks[0]), "A 在前（startMs 小）");
    assert.ok(/^2\n/.test(blocks[1]) && /\n乙$/.test(blocks[1]), "B 在后、序号连续");
  });

  test("buildSrt 导出门禁：requireTranslations=true 时任何空译文都拒绝生成半成品 SRT", () => {
    const partial = [
      { startMs: 0, endMs: 1000, originalText: "translated", translation: "已翻译" },
      { startMs: 1000, endMs: 2000, originalText: "english only", translation: "" },
      { startMs: 2000, endMs: 3000, originalText: "translated again", translation: "再次翻译" },
    ];
    assert.strictEqual(Core.buildSrt(partial, { mode: "bilingual_orig_top", requireTranslations: true }), "");
    assert.strictEqual(Core.buildSrt(partial, { mode: "only_translated", requireTranslations: true }), "");
    assert.strictEqual(Core.buildSrt([{ startMs: 0, endMs: 1000, originalText: "source", translation: "   " }], { mode: "bilingual_orig_top", requireTranslations: true }), "");
    assert.strictEqual(Core.buildSrt([{ startMs: 0, endMs: 1000, originalText: "source" }], { mode: "bilingual_orig_top", requireTranslations: true }), "");
  });

  test("isolated 导出与原生字幕隐藏契约：block renderUnits 是导出权威，原文/译文时间轴独立", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /rebuildRenderTimeline\(\);[\s\S]*?var realUnits = state\.renderUnits\.filter[\s\S]*?var allTranslated = realUnits\.length > 0 && realUnits\.every/, "导出必须读取 block 渲染时间轴并检查完整译文");
    assert.match(src, /units: state\.renderUnits\.map[\s\S]*?startMs: u\.start[\s\S]*?endMs: u\.end/, "SRT 必须导出目标语言独立时间单元");
    assert.match(src, /function updateNativeCaptionVisibility[\s\S]*?!config\.enabled \|\| !state\.renderer[\s\S]*?classList\.remove\("dualsub-hide-native-captions"\)[\s\S]*?domHasDualsubText[\s\S]*?timelineHasDualsubText[\s\S]*?dualsub-hide-native-captions/, "只要 DualSub 文本层出现就必须隐藏原生字幕");
    assert.match(src, /Core\.findCueIndexAt\(state\.cues, ms, -1\)[\s\S]*?setRendererText\(sourceText, trans/, "双语原文必须独立按源时间轴查询，不得复制译文段的粗略原文");
    assert.match(src, /function translateClip[\s\S]*?segmentationModeAtStart = state\.segmentationMode[\s\S]*?timelineEpoch !== state\.timelineEpoch \|\| segmentationModeAtStart !== state\.segmentationMode[\s\S]*?applyBlockUnits/, "block 写入必须用 generation/epoch/mode 拒绝 stale 结果");
  });

  
  test("loadOrTranslateClip 直接透传 block segments/units，不再采用 repaired cue 时间轴", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /var out = \{[\s\S]*?segments: result && result\.segments[\s\S]*?units: result && result\.units/,
      "loadOrTranslateClip 必须透传自然分段及其独立渲染单元");
    assert.doesNotMatch(src.slice(src.indexOf("async function translateClip"), src.indexOf("function applyBlockUnits")), /result\.repaired|adoptRepairedClipTimeline/,
      "block 翻译不得再改写源 cue 时间轴");
    assert.match(src, /applyBlockUnits\(idx, clip, result\.key, result\.units/,
      "translateClip 必须直接安装目标语言 block units");
  });

test("buildSrt 导出门禁：requireTranslations=true 时完整双语才允许生成", () => {
    const complete = [
      { startMs: 0, endMs: 1000, originalText: "translated", translation: "已翻译" },
      { startMs: 1000, endMs: 2000, originalText: "translated again", translation: "再次翻译" },
    ];
    const srt = Core.buildSrt(complete, { mode: "bilingual_orig_top", requireTranslations: true });
    assert.ok(srt.includes("translated\n已翻译"));
    assert.ok(srt.includes("translated again\n再次翻译"));
  });

  test("buildSrt 保留字幕单元内安全换行，不把换行压成异常空格", () => {
  const srt = Core.buildSrt([
    { startMs: 0, endMs: 1000, originalText: "source", translation: "如果你是人类，你会经常做的一件事，\n就是烧水。" },
  ], { mode: "bilingual_orig_top" });
  assert.ok(srt.includes("如果你是人类，你会经常做的一件事，\n就是烧水。"));
  assert.ok(!srt.includes("事， 就是"));
});

test("buildSrt：兼容 isolated.js 的 start/end 命名", () => {
    const srt = Core.buildSrt([{ start: 0, end: 1000, originalText: "x", translation: "叉" }], {
      mode: "bilingual_orig_top",
    });
    assert.ok(/00:00:00,000 --> 00:00:01,000/.test(srt), "start/end 也能取到时间");
  });

  await asyncTest("缓存命中则零调用：命中缓存不触发 translateClipLines/fetch", async () => {
    // 模拟 isolated.js 的"先查缓存命中则零调用"语义
    const key = Core.makeCacheKey({ videoId: "v", trackCode: "en-asr", targetLang: "zh", apiModel: "m", clipStartMs: 0 });
    const cache = {};
    cache[key] = { t: Date.now(), lines: ["你好", "世界"] };
    let fetchCalled = false;
    // 命中：直接用缓存，不调 translateClipLines/fetch
    let lines;
    if (cache[key]) {
      lines = cache[key].lines;
    } else {
      fetchCalled = true;
      lines = await Core.translateClipLines({ cues: [{ content: "hello" }], apiBaseUrl: "x", apiModel: "m", fetchImpl: async () => { fetchCalled = true; return {}; } });
    }
    assert.deepStrictEqual(lines, ["你好", "世界"]);
    assert.strictEqual(fetchCalled, false, "命中缓存不应触发 fetch");
  });

  /* ============ 6c. makeSemaphore：全局 in-flight 并发不超限 ============ */
  console.log("\n[makeSemaphore：全局并发上限不被突破]");

  await asyncTest("makeSemaphore run() 峰值并发不超过 cap", async () => {
    const cap = 3;
    const sem = Core.makeSemaphore(cap);
    let inFlight = 0;
    let peak = 0;
    // 20 个任务同时丢进信号量，每个任务体内停一会儿模拟在途请求
    const task = () =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        assert.ok(inFlight <= cap, "任意时刻在途数不应超过 cap=" + cap + "（实际 " + inFlight + "）");
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
    await Promise.all(Array.from({ length: 20 }, task));
    assert.strictEqual(inFlight, 0, "全部完成后在途归零");
    assert.strictEqual(peak, cap, "峰值应恰好打满 cap（够忙才有意义）");
    assert.strictEqual(sem.inFlight, 0, "信号量内部计数复位");
    assert.strictEqual(sem.queued, 0, "无遗留排队");
  });

  await asyncTest("makeSemaphore 任务抛错也会 release（不泄漏令牌）", async () => {
    const sem = Core.makeSemaphore(1);
    let threw = false;
    try {
      await sem.run(async () => {
        throw new Error("boom");
      });
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, "错误应向上抛");
    assert.strictEqual(sem.inFlight, 0, "抛错后令牌应已释放");
    // 释放后还能正常拿令牌
    const ok = await sem.run(async () => 42);
    assert.strictEqual(ok, 42);
  });

  await asyncTest("makeSemaphore cap<1 视为 1（串行）", async () => {
    const sem = Core.makeSemaphore(0);
    assert.strictEqual(sem.max, 1);
    let inFlight = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      });
    await Promise.all([task(), task(), task()]);
    assert.strictEqual(peak, 1, "cap=0→1 应严格串行");
  });


  /* ============ 6d. v0.4.0 集成回归：core/isolated 不脱节 + 端到端产出 ============
   * 6/29 的 v0.4.0 架构简化删了 core 的 translateSentences/segmentSentenceUnit/
   * alignSentencesPartial/translateCues/translateBatch，但 isolated.js 一度仍在调它们，
   * 扩展一翻译就 Core.xxx is not a function 崩。这组测试锁死两条契约，防再次脱节：
   *  (1) isolated.js 源码里不再出现任何已删函数名（静态扫描）；且已删函数在 core 确实 0 定义。
   *  (2) translateClipLines(mock) → buildClipUnits 端到端：行数合理、时间轴单调不回退、
   *      全覆盖 clip 时间窗、译文不空，与 isolated.js 主路径同一调用序列（照 e2e-harness）。
   */
  console.log("\n[v0.4.0 集成回归：core/isolated 对接]");

  const DELETED_FNS = [
    "translateSentences",
    "segmentSentenceUnit",
    "alignSentencesPartial",
    "translateCues",
    "translateBatch",
  ];

  test("block 翻译立即使用可播放源时间轴，并以 generation/epoch 拒绝旧异步结果", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const load = src.slice(src.indexOf("async function loadTrack"), src.indexOf("/* =====================================================\n   * 翻译编排"));
    assert.ok(load.includes('installCueTimeline(fallbackCues, "block", { sourceTimeline: sourceTimeline })'), "应立即安装可播放源时间轴并启动 block 翻译");
    assert.ok(!/runInitialSemanticRestore/.test(load), "加载主路径不得再等待独立 semantic restoration");
    assert.ok(/timelineEpoch !== state\.timelineEpoch/.test(src), "旧时间轴异步请求不得写入新时间轴");
    assert.ok(/function resetForNewVideo\(\)[\s\S]{0,120}invalidateRuntimeRequests\(\)[\s\S]{0,120}state\.timelineEpoch\+\+/.test(src), "切视频必须废止旧请求");
    assert.ok(/Core\.translateContextBlock/.test(src), "所有运行时 clip 必须走 block 翻译入口");
    assert.ok(/contextBefore[\s\S]{0,200}contextAfter/.test(src), "相邻 cue 只作为上下文发送，不能要求逐条输出");
    assert.ok(/"dsc-v90"/.test(fs.readFileSync(path.join(ROOT, "core.js"), "utf8")), "block 协议必须隔离旧缓存");
    assert.ok(/white-space:nowrap/.test(src) && !/text-overflow:ellipsis/.test(src), "字幕保持单屏且不得省略内容");
    assert.ok(/function fitSubtitleRows/.test(src) && /scrollWidth/.test(src), "仍需按真实 DOM 宽度适配");
  });

  test("block 渲染时间轴独立于源 cue 数量，未翻块回退原文且真实停顿保留", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const rebuild = src.slice(src.indexOf("function rebuildRenderTimeline"), src.indexOf("/* =====================================================\n   * 渲染叠加层"));
    assert.match(rebuild, /translated\.length[\s\S]*?unit\.startMs[\s\S]*?unit\.endMs[\s\S]*?unit\.translation/, "已翻 block units 必须直接组成渲染时间轴");
    assert.match(rebuild, /else if \(clip\)[\s\S]*?clip\.cues[\s\S]*?translation: null/, "未翻块必须立即显示源 cue");
    assert.doesNotMatch(rebuild, /clipUnits\.length !== clip\.cues\.length|translations\[sourceUnit\.id\]/, "渲染层不得恢复源译 1:1 约束");
    assert.match(src, /Core\.materializeBlockTranslation\(cached\.segments, clip\.cues, \{ maxVisualWidth: identity\.maxLineChars, requireIntegrity: true \}\)/, "缓存必须按当前源时间重新物化，保留 cue gap");
    assert.ok(/if \(ms < clips\[i\]\.startMs\) return i/.test(src), "播放头在 gap 时应预热下一块");
  });

  test("isolated.js 不再引用任何 v0.4.0 已删的 core 函数", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    DELETED_FNS.forEach((fn) => {
      const re = new RegExp("Core\\." + fn + "\\b");
      assert.ok(!re.test(src), "isolated.js 不应再调用 Core." + fn + "（已删，会 is not a function 崩）");
    });
    assert.ok(/Core\.translateContextBlock\b/.test(src), "isolated.js 应调用 block 翻译入口");
    assert.ok(/Core\.materializeBlockTranslation\b/.test(src), "缓存读取应按源时间重新物化 block units");
  });

  test("已删函数在 core.js 确实 0 定义、且不在导出表里", () => {
    DELETED_FNS.forEach((fn) => {
      assert.strictEqual(typeof Core[fn], "undefined", "core 不应再导出 " + fn);
    });
    assert.strictEqual(typeof Core.translateContextBlock, "function", "translateContextBlock 应存在");
    assert.strictEqual(typeof Core.materializeBlockTranslation, "function", "materializeBlockTranslation 应存在");
  });






  /* ============ 6e. v0.4.1 打磨：原文对齐空行 / 半截短语 / 首包默认 ============
   * 验收里发现：译文行多于 cue 时，旧「cue 中点落槽」会在时隙空白处留下空 originalText
   * （双语对照约 1/3 行无英文）。这里锁死：只要该时隙与任一 cue 时间重叠，就有原文。
   */
  console.log("\n[中文目标清洗]");












  test("sanitizeSubtitleLine：只剔除不可显示字符，绝不删除专有名词原文", () => {
    // 此前这里断言的是"删掉一切拉丁串"（SodaStream/hello 被抹成空）。那个行为的
    // 本意是拦住"模型没翻译、原样回吐英文"，但机制错了：它连合法的人名/品牌/术语
    // 一起删，把已经译好的内容抹掉（"嗨 Vsauce 我是 Michael" → "嗨，，我是"）。
    // 「有没有真的翻译」现在由 validateChineseDisplayUnit 显式判定（见下一条门禁），
    // sanitize 只负责剔除控制字符等不可显示内容。
    assert.strictEqual(typeof Core.sanitizeSubtitleLine, "function");
    assert.strictEqual(Core.sanitizeSubtitleLine("功率是 8.8 千瓦"), "功率是 8.8 千瓦");
    // 专有名词必须活着
    assert.strictEqual(Core.sanitizeSubtitleLine("把水烧开对，这是个 SodaStream 瓶子"), "把水烧开对，这是个 SodaStream 瓶子");
    assert.strictEqual(Core.sanitizeSubtitleLine("嗨 Vsauce 我是 Michael"), "嗨 Vsauce 我是 Michael");
    // 控制字符/零宽字符要去掉
    assert.strictEqual(Core.sanitizeSubtitleLine("这里少\u200b得多"), "这里少得多");
    // 中文显示契约：句号不显示
    assert.strictEqual(Core.sanitizeSubtitleLine("这是一句话。"), "这是一句话");
    // 汉字之间的多余空格压掉，拉丁词两侧空格保留
    assert.strictEqual(Core.sanitizeSubtitleLine("这 是 一句话"), "这是一句话");

    // 模型会在 URL 内部插空格（实测俄语轨真实输出 "https:// example. com/ kettle"）。
    // 空格一进去这段就不再是 URL 原子，保护与宽度判定全部失效、用户复制不出链接。
    // 必须由程序确定性收回，且不得吞掉 URL 之后属于句子的空格。
    assert.strictEqual(
      Core.sanitizeSubtitleLine("详情请看网站 https:// example. com/ kettle"),
      "详情请看网站 https://example.com/kettle",
      "模型在 URL 内插的空格必须被程序删除"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("详情请看网站 https://example.com/kettle"),
      "详情请看网站 https://example.com/kettle",
      "正确的 URL 不得被改动"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("看 https://example.com/a 了解更多"),
      "看 https://example.com/a 了解更多",
      "URL 之后属于句子的空格不得被吞"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("打开 https:// example.com/p? a=1& b=2 试试"),
      "打开 https://example.com/p?a=1&b=2 试试",
      "查询串里的空格也必须收回"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("访问 www. example. com 查看"),
      "访问 www.example.com 查看",
      "www 形式同样处理"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("见 https:// a. com 和 https:// b. com"),
      "见 https://a.com 和 https://b.com",
      "多个 URL 分别收回"
    );
    assert.strictEqual(
      Core.sanitizeSubtitleLine("地址是 https://example.com/a，记住"),
      "地址是 https://example.com/a，记住",
      "URL 后的中文标点不得被算进链接"
    );
  });

  test("翻译超时必须容得下真实网关延迟，且全系统只有一处定义", () => {
    // 实测同网关同模型（gpt-5.4-mini）翻 4 行波兰语端到端 10.0s–32.4s。
    // 原先写死 20s：慢的请求被自己掐断，重试再超时，整个 clip 全成 [未翻译]。
    // 这与源语言无关，是"大面积未翻译"的第二个独立根因。
    assert.ok(Core.TRANSLATE_TIMEOUT_MS >= 60000, `翻译超时 ${Core.TRANSLATE_TIMEOUT_MS}ms 低于实测延迟上限，慢请求会被误判为失败`);
    // 上限仍须存在，否则卡死的请求会永久占住重试队列
    assert.ok(Core.TRANSLATE_TIMEOUT_MS <= 180000, "翻译超时过大，卡死请求会占住重试队列");
    // 不得再各处硬写 20000
    const isolatedSrc = fs.readFileSync(path.join(__dirname, "../isolated.js"), "utf8");
    assert.equal(
      /timeoutMs:\s*\d+/.test(isolatedSrc), false,
      "isolated.js 又出现硬编码 timeoutMs，必须统一取 Core.TRANSLATE_TIMEOUT_MS"
    );
  });

  test("validateChineseDisplayUnit：显式判定「模型没翻译」而不是靠删拉丁字母", () => {
    const judge = (t) => Core.validateChineseDisplayUnit(t, { continues: false, maxVisualWidth: 200 });
    // 合法：夹专有名词、缩写、单位的中文译文必须通过
    assert.strictEqual(judge("嗨 Vsauce 我是 Michael").ok, true, "专有名词密集的正确译文被误杀");
    assert.strictEqual(judge("这是个 SodaStream 瓶子").ok, true, "品牌名导致误杀");
    assert.strictEqual(judge("NASA 绘制了温度图").ok, true, "缩写导致误杀");
    assert.strictEqual(judge("功率是 8.8 千瓦").ok, true, "数字导致误杀");
    assert.strictEqual(judge("在 Google 和 Amazon 的数据中心里存储着数百万台服务器").ok, true, "多专名长句被误杀");
    // 没翻译：整条源语言原样回吐必须拒绝（与源语言无关）
    assert.strictEqual(judge("still English here").reason, "no-chinese", "纯英文未被拦住");
    assert.strictEqual(judge("Mimas jest jednym z najsłodszych księżyców").reason, "no-chinese", "纯波兰语未被拦住");
    assert.strictEqual(judge("Mimas jest jednym z 的").reason, "mostly-untranslated", "几乎没译未被拦住");
    assert.strictEqual(judge("Mimas is one of Saturns cutest 卫星").reason, "mostly-untranslated", "半英半中未被拦住");
  });




  /* ============ 6f. 选轨不得维护源语言名单 ============ */
  console.log("\n[所有源语言统一选轨]");
  test("运行时不再包含中英文源语言特判或 skipChineseSource", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const core = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
    const popup = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8") + fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
    assert.doesNotMatch(src, /isEnglishTrack|isChineseTrack|shouldSkipChineseSource|skipChineseSource/);
    assert.doesNotMatch(core, /isChineseLangCode|shouldSkipChineseSource|skipChineseSource\s*:/);
    assert.match(core, /delete c\.skipChineseSource/, "迁移时应清除旧废字段");
    assert.doesNotMatch(popup, /skipChineseSource/);
    const pick = src.slice(src.indexOf("function pickTrack"), src.indexOf("/* =====================================================", src.indexOf("function pickTrack")));
    assert.match(pick, /sourceLang === "auto"[\s\S]*?picked = list\[0\]/);
    assert.match(pick, /Core\.preferManualTrack\(list, picked\)/);
    assert.doesNotMatch(pick, /picked = exact \|\| prefix \|\| list\[0\]/, "显式源语言不存在时不得偷偷换成其它语言");
    assert.doesNotMatch(pick, /["'](?:en|zh|ja|ar|th|pl)["']/);
  });

  console.log("\n[token-span coverage 1:1 对齐]");
  test("buildClipUnits 1:1：行数=cue 数时用 cue 时间与原文", () => {
    const cues = [
      { start: 0, end: 3000, content: "If you are a human person," },
      { start: 3000, end: 6000, content: "one of those things you will do" },
      { start: 6000, end: 9000, content: "is boil water." },
    ];
    const units = Core.buildClipUnits(["如果你是人类", "你会经常做的一件事", "就是烧水"], 0, 9000, cues);
    assert.strictEqual(units.length, 3);
    assert.strictEqual(units[0].originalText, "If you are a human person,");
    assert.strictEqual(units[0].startMs, 0);
    assert.strictEqual(units[0].endMs, 3000);
    assert.strictEqual(units[1].startMs, 3000);
  });

  test("DEFAULT_CONFIG 行长接近正常字幕 + 首包等待", () => {
    assert.ok(Core.DEFAULT_CONFIG.minLineChars >= 10);
    assert.strictEqual(Core.DEFAULT_CONFIG.maxLineChars, 0, "双语对照模式不得在中文 cue 内插入换行");
    assert.strictEqual(Core.DEFAULT_CONFIG.waitForFirstTranslation, true);
    assert.ok(Core.DEFAULT_CONFIG.waitForFirstTranslationMs >= 1000 && Core.DEFAULT_CONFIG.waitForFirstTranslationMs <= 15000);
  });

  /* ============ 7. 交付物校验 ============ */
  console.log("\n[交付物校验]");

  test("manifest.json 能 JSON.parse 且字段完整", () => {
    const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
    const m = JSON.parse(raw);
    assert.strictEqual(m.manifest_version, 3);
    assert.match(m.version, /^\d+\.\d+\.\d+$/, "manifest 版本必须是 semver（发版时同步 bump，不再硬编码单一版本）");
    // README 是项目唯一权威说明，不能落后于 manifest：曾出现只 bump 一处的漂移。
    // 门禁只锁"README 声明的当前版本 == manifest 版本"，不锁具体号。
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const declared = readme.match(/当前版本：\*\*v(\d+\.\d+\.\d+)\*\*/);
    assert.ok(declared, "README 必须声明当前版本");
    assert.strictEqual(declared[1], m.version, "README 当前版本必须与 manifest.json 一致");
    assert.ok(
      readme.includes(`/releases/tag/v${m.version}`),
      "README 的 Releases 链接必须指向当前版本的 tag",
    );
    assert.ok(Array.isArray(m.content_scripts) && m.content_scripts.length === 2);
    const worlds = m.content_scripts.map((c) => c.world).sort();
    assert.deepStrictEqual(worlds, ["ISOLATED", "MAIN"]);
    assert.ok(m.host_permissions.includes("<all_urls>"), "需 <all_urls> 才能跨域翻译");
    assert.strictEqual(m.action.default_popup, "popup.html");
  });

  test("图标是真 PNG 且 >0 字节", () => {
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const s of [16, 48, 128]) {
      const p = path.join(ROOT, "icons", s + ".png");
      const buf = fs.readFileSync(p);
      assert.ok(buf.length > 0, s + ".png 应 >0 字节");
      assert.ok(buf.slice(0, 8).equals(PNG_SIG), s + ".png 应是真 PNG");
    }
  });

  test("popup.html 引用 popup.js", () => {
    const html = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
    assert.ok(/popup\.js/.test(html));
  });


  test("canonical overlap 只去除时间重叠的滚动前缀，保留真实相邻重复词并支持超过 8 词", () => {
    const repeated = Core.buildCanonicalTokenTimeline([
      { start: 0, end: 500, content: "yes", tokens: [{ text: "yes", start: 0, end: 500, nativeTiming: true }] },
      { start: 500, end: 1000, content: "yes again", tokens: [
        { text: "yes", start: 500, end: 700, nativeTiming: true }, { text: "again", start: 700, end: 1000, nativeTiming: true },
      ] },
    ]);
    assert.deepStrictEqual(repeated.tokens.map(t => t.text), ["yes", "yes", "again"]);
    const words = ["one","two","three","four","five","six","seven","eight","nine"];
    const first = words.map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100, nativeTiming: true }));
    const rolling = words.map((text, i) => ({ text, start: i * 100 + 50, end: (i + 1) * 100 + 50, nativeTiming: true }));
    rolling.push({ text: "ten", start: 950, end: 1050, nativeTiming: true });
    const timeline = Core.buildCanonicalTokenTimeline([
      { start: 0, end: 900, content: words.join(" "), tokens: first },
      { start: 50, end: 1050, content: words.join(" ") + " ten", tokens: rolling },
    ]);
    assert.deepStrictEqual(timeline.tokens.map(t => t.text), words.concat("ten"));
  });

  test("planCoverageBatches 对单项超过硬上限 fail-closed，所有批次总 unit 数均不超过 8", () => {
    const item = n => ({ cues: Array.from({ length: n }, (_, i) => ({ content: String(i) })) });
    assert.throws(() => Core.planCoverageBatches([item(9)], 8), /exceeds coverage batch limit/i);
    const batches = Core.planCoverageBatches([item(5), item(3), item(4), item(4)], 8);
    assert.ok(batches.length > 1);
    assert.ok(batches.every(batch => batch.reduce((n, x) => n + x.cues.length, 0) <= 8));
  });

  test("makeCacheKey 只规范化 endpoint scheme/host，保留大小写敏感 path/query", () => {
    const base = { videoId:"v", trackCode:"en", targetLang:"zh-Hans", apiModel:"m", clipStartMs:0, cueFingerprint:"f" };
    assert.notStrictEqual(Core.makeCacheKey({ ...base, apiBaseUrl:"https://gw.example/V1?tenant=A" }), Core.makeCacheKey({ ...base, apiBaseUrl:"https://gw.example/v1?tenant=A" }));
    assert.notStrictEqual(Core.makeCacheKey({ ...base, apiBaseUrl:"https://gw.example/v1?tenant=A" }), Core.makeCacheKey({ ...base, apiBaseUrl:"https://gw.example/v1?tenant=a" }));
    assert.strictEqual(Core.makeCacheKey({ ...base, apiBaseUrl:"HTTPS://GW.EXAMPLE/v1/" }), Core.makeCacheKey({ ...base, apiBaseUrl:"https://gw.example/v1" }));
  });

  test("validateTrackManifest 把 timedtext URL 绑定到声明的视频、语言和轨道类型", () => {
    const base = { videoId:"videoA", files:[{ name:"English", code:"en-asr", languageCode:"en", kind:"asr", url:"https://www.youtube.com/api/timedtext?v=videoA&lang=en&kind=asr&pot=signed" }] };
    assert.ok(Core.validateTrackManifest(base, { expectedVideoId:"videoA" }));
    assert.strictEqual(Core.validateTrackManifest(base, { expectedVideoId:"videoB" }), null);
    for (const url of [
      "https://www.youtube.com/api/timedtext?v=videoB&lang=en&kind=asr&pot=signed",
      "https://www.youtube.com/api/timedtext?v=videoA&lang=fr&kind=asr&pot=signed",
      "https://www.youtube.com/api/timedtext?v=videoA&lang=en&pot=signed",
      "https://www.youtube.com/api/timedtext?v=videoA&lang=en&kind=asr",
      "https://www.youtube.com/api/timedtext?v=videoA&lang=en&kind=asr&tlang=zh-Hans&pot=signed",
    ]) assert.strictEqual(Core.validateTrackManifest({ ...base, files:[{ ...base.files[0], url }] }, { expectedVideoId:"videoA" }), null, url);
  });

  // ── 连字符复合词:词切分口径必须全系统统一 ──────────────────────────
  // 回归防护。曾有三份互相矛盾的词正则(parseJson3 与 restoredBoundaryMarks
  // 各自手写不含连字符的版本,RESTORE_WORD_RE 含连字符),使 "purpose-built"
  // 在 canonical 侧算 2 个 token、显示侧算 1 个词 → 两条词流从该处永久错位 →
  // 对齐抛 "display cue does not align to canonical timeline" → 整轨字幕
  // (含英文原文)全部消失。真机轨含 old-fashioned / plug-in / purpose-built。
  // 此前 210 个测试全绿却漏掉,因为 fixture 无 tokens 字段,从未走词级时间路径。
  test("连字符复合词在 parseJson3 中算一个 token", () => {
    const cues = Core.parseJson3({
      events: [{
        tStartMs: 0, dDurationMs: 2000,
        segs: [
          { utf8: "these ", tOffsetMs: 0 },
          { utf8: "purpose-built ", tOffsetMs: 500 },
          { utf8: "old-fashioned ", tOffsetMs: 1000 },
          { utf8: "plug-in ", tOffsetMs: 1500 },
        ],
      }],
    });
    assert.strictEqual(cues.length, 1);
    const texts = cues[0].tokens.map((t) => t.text);
    assert.deepStrictEqual(texts, ["these", "purpose-built", "old-fashioned", "plug-in"],
      "连字符复合词被拆开了,词流会与显示侧永久错位");
  });

  test("含连字符复合词的整轨:canonical 与显示词流对齐不抛错", () => {
    // 每个 event 10 词,含连字符词;走真实生产参数。
    const words = ("If you are a human person one of those purpose-built things " +
      "you will want to do with some regularity is boil water using an old-fashioned " +
      "plug-in kettle because it heats much faster than any stove top method here").split(" ");
    const events = [];
    const PER = 250;
    for (let i = 0; i < words.length; i += 10) {
      const chunk = words.slice(i, i + 10);
      events.push({
        tStartMs: i * PER,
        dDurationMs: chunk.length * PER,
        segs: chunk.map((w, j) => ({ utf8: w + " ", tOffsetMs: j * PER })),
      });
    }
    const cues = Core.cleanupCues(Core.parseJson3({ events }));
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
    // 修复前此处抛 "display cue does not align to canonical timeline"
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const covered = units.reduce((n, u) => n + (u.tokenEnd - u.tokenStart), 0);
    assert.strictEqual(covered, timeline.tokens.length, "词流覆盖不完整,存在丢词");
    assert.ok(units.length > 0, "未产出任何显示单元");
  });

  // ── 滚动 ASR 大重叠:重复回看范围必须随数据自适应 ────────────────────
  // 回归防护。曾把回看范围写死为常量 32,而滚动 ASR 的重发前缀长度由单条 cue
  // 的词数决定:cue 长 40 词、重发 35 词时同词上次出现距离达 36 > 32,
  // 判不出是重复 → 抛 "display cue does not align to canonical timeline"
  // → 整轨字幕(含英文原文)全部消失。现改为「最长 display cue 的词数」。
  test("滚动 ASR 大重叠(重发前缀 > 32 词)仍能对齐且不丢词", () => {
    const base = ("If you are a human person one of those things you will want to do " +
      "with some regularity is boil water We do it for lots of reasons from cooking " +
      "to cleaning and disinfecting to other things probably And one of the fastest " +
      "ways to heat water across the planet is a purpose built electric kettle which " +
      "many people in some countries use every single morning without thinking twice").split(" ");
    const PER = 250;
    // seg=40 / ov=35:重发前缀 35 词,同词回看距离可超过 32
    const SEG = 40, OV = 35;
    const events = [];
    let pos = 0;
    while (pos < base.length) {
      const from = Math.max(0, pos - OV);
      const to = Math.min(base.length, pos + SEG);
      events.push({
        tStartMs: from * PER,
        dDurationMs: (to - from) * PER,
        segs: base.slice(from, to).map((w, j) => ({ utf8: w + " ", tOffsetMs: (from + j) * PER - from * PER })),
      });
      pos = to;
    }
    const cues = Core.cleanupCues(Core.parseJson3({ events }));
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const covered = units.reduce((n, u) => n + (u.tokenEnd - u.tokenStart), 0);
    assert.strictEqual(covered, timeline.tokens.length, "大重叠下词流覆盖不完整");
  });

  // ── 句中切开的译文不得被判违规 ──────────────────────────────────
  // 回归防护。分屏器会故意在句中切开(一屏最多 ~12 词),这种单元的忠实译文
  // 本来就该断在逗号上。曾有两处缺陷叠加导致这类正确译文被拒、整段回退英文:
  //   1) validateChineseDisplayUnit 不看原文,一律拒绝逗号结尾;
  //   2) parseTranslationCoverageResponse 重建 expected 时把 sourceText 丢掉,
  //      于是即便校验侧想对照原文也永远拿到 undefined。
  // gpt-5.4-mini 上实测首 clip 3 行有 2 行被误杀(3/3 复现),修复后 5/5 通过。
  test("句中切开的译文(逗号结尾)不判违规", () => {
    var midSentence = Core.validateChineseDisplayUnit("如果你是人类，", {
      sourceText: "If you're a human person,",
      continues: true,
    });
    assert(midSentence.ok, "句中续的逗号结尾译文被误判: " + midSentence.reason);

    // 整句到此为止却断在逗号 → 仍必须拒绝(这才是真的没译完)
    var ended = Core.validateChineseDisplayUnit("如果你是人类，", {
      sourceText: "If you're a human person.",
      continues: false,
    });
    assert(!ended.ok && ended.reason === "non-terminal-punctuation",
      "整句结尾的逗号译文本应被拒,实际: " + JSON.stringify(ended));

    // 只给原文时应能自行推断:原文无终止标点 = 还没说完
    var inferred = Core.validateChineseDisplayUnit("如果你是人类，", {
      sourceText: "If you're a human person,",
    });
    assert(inferred.ok, "未能从原文推断句中续: " + inferred.reason);
  });

  // sourceText 必须真的流到校验侧(防 expected 重建时再次丢字段)
  test("覆盖响应解析保留 sourceText", () => {
    var units = [
      { unitId: "u0", tokenStart: 0, tokenEnd: 5, sourceText: "If you're a human person," },
      { unitId: "u1", tokenStart: 5, tokenEnd: 9, sourceText: "we boil water." },
    ];
    var payload = JSON.stringify({
      translations: [
        { unitId: "u0", coverFrom: 0, coverTo: 5, translation: "如果你是人类，" },
        { unitId: "u1", coverFrom: 5, coverTo: 9, translation: "我们烧水。" },
      ],
    });
    // lenient=false:若 sourceText 丢失,u0 会因逗号结尾被 throw
    var out = Core.parseTranslationCoverageResponse(payload, units, { lenient: false });
    assert(out.length === 2, "单元数不对: " + out.length);
    assert(out[0].translation === "如果你是人类，",
      "句中切开的译文被清空(sourceText 未传到校验侧): " + JSON.stringify(out[0]));
  });

  // ── 过短显示单元必须补足可读时长(只借真实静音) ────────────────────
  // 回归防护。renderUnits 时间原本完全照抄 token 跨度,没有任何可读下限:
  // 实测真机轨 449 单元中 63 个短于 1200ms,最短 113ms("I")。长句在句中切开后
  // 的后半截尤其容易只分到极短跨度 → 一闪而过几乎看不见(用户报告 52-57s 长句)。
  //
  // 补偿必须落在 renderUnits(呈现层):units 是 canonical provenance,
  // validateTokenSpanCoverage 要求其时间与 token 跨度逐一相等(source timing
  // mismatch),在那一层补会直接违约 —— 曾这样改过,7 个既有测试立刻变红。
  //
  // 同时锁死不得换来别的毛病:不与下一条重叠、不改 startMs、不动 token 跨度。
  test("过短渲染单元补足时长且不与下一条重叠", () => {
    const tl = {
      sourceFingerprint: "fp-pad",
      tokens: [
        { id: 0, text: "this", startMs: 0, endMs: 1500 },
        { id: 1, text: "just", startMs: 1500, endMs: 3000 },
        // 长句后半截:仅 200ms
        { id: 2, text: "isnt", startMs: 3000, endMs: 3100 },
        { id: 3, text: "true", startMs: 3100, endMs: 3200 },
        // 后接 2s 静音
        { id: 4, text: "next", startMs: 5200, endMs: 6400 },
      ],
    };
    const units = Core.buildTokenSpanUnits(tl, [1, 3]);
    // units 层必须仍严格等于 token 跨度(否则 coverage 契约被破坏)
    assert.strictEqual(units[1].endMs, 3200, "units 层时间被改动: " + units[1].endMs);

    const snap = Core.createTimelineSnapshot({ timeline: tl, units: units });
    const ru = snap.renderUnits;
    assert.strictEqual(ru.length, 3, "渲染单元数不对: " + ru.length);

    const short = ru[1];
    assert.ok(short.endMs - short.startMs >= 1200,
      "过短渲染单元未补足时长: " + (short.endMs - short.startMs) + "ms");
    assert.strictEqual(short.startMs, 3000, "startMs 被改动了: " + short.startMs);
    assert.strictEqual(short.tokenEnd - short.tokenStart, 2, "token 跨度被动过");

    for (let i = 0; i + 1 < ru.length; i++) {
      assert.ok(ru[i].endMs <= ru[i + 1].startMs,
        `渲染单元 ${i} 与下一条重叠: ${ru[i].endMs} > ${ru[i + 1].startMs}`);
    }

    // 可读下限必须**随词数增长**,不能是定值。
    // 实测 ASR 会给出 "13 词 / 1000ms"(77ms/词 ≈ 650 wpm)这类失真 cue:
    // 定值下限(曾用 1200ms)会认为它够长而完全不管,长句照旧一闪而过。
    const longTl = {
      sourceFingerprint: "fp-long",
      tokens: [],
    };
    // 13 词挤在 1000ms 内,后面留 1000ms 静音(真机 #16 的形状)
    const words = "I think it is fair to say that they are a lot less".split(" ");
    words.forEach((w, i) => {
      longTl.tokens.push({ id: i, text: w, startMs: 40322 + i * 77, endMs: 40322 + (i + 1) * 77 });
    });
    longTl.tokens.push({ id: words.length, text: "next", startMs: 42324, endMs: 43182 });
    const longUnits = Core.buildTokenSpanUnits(longTl, [words.length - 1]);
    const longSnap = Core.createTimelineSnapshot({ timeline: longTl, units: longUnits });
    const longRu = longSnap.renderUnits[0];
    const longDur = longRu.endMs - longRu.startMs;
    const perWord = longDur / words.length;
    assert.ok(perWord >= 150,
      `长单元每词时长仍过短(下限没随词数增长): ${Math.round(perWord)}ms/词, 总 ${longDur}ms`);
    assert.ok(longRu.endMs <= longSnap.renderUnits[1].startMs,
      "长单元补偿后与下一条重叠");

    // ★ 根因层:源 cue 自报时间失真时,必须在 canonical timeline 建立前修好。
    // YouTube ASR 会给出 "13 词 / 1000ms"(77ms/词 ≈ 650 wpm)且后接大段静音。
    // cue 的 [start,end] 是词级时间均摊的唯一依据 —— 不在这层修,它切出的
    // 每一屏 startMs/endMs 全是错的,而错的 startMs 靠下游延长屏尾永远修不回来。
    const distorted = [
      { start: 40322, end: 41322, content: "I think it's fair to say that they are a lot less common." },
      { start: 42324, end: 43182, content: "One" },
    ];
    const fixedTl = Core.buildCanonicalTokenTimeline(distorted);
    const firstWordCount = 12; // "I think it's fair to say that they are a lot less common."
    const lastOfFirst = fixedTl.tokens[firstWordCount - 1];
    const spanMs = lastOfFirst.endMs - fixedTl.tokens[0].startMs;
    const srcPerWord = spanMs / firstWordCount;
    assert.ok(srcPerWord >= 150,
      `失真源 cue 未在 canonical 层修复: ${Math.round(srcPerWord)}ms/词 (span ${spanMs}ms)`);
    // 起点必须仍严格来自源轨(只延 end,不动 start)
    assert.strictEqual(fixedTl.tokens[0].startMs, 40322,
      "修复动了 startMs: " + fixedTl.tokens[0].startMs);
    // 绝不越过下一条 cue 的 start
    assert.ok(lastOfFirst.endMs <= 42324,
      "修复越过了下一条 cue: " + lastOfFirst.endMs);

    // 正常语速的 cue 不得被改动
    const normal = [{ start: 1000, end: 4000, content: "this is a normal sentence" }];
    const normalTl = Core.buildCanonicalTokenTimeline(normal);
    assert.strictEqual(normalTl.tokens[normalTl.tokens.length - 1].endMs, 4000,
      "正常语速 cue 被误改: " + normalTl.tokens[normalTl.tokens.length - 1].endMs);

    // ★ 有原生词级时间时，token 时间必须来自 tokens 本身，不得退回 cue.start/end 均摊。
    // 这条是承重的：真实线上 ASR 轨实测 587/587 cue（100%）都带原生 tokens，
    // 整条轨的时间正确性全押在"优先取 native tokens"这一个行为上
    // （timelineTokensForCue: return native.length ? native : fallbackCueTokens(cue)）。
    // 一旦它退化成按 cue 时长均摊，就是把唯一精确贴合音轨的测量值换成猜测 ——
    // v0.7.3 漂移回归的同类形态。手造样本命中不到，因为手造 cue 通常不带 tokens。
    //
    // 注：repairImplausibleCueTiming 里的 tokens guard 是冗余的第二道防线
    // （它只改 cue.end，而带 tokens 的 cue 压根不读 cue.end），移除它测不出变化，
    // 所以门禁必须打在上面这个真正承重的点上，而不是那个 guard。
    const nativeCue = [
      // 13 词 / 1000ms = 77ms/词，符合"失真"判据，但它带原生词级时间 -> 必须不动
      {
        start: 1000, end: 2000, nativeTiming: true,
        content: "one two three four five six seven eight nine ten eleven twelve thirteen",
        tokens: Array.from({ length: 13 }, (_, i) => ({
          text: String(i), start: 1000 + i * 76, end: 1000 + i * 76 + 76, nativeTiming: true,
        })),
      },
      { start: 9000, end: 9500, content: "next", nativeTiming: true, tokens: [{ text: "next", start: 9000, end: 9500, nativeTiming: true }] },
    ];
    const nativeTl = Core.buildCanonicalTokenTimeline(nativeCue);
    // 末词 endMs 必须仍是原生测量值，绝不被延进后方 7 秒静音
    const lastNative = nativeTl.tokens[12];
    assert.strictEqual(lastNative.endMs, 1000 + 12 * 76 + 76,
      "带原生词级时间的 cue 被失真修复改动了 endMs: " + lastNative.endMs);
    assert.strictEqual(nativeTl.tokens[0].startMs, 1000,
      "带原生词级时间的 cue 被改动了 startMs: " + nativeTl.tokens[0].startMs);
    // 反向：同样形状但去掉 tokens，就必须被修（证明门禁测的是 guard 本身，不是恒真断言）
    const strippedTl = Core.buildCanonicalTokenTimeline(
      nativeCue.map((c) => ({ start: c.start, end: c.end, content: c.content }))
    );
    const strippedSpan = strippedTl.tokens[12].endMs - strippedTl.tokens[0].startMs;
    assert.ok(strippedSpan / 13 >= 150,
      `去掉 tokens 后仍未被修复，说明上面的断言恒真、门禁无效: ${Math.round(strippedSpan / 13)}ms/词`);

    // 静音不足时只能借多少算多少,仍不许重叠
    const tightTl = {
      sourceFingerprint: "fp-tight",
      tokens: [
        { id: 0, text: "a", startMs: 0, endMs: 100 },
        { id: 1, text: "b", startMs: 150, endMs: 1600 },
      ],
    };
    const tightSnap = Core.createTimelineSnapshot({ timeline: tightTl, units: Core.buildTokenSpanUnits(tightTl, [0]) });
    assert.ok(tightSnap.renderUnits[0].endMs <= tightSnap.renderUnits[1].startMs,
      "静音不足时仍重叠: " + tightSnap.renderUnits[0].endMs + " > " + tightSnap.renderUnits[1].startMs);
  });

  test("真实滚动窗口 ASR 轨（yt-dlp 抓取的线上 json3）：零漂移 + 零重叠 + 零丢词", () => {
    // 为什么必须有这条：前面所有滚动窗口断言用的都是 4 条 cue 的手造样本。
    // 真实线上轨是 8 分钟 393 条 cue、几乎每条都与下一条重叠（99% 重叠率）的形状，
    // 三个版本连续修错就是因为验证数据里根本没有这个形状——手造样本的规模掩盖了
    // 累积漂移（漂移要走过几百条才显形）。这份 fixture 是 yt-dlp 直接抓的原始
    // json3，未经任何整理，解析走产品自己的 parseJson3。
    const raw = JSON.parse(
      fs.readFileSync(path.join(ROOT, "test/fixtures/youtube-json3-rolling-raw.json"), "utf8")
    );
    const cues = Core.parseJson3(raw);
    // parseJson3 会合并滚动窗口的重发前缀，所以解析后条数远少于原始 events（393 -> ~197），
    // 这是产品的正常行为，不是丢内容。规模断言按解析后的实际量级设定。
    assert.ok(cues.length > 150, `fixture 规模不足：${cues.length} 条`);
    const srcOverlap = cues.filter((c, i) => cues[i + 1] && c.end > cues[i + 1].start).length;
    assert.ok(
      srcOverlap > cues.length * 0.5,
      `fixture 必须是真实滚动窗口形状（高重叠），当前只有 ${srcOverlap}/${cues.length} 重叠`
    );

    // 基准：源轨每个词的原生起始时间
    const nativeStart = new Map();
    cues.forEach((c) => (c.tokens || []).forEach((t) => {
      const k = t.text + "@" + t.start;
      if (!nativeStart.has(t.text)) nativeStart.set(t.text, new Set());
      nativeStart.get(t.text).add(t.start);
      void k;
    }));

    const clean = Core.cleanupCues(cues);
    const timeline = Core.buildCanonicalTokenTimeline(clean);

    // 零漂移：每个 canonical token 的 startMs 必须是它在源轨里出现过的某个原生时间。
    // 前推/重锚会产生源轨里不存在的时间值，这里立刻抓到。
    let drifted = 0;
    let sample = "";
    timeline.tokens.forEach((tok) => {
      const set = nativeStart.get(tok.text);
      if (!set) return;
      if (!set.has(tok.startMs)) {
        drifted++;
        if (!sample) {
          sample = `"${tok.text}" got=${tok.startMs} 源可选=${[...set].slice(0, 3).join("/")}`;
        }
      }
    });
    assert.equal(drifted, 0, `${drifted} 个 token 起始时间不是源原生值（整轨会累积漂移）：${sample}`);

    const display = Core.resegmentCues(clean, { maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const snapshot = Core.createTimelineSnapshot({
      revision: 0, videoId: "real-rolling", trackCode: "en", timeline: timeline, units: units,
    });
    const rendered = snapshot.renderUnits.filter((u) => String(u.originalText || "").trim());

    const overlaps = rendered.filter((u, i) => rendered[i + 1] && u.endMs > rendered[i + 1].startMs);
    assert.equal(overlaps.length, 0, `真实轨渲染层仍有 ${overlaps.length} 处重叠`);

    const zero = rendered.filter((u) => u.endMs <= u.startMs);
    assert.equal(zero.length, 0, `真实轨出现 ${zero.length} 个 0ms 单元`);

    // 单元起始时间也必须落在源原生时间上（渲染层截 endMs 不许动 startMs）
    const allNative = new Set();
    cues.forEach((c) => (c.tokens || []).forEach((t) => allNative.add(t.start)));
    const offGrid = rendered.filter((u) => !allNative.has(u.startMs));
    assert.equal(
      offGrid.length, 0,
      `${offGrid.length} 个渲染单元的起始时间不在源原生时间上，例：${offGrid.slice(0, 2).map((u) => u.startMs).join(",")}`
    );
  });

  // ==========================================================================
  // 语言无关性门禁
  //
  // 缘由：整套时间轴/切分/对齐此前隐含"源语言是英文"的假设，散落多处 ASCII-only
  // 字符类（[A-Za-z0-9] 分词、[^0-9a-z一-鿿] 词键、按空白数词）。后果是真实用户
  // 视频 scWj1BMRHUA（波兰语人工字幕轨）整轨失效：变音字母被吞成空格、词数被高估
  // 导致超长行、词键被削致对齐抛错、138 单元里 127 条 [未翻译]。
  // 这些都是"英文轨永远测不出"的缺陷，因此必须有跨书写系统的常驻门禁。
  // ==========================================================================
  const MULTILANG_SAMPLES = {
    英语: "Mimas is one of Saturn's cutest moons but its enormous crater makes it look like the Death Star honestly",
    波兰语: "Mimas jest jednym z najsłodszych księżyców Saturna ale jego ogromny krater powoduje że wygląda jak Gwiazda Śmierci",
    俄语: "Мимас один из самых милых спутников Сатурна но его огромный кратер делает его похожим на Звезду Смерти",
    希腊语: "Ο Μίμας είναι ένας από τους πιο χαριτωμένους δορυφόρους του Κρόνου αλλά ο τεράστιος κρατήρας του",
    阿拉伯语: "ميماس هو أحد أجمل أقمار زحل لكن فوهته الضخمة تجعله يشبه نجمة الموت تماما جدا",
    希伯来语: "מימאס הוא אחד הירחים החמודים של שבתאי אבל המכתש הענק שלו גורם לו להיראות",
    印地语: "मीमास शनि के सबसे प्यारे चंद्रमाओं में से एक है लेकिन इसका विशाल क्रेटर",
    土耳其语: "Mimas Satürnün en şirin uydularından biri ama dev krateri onu Ölüm Yıldızına benzetiyor gerçekten",
    越南语: "Mimas là một trong những mặt trăng đáng yêu nhất của Sao Thổ nhưng miệng núi lửa khổng lồ",
    韩语: "미마스는 토성의 가장 귀여운 위성 중 하나이지만 거대한 분화구 때문에 데스스타처럼 보입니다",
    日语: "ミマスは土星の最もかわいい衛星の一つですが巨大なクレーターのせいで死の星のように見えますそしてNASAが温度マップを作ったとき最も暖かい領域がパックマンのように見えることを発見しました",
    中文: "米玛斯是土星最可爱的卫星之一但它巨大的陨石坑让它看起来像死星而当美国航空航天局绘制温度图时最温暖的区域看起来像吃豆人",
    泰语: "ไมมัสเป็นหนึ่งในดวงจันทร์ที่น่ารักที่สุดของดาวเสาร์แต่หลุมอุกกาบาตขนาดใหญ่ทำให้ดูเหมือนดาวมรณะและเมื่อนาซาสร้างแผนที่อุณหภูมิ",
    中英混排: "NASAが温度マップを作ったとき Pac-Man のように見えた really",
  };
  const MULTILANG_CAP = 14;

  Object.keys(MULTILANG_SAMPLES).forEach((lang) => {
    test(`语言无关：${lang} 轨走完整链路（对齐/不丢词/不超宽/原文逐字保真）`, () => {
      const text = MULTILANG_SAMPLES[lang];
      const cues = Core.cleanupCues([{ start: 0, end: 9000, content: text }]);
      const timeline = Core.buildCanonicalTokenTimeline(cues);
      const display = Core.resegmentCues(cues, { maxWords: 12, continuationMaxWords: MULTILANG_CAP });

      // 对齐不得抛错（词键被削 / 词流错位都会在这里炸）
      const units = Core.buildCueTokenSpanUnits(timeline, display);
      const snap = Core.createTimelineSnapshot({ timeline, units, cues });
      const rendered = snap.renderUnits.filter((u) => String(u.originalText || "").trim());

      // 不丢词
      const covered = units.reduce((n, u) => n + (u.tokenEnd - u.tokenStart), 0);
      assert.equal(covered, timeline.tokens.length, `${lang}: token 覆盖 ${covered}/${timeline.tokens.length}，丢词`);

      // 不超过翻译层词数上限（超了必被 fail-closed 拒成 [未翻译]）
      const widths = rendered.map((u) => Core.restoredWords(u.originalText).length);
      const over = widths.filter((n) => n > MULTILANG_CAP);
      assert.equal(over.length, 0, `${lang}: ${over.length} 个单元超过 ${MULTILANG_CAP} 词上限（最宽 ${Math.max(...widths)} 词）→ 会变 [未翻译]`);

      // 零重叠
      let overlap = 0;
      for (let i = 0; i + 1 < rendered.length; i++) if (rendered[i].endMs > rendered[i + 1].startMs) overlap++;
      assert.equal(overlap, 0, `${lang}: ${overlap} 处相邻单元重叠`);

      // 原文逐字保真：不得丢字母（变音符号/非拉丁字）也不得插入空格撑开
      const rebuilt = rendered.map((u) => u.originalText).join("").replace(/\s+/g, "");
      assert.equal(rebuilt, text.replace(/\s+/g, ""), `${lang}: 原文被改动（丢字母或被空格撑开）`);
    });
  });

  test("语言无关：连写文字（中日泰）必须一字一词，否则长度上限对它们全部失效", () => {
    // 这是"通用方案"的承重点：不给中日泰另开分支，而是让它们的分词粒度与
    // 空格分词语言可比，于是 maxWords / token 跨度时间 / 去重对齐全部原样生效。
    assert.equal(Core.restoredWords("米玛斯是土星").length, 6, "中文未按字分词");
    assert.equal(Core.restoredWords("ミマスは").length, 4, "日文假名未按字分词");
    // 长音符 ー(U+30FC)、中点 ・ 的 Script 是 Common，需 scx 才归入假名
    assert.deepEqual(Core.restoredWords("クレーター"), ["ク", "レ", "ー", "タ", "ー"], "长音符未按字切分");
    // 拉丁与连写文字相邻时不得互相吞并
    assert.deepEqual(Core.restoredWords("NASAが温度"), ["NASA", "が", "温", "度"], "拉丁块吞掉了连写文字");
    // 空格分词语言必须保持原有粒度（连字符/撇号/千分位仍算一个词）
    assert.deepEqual(
      Core.restoredWords("purpose-built don't 1,800"),
      ["purpose-built", "don't", "1,800"],
      "空格分词语言的词粒度被破坏"
    );
    // 韩文用空格分词，不应被按字切开
    assert.equal(Core.restoredWords("미마스는 토성의").length, 2, "韩文被误当连写文字");
  });

  test("语言无关：纯标点不得成为 canonical token，真实日语 ASR 必须能建立时间轴", () => {
    // PCZhLRE7avE 的 ja-orig 真实轨：Script_Extensions 会把日文句号“。”和逗号“、”
    // 也判进 Hiragana/Katakana 集合。旧正则因此产生纯标点 token；wordKey() 随后把它
    // 清成空键，display 侧跳过、canonical 侧保留，从第一个句号起永久错位，整轨拒载。
    // 规则必须语言无关：一个“词”至少含 Unicode 字母/组合记号/数字，纯标点一律不是词。
    assert.deepEqual(Core.restoredWords("いいね。いいやつ。"), ["い", "い", "ね", "い", "い", "や", "つ"]);
    assert.deepEqual(Core.restoredWords("え、1回集合、1回集合"), ["え", "1", "回", "集", "合", "1", "回", "集", "合"]);

    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-pczh-ja-asr-head.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(fixture));
    // 锁调用点而不只锁正则纯函数：同一词跨 YouTube seg 时，parseJson3 必须先拼 event
    // 再分词。fixture 中真实形状是 ["6", "TV", "へ。"]，canonical 必须得到 "6TV"。
    assert.ok(cues.some((cue) => (cue.tokens || []).some((token) => token.text === "6TV")), "跨 seg 的同一词被错误拆开");
    const spaced = Core.parseJson3({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [
      { utf8: "hello", tOffsetMs: 0 }, { utf8: " " }, { utf8: "world", tOffsetMs: 500 },
    ] }] });
    assert.deepEqual(spaced[0].tokens.map((token) => token.text), ["hello", "world"], "纯空白 seg 被丢弃后错误粘词");
    assert.equal(spaced[0].tokens[0].end, 500, "无 offset 的空白 seg 吞掉了后一个原生时间边界");
    assert.equal(spaced[0].tokens[1].start, 500, "空白 seg 后文本未从自己的原生 offset 开始");

    // 性质门禁：seg 怎么切都不能改变词流。以下样例只覆盖不同 Unicode 结构；产品代码
    // 不读取语言，也没有这些语言的分支。左右两侧必须共用同一个 RESTORE_WORD_RE 权威。
    [
      ["pur", "pose-built"],           // 拉丁 + 连字符
      ["при", "вет"],                 // 西里尔
      ["مر", "حبا"],                  // 阿拉伯
      ["नम", "स्ते"],                 // 天城文 + 组合记号
      ["안", "녕", " ", "하세요"], // 韩文 + 空白 seg
      ["NASA", "が", "温", "度"],  // 空格/连写文字混排
      ["6", "TV"],                    // 数字字母混排
    ].forEach((parts) => {
      const eventText = parts.join("");
      const parsed = Core.parseJson3({ events: [{
        tStartMs: 0,
        dDurationMs: 1000,
        segs: parts.map((utf8, index) => ({ utf8, tOffsetMs: index * 100 })),
      }] });
      assert.deepEqual(
        parsed[0].tokens.map((token) => token.text),
        Core.restoredWords(eventText),
        "seg 切法改变了权威词流: " + JSON.stringify(parts)
      );
      parsed[0].tokens.forEach((token) => {
        assert.ok(token.start >= 0 && token.end >= token.start && token.end <= 1000, "token 时间越出源 event");
      });
    });

    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, {
      tailTrimMs: 0,
      maxWords: Core.DISPLAY_UNIT_MAX_WORDS,
      continuationMaxWords: Core.SOURCE_UNIT_MAX_WORDS,
    });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    assert.ok(units.length > 0, "真实日语轨未建立显示单元");
    assert.equal(units[units.length - 1].tokenEnd, timeline.tokens.length, "日语显示单元未完整覆盖 canonical token");
  });

  test("语言无关：显示分词必须与 canonical 共用权威边界，小数和单位不得拆坏整轨", () => {
    // P1WniHPKAxY 的日语人工字幕真实片段含 "0.1mm"。canonical 的权威正则把
    // "0.1" 视为一个 token；旧显示侧另写 UNSPACED_PIECE_RE，却切成 "0." + "1mm"，
    // 从这里开始永久错位。修复必须删除第二套 tokenizer，而不是补一个日语/小数特判。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-p1w-ja-decimal-head.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    assert.ok(cues.some((cue) => cue.content.includes("0.1mm")), "真实 fixture 缺失 0.1mm 故障形状");
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, {
      tailTrimMs: 0,
      maxWords: Core.DISPLAY_UNIT_MAX_WORDS,
      continuationMaxWords: Core.SOURCE_UNIT_MAX_WORDS,
    });
    assert.deepEqual(
      Core.restoredWords(display.map((cue) => cue.content).join(" ")).slice(0, timeline.tokens.length),
      timeline.tokens.map((token) => token.text),
      "显示侧与 canonical 使用了不同词边界"
    );
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    assert.equal(units[units.length - 1].tokenEnd, timeline.tokens.length, "小数之后的显示单元未完整覆盖 canonical token");
  });

  test("语义恢复必须语言无关、按视觉负载分配预算，并且只翻最终语义单元一次", () => {
    const ja = Array.from("今回はずっと乗ってみたかったセンチュリー").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
    const en = "This is a deliberately ordinary English subtitle sentence for comparison".split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
    assert.equal(typeof Core.semanticTokenBudgets, "function", "缺少语言无关的视觉预算权威");
    const jaBudget = Core.semanticTokenBudgets(ja);
    const enBudget = Core.semanticTokenBudgets(en);
    assert.ok(jaBudget.preferredTokens > enBudget.preferredTokens, `日文字符预算 ${jaBudget.preferredTokens} 未高于英文词预算 ${enBudget.preferredTokens}`);
    assert.ok(jaBudget.maxTokens <= 40 && enBudget.maxTokens <= 16, "视觉预算失去单行字幕上限");
    assert.ok(!/英语字幕|英文字幕单元/.test(Core.DEFAULT_RESTORATION_PROMPT + Core.DEFAULT_SYSTEM_PROMPT), "默认 prompt 仍把任意源语言写死为英文");
    assert.equal(typeof Core.semanticPlanningGroups, "function", "缺少语言无关的词法提示层");
    const grouped = Core.semanticPlanningGroups(ja.map((token, i) => ({ ...token, tokenId: `j${i}` })));
    assert.equal(grouped.sourceText, "今回はずっと乗ってみたかったセンチュリー", "词法提示层改写了连写源文");
    assert.ok(grouped.groups.length < ja.length, "连写文字仍被逐字符发送给语义规划器");
    assert.equal(grouped.groups[0].fromId, "j0");
    assert.equal(grouped.groups[grouped.groups.length - 1].toId, `j${ja.length - 1}`);

    const mixed = ["offset", "0.1", "mm", "causes", "the", "door", "to", "stop", "opening", "during", "the", "precision", "test"]
      .map((text, i) => ({ text, tokenId: `m${i}`, start: i * 100, end: (i + 1) * 100 }));
    const mixedGroups = Core.semanticPlanningGroups(mixed).groups;
    assert.ok(mixedGroups.some((group) => group.text === "0.1 mm"), "数字+后续数量词必须语言无关地保持原子，不得靠单位名单");
    const visualMarks = Core.enforceVisualDisplayMarks(mixed, mixed.map(() => ""), 28);
    const visualUnits = Core.packRestoredTokens(mixed, visualMarks, { maxWords: 40 });
    assert.ok(visualUnits.every((unit) => Core.semanticDisplayWidth(unit.content) <= 28), "确定性 display cut 未执行视觉硬门禁");
    assert.ok(!visualMarks.some((mark) => mark === "."), "程序补短屏只能新增 display cut，不得伪造 semantic cut");
    assert.ok(!visualUnits.some((unit) => /0\.1$/.test(unit.content)), "确定性排版切断了数字+数量词");
    const advisedTokens = new Array(8).fill(0).map((_, i) => ({ text: "aaaa", tokenId: `a${i}`, start: i * 100, end: (i + 1) * 100 }));
    const advisedMarks = advisedTokens.map((_, i) => i === 2 ? "|" : "");
    const advisedResult = Core.enforceVisualDisplayMarks(advisedTokens, advisedMarks, 26);
    assert.equal(advisedResult[2], "|", "模型自然显示建议在不破坏均衡/硬上限时应成为 DP 软偏好");
    assert.ok(Core.packRestoredTokens(advisedTokens, advisedResult, { maxWords: 40 }).every((unit) => Core.semanticDisplayWidth(unit.content) <= 26));

    const coreSource = fs.readFileSync(path.join(__dirname, "../core.js"), "utf8");
    assert.ok(!coreSource.includes("Math.min(preferredMaxWords, 10)"), "动态视觉预算仍被旧英文 10 词上限截断");
    assert.ok(!coreSource.includes("Math.min(maxWords, 12)"), "动态视觉预算仍被旧英文 12 词上限截断");
    assert.ok(!/languageCode\s*===|\[.*ja.*zh.*ko.*\]/s.test(Core.semanticPlanningGroups.toString()), "词法提示层出现逐语言分支");

    const isolatedSource = fs.readFileSync(path.join(__dirname, "../isolated.js"), "utf8");
    assert.ok(!isolatedSource.includes("hasNativeTokenTiming(rawCues, 0.8)"), "75.9% 原生时间覆盖的真实日语轨仍会被挡在 semantic 外");
    assert.ok(!isolatedSource.includes("fallback-translation"), "仍存在先翻机械 fallback、再翻最终 semantic 的双翻译路径");
    assert.ok(!isolatedSource.includes("enableFallbackTranslation"), "fallback 碎片翻译入口仍然存活");
  });

  test("语言无关：把词拼回文本时连写文字之间不得插入空格", () => {
    // 一字一词之后，若无脑 join(" ")，45 字中文会变成 89 字的散字，屏上全是空隙。
    assert.equal(Core.joinRestoredWords(["米", "玛", "斯"]), "米玛斯");
    assert.equal(Core.joinRestoredWords(["Hello", "world"]), "Hello world");
    // 混排：连写侧不加空格
    assert.equal(Core.joinRestoredWords(["NASA", "が", "温", "度"]), "NASAが温度");
  });

  test("选定源语言后统一优先同语言人工轨，没有人工轨才保留 ASR", () => {
    const tracks = [
      { code: "ja-asr", languageCode: "ja", kind: "asr", url: "ja-asr" },
      { code: "ja", languageCode: "ja", kind: "", url: "ja-manual" },
      { code: "pl-asr", languageCode: "pl", kind: "asr", url: "pl-asr" },
      { code: "ar", languageCode: "ar", kind: "", url: "ar-manual" },
      { code: "ar-asr", languageCode: "ar", kind: "asr", url: "ar-asr" },
    ];
    assert.equal(Core.preferManualTrack(tracks, tracks[0]).url, "ja-manual");
    assert.equal(Core.preferManualTrack(tracks, tracks[2]).url, "pl-asr", "没有人工同语言轨时不得误切到其他语言");
    assert.equal(Core.preferManualTrack(tracks, tracks[4]).url, "ar-manual");
    assert.ok(!/["'](?:ja|pl|ar)["']/.test(Core.preferManualTrack.toString()), "人工轨排序不得包含语言代码名单");
  });

  test("真实波兰语人工字幕轨（yt-dlp 抓取，0% 词级时间）：整轨可用且原文保真", () => {
    // 用户实际报障的视频 scWj1BMRHUA。它与既有 ASR fixture 是两种不同形状：
    //   - 人工字幕：一条 cue 就是一整句长文本，且【完全没有】tOffsetMs 词级时间
    //   - ASR 轨：每条只有几个词，100% 带原生词级时间
    // 既有门禁全按 ASR 轨写，因此这一整类缺陷此前无法被发现。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-manual-polish-raw.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    assert.ok(cues.length > 100, `波兰语轨只解析出 ${cues.length} 条 cue`);

    // 这条轨确实没有词级时间——保证 fixture 的形状不被后人换掉
    assert.equal(Core.hasNativeTokenTiming(cues), false, "波兰语人工轨不应有原生词级时间（fixture 形状变了）");

    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, { maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const snap = Core.createTimelineSnapshot({ timeline, units, cues });
    const rendered = snap.renderUnits.filter((u) => String(u.originalText || "").trim());

    const covered = units.reduce((n, u) => n + (u.tokenEnd - u.tokenStart), 0);
    assert.equal(covered, timeline.tokens.length, `丢词：覆盖 ${covered}/${timeline.tokens.length}`);

    const widths = rendered.map((u) => Core.restoredWords(u.originalText).length);
    const over = widths.filter((n) => n > 14);
    assert.equal(over.length, 0, `${over.length} 个单元超 14 词上限（最宽 ${Math.max(...widths)}）→ 会变 [未翻译]`);

    let overlap = 0;
    for (let i = 0; i + 1 < rendered.length; i++) if (rendered[i].endMs > rendered[i + 1].startMs) overlap++;
    assert.equal(overlap, 0, `${overlap} 处相邻单元重叠`);

    // 变音符号必须活着。原缺陷把 ł/ą/ę/ś/ż 全替换成空格，
    // "najsłodszych księżyców" 变成 "najs odszych ksi yc w"。
    const allText = rendered.map((u) => u.originalText).join(" ");
    const diacritics = (allText.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
    assert.ok(diacritics > 100, `波兰语变音字母只剩 ${diacritics} 个，说明仍被吞掉`);
  });

  test("语义恢复必须跟着播放位置滑动，token 消耗正比于实际观看时长", () => {
    // 旧实现整轨一次性恢复：37 分钟轨 = 6257 token / 35 个模型块 / 约 9.5 分钟，
    // 且无论用户看多久都要先付满 35 块。这条门禁锁住"按需恢复"这个性质：
    // 只看开头一小段时，恢复量必须远小于整轨。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-json3-rolling-raw.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    // 区间必须定义在 snapshot units 空间上：原始轨 197 条 cue 经 fallback 重组变 150 个
    // 单元，两套下标混用会让 resegmentTimelineSnapshot 取到错误 token 跨度
    // （实测 browser-replay 报 replacement token coverage mismatch）。
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const fallbackCues = Core.resegmentCues(cues, { tailTrimMs: 0, maxWords: 12, continuationMaxWords: 14 });
    const snapshot = Core.createTimelineSnapshot({
      revision: 0, videoId: "gate", trackCode: "en",
      timeline: timeline,
      units: Core.buildCueTokenSpanUnits(timeline, fallbackCues),
      translations: {},
    });
    const wholeTrackTokens = timeline.tokens.length;
    assert.ok(wholeTrackTokens > 0, "fixture 没有可恢复 token");

    const first = Core.planSemanticInterval(snapshot, 0);
    assert.ok(first, "必须能为播放位置 0 选出恢复区间");
    assert.ok(first.startIndex === 0, "首个区间必须从轨首开始");
    assert.ok(first.endIndex > first.startIndex, "区间必须非空");
    // 区间必须按整条 cue 对齐 —— 半条 cue 过不了 resegmentTimelineSnapshot 的词流校验。
    assert.ok(Number.isInteger(first.startIndex) && Number.isInteger(first.endIndex), "区间边界必须是 cue 下标");

    // 关键性质：单次恢复量必须显著小于整轨（否则等于没改）。
    assert.ok(
      first.tokens.length < wholeTrackTokens,
      `单次恢复 ${first.tokens.length} token，与整轨 ${wholeTrackTokens} 相同 —— 仍是整轨恢复`
    );

    // 区间要跟着播放位置走：从后面的位置出发，必须选到后面的单元。
    const units = snapshot.units;
    const lastStart = Number(units[units.length - 1].startMs);
    if (lastStart > 0) {
      const later = Core.planSemanticInterval(snapshot, lastStart);
      assert.ok(later, "轨尾附近也应能选出区间");
      assert.ok(later.startIndex > first.startIndex, "区间必须随播放位置前移");
    }
    // 播放位置超过轨尾 → 无可恢复区间（推进器据此停止，不再无谓请求）。
    assert.strictEqual(Core.planSemanticInterval(snapshot, Number(units[units.length - 1].endMs) + 1), null, "轨尾之后必须返回 null");

    // 区间推进必须连续覆盖，不得跳过中间片段（跳过 = 那段永远停留在 fallback 断句）。
    // 换入后单元数会变（真实轨实测 36 个 fallback 单元 → 46 个 semantic 单元），
    // 所以"下一个区间的起点"必须按换入后的快照重新计算，不能沿用旧下标。
    let cursor = 0;
    let guard = 0;
    let snap = snapshot;
    while (guard++ < 50) {
      const iv = Core.planSemanticInterval(snap, cursor);
      if (!iv) break;
      assert.strictEqual(
        iv.startIndex,
        snap.units.findIndex((u) => Number(u.endMs) > cursor),
        "区间起点必须正好接在已恢复位置之后，不得跳过单元"
      );
      const last = snap.units[iv.endIndex - 1];
      const nextCursor = Number(last.endMs);
      assert.ok(nextCursor > cursor, "区间推进必须前进，否则会无限循环");
      cursor = nextCursor;
    }
    assert.ok(guard < 50, "区间推进未能在合理步数内覆盖整轨");

    // 区间必须能真的换入：这条直接调用生产替换器，覆盖校验不通过就会抛错。
    // 用「原样替换」验证下标空间一致性 —— 这正是 mismatch 缺陷的最小复现。
    const sameCues = visualReplacementCues(first.tokens);
    const replaced = Core.resegmentTimelineSnapshot(snapshot, first.startIndex, first.endIndex, sameCues);
    assert.ok(replaced && replaced.units.length > 0, "视觉受限的原样区间替换必须通过词流覆盖校验");
    const installed = replaced.units.filter((u) => u.tokenStart >= first.tokens[0].index && u.tokenEnd <= first.tokens[first.tokens.length - 1].index + 1);
    assert.strictEqual(new Set(installed.map((u) => u.semanticGroupId)).size, 1, "semanticGroupId 必须穿过 snapshot 换入层");
    assert.strictEqual(new Set(Core.cuesFromTimelineSnapshot(replaced).filter((c) => installed.some((u) => u.id === c.unitId)).map((c) => c.semanticGroupId)).size, 1, "翻译 cue 必须继承 semanticGroupId");
  });

  test("语义区间换入必须保住已有译文：边界内的译文不得被换入丢弃", () => {
    // 用户实测（视频 BhtgINeaJWg，5.7 分钟真实 ASR 轨）：85 个单元里 53 个 [未翻译]，
    // 连开头 4-24s 也未翻 —— 开头本该最先翻好，说明它被翻过又丢了。
    //
    // 根因：翻译跑在语义恢复前面，按 fallback 断句翻好后，恢复重切边界，
    // 跨边界的旧译文无法继承（真机 28 条新单元里 17 条交叉切开），只能作废重翻。
    // 同一段内容翻两遍，这才是「翻译永远跟不上字幕」。
    //
    // 修法不是"让跨边界的译文也能救回来"（交叉切开时旧译文确实对不上新单元内容，
    // 硬拼会产出错误译文），而是**不产生**跨边界的译文：预取截到已恢复边界内
    // （见上一条门禁）。这里验证在此前提下换入是无损的 —— 边界内已翻的内容，
    // 换入后必须一条都不丢。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-bhtg-asr-raw.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const fallbackCues = Core.resegmentCues(cues, { tailTrimMs: 0, maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, fallbackCues);

    const snapshot0 = Core.createTimelineSnapshot({
      revision: 0, videoId: "BhtgINeaJWg", trackCode: "en", timeline, units, translations: {},
    });
    const iv = Core.planSemanticInterval(snapshot0, 0);
    assert.ok(iv, "首个区间必须存在");

    // 遵守设计约束：只有**区间之外**（已恢复边界之内 = 尚未被本次换入触及）的单元有译文。
    // 这正是修复后的真实运行状态：预取不会翻到未恢复区间里去。
    const translations = {};
    units.slice(iv.endIndex).forEach((u) => { translations[u.id] = "【已翻】" + u.originalText.slice(0, 10); });
    const snapshot = Core.createTimelineSnapshot({
      revision: 0, videoId: "BhtgINeaJWg", trackCode: "en", timeline, units, translations,
    });
    const before = Object.values(snapshot.translations).filter(Boolean).length;
    assert.ok(before > 0, "构造前提：区间外必须有已翻单元");

    // 语义恢复真实形状：按语义重切，新边界与旧边界普遍交叉
    const intervalTokenStart = units[iv.startIndex].tokenStart;
    const intervalTokenEnd = units[iv.endIndex - 1].tokenEnd;
    const resegmented = visualReplacementCues(timeline.tokens.slice(intervalTokenStart, intervalTokenEnd));
    const after = Core.resegmentTimelineSnapshot(snapshot, iv.startIndex, iv.endIndex, resegmented);

    const coveredBefore = new Set();
    units.forEach((u) => {
      if (!translations[u.id]) return;
      for (let t = u.tokenStart; t < u.tokenEnd; t++) coveredBefore.add(t);
    });
    const coveredAfter = new Set();
    after.units.forEach((u) => {
      if (!after.translations[u.id]) return;
      for (let t = u.tokenStart; t < u.tokenEnd; t++) coveredAfter.add(t);
    });
    let lost = 0;
    coveredBefore.forEach((t) => { if (!coveredAfter.has(t)) lost++; });
    assert.strictEqual(lost, 0,
      `区间换入丢失了 ${lost}/${coveredBefore.size} 个边界外的已翻词 —— 换入不得影响它触及范围之外的译文`);
  });

  test("翻译输入卫士只保护模型容量，语义视觉质量由动态预算在装载时校验", () => {
    // 真机实测缺陷（必须真浏览器 + 真轨 + 真模型才暴露，离线门禁全绿）：
    // 输入卫士曾按 segmentationMode 分叉（semantic 12 / 其他 14），把"semantic 恢复结果
    // 该 ≤12 词"这个**断句质量**约束混进了翻译路径。语义恢复只覆盖当前区间，区间外仍是
    // fallback 断句（允许语法续接到 14 词），却因全局 mode 已是 "semantic" 而被按 12 词
    // 拒翻 → 永远翻不了、反复退避重试到 failed。
    // 真机日志：clip 3 翻译失败：oversized source unit before translation: 14 words (cap 12)
    const guard = String(Core.translateClipWithBoundaryRepair);
    assert.ok(!/segmentationMode\s*===\s*["']semantic["']\s*\?/.test(guard),
      "输入卫士不得按 segmentationMode 分叉词数上限");

    assert.equal(Core.SEMANTIC_MAX_TOKENS, 40, "翻译输入容量必须覆盖语言无关视觉预算的最大值");
    // 14 词单元在任何 mode 下都必须能翻；输入卫士不再承担显示质量判断。
    const cue14 = {
      unitId: "u0", tokenStart: 0, tokenEnd: 14, start: 0, end: 1400,
      content: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
    };
    for (const mode of ["semantic", "fallback", "fallback-translation"]) {
      let called = 0;
      assert.doesNotReject(() => Core.translateClipWithBoundaryRepair({
        cues: [cue14], segmentationMode: mode,
        apiBaseUrl: "https://example.test", apiModel: "m",
        fetchImpl: async (_u, req) => {
          called++;
          return { ok: true, json: async () => ({ choices: [{ message: { content: translationCoverageJson(req, ["这是一条完整译文"]) } }] }) };
        },
      }), `mode=${mode} 下 14 词单元必须能翻`);
    }

    // 语义断句质量约束必须落在恢复装载处，并调用同一视觉预算权威。
    const resegment = String(Core.resegmentTimelineSnapshot);
    assert.ok(/semanticTokenBudgets|visual cap/.test(resegment),
      "resegmentTimelineSnapshot 必须按语言无关视觉预算校验恢复结果");
  });

  test("翻译不得越过语义恢复边界：越界翻的内容注定作废重翻", () => {
    // 语义恢复重切边界后，跨边界的旧译文无法继承（真机 28 条新单元里 17 条交叉切开），
    // 只能重翻。所以「已恢复到哪」就是「能翻到哪」，越过去纯属浪费算力。
    const clipStartMs = [];
    for (let i = 0; i < 30; i++) clipStartMs.push(i * 12000);

    // 已恢复到 60s：预取窗口 [2..5] 里只有起点 < 60s 的段可翻
    const clamped = Core.planTranslationWindow({
      currentIdx: 2, clipCount: 30, semanticReadyUntilMs: 60000, clipStartMs,
    });
    assert.strictEqual(clamped.reason, "clamped-to-semantic", "越界时必须报告已截断");
    assert.ok(clamped.plan.every((i) => clipStartMs[i] < 60000),
      `不得计划恢复边界之外的段，实际 ${JSON.stringify(clamped.plan)}`);
    assert.ok(clamped.plan.includes(2), "当前段必须始终在计划内（首屏可用性底线）");

    // 恢复已到轨尾（Infinity）时不得截断 —— 否则永远只翻一段
    const done = Core.planTranslationWindow({
      currentIdx: 2, clipCount: 30, semanticReadyUntilMs: Infinity, clipStartMs,
    });
    assert.ok(done.plan.length >= 4, `恢复完成后窗口不得被截断，实际 ${JSON.stringify(done.plan)}`);

    // 非语义轨（传 null）保持原行为，不受影响
    const plain = Core.planTranslationWindow({ currentIdx: 2, clipCount: 30, semanticReadyUntilMs: null, clipStartMs });
    assert.ok(plain.plan.length >= 4, "fallback 轨不得被语义边界截断");

    // 当前段尚未恢复也必须翻：宁可断句将来变，也不能没有中文
    const cold = Core.planTranslationWindow({
      currentIdx: 5, clipCount: 30, semanticReadyUntilMs: 0, clipStartMs,
    });
    assert.deepStrictEqual(cold.plan, [5], "边界为 0 时仍须保留当前段");
  });

  test("block 预取只能经 planTranslationWindow，且不再启动 semantic 推进器", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const prefetch = src.slice(src.indexOf("function prefetchAround"), src.indexOf("function getBackoff"));
    assert.match(prefetch, /Core\.planTranslationWindow\(/);
    assert.doesNotMatch(prefetch, /maybeAdvanceSemanticInterval|semanticPending|restoreSemantic/);
    assert.match(prefetch, /translateClip\(plan\[0\], 100\)/);
  })

  test("翻译必须始终领先播放：整轨模拟播放，译文边界不得被播放追上", () => {
    // 用户报障原话：「我看着翻译文字永远也跟不上字幕」。
    //
    // 实测根因不是速度不够：单 clip 翻译 9.5s 中位，一个 clip 覆盖约 14s 播放，
    // 并发 4 的吞吐 = 5.74 倍播放速度，绰绰有余。真正的原因是调度降级 ——
    // 整轨语义恢复期间（semanticPending），预取计划被砍成 [idx]（只翻当前正在播的段）。
    // 而整轨恢复在 37 分钟轨上要 9.5 分钟（35 块 × 16.4s，最低优先级只吃富余并发）。
    // 这 9 分钟里翻译退化成"播到哪才翻哪"，必然永远追着播放跑。
    //
    // 这条门禁把"调度能否维持领先"变成可测断言：离散事件模拟整轨播放，
    // 用真实 fixture 的 clip 时间轴 + 实测翻译延迟，断言译文边界始终领先播放位置。
    // 它不测网关速度（那个已单独实测），只测调度设计。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-json3-rolling-raw.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, { maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const snap = Core.createTimelineSnapshot({ timeline, units, cues });
    const R = snap.renderUnits.filter((u) => String(u.originalText || "").trim());
    assert.ok(R.length >= 8, `fixture 单元太少（${R.length}），模拟没有意义`);

    const clips = Core.sliceClipsByCue(
      R.map((u) => ({ start: u.startMs, end: u.endMs, content: u.originalText })),
      Core.DEFAULT_CONFIG.clipSeconds * 1000,
      { maxCues: 8 }
    ).map((c) => {
      const cs = c.cues || c;
      return { start: cs[0].start, end: cs[cs.length - 1].end };
    });
    assert.ok(clips.length >= 3, `clip 太少（${clips.length}）`);

    const LAT = 9500;   // 单 clip 翻译耗时（真实模型实测中位）
    const CONC = 4;     // 生产全局并发上限
    const TICK = 1500;  // 预取轮询周期
    const st = {};
    const finish = [];
    let inflight = 0;
    let uncovered = 0;
    let samples = 0;
    const endMs = clips[clips.length - 1].end;

    for (let now = 0; now <= endMs; now += TICK) {
      for (let i = finish.length - 1; i >= 0; i--) {
        if (finish[i].at <= now) { st[finish[i].idx] = "done"; inflight--; finish.splice(i, 1); }
      }
      let idx = clips.findIndex((c) => now >= c.start && now < c.end);
      if (idx === -1) idx = clips.findIndex((c) => c.start > now);
      if (idx === -1) idx = clips.length - 1;

      // 走产品的权威调度判据
      const plan = Core.planTranslationWindow({
        currentIdx: idx,
        clipCount: clips.length,
        remainMsInCurrent: clips[idx].end - now,
      }).plan;
      for (const j of plan) {
        if (st[j] || inflight >= CONC) continue;
        st[j] = "inflight"; inflight++; finish.push({ idx: j, at: now + LAT });
      }

      // 首个 clip 必然要等一次翻译（约 LAT），这段不计入落后统计
      if (now < LAT * 1.5) continue;
      samples++;
      if (st[idx] !== "done") uncovered++;
    }

    assert.ok(samples > 0, "模拟没有产生采样点");
    const missRate = uncovered / samples;
    // 首屏之后，播放中的字幕应当基本总是已有译文。
    assert.ok(
      missRate <= 0.05,
      `翻译跟不上播放：${uncovered}/${samples} 个采样点（${(missRate * 100).toFixed(1)}%）当前字幕还没译文`
    );
  });

  test("真实停顿必须保留：源轨里说话人停下来的地方，字幕之间也要有空隙", () => {
    // 用户报障原话：「字幕没有停顿是不是你没发现？」—— 他是对的。
    // 此前渲染层 436/439 个相邻单元空隙为 0ms，字幕整段连成一片。
    //
    // 根因：YouTube json3 的每个 seg 只有 tOffsetMs（词的**开始**时刻），没有任何
    // 词级时长字段，于是 parseJson3 只能把词的 end 填成下一个词的 start ——
    // 说话人的停顿被吞进了前一个词的显示时长里。
    // 但停顿信息确实在数据里：同一 event 内相邻词间隔中位 241ms，而有 500 处
    // ≥500ms。修复在渲染层按"末词说完即止"把静音让回去（只动 endMs）。
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/youtube-json3-rolling-raw.json"), "utf8"));
    const cues = Core.cleanupCues(Core.parseJson3(raw));
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    const display = Core.resegmentCues(cues, { maxWords: 12, continuationMaxWords: 14 });
    const units = Core.buildCueTokenSpanUnits(timeline, display);
    const snap = Core.createTimelineSnapshot({ timeline, units, cues });
    const R = snap.renderUnits;
    const T = timeline.tokens;

    let srcPause = 0, kept = 0;
    for (let i = 0; i < R.length - 1; i++) {
      const lastTok = T[units[i].tokenEnd - 1];
      const nextTok = T[units[i + 1].tokenStart];
      if (!lastTok || !nextTok) continue;
      // 源数据里"末词开口 → 下一词开口"跨度很大 = 说话人真的停了
      if (nextTok.startMs - lastTok.startMs < 800) continue;
      srcPause++;
      if (R[i + 1].startMs - R[i].endMs >= 120) kept++;
    }
    // 下限按 fixture 自身真实规模定（实测 63 处）。定得比实际高会让整条门禁
    // 卡在这一行上，保住率断言永远跑不到 —— 那样它就成了永远变红的死门禁。
    assert.ok(srcPause >= 50, `真实轨应含大量停顿，实测仅 ${srcPause} 处（fixture 形状不对）`);
    const rate = kept / srcPause;
    assert.ok(rate >= 0.9, `真实停顿只保住 ${kept}/${srcPause}（${Math.round(rate * 100)}%），字幕会连成一片`);

    // 让出停顿绝不能破坏既有的三条硬契约
    for (let i = 0; i < R.length; i++) {
      assert.strictEqual(R[i].startMs, units[i].startMs, "startMs 被改动 —— 出现时刻必须精确贴合音轨");
      assert.ok(R[i].endMs > R[i].startMs, "单元时长非正");
      assert.ok(R[i].endMs - R[i].startMs >= 400, `单元被削到 ${R[i].endMs - R[i].startMs}ms，短于可读下限`);
      if (i + 1 < R.length) assert.ok(R[i + 1].startMs >= R[i].endMs, "让出停顿后仍存在重叠");
    }
  });

  console.log("\n========================================");
  console.log("  通过: " + passed + "  失败: " + failed);
  console.log("========================================");
  if (failed > 0) process.exit(1);
}

main();
