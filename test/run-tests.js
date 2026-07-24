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
  return JSON.stringify({ cutsAfter: cuts });
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
    fetchImpl: async (_url, opts) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ cutsAfter: ["unknown-token"] }) } }] }) }),
  }), /invalid boundary cuts/);
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

test("repairNaturalUnitBoundaries 合并条件主句和介词续接，但不把完整对比从句硬塞进前屏", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 160, end: 1875, content: "If you're a human person", tokens: [{ text: "If" }] },
    { start: 2184, end: 4636, content: "one of those things you're going to want to do with some regularity is boil water", tokens: [{ text: "one" }] },
    { start: 237505, end: 243505, content: "Let me reiterate that the cheapest electric kettle I could get my hands on", tokens: [{ text: "Let" }] },
    { start: 243505, end: 246286, content: "is significantly faster at boiling water", tokens: [{ text: "is" }] },
    { start: 246286, end: 252108, content: "than this stove top kettle despite being limited by our 120 volt electrical system", tokens: [{ text: "than" }] },
    { start: 252108, end: 258153, content: "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets", tokens: [{ text: "Our" }] },
    { start: 258153, end: 260931, content: "although 1800 watts is technically permissible", tokens: [{ text: "although" }] },
  ], { maxNaturalWords: 24 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "If you're a human person one of those things you're going to want to do with some regularity is boil water",
    "Let me reiterate that the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system",
    "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets",
    "although 1800 watts is technically permissible",
  ]);
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

asyncTest("restoreAndPackTokens 条件从句无安全短边界时显式回退而不是制造 21 词屏", async () => {
  const source = "If you're a human person one of those things you're going to want to do with some regularity is boil water";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 200, end: (i + 1) * 200 }));
  let call = 0;
  await assert.rejects(() => Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 80,
    preferredMaxWords: 16, maxWords: 16, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, boundaryJson(req, [])) } }] }) }),
  }), /unresolved oversized semantic unit/i);
  assert.strictEqual(call, 2, "超过硬上限且无自然边界时只做一次有界 rescue 后回退");
});

asyncTest("restoreAndPackTokens 行长优先且绝不在 than 比较结构中间切屏", async () => {
  const tokens = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited".split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 80,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, boundaryJson(req, [])) } }] }) }),
  });
  assert.strictEqual(call, 1, "确定性整句分区已解决长句时不应浪费第二次 rescue 调用");
  assert.deepStrictEqual(units.map((u) => u.content), [
    "let me reiterate that",
    "the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle",
    "despite being limited",
  ], "短尾让步语可以独立成屏，但 than 比较结构绝不能被切断");
  assert.ok(units.every((u) => u.content.split(/\s+/).length <= 12), "每个真实显示单元必须保持舒适行长");
  assert.strictEqual(units.map((u) => u.content).join(" "), tokens.map((t) => t.text).join(" "), "分屏不能丢词或改写原文");
});

asyncTest("restoreAndPackTokens 默认舒适行长把 reporting 长句拆成 4/10/11/9", async () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100, nativeTiming: true }));
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: boundaryJson(req, []) } }] }) }),
  });
  assert.deepStrictEqual(units.map(u => u.content.split(/\s+/).length), [4, 10, 11, 9]);
  assert.ok(units.every(u => u.content.split(/\s+/).length <= 12));
  assert.strictEqual(units.map(u => u.content).join(" "), source);
  assert.deepStrictEqual(units.map(u => [u.start, u.end]), [[0, 400], [400, 1400], [1400, 2500], [2500, 3400]]);
});

test("partitionReadableTokenUnit 有界恢复 14/11/9 屏并拒绝无安全候选硬切", () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const bad = tokens.map(() => ""); bad[19] = "|"; // 唯一模型边界是 boiling water | than...
  const marks = Core.partitionReadableTokenUnit(tokens, Core.filterUnsafeRescueMarks(tokens.map((t) => t.text), bad), { preferredWords: 14, hardWords: 16, minWords: 6 });
  assert.ok(marks);
  const units = Core.packRestoredTokens(tokens, marks, { maxWords: 16 });
  assert.deepStrictEqual(units.map((u) => u.content.split(/\s+/).length), [14, 11, 9]);
  assert.strictEqual(Core.partitionReadableTokenUnit("these words provide no recognized safe boundary for deterministic partitioning whatsoever today".split(" ").map((text, i) => ({ text, start: i, end: i + 1 })), [], { preferredWords: 6, hardWords: 8, minWords: 4 }), null);
});

asyncTest("restoreAndPackTokens 对无安全边界的超长句显式失败而不是返回超长显示单元", async () => {
  const source = "these deliberately opaque tokens provide no recognized semantic boundary and remain impossible to partition safely without fabricating a hard cut today";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100, nativeTiming: true }));
  let calls = 0;
  await assert.rejects(() => Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
    preferredMaxWords: 16, maxWords: 16, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls, boundaryJson(req, [])) } }] }) }),
  }), /unresolved oversized semantic unit/i);
  assert.strictEqual(calls, 2, "只允许首轮恢复加一次有界 rescue");
});

asyncTest("restoreAndPackTokens 把 15/8 外边界归一化为 5/10/8 且不浪费 rescue", async () => {
  const source = "Let me point out that the least expensive adapter I could get my hands on still handled every device in our overnight test";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
    preferredMaxWords: 10, maxWords: 12, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, boundaryJson(req, [])) } }] }) }),
  });
  assert.strictEqual(call, 1, "确定性整句分区已解决长行时不应额外调用 rescue");
  assert.deepStrictEqual(units.map(u => u.content.split(/\s+/).length), [5, 10, 8]);
  assert.strictEqual(units.map(u => u.content).join(" "), source);
});

test("partitionReadableTokenUnit 识别 reporting 主语后的副词加实义谓语", () => {
  const source = "Let me point out that the least expensive adapter I could get my hands on still handled every device in our overnight test";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = Core.partitionReadableTokenUnit(tokens, tokens.map(() => ""), { preferredWords: 14, hardWords: 16, minWords: 6 });
  assert.ok(marks, "15/8 自然边界必须能确定性恢复");
  assert.deepStrictEqual(Core.packRestoredTokens(tokens, marks, { maxWords: 16 }).map(u => u.content.split(/\s+/).length), [15, 8]);
});

asyncTest("restoreAndPackTokens 接受自然完整的 11 词屏而不为追 10 强拆", async () => {
  const source = "Let me point out that this compact kettle works very reliably";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let calls = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m",
    preferredMaxWords: 10, maxWords: 12, attempts: 1,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls, boundaryJson(req, [])) } }] }) }),
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(units.map(u => u.content), [source]);
  assert.strictEqual(units[0].content.split(/\s+/).length, 11);
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

test("normalizeOversizeSentenceMarks 覆盖模型 4/21/9 坏切并恢复 14/11/9", () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  const marks = tokens.map(() => ""); marks[3] = "|"; marks[24] = "|"; marks[33] = ".";
  const normalized = Core.normalizeOversizeSentenceMarks(tokens, marks, { preferredWords: 14, hardWords: 16, minWords: 6 });
  const units = Core.packRestoredTokens(tokens, normalized, { maxWords: 16 });
  assert.deepStrictEqual(units.map((u) => u.content.split(/\s+/).length), [14, 11, 9]);
  assert.strictEqual(units.map((u) => u.content).join(" "), source);
});

asyncTest("restoreAndPackTokens 真实水壶长句拆成四个舒适短屏且保留词与时间", async () => {
  const source = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited by our 120 volt electrical system";
  const tokens = source.split(" ").map((text, i) => ({ text, start: 237505 + i * 400, end: 237905 + i * 400, nativeTiming: true }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 80,
    fetchImpl: async (_url, req) => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call, boundaryJson(req, [])) } }] }) }),
  });
  assert.strictEqual(call, 1, "确定性整句分区成功后不应再调用局部 rescue");
  assert.deepStrictEqual(units.map((u) => u.content), [
    "let me reiterate that",
    "the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle",
    "despite being limited by our 120 volt electrical system",
  ]);
  assert.ok(units.every((u) => u.content.split(/\s+/).length <= 12), "真实长句不得再退化为 20–34 词单屏");
  assert.strictEqual(units.map((u) => u.content).join(" "), source, "分屏必须逐词保真");
  assert.deepStrictEqual(units.map((u) => [u.start, u.end]), [[237505, 239105], [239105, 243105], [243105, 247505], [247505, 251105]], "每屏时间必须直接来自边界 token");
});

test("repairNaturalUnitBoundaries 合并 And 开头的状语与下一条主句", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 260931, end: 266030, content: "And on a 20 amp circuit which is fairly common especially in kitchens", tokens: [{ text: "And" }] },
    { start: 266030, end: 267622, content: "2400 watts is possible", tokens: [{ text: "2400" }] },
  ], { maxNaturalWords: 20 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "And on a 20 amp circuit which is fairly common especially in kitchens 2400 watts is possible",
  ]);
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

test("repairNaturalUnitBoundaries 合并介词起始的 ASR 半句", () => {
  const repaired = Core.repairNaturalUnitBoundaries([
    { start: 0, end: 1000, content: "We do it for lots of reasons", tokens: [{ text: "We" }] },
    { start: 1000, end: 2000, content: "from cooking to cleaning and disinfecting", tokens: [{ text: "from" }] },
    { start: 2000, end: 3000, content: "to other things probably", tokens: [{ text: "to" }] },
  ], { preferredMaxWords: 24, maxNaturalWords: 36 });
  assert.deepStrictEqual(repaired.map((u) => u.content), [
    "We do it for lots of reasons from cooking to cleaning and disinfecting to other things probably",
  ]);
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


test("parseBoundaryCutsResponse 只接受严格递增且属于请求窗口的 cutsAfter token ID", () => {
  const allowed = ["t10", "t11", "t12", "t13"];
  assert.deepStrictEqual(Core.parseBoundaryCutsResponse('{"cutsAfter":["t11","t13"]}', allowed), ["t11", "t13"]);
  assert.deepStrictEqual(Core.parseBoundaryCutsResponse('```json\n{"cutsAfter":["t12"]}\n```', allowed), ["t12"]);
});

test("parseBoundaryCutsResponse 对未知/重复/乱序/夹带字段 fail-closed", () => {
  const allowed = ["t10", "t11", "t12"];
  assert.throws(() => Core.parseBoundaryCutsResponse('{"cutsAfter":["t99"]}', allowed), /unknown cut token/i);
  assert.throws(() => Core.parseBoundaryCutsResponse('{"cutsAfter":["t11","t11"]}', allowed), /strictly increasing/i);
  assert.throws(() => Core.parseBoundaryCutsResponse('{"cutsAfter":["t12","t11"]}', allowed), /strictly increasing/i);
  assert.throws(() => Core.parseBoundaryCutsResponse('{"cutsAfter":[],"rewrittenText":"evil"}', allowed), /unexpected boundary response field/i);
  assert.throws(() => Core.parseBoundaryCutsResponse('{"cutsAfter":"t11"}', allowed), /cutsAfter must be an array/i);
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

test("DEFAULT_SYSTEM_PROMPT 只声明结构化 coverage JSON，不保留编号/MERGE 协议", () => {
  const prompt = Core.DEFAULT_SYSTEM_PROMPT;
  assert.ok(prompt.includes("translations") && prompt.includes("unitId") && prompt.includes("coverFrom") && prompt.includes("coverTo"));
  assert.ok(prompt.includes("单行") && prompt.includes("不得输出中文句号"));
  assert.ok(!/带序号|MERGE_PREV|只输出带编号/.test(prompt));
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
  assert.deepStrictEqual(requestPayload.units.map(x=>Object.keys(x).sort()),[["coverFrom","coverTo","sourceText","unitId"],["coverFrom","coverTo","sourceText","unitId"]]);
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

asyncTest("translateClipWithBoundaryRepair 不再合并边界：semantic 12/fallback 14 cap，成功只请求一次", async () => {
  const cue13={unitId:"u0",tokenStart:0,tokenEnd:13,start:0,end:1300,content:"one two three four five six seven eight nine ten eleven twelve thirteen"};
  let calls=0;
  await assert.rejects(()=>Core.translateClipWithBoundaryRepair({cues:[cue13],segmentationMode:"semantic",apiBaseUrl:"https://example.test",apiModel:"m",fetchImpl:async()=>{calls++;throw new Error("must not fetch")}}),/oversized source unit/);
  assert.strictEqual(calls,0);
  const result=await Core.translateClipWithBoundaryRepair({cues:[cue13],segmentationMode:"fallback-translation",apiBaseUrl:"https://example.test",apiModel:"m",fetchImpl:async(_u,req)=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:translationCoverageJson(req,["这是一条完整译文"])}}]})}}});
  assert.strictEqual(calls,1);
  assert.strictEqual(result.repaired,false);
  assert.deepStrictEqual(result.lines,["这是一条完整译文"]);
  assert.deepStrictEqual(result.cues,[cue13]);
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

/* ============ 5d. 缓存 key + LRU 裁剪 ============ */
console.log("\n[makeCacheKey + pruneCache]");

test("makeCacheKey 同输入稳定、异输入不同", () => {
  const a = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "zh-Hans", apiModel: "m", clipStartMs: 0 });
  const b = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "zh-Hans", apiModel: "m", clipStartMs: 0 });
  const c = Core.makeCacheKey({ videoId: "v1", trackCode: "en-asr", targetLang: "ja", apiModel: "m", clipStartMs: 0 });
  assert.strictEqual(a, b, "相同输入 key 相同 → 可命中");
  assert.notStrictEqual(a, c, "目标语言不同 key 不同 → 不误命中");
});

test("makeCacheKey v0.6 隔离旧协议缓存与 fallback/semantic 分段", () => {
  const fallback = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "fallback", clipStartMs: 0 });
  const semantic = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0 });
  assert.ok(fallback.startsWith("dsc-v70|cue-v1|fallback|"), "10/12 舒适短屏必须隔离旧 14/16 边界与译文缓存");
  assert.notStrictEqual(fallback, semantic, "fallback 与 semantic cue 边界不得共用翻译缓存");
  const beforeRepair = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0, cueFingerprint: "0:1000:a~1000:2000:b" });
  const afterRepair = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0, cueFingerprint: "0:2000:a b" });
  assert.notStrictEqual(beforeRepair, afterRepair, "边界回修前后的 cue 指纹不同，缓存 key 必须隔离");
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

test("isolated 生命周期：disable 与同视频换轨必须先失效旧 generation", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /if \(!config\.enabled\) \{[\s\S]{0,260}?invalidateRuntimeRequests\(\)[\s\S]{0,260}?teardownRuntime\(true\)/, "disable 必须先 abort/失效再拆 UI");
  assert.match(src, /function switchTrack\(track\)[\s\S]{0,500}?invalidateRuntimeRequests\(\)[\s\S]{0,500}?state\.activeTrack = track[\s\S]{0,500}?loadTrack\(track\)/, "所有轨道切换必须走单一失效入口");
  assert.match(src, /async function loadTrack\(track\)[\s\S]{0,700}?trackUrl[\s\S]{0,700}?state\.activeTrack\.url === trackUrl/, "轨道 body/install 前必须复验精确轨道身份");
  assert.match(src, /function isRuntimeRequestCurrent\(context\)[\s\S]{0,220}?config\.enabled/, "所有异步副作用须同时受 enabled 门禁");
});

test("翻译 identity 包含 maxLineChars，并在其变化时清空旧 snapshot 译文", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /function clipCacheKey[\s\S]{0,700}?maxLineChars:\s*identity\.maxLineChars/);
  assert.match(src, /prevMaxLineChars[\s\S]{0,900}?config\.maxLineChars !== prevMaxLineChars/);
  const base = { videoId:"v",trackCode:"en",targetLang:"zh-Hans",apiModel:"m",apiBaseUrl:"https://gw/v1",systemPrompt:"p",reasoningEffort:"low",contractVersion:"span-v1",segmentationMode:"semantic",clipStartMs:0,cueFingerprint:"x",maxLineChars:16 };
  assert.notStrictEqual(Core.makeCacheKey(base), Core.makeCacheKey(Object.assign({}, base, { maxLineChars: 28 })));
});

test("持久缓存采用 per-entry storage key，禁止跨 tab 共享对象 RMW", () => {
  const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  assert.match(src, /CACHE_ENTRY_PREFIX/);
  assert.match(src, /SEMANTIC_CACHE_ENTRY_PREFIX/);
  assert.ok(!/function readCache\(\)[\s\S]{0,500}?CACHE_KEY/.test(src), "translation cache 不得整对象读改写");
  assert.ok(!/function readSemanticCache\(\)[\s\S]{0,500}?SEMANTIC_CACHE_KEY/.test(src), "semantic cache 不得整对象读改写");
});

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
  assert.ok(a.startsWith("dss-v1|"), "语义恢复缓存必须有独立版本 namespace");
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
  // v0.4.1：首包延迟打磨——默认 clip 收短到 12s（仍 >0；旧 15 易让单请求 > 播放窗）
  assert.ok(d.clipSeconds >= 8 && d.clipSeconds <= 12, "clipSeconds 默认应在 8–12");
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
        text: async () => JSON.stringify({ choices: [{ message: { content: boundaryJson(req, []) } }], usage }),
      }),
    });
    assert.deepStrictEqual(seen, usage);
  });

  test("isolated get-state 回传当前页面真实 API usage", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const block = src.match(/if \(msg\.type === "get-state"\) \{[\s\S]*?return true;/);
    assert.ok(block && /apiUsage:\s*Object\.assign/.test(block[0]), "get-state 必须回传 usage 快照");
  });

  test("restoration prompt 与 10/12 舒适短屏契约一致", () => {
    const prompt = Core.DEFAULT_RESTORATION_PROMPT;
    assert.ok(prompt.includes("4–11 词") && prompt.includes("最多 12 词"));
    assert.ok(prompt.includes("cutsAfter") && prompt.includes("不得回显") && prompt.includes("比较结构"), "prompt 必须要求纯 token-ID 边界协议且禁止模型拥有正文");
    assert.ok(!/只返回原词|加入空格和 \. \? ! \||6–16|最多 20 词/.test(prompt), "不得保留全文回显或旧长屏协议");
  });

  test("isolated 生产语义恢复统一使用 10 词目标与 12 词硬上限", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.strictEqual((src.match(/preferredMaxWords:\s*10/g) || []).length, 2, "缓存身份和真实请求必须使用同一 10 词目标");
    assert.strictEqual((src.match(/maxWords:\s*12/g) || []).length, 3, "semantic 缓存/请求与 fallback 目标必须统一使用 12 词");
    assert.ok(!/preferredMaxWords:\s*14/.test(src) && !/maxWords:\s*16/.test(src), "运行时不得残留旧 14/16 行长目标");
    assert.match(src, /function translatePreparedClip[\s\S]*?loadOrTranslateClip\(clip, "semantic",\s*100\)/, "semantic 预热必须显式标记 semantic mode");
    assert.match(src, /function translateClip[\s\S]*?loadOrTranslateClip\(clip, segmentationModeAtStart, priority\)/, "运行翻译必须传入真实 segmentation mode");
    assert.strictEqual((src.match(/Core\.translateClipLines\s*\(/g) || []).length, 1, "除 testConnection 单行探针外不得绕过 repair/source-cap 门禁直调 translateClipLines");
    assert.match(src, /function testConnection[\s\S]*?Core\.translateClipLines\s*\(\{[\s\S]*?cues:\s*\[\{ content:\s*"hello world"/, "唯一直调必须受限于 testConnection 的单行连接探针");
    assert.match(src, /function enableFallbackTranslation[\s\S]*?state\.segmentationMode === "semantic"[\s\S]*?state\.segmentationMode === "fallback-translation"[\s\S]*?state\.segmentationMode !== "fallback"[\s\S]*?state\.segmentationMode = "fallback-translation"/, "只有 fallback 可显式迁移进入 14 词 fallback translation，且不得覆盖 semantic 或重复进入");
    assert.ok(!src.includes("maxSourceWords"), "生产调用不得自行计算 12/14 数值上限");
    assert.match(src, /Core\.resegmentCues\(cues, \{ tailTrimMs: config\.tailTrimMs, maxWords: 12, continuationMaxWords: 14 \}\)/, "生产 fallback 必须显式区分 12 词目标与 14 词续接硬上限");
    assert.strictEqual((src.match(/Core\.resegmentCues\(/g) || []).length, 1, "isolated 中 resegmentCues 只能用于 fallback，semantic 必须走 restoreAndPackTokens");
  });

  test("语义缓存 key 与恢复请求显式复用同一 restoration prompt", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /var restorationPrompt = Core\.DEFAULT_RESTORATION_PROMPT;/);
    assert.match(src, /makeSemanticCacheKey\(\{[\s\S]*?systemPrompt:\s*restorationPrompt[\s\S]*?\}\);/);
    assert.match(src, /restoreAndPackTokens\(\{[\s\S]*?systemPrompt:\s*restorationPrompt[\s\S]*?\}\);/);
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

  test("isolated 导出与原生字幕隐藏契约：按有原文单元完整性判断，英文 fallback 也隐藏 YouTube 原生字幕", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /var exportSnapshot = state\.timelineSnapshot[\s\S]*?exportSnapshot\.renderUnits\.filter[\s\S]*?String\(u\.originalText \|\| ""\)\.trim\(\) !== ""[\s\S]*?var allTranslated = realUnits\.length > 0 && realUnits\.every/, "导出必须按所有有原文单元检查译文完整性");
    assert.match(src, /function updateNativeCaptionVisibility[\s\S]*?!config\.enabled \|\| !state\.renderer[\s\S]*?classList\.remove\("dualsub-hide-native-captions"\)[\s\S]*?domHasDualsubText[\s\S]*?timelineHasDualsubText[\s\S]*?dualsub-hide-native-captions/, "只要 DualSub 任一 DOM 或时间轴文本层出现，就必须隐藏 YouTube 原生字幕；禁用或 renderer 清除时必须恢复原生字幕");
    assert.match(src, /function setRendererText[\s\S]*?updateNativeCaptionVisibility\(\)[\s\S]*?fitSubtitleRows\(\)/, "写入字幕 DOM 的同一 tick 必须同步更新原生字幕隐藏状态，避免首帧双字幕窗口");
    assert.match(src, /function installCueTimeline[\s\S]*?state\.timelineEpoch\+\+[\s\S]*?clearSemanticFallbackTimer\(\)/, "semantic 原子接管必须递增 epoch 并取消慢 fallback 定时器，使旧 fallback 请求失效");
    assert.match(src, /function translateClip[\s\S]*?segmentationModeAtStart = state\.segmentationMode[\s\S]*?timelineEpoch !== state\.timelineEpoch \|\| segmentationModeAtStart !== state\.segmentationMode[\s\S]*?applyClipLines/, "translateClip 必须用 epoch+segmentationMode 双重快照拒绝 stale fallback 写入 semantic 时间轴");
  });

  
  test("loadOrTranslateClip 必须透传 repaired 标志，禁止硬编码 false", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.match(src, /var out = \{[\s\S]*?cues: result && result\.repaired \? result\.cues : clip\.cues[\s\S]*?repaired: !!\(result && result\.repaired\)/,
      "loadOrTranslateClip 必须把 Core.translateClipWithBoundaryRepair 的 repaired 结果透传给 translateClip/translatePreparedClip");
    assert.doesNotMatch(src, /cues: result && result\.repaired \? result\.cues : clip\.cues[\s\S]*?repaired: false,/,
      "loadOrTranslateClip 不得在采用 repaired cues 的同时把 repaired 硬编码为 false");
    assert.match(src, /if \(result\.repaired\) \{[\s\S]*?adoptRepairedClipTimeline\(idx, result\.cues\)/,
      "translateClip 必须在 repaired=true 时调用 adoptRepairedClipTimeline");
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

  test("语义恢复不阻塞 fallback 首屏，切换时隔离旧异步结果与缓存", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    const load = src.slice(src.indexOf("async function loadTrack"), src.indexOf("/* =====================================================\n   * 翻译编排"));
    assert.ok(load.indexOf('installCueTimeline(fallbackCues, "fallback", { sourceTimeline: sourceTimeline })') >= 0, "应先安装 fallback 首屏时间轴");
    assert.ok(load.indexOf('installCueTimeline(fallbackCues, "fallback", { sourceTimeline: sourceTimeline })') < load.indexOf("restoreSemanticCuesIfAvailable(cues)"), "语义恢复必须后台启动，不得 await 阻塞首屏");
    assert.ok(/timelineEpoch !== state\.timelineEpoch/.test(src), "旧分段异步请求不得写入新时间轴");
    assert.ok(/state\.timelineSnapshot = Core\.createTimelineSnapshot/.test(src), "renderer 提交必须生成不可变 TimelineSnapshot revision");
    assert.ok(/var exportSnapshot = state\.timelineSnapshot/.test(src), "SRT 导出必须读取 renderer 同一 snapshot");
    assert.ok(/function resetForNewVideo\(\)[\s\S]{0,120}invalidateRuntimeRequests\(\)[\s\S]{0,120}state\.timelineEpoch\+\+/.test(src), "切视频必须废止旧轨道异步请求");
    assert.ok(/if \(mode === "semantic"\) state\.firstClipReady = true/.test(src), "语义后台切换不得再次暂停已播放视频");
    assert.ok(/white-space:nowrap/.test(src), "英文和中文都必须保持单行");
    assert.ok(!/text-overflow:ellipsis/.test(src), "字幕正文禁止用省略号隐藏内容");
    assert.ok(!/overflow:hidden/.test(src.slice(src.indexOf(".dualsub-subtitle{"), src.indexOf(".dualsub-subtitle.dualsub-orig"))), "字幕正文不能静默裁切");
    assert.ok(/--ds-fit-scale/.test(src) && /calc\(var\(--ds-fontsize,22px\) \* var\(--ds-fit-scale,1\)\)/.test(src), "单行字幕超宽时应等比缩小字号，不能横向扭曲字形");
    assert.ok(!/scaleX\(var\(--ds-fit-scale/.test(src), "禁止用 scaleX 挤扁字幕字形");
    assert.ok(/function fitSubtitleRows/.test(src) && /scrollWidth/.test(src), "必须测量真实 DOM 像素宽度后适配，不能只按词数猜测");
    assert.ok(/padding:0 2%/.test(src) && /max-width:100%/.test(src) && /clientWidth \* 0\.96/.test(src), "超长完整语义单元应优先使用播放器安全宽度，不能因容器重复留白被迫缩到小字");
    const setTextBody = src.slice(src.indexOf("function setRendererText"), src.indexOf("function teardownRuntime"));
    assert.ok(/fitSubtitleRows\(\)/.test(setTextBody), "每次写入新字幕后必须重新做像素宽度适配");
    assert.ok(!/-webkit-line-clamp:2/.test(src) && !/white-space:pre-wrap/.test(src), "渲染器不得允许字幕折成多行");
    assert.ok(/function clipCacheKey\(clip, segmentationMode/.test(src), "不同分段模式不得复用同一 clip 缓存");
    assert.ok(/function loadOrTranslateClip[\s\S]*Core\.translateClipWithBoundaryRepair/.test(src) && /function translatePreparedClip[\s\S]*loadOrTranslateClip\(clip, "semantic",\s*100\)/.test(src), "semantic 原子接管的预热翻译也必须走统一边界回修入口，不能绕过新契约");
    assert.ok(/cached\.coverage/.test(src) && /writeCache\(key, \{ lines: out\.lines, coverage: out\.coverage \}, generation\)/.test(src), "coverage ledger 必须随 per-entry 译文缓存，并受 generation 写门禁保护");
    assert.ok(!/if \(translationResult && translationResult\.repaired\)[\s\S]{0,160}key = clipCacheKey\(clip\)/.test(src), "回修结果必须写在本次输入 key 下；若改写为输出 key，下一次仍以原 cue 查询将永远无法命中");
    const cacheKeyBody = src.slice(src.indexOf("function clipCacheKey"), src.indexOf("function semanticUnitsFromTrack"));
    assert.ok(/cueFingerprint/.test(cacheKeyBody), "clip 缓存键必须包含当前 cue 边界与文本指纹；边界回修前后不得碰撞");
    assert.ok(/"dsc-v70"/.test(fs.readFileSync(path.join(ROOT, "core.js"), "utf8")), "10/12 舒适短屏必须升级缓存 namespace");
    const prefetch = src.slice(src.indexOf("function prefetchAround"), src.indexOf("function getBackoff"));
    assert.ok(/state\.segmentationMode === "fallback"/.test(prefetch), "语义恢复尚未结束时 fallback 只显原文，不应抢跑重复翻译");
    assert.ok(/function enableFallbackTranslation\(loadEpoch\)/.test(src), "语义恢复失败后必须有显式 fallback 翻译降级入口");
    assert.ok(/!semanticCues[\s\S]{0,160}enableFallbackTranslation\(loadEpoch\)/.test(load), "语义恢复不适用或失败时必须启动 fallback 翻译");
    assert.ok(/stageSemanticTimeline[\s\S]{0,360}else \{[\s\S]*finishSemanticPending\(loadEpoch\)[\s\S]*enableFallbackTranslation\(loadEpoch\)/.test(load), "semantic 当前段预热失败时必须启动 fallback 翻译");
    const render = src.slice(src.indexOf("function onRenderTick"), src.indexOf("function setRendererText"));
    assert.ok(/state\.segmentationMode !== "fallback" \? Core\.clipDisplayFlags/.test(render), "启用翻译降级后的 fallback 必须显示中文或翻译状态");
  });

  test("isolated.js 只在可靠 JSON3 token 时序下启用语义恢复，失败完整回退", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.ok(/Core\.hasNativeTokenTiming\(cues, 0\.8\)/.test(src), "应有 80% 原生 token timing 门槛");
    assert.ok(/Core\.restoreAndPackTokens\b/.test(src), "加载路径应调用生产语义恢复器");
    assert.ok(/var fallbackCues = Core\.resegmentCues\(cues, \{ tailTrimMs: config\.tailTrimMs, maxWords: 12, continuationMaxWords: 14 \}\)/.test(src), "不满足契约时应完整回退 ASR 重组");
    assert.ok(/installCueTimeline\(fallbackCues, "fallback", \{ sourceTimeline: sourceTimeline \}\)/.test(src), "fallback 必须先安装可播放时间轴");
    assert.ok(/stageSemanticTimeline\(Core\.applyTailTrim\(semanticCues, config\.tailTrimMs\), loadEpoch\)/.test(src), "启用路径应先预热当前 semantic clip");
    assert.ok(/for \(var attempt = 0; attempt < 3; attempt\+\+\)/.test(src), "semantic 预热应有界重验播放头");
    assert.ok(/var installIdx = clipIdxAtIn\(clips, currentTimeMs\(\)\)/.test(src), "翻译 await 后必须重验当前 clip");
    assert.ok(/return installCueTimeline\(installedCues, "semantic", \{ clips: clips, seeds: seeds \}\)/.test(src), "只有当前段已有 seed 且回修 cue 已汇总的 semantic 候选才能原子接管屏幕");
    const install = src.slice(src.indexOf("function installCueTimeline"), src.indexOf("/* =====================================================\n   * 翻译编排"));
    assert.ok(install.indexOf("nextClipUnits[seedIdx]") < install.indexOf("state.timelineEpoch++"), "semantic seed 必须在 epoch/mode 切换前事务化构建；异常时保留工作中的 fallback");
    assert.ok(install.indexOf("nextClipUnits[seedIdx]") < install.indexOf("state.segmentationMode = mode"), "semantic seed 构建失败不得留下半安装 semantic mode");
    assert.ok(install.indexOf("state.clipUnits = nextClipUnits") < install.indexOf("rebuildRenderTimeline();"), "semantic seeds 必须在首帧重建前原子写入，禁止闪回翻译中");
    assert.ok(/if \(ms < clips\[i\]\.startMs\) return i/.test(src), "播放头在 gap 时应预热下一段而不是末段");
    assert.ok(/installCueTimeline\(fallbackCues, "fallback", \{ sourceTimeline: sourceTimeline \}\)/.test(src), "回退路径应安装可诊断 fallback 模式");
  });

  test("isolated.js 不再引用任何 v0.4.0 已删的 core 函数", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    DELETED_FNS.forEach((fn) => {
      const re = new RegExp("Core\\." + fn + "\\b");
      assert.ok(!re.test(src), "isolated.js 不应再调用 Core." + fn + "（已删，会 is not a function 崩）");
    });
    // 正向：新主路径入口确实在被调用（对接到位，不是把调用整段删没了）
    assert.ok(/Core\.translateClipLines\b/.test(src), "isolated.js 应调用新入口 Core.translateClipLines");
    assert.ok(/Core\.buildClipUnits\b/.test(src), "isolated.js 应调用 Core.buildClipUnits 配时间轴");
  });

  test("已删函数在 core.js 确实 0 定义、且不在导出表里", () => {
    DELETED_FNS.forEach((fn) => {
      assert.strictEqual(typeof Core[fn], "undefined", "core 不应再导出 " + fn);
    });
    // 新架构入口应存在且为函数
    assert.strictEqual(typeof Core.translateClipLines, "function", "translateClipLines 应存在");
    assert.strictEqual(typeof Core.buildClipUnits, "function", "buildClipUnits 应存在");
  });






  /* ============ 6e. v0.4.1 打磨：原文对齐空行 / 半截短语 / 首包默认 ============
   * 验收里发现：译文行多于 cue 时，旧「cue 中点落槽」会在时隙空白处留下空 originalText
   * （双语对照约 1/3 行无英文）。这里锁死：只要该时隙与任一 cue 时间重叠，就有原文。
   */
  console.log("\n[中文目标清洗]");












  test("sanitizeSubtitleLine：去掉非中文目标杂质（拉丁串/异常脚本）但保留数字与常用标点", () => {
    assert.strictEqual(typeof Core.sanitizeSubtitleLine, "function");
    assert.strictEqual(Core.sanitizeSubtitleLine("这里少得多ഒരു"), "这里少得多");
    assert.strictEqual(Core.sanitizeSubtitleLine("把水烧开对，这是个 SodaStream 瓶子"), "把水烧开对，这是个瓶子");
    assert.strictEqual(Core.sanitizeSubtitleLine("功率是 8.8 千瓦"), "功率是 8.8 千瓦");
    assert.strictEqual(Core.sanitizeSubtitleLine("  hello  "), "");
  });




  /* ============ 6f. 跳过中文源 ============ */
  console.log("\n[跳过中文源：shouldSkipChineseSource / isChineseLangCode]");
  test("isChineseLangCode 识别 zh / yue / 后缀", () => {
    assert.strictEqual(Core.isChineseLangCode("zh"), true);
    assert.strictEqual(Core.isChineseLangCode("zh-Hans"), true);
    assert.strictEqual(Core.isChineseLangCode("zh-CN-asr"), true);
    assert.strictEqual(Core.isChineseLangCode("yue"), true);
    assert.strictEqual(Core.isChineseLangCode("en"), false);
    assert.strictEqual(Core.isChineseLangCode("en-US"), false);
    assert.strictEqual(Core.isChineseLangCode("ja"), false);
  });

  test("shouldSkipChineseSource：默认跳中文轨，手动选中文源不跳", () => {
    const zhTrack = { code: "zh-Hans-asr", languageCode: "zh-Hans", kind: "asr", name: "Chinese" };
    const enTrack = { code: "en-asr", languageCode: "en", kind: "asr", name: "English" };
    assert.strictEqual(
      Core.shouldSkipChineseSource(zhTrack, { skipChineseSource: true, sourceLang: "auto" }),
      true
    );
    assert.strictEqual(
      Core.shouldSkipChineseSource(enTrack, { skipChineseSource: true, sourceLang: "auto" }),
      false
    );
    assert.strictEqual(
      Core.shouldSkipChineseSource(zhTrack, { skipChineseSource: false, sourceLang: "auto" }),
      false
    );
    assert.strictEqual(
      Core.shouldSkipChineseSource(zhTrack, { skipChineseSource: true, sourceLang: "zh-Hans" }),
      false
    );
  });

  test("DEFAULT_CONFIG.skipChineseSource 默认 true", () => {
    assert.strictEqual(Core.DEFAULT_CONFIG.skipChineseSource, true);
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
    assert.strictEqual(m.version, "0.6.0", "token timeline、coverage 与全轨 SRT 契约必须随 v0.6.0 发布");
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

  console.log("\n========================================");
  console.log("  通过: " + passed + "  失败: " + failed);
  console.log("========================================");
  if (failed > 0) process.exit(1);
}

main();
