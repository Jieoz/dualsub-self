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
    fetchImpl: async (_url, opts) => { calls.push(opts); return { ok: true, json: async () => ({ choices: [{ message: { content: "For this kettle boil water. Next sentence." } }] }) }; },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(units.map((u) => u.content), ["For this kettle boil water", "Next sentence"]);
  await assert.rejects(() => Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", attempts: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "For this kettle boils water." } }] }) }),
  }), /invalid sentence restoration/);
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
    "the cheapest kettle is faster despite being limited",
    "by our 120 volt electrical system"
  ), { safe: false, reason: "continuation-start" });
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
    "Let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water",
    "than this stove top kettle despite being limited by our 120 volt electrical system",
    "Our weird system puts a practical limit of 1500 watts on most things which plug into ordinary outlets",
    "although 1800 watts is technically permissible",
  ]);
});

test("filterUnsafeRescueMarks 保留可配自然中文的引导片段，只拒绝 than 比较从句坏边界", () => {
  const words = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited".split(" ");
  const marks = words.map(() => "");
  marks[13] = "|"; // let me reiterate that ... hands on | is ...：左侧缺主断言
  marks[19] = "|"; // boiling water | than this ...：右侧比较从句续接
  const filtered = Core.filterUnsafeRescueMarks(words, marks);
  assert.strictEqual(filtered[13], "|", "引导片段可由中文完整改写，不能因此制造 34 词超长屏");
  assert.strictEqual(filtered[19], "", "than 比较结构不能另起字幕");
});

test("restoreAndPackTokens 首段条件从句不能为缩短显示而切成两条半句", async () => {
  const source = "If you're a human person one of those things you're going to want to do with some regularity is boil water";
  const tokens = source.split(" ").map((text, i) => ({ text, start: i * 200, end: (i + 1) * 200 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "k", apiModel: "m", chunkWords: 80,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call === 1)
      ? source + "."
      : "If you're a human person | one of those things you're going to want to do with some regularity is boil water." } }] }) }),
  });
  assert.strictEqual(call, 2, "超过舒适显示长度的完整句必须触发自然从句 rescue");
  assert.deepStrictEqual(units.map((u) => u.content), [source], "条件从句和主句必须作为同一自然语义单元");
  assert.deepStrictEqual(units.map((u) => [u.start, u.end]), [[0, 4200]], "合并后必须保留完整词级时间范围");
});

test("restoreAndPackTokens 对已验证超长句做一次局部 clause rescue", async () => {
  const tokens = "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited".split(" ").map((text, i) => ({ text, start: i * 100, end: (i + 1) * 100 }));
  let call = 0;
  const units = await Core.restoreAndPackTokens({
    tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m", chunkWords: 80,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++call === 1)
      ? "let me reiterate that the cheapest electric kettle I could get my hands on is significantly faster at boiling water than this stove top kettle despite being limited."
      : "let me reiterate that the cheapest electric kettle I could get my hands on | is significantly faster at boiling water | than this stove top kettle despite being limited." } }] }) }),
  });
  assert.strictEqual(call, 2, "一次 rescue 应保留可自然翻译的引导片段并拒绝 than 坏边界");
  assert.deepStrictEqual(units.map((u) => u.content), [
    "let me reiterate that the cheapest electric kettle I could get my hands on",
    "is significantly faster at boiling water than this stove top kettle despite being limited",
  ], "不能留下 than 开头的半句，也不能退化成 27 词超长单屏");
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

asyncTest("translateClipWithBoundaryRepair 中文硬门禁失败也向前合并后只重翻一次", async () => {
  const cues = [
    { start: 0, end: 1000, content: "The answer is simple", tokens: [{ text: "The" }] },
    { start: 1000, end: 2200, content: "But before we get into it with excruciating detail", tokens: [{ text: "But" }] },
  ];
  let calls = 0;
  const result = await Core.translateClipWithBoundaryRepair({
    cues, apiBaseUrl: "https://example.test", apiKey: "k", apiModel: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls === 1)
      ? "1. 答案很简单。\n2. 不过，在详细说明之前，"
      : "1. 答案很简单，不过在详细说明之前还要补充一点。" } }] }) }),
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.repaired, true);
  assert.strictEqual(result.cues.length, 1);
  assert.strictEqual(result.cues[0].start, 0);
  assert.strictEqual(result.cues[0].end, 2200);
});

test("mergeRejectedTranslationCues 只将 MERGE_PREV 与前一相邻 cue 合并并保留时间/token", () => {
  const cues = [
    { start: 0, end: 1000, content: "let me reiterate that the cheapest kettle", tokens: [{ text: "let" }] },
    { start: 1000, end: 2200, content: "is faster at boiling water", tokens: [{ text: "is" }] },
    { start: 2400, end: 3000, content: "Next sentence", tokens: [{ text: "Next" }] },
  ];
  const merged = Core.mergeRejectedTranslationCues(cues, ["[MERGE_PREV]", "[MERGE_PREV]", "下一句。"]);
  assert.deepStrictEqual(merged.map((c) => [c.start, c.end, c.content]), [
    [0, 2200, "let me reiterate that the cheapest kettle is faster at boiling water"],
    [2400, 3000, "Next sentence"],
  ]);
  assert.deepStrictEqual(merged[0].tokens.map((t) => t.text), ["let", "is"]);
});


test("默认翻译 prompt 要求从属开头且不能独立翻译时返回 MERGE_PREV", () => {
  assert.ok(Core.DEFAULT_SYSTEM_PROMPT.includes("[MERGE_PREV]"));
  assert.ok(Core.DEFAULT_SYSTEM_PROMPT.includes("若当前英文以从属连接词开头"));
});

asyncTest("translateClipWithBoundaryRepair 遇到 MERGE_PREV 只合并重翻一次", async () => {
  const cues = [
    { start: 0, end: 1000, content: "let me reiterate that the cheapest kettle", tokens: [{ text: "let" }] },
    { start: 1000, end: 2200, content: "is faster at boiling water", tokens: [{ text: "is" }] },
  ];
  let calls = 0;
  const result = await Core.translateClipWithBoundaryRepair({
    cues, apiBaseUrl: "https://example.test", apiKey: "k", apiModel: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls === 1)
      ? "1. 我再强调一次，能买到的最便宜电热水壶，\n2. [MERGE_PREV]"
      : "1. 我再强调一次，能买到的最便宜电热水壶烧水也更快。" } }] }) }),
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.repaired, true);
  assert.deepStrictEqual(result.cues.map((c) => c.content), ["let me reiterate that the cheapest kettle is faster at boiling water"]);
  assert.deepStrictEqual(result.lines, ["我再强调一次，能买到的最便宜电热水壶烧水也更快。"]);
});

test("cleanSubtitleBody 清除中文标点和汉字间异常空格", () => {
  assert.deepStrictEqual(
    Core.parseAlignedSubtitleLines("1. 如果你是人类，那么你会经常想做的一件事， 就是烧水。\n2. 不重要。 总之，这很常见。\n3. 结果 可能会略有不同。", 3),
    ["如果你是人类，那么你会经常想做的一件事，就是烧水。", "不重要。总之，这很常见。", "结果可能会略有不同。"]
  );
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

test("makeCacheKey v0.5.6 隔离旧缓存与 fallback/semantic 分段", () => {
  const fallback = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "fallback", clipStartMs: 0 });
  const semantic = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0 });
  assert.ok(fallback.startsWith("dsc-v58|fallback|"), "双语严格单行与英文自然分屏必须隔离旧缓存");
  assert.notStrictEqual(fallback, semantic, "fallback 与 semantic cue 边界不得共用翻译缓存");
  const beforeRepair = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0, cueFingerprint: "0:1000:a~1000:2000:b" });
  const afterRepair = Core.makeCacheKey({ videoId: "v", trackCode: "en", targetLang: "zh-Hans", apiModel: "m", segmentationMode: "semantic", clipStartMs: 0, cueFingerprint: "0:2000:a b" });
  assert.notStrictEqual(beforeRepair, afterRepair, "边界回修前后的 cue 指纹不同，缓存 key 必须隔离");
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

test("exportConfig 导出含全部默认键且可 JSON.parse", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, { apiKey: "sk-secret", fontSize: 30 });
  const text = Core.exportConfig(cfg);
  const obj = JSON.parse(text);
  assert.strictEqual(obj.__dualsub, 1);
  assert.ok(obj.config && typeof obj.config === "object");
  // 导出应覆盖 DEFAULT_CONFIG 所有键
  Object.keys(Core.DEFAULT_CONFIG).forEach((k) => {
    assert.ok(k in obj.config, "导出应含键 " + k);
  });
  assert.strictEqual(obj.config.apiKey, "sk-secret");
  assert.strictEqual(obj.config.fontSize, 30);
});

test("export→import round-trip 配置等价", () => {
  const cfg = Object.assign({}, Core.DEFAULT_CONFIG, {
    apiBaseUrl: "https://gw/v1",
    apiKey: "sk-x",
    apiModel: "gpt-4o-mini",
    targetLang: "ja",
    fontSize: 26,
    transOnTop: false,
    showLoading: false,
  });
  const text = Core.exportConfig(cfg);
  const res = Core.importConfig(text);
  assert.ok(res.ok, "导入应成功");
  Object.keys(Core.DEFAULT_CONFIG).forEach((k) => {
    assert.strictEqual(res.config[k], cfg[k], "键 " + k + " round-trip 应等价");
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
console.log("\n[system prompt v0.5 cue 1:1 契约校验]");

test("DEFAULT_SYSTEM_PROMPT：完整语义单元 1:1（完整译文/标点/不切词）", () => {
  const filled = Core.buildSystemPrompt("zh-Hans");
  // semantic 契约：模型结合上下文，按完整语义单元编号 1:1 返回。
  // 规则1：绝不把中文词切成两半。
  assert.ok(/不把一个词语切成两半|绝不.*切成两半/.test(filled), "应含「不切词」规则");
  // 规则2：每个输入已经是完整语义单元，中文也必须完整自然，不得输出半句。
  assert.ok(/完整语义单元/.test(filled) && /完整、自然|完整自然/.test(filled), "应要求每条都是完整自然译文");
  assert.ok(!/源 cue 是半句|自然承接前后行/.test(filled), "不得继续鼓励半句中文承接");
  // 规则3：保留必要的中文标点，避免分句粘连。
  assert.ok(/标点/.test(filled) && /问号|感叹号|逗号|句号/.test(filled), "应含必要标点规则");
  // 规则4：只输出带编号的中文字幕行，不要英文或解释。
  assert.ok(/只输出.*中文.*行/.test(filled), "应要求只输出中文字幕行");
  assert.ok(/相同序号|编号|完全一致/.test(filled), "应要求编号 1:1");
  // 目标语言占位符：默认中文 prompt 无占位符（替换为 no-op），不应残留 {TARGET_LANG}。
  assert.ok(!/\{TARGET_LANG\}/.test(filled), "占位符应被全部替换（默认中文 prompt 无占位符）");
});

test("字幕清洗保留有意义标点并折叠重复尾部标点", () => {
  assert.deepStrictEqual(Core.parseSubtitleLines("1. 总之，我不知道。\n2. 真的？\n3. 好了。。。"), [
    "总之，我不知道。",
    "真的？",
    "好了。",
  ]);
  assert.deepStrictEqual(Core.parseSubtitleLines("1. 清洁、消毒， 以及其他事情。"), [
    "清洁、消毒，以及其他事情。",
  ]);
  assert.deepStrictEqual(Core.parseAlignedSubtitleLines("1. 总之，我不知道。\n2. 真的？", 2), [
    "总之，我不知道。",
    "真的？",
  ]);
});

test("自定义 systemPrompt 仍覆盖默认（现有逻辑不变）", () => {
  const custom = Core.buildSystemPrompt("ja", "MY CUSTOM {TARGET_LANG} PROMPT");
  assert.strictEqual(custom, "MY CUSTOM ja PROMPT", "非空自定义应覆盖默认并替换占位符");
});

/* ============ 5f. normalizeColor ============ */
console.log("\n[normalizeColor + DEFAULT_CONFIG]");

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

  await asyncTest("makeAdaptiveGate run 受 cap 约束：429 后在途峰值下降", async () => {
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
    assert.ok(load.indexOf('installCueTimeline(fallbackCues, "fallback")') >= 0, "应先安装 fallback 首屏时间轴");
    assert.ok(load.indexOf('installCueTimeline(fallbackCues, "fallback")') < load.indexOf("restoreSemanticCuesIfAvailable(cues)"), "语义恢复必须后台启动，不得 await 阻塞首屏");
    assert.ok(/timelineEpoch !== state\.timelineEpoch/.test(src), "旧分段异步请求不得写入新时间轴");
    assert.ok(/function resetForNewVideo\(\) \{\n    state\.timelineEpoch\+\+/.test(src), "切视频必须废止旧轨道异步请求");
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
    assert.ok(/segmentationMode: state\.segmentationMode/.test(src), "不同分段模式不得复用同一 clip 缓存");
    assert.ok(/function translatePreparedClip[\s\S]*translateClipWithBoundaryRepair/.test(src), "semantic 原子接管的预热翻译也必须走边界回修，不能绕过新契约");
    assert.ok(/cached\[key\]\.cues/.test(src) && /writeCache\(key, \{ lines: lines, cues: clip\.cues \}\)/.test(src), "边界回修后的 cue 必须随译文缓存，不能下次再按旧边界错配");
    assert.ok(!/if \(translationResult && translationResult\.repaired\)[\s\S]{0,160}key = clipCacheKey\(clip\)/.test(src), "回修结果必须写在本次输入 key 下；若改写为输出 key，下一次仍以原 cue 查询将永远无法命中");
    const cacheKeyBody = src.slice(src.indexOf("function clipCacheKey"), src.indexOf("function semanticUnitsFromTrack"));
    assert.ok(/cueFingerprint/.test(cacheKeyBody), "clip 缓存键必须包含当前 cue 边界与文本指纹；边界回修前后不得碰撞");
    assert.ok(/"dsc-v58"/.test(fs.readFileSync(path.join(ROOT, "core.js"), "utf8")), "双语严格单行与英文自然分屏必须升级缓存 namespace");
    const prefetch = src.slice(src.indexOf("function prefetchAround"), src.indexOf("function getBackoff"));
    assert.ok(/state\.segmentationMode !== "semantic"/.test(prefetch), "fallback 只显原文，不得翻译技术 cue 产生碎中文");
    const render = src.slice(src.indexOf("function onRenderTick"), src.indexOf("function setRendererText"));
    assert.ok(/state\.segmentationMode === "semantic" \? Core\.clipDisplayFlags/.test(render), "fallback 中文层必须为空，不得显示翻译中");
  });

  test("isolated.js 只在可靠 JSON3 token 时序下启用语义恢复，失败完整回退", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    assert.ok(/Core\.hasNativeTokenTiming\(cues, 0\.8\)/.test(src), "应有 80% 原生 token timing 门槛");
    assert.ok(/Core\.restoreAndPackTokens\b/.test(src), "加载路径应调用生产语义恢复器");
    assert.ok(/var fallbackCues = Core\.resegmentCues\(cues, \{ tailTrimMs: config\.tailTrimMs \}\)/.test(src), "不满足契约时应完整回退 ASR 重组");
    assert.ok(/installCueTimeline\(fallbackCues, "fallback"\)/.test(src), "fallback 必须先安装可播放时间轴");
    assert.ok(/stageSemanticTimeline\(Core\.applyTailTrim\(semanticCues, config\.tailTrimMs\), loadEpoch\)/.test(src), "启用路径应先预热当前 semantic clip");
    assert.ok(/for \(var attempt = 0; attempt < 3; attempt\+\+\)/.test(src), "semantic 预热应有界重验播放头");
    assert.ok(/var installIdx = clipIdxAtIn\(clips, currentTimeMs\(\)\)/.test(src), "翻译 await 后必须重验当前 clip");
    assert.ok(/return installCueTimeline\(installedCues, "semantic", \{ clips: clips, seeds: seeds \}\)/.test(src), "只有当前段已有 seed 且回修 cue 已汇总的 semantic 候选才能原子接管屏幕");
    const install = src.slice(src.indexOf("function installCueTimeline"), src.indexOf("/* =====================================================\n   * 翻译编排"));
    assert.ok(install.indexOf("state.clipUnits[seedIdx]") < install.indexOf("rebuildRenderTimeline();"), "semantic seeds 必须在首帧重建前写入，禁止闪回翻译中");
    assert.ok(/if \(ms < clips\[i\]\.startMs\) return i/.test(src), "播放头在 gap 时应预热下一段而不是末段");
    assert.ok(/installCueTimeline\(fallbackCues, "fallback"\)/.test(src), "回退路径应安装可诊断 fallback 模式");
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

  await asyncTest("translateClipLines→buildClipUnits 端到端（mock）：cue/译文/时间轴 1:1", async () => {
    const clip = {
      startMs: 10000,
      endMs: 25000,
      cues: [
        { start: 10000, end: 13000, content: "so today we are going to" },
        { start: 13000, end: 17000, content: "take a close look at how" },
        { start: 17000, end: 21000, content: "transformers actually work" },
        { start: 21000, end: 25000, content: "under the hood step by step" },
      ],
    };
    const MODEL_LINES = ["今天我们要来", "仔细看看变换器", "实际上如何工作", "以及底层实现步骤"];
    const MODEL_RESPONSE = MODEL_LINES.map((line, i) => `${i + 1}. ${line}`).join("\n");
    let sysSeen = "";
    let userSeen = "";
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      sysSeen = body.messages[0].content;
      userSeen = body.messages[1].content;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: MODEL_RESPONSE } }] }),
        text: async () => "",
      };
    };
    const lines = await Core.translateClipLines({
      cues: clip.cues,
      apiBaseUrl: "http://mock/v1",
      apiKey: "k",
      apiModel: "m",
      targetLang: "zh-Hans",
      reasoningEffort: "low",
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });
    assert.ok(/相同序号|完全一致/.test(sysSeen), "system 应要求 cue 1:1 对齐");
    assert.ok(/^1\. so today/m.test(userSeen), "user 应含带序号的原文行");
    assert.deepStrictEqual(lines, MODEL_LINES, "应按编号返回 1:1 中文字幕");

    const units = Core.buildClipUnits(lines, clip.startMs, clip.endMs, clip.cues);
    assert.strictEqual(units.length, clip.cues.length, "渲染单元数应等于 cue 数");
    for (let i = 0; i < units.length; i++) {
      assert.strictEqual(units[i].startMs, clip.cues[i].start, "单元应沿用对应 cue 起点");
      assert.strictEqual(units[i].endMs, clip.cues[i].end, "单元应沿用对应 cue 终点");
      assert.strictEqual(units[i].originalText, clip.cues[i].content, "单元应沿用对应 cue 原文");
      assert.strictEqual(units[i].translation, MODEL_LINES[i], "单元应沿用对应编号译文");
    }
  });

  await asyncTest("translateClipLines 模型空响应 → 返回空数组（isolated 侧回退显原文）", async () => {
    // 契约：模型吐空/纯空白 → parseSubtitleLines 得空数组 → isolated.js applyClipLines 走空分支
    // （error+退避，渲染层回退显原文）。这里只验证 core 侧返回空数组。
    const emptyFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "   \n  \n" } }] }),
      text: async () => "",
    });
    const lines = await Core.translateClipLines({
      cues: [{ start: 0, end: 2000, content: "hello" }],
      apiBaseUrl: "http://mock/v1", apiKey: "k", apiModel: "m",
      timeoutMs: 5000, fetchImpl: emptyFetch,
    });
    assert.deepStrictEqual(lines, [], "空/空白响应应清洗为空数组");
    // buildClipUnits 对空行数组返回空（isolated 侧据此回退显原文，不产出空译文单元）
    assert.deepStrictEqual(Core.buildClipUnits(lines, 0, 2000, [{ start: 0, end: 2000, content: "hello" }]), []);
  });

  await asyncTest("translateClipLines 无编号超长译文仍保持单行", async () => {
    const overlong = "这是第一部分不过这是第二部分因为这是第三部分所以这是第四部分而且还有第五部分";
    const lines = await Core.translateClipLines({
      cues: [{ start: 0, end: 5000, content: "one complete semantic unit" }],
      apiBaseUrl: "http://mock/v1", apiModel: "m", maxLineChars: 16, timeoutMs: 5000,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: overlong } }] }), text: async () => "" }),
    });
    assert.deepStrictEqual(lines, [overlong]);
    assert.ok(!lines[0].includes("\n"), "中文不得在语义单元内部换行");
  });

  await asyncTest("translateClipLines 数量不足时拒绝部分结果，交运行层整包重试", async () => {
    await assert.rejects(
      Core.translateClipLines({
        cues: [{ content: "first" }, { content: "second" }],
        apiBaseUrl: "https://example.test/v1", apiKey: "k", apiModel: "m", targetLang: "zh-Hans",
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "只有一条" } }] }) }),
      }),
      /incomplete translation.*0\/2/,
    );
  });

  await asyncTest("translateClipLines 编号缺槽时拒绝部分结果，绝不缓存空译文", async () => {
    await assert.rejects(
      Core.translateClipLines({
        cues: [{ content: "first" }, { content: "second" }, { content: "third" }],
        apiBaseUrl: "https://example.test/v1", apiKey: "k", apiModel: "m", targetLang: "zh-Hans",
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "1. 第一条\n3. 第三条" } }] }) }),
      }),
      /incomplete translation.*2\/3/,
    );
  });

  /* ============ 6e. v0.4.1 打磨：原文对齐空行 / 半截短语 / 首包默认 ============
   * 验收里发现：译文行多于 cue 时，旧「cue 中点落槽」会在时隙空白处留下空 originalText
   * （双语对照约 1/3 行无英文）。这里锁死：只要该时隙与任一 cue 时间重叠，就有原文。
   */
  console.log("\n[v0.4.1 打磨：原文对齐 + 半截短语 + 默认 clip]");

  test("joinLine：句号后拼接英文要有空格", () => {
    assert.strictEqual(Core.joinLine("water.", "We do it"), "water. We do it");
    assert.strictEqual(Core.joinLine("hello", "world"), "hello world");
    assert.strictEqual(Core.joinLine("你好", "世界"), "你好世界");
  });

  test("splitOriginalByPunct：按句读标点切段并保留标点", () => {
    assert.strictEqual(typeof Core.splitOriginalByPunct, "function");
    assert.deepStrictEqual(
      Core.splitOriginalByPunct("Hello world. We boil water, for tea! OK?"),
      ["Hello world.", "We boil water, for tea!", "OK?"]
    );
    // 无标点整段保留
    assert.deepStrictEqual(Core.splitOriginalByPunct("no punctuation here"), ["no punctuation here"]);
    // 空/空白
    assert.deepStrictEqual(Core.splitOriginalByPunct("  "), []);
    assert.deepStrictEqual(Core.splitOriginalByPunct(""), []);
    // 不在小数点处切
    assert.deepStrictEqual(Core.splitOriginalByPunct("Use 120.5 volts now."), ["Use 120.5 volts now."]);
    // 词边界硬切不应留下 "water." 这种 ≤12 字孤儿尾巴
    const longish =
      "If you are a human person, one of those things you are going to want to do is boil water.";
    const parts = Core.splitOriginalByPunct(longish);
    assert.ok(parts.every((p) => !/^water\.?$/i.test(p.trim())), "不应单独拆出 water.: " + JSON.stringify(parts));
    assert.ok(parts.some((p) => /boil water/i.test(p)), "boil water 应同段: " + JSON.stringify(parts));
  });

  test("buildClipUnits：长英文 cue 覆盖多行中文时按标点拆分分配，不全文重复", () => {
    const cues = [
      {
        start: 0,
        end: 12000,
        content:
          "If you're a human person, one of those things you're going to want to do is boil water. We do it for lots of reasons from cooking to cleaning.",
      },
    ];
    const lines = ["如果你是人类", "你会经常做的一件事", "就是烧水", "我们这么做有很多原因", "从做饭到清洁"];
    const units = Core.buildClipUnits(lines, 0, 12000, cues);
    assert.strictEqual(units.length, 5);
    // 每行都应有原文
    units.forEach((u, i) => {
      assert.ok(String(u.originalText || "").trim(), "行 " + i + " 原文不应空");
    });
    // 不应五行都是同一长句全文
    const uniq = new Set(units.map((u) => u.originalText.trim()));
    assert.ok(uniq.size >= 2, "长英文应按标点拆到多行，不应全文复制: " + JSON.stringify([...uniq]));
    // 单行原文不应接近整段长度（允许略长，但不该每行都是全文）
    const fullLen = cues[0].content.length;
    const allFull = units.every((u) => u.originalText.replace(/\s+/g, " ").trim().length >= fullLen - 5);
    assert.ok(!allFull, "不能每行都挂接近全文的英文");
    // 拼接后应覆盖主要信息（boil / cooking 等关键词还在）
    const joined = units.map((u) => u.originalText).join(" ");
    assert.ok(/boil/i.test(joined), "应保留 boil");
    assert.ok(/cooking|cleaning/i.test(joined), "应保留 cooking/cleaning");
  });

  test("buildClipUnits：译文行多于 cue 时，重叠时隙不得空 originalText", () => {
    // 复现验收空原文：布局在 cue 间隙开出时隙，中点分配会漏行。
    const cues = [
      { start: 160, end: 3636, content: "If you're a human person, one of those things you're going to want to do with" },
      { start: 4160, end: 5183, content: "some regularity is boil water. We do it for lots of reasons," },
      { start: 7211, end: 8091, content: "from cooking to" },
      { start: 10000, end: 13697, content: "cleaning and disinfecting to other things probably .And one of those other" },
      { start: 14559, end: 15297, content: "things is preparing" },
    ];
    const lines = [
      "如果你是人类",
      "你会经常做的一件事",
      "就是烧水我们这么做有很多原因",
      "从做饭到清洁、消毒",
      "还有其他用途",
      "热饮，比如茶",
    ];
    const units = Core.buildClipUnits(lines, 160, 15297, cues);
    assert.strictEqual(units.length, lines.length, "一行一单元");
    const empty = units.filter((u) => !String(u.originalText || "").trim());
    assert.strictEqual(
      empty.length,
      0,
      "有时间重叠的译文行不应空原文；空行=" + JSON.stringify(empty.map((u) => u.translation))
    );
    // 长 cue 跨多时隙时，被覆盖的时隙都应带上该 cue 文本（可重复，双语显示优先不留白）
    const allOrig = units.map((u) => u.originalText).join(" | ");
    assert.ok(/cleaning and disinfecting/.test(allOrig), "长 cue 应按重叠落入相关时隙");
    assert.ok(/from cooking to/.test(allOrig), "短 cue 仍应保留");
  });

  test("buildClipUnits：完全无重叠的时隙用最近邻原文回填，仍不切词", () => {
    // 极端：中间时隙落在 cue 间隙（无任何时间重叠）→ 仍应用最近非空原文回填
    const cues = [
      { start: 0, end: 1000, content: "hello there" },
      { start: 9000, end: 10000, content: "goodbye now" },
    ];
    const lines = ["你好啊", "中间这行", "再见啦"];
    const units = Core.buildClipUnits(lines, 0, 10000, cues);
    assert.strictEqual(units.length, 3);
    units.forEach((u, i) => {
      assert.ok(String(u.originalText || "").trim(), "单元 " + i + " 原文不应为空");
    });
  });

  test("mergeDanglingLines：半截连接尾（的/和/与）整行并入下一行", () => {
    assert.strictEqual(typeof Core.mergeDanglingLines, "function", "应导出 mergeDanglingLines");
    const src = ["所以专门烧水的", "东西叫水壶", "我先从一些测试和", "演示开始", "这根本不是真的"];
    const out = Core.mergeDanglingLines(src);
    assert.deepStrictEqual(out, ["所以专门烧水的东西叫水壶", "我先从一些测试和演示开始", "这根本不是真的"]);
  });

  test("mergeDanglingLines：空/单行/无半截原样返回", () => {
    assert.deepStrictEqual(Core.mergeDanglingLines([]), []);
    assert.deepStrictEqual(Core.mergeDanglingLines(["完整一行"]), ["完整一行"]);
    assert.deepStrictEqual(Core.mergeDanglingLines(["你会经常做的一件事", "就是烧水"]), [
      "你会经常做的一件事",
      "就是烧水",
    ]);
  });

  await asyncTest("translateClipLines v0.5：1:1 对齐不跨 cue 合并", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "1. 所以专门烧水的\n2. 东西叫水壶\n3. 我先从一些测试和\n4. 演示开始" } }],
      }),
      text: async () => "",
    });
    const lines = await Core.translateClipLines({
      cues: [
        { start: 0, end: 2000, content: "so the thing made for boiling water" },
        { start: 2000, end: 4000, content: "is called a kettle" },
        { start: 4000, end: 6000, content: "I'll start with some testing and" },
        { start: 6000, end: 8000, content: "demonstration" },
      ],
      apiBaseUrl: "http://mock/v1",
      apiKey: "k",
      apiModel: "m",
      maxLineChars: 20,
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });
    assert.deepStrictEqual(lines, ["所以专门烧水的", "东西叫水壶", "我先从一些测试和", "演示开始"]);
  });

  test("translateClipLines v0.5：超长 cue 的中文仍严格单行", async () => {
    const lines = await Core.translateClipLines({
      cues: [{ content: "is boil water we do it for lots of reasons" }, { content: "such as tea maybe cooking" }],
      apiBaseUrl: "https://example.invalid/v1",
      apiKey: "k",
      apiModel: "m",
      targetLang: "zh-Hans",
      maxLineChars: 12,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "1. 就是烧水我们烧水有很多原因\n2. 比如泡茶也许你会把这归到烹饪里" } }] }),
      }),
    });
    assert.strictEqual(lines.length, 2, "仍保持 cue 1:1");
    assert.strictEqual(lines[0], "就是烧水我们烧水有很多原因", "首 cue 中文必须保持单行");
    assert.strictEqual(lines[1], "比如泡茶也许你会把这归到烹饪里", "次 cue 中文必须保持单行");
  });

  test("splitLongLines：超长粘句只在短语边界拆，绝不切词", () => {
    assert.strictEqual(typeof Core.splitLongLines, "function");
    // 超过每行上限时，才在安全短语边界断行。
    assert.deepStrictEqual(
      Core.splitLongLines(["就是烧水我们烧水有很多原因"], 10),
      ["就是烧水", "我们烧水有很多原因"]
    );
    // 未超过 16 字时保持完整一行，不为话语标记制造短碎片。
    assert.deepStrictEqual(
      Core.splitLongLines(["比如泡茶也许你会把这归到烹饪里"], 16),
      ["比如泡茶也许你会把这归到烹饪里"]
    );
    // 短行不动
    assert.deepStrictEqual(Core.splitLongLines(["如果你是人类"], 16), ["如果你是人类"]);
    // 无安全边界 → 不动（宁可不切词）
    assert.deepStrictEqual(
      Core.splitLongLines(["这根本不是真的电热水壶"], 10),
      ["这根本不是真的电热水壶"]
    );
    // max<=0 关闭
    assert.deepStrictEqual(Core.splitLongLines(["就是烧水我们烧水有很多原因"], 0), ["就是烧水我们烧水有很多原因"]);
  });

  test("splitLongLines：以至于半截与下一行在 mergeDangling 后可读", () => {
    // 先 split 再 dangling 的链路由 translateClipLines 保证；这里单测 split 本身
    const lines = Core.splitLongLines([
      "是如此普遍的做法以至于专门用来烧水的器具叫做水壶",
    ], 16);
    assert.ok(lines.length >= 2, "应拆成多行");
    assert.ok(lines.every((ln) => !/[\u4e00-\u9fff]{1}$/.test("") ), "sanity");
    // 不应出现单字碎片
    assert.ok(lines.every((ln) => Core.charLen(ln) >= 2));
  });

  test("sanitizeSubtitleLine：去掉非中文目标杂质（拉丁串/异常脚本）但保留数字与常用标点", () => {
    assert.strictEqual(typeof Core.sanitizeSubtitleLine, "function");
    assert.strictEqual(Core.sanitizeSubtitleLine("这里少得多ഒരു"), "这里少得多");
    assert.strictEqual(Core.sanitizeSubtitleLine("把水烧开对，这是个 SodaStream 瓶子"), "把水烧开对，这是个瓶子");
    assert.strictEqual(Core.sanitizeSubtitleLine("功率是 8.8 千瓦"), "功率是 8.8 千瓦");
    assert.strictEqual(Core.sanitizeSubtitleLine("  hello  "), "");
  });

  test("DEFAULT_SYSTEM_PROMPT 强调上下文 1:1 与双语单行", () => {
    const p = Core.DEFAULT_SYSTEM_PROMPT;
    assert.ok(/绝不/.test(p) && /(中文词|切成两半)/.test(p), "仍强调不切词");
    assert.ok(/简洁|适合字幕/.test(p), "应要求字幕表达简洁可读");
    assert.ok(/半句|语法续接/.test(p) && /补入|没有的意思/.test(p), "半句应自然承接且不得擅自补意");
    assert.ok(/严格保持单行/.test(p) && /不得.*换行/.test(p), "中文 cue 必须严格单行");
    assert.ok(/标点/.test(p) && /粘连/.test(p), "应保留必要标点避免分句粘连");
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

  console.log("\n[v0.5 源 cue 1:1 对齐]");
  test("parseAlignedSubtitleLines：按编号落槽，缺行留空", () => {
    const slots = Core.parseAlignedSubtitleLines("1. 你好世界\n3. 第三行", 3);
    assert.strictEqual(slots.length, 3);
    assert.strictEqual(slots[0], "你好世界");
    assert.strictEqual(slots[1], "");
    assert.strictEqual(slots[2], "第三行");
  });
  test("parseAlignedSubtitleLines：无编号但行数对齐时顺序落槽", () => {
    assert.deepStrictEqual(Core.parseAlignedSubtitleLines("甲行\n乙行", 2), ["甲行", "乙行"]);
  });
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
  test("简体中文完整短句未超过 16 字时绝不为凑行长拆分", () => {
    // Netflix 简体中文规范：通常保持一行；达到每行 16 字限制后才考虑换行。
    // 这句含“不过”，旧的 glueMin/目标 8 字规则会错误拆成约 6+6 的碎片。
    const line = "我先重申一下不过我们再说";
    assert.strictEqual(Core.charLen(line), 12);
    assert.deepStrictEqual(Core.splitLongLines([line], 16, 4), [line]);
  });

  test("双语对照的每种语言都严格保留一行", () => {
    const source = "这是第一部分不过这是第二部分因为这是第三部分所以这是第四部分";
    assert.strictEqual(Core.shapeAlignedLine(source, 16), source, "中文不得在单元内部插入换行");
    assert.strictEqual(Core.shapeAlignedLine("甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲", 16), "甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲", "超长但完整的中文仍保留单行");
  });
  test("DEFAULT_CONFIG 行长接近正常字幕 + 首包等待", () => {
    assert.ok(Core.DEFAULT_CONFIG.minLineChars >= 10);
    assert.strictEqual(Core.DEFAULT_CONFIG.maxLineChars, 0, "双语对照模式不得在中文 cue 内插入换行");
    assert.strictEqual(Core.DEFAULT_CONFIG.waitForFirstTranslation, true);
    assert.ok(Core.DEFAULT_CONFIG.waitForFirstTranslationMs >= 1000 && Core.DEFAULT_CONFIG.waitForFirstTranslationMs <= 15000);
  });
  await asyncTest("translateClipLines v0.5：mock 编号输出保持 1:1", async () => {
    const cues = [
      { start: 0, end: 2000, content: "Hello world." },
      { start: 2000, end: 4000, content: "We boil water." },
    ];
    const lines = await Core.translateClipLines({
      cues, apiBaseUrl: "https://example.test/v1", apiKey: "k", apiModel: "m", targetLang: "zh-Hans",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "1. 你好世界\n2. 我们烧水" } }] }) }),
    });
    assert.strictEqual(lines.length, 2);
    assert.ok(/你好/.test(lines[0]));
    assert.ok(/烧水/.test(lines[1]));
    const units = Core.buildClipUnits(lines, 0, 4000, cues);
    assert.strictEqual(units[0].originalText, "Hello world.");
    assert.strictEqual(units[1].originalText, "We boil water.");
  });

  /* ============ 7. 交付物校验 ============ */
  console.log("\n[交付物校验]");

  test("manifest.json 能 JSON.parse 且字段完整", () => {
    const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
    const m = JSON.parse(raw);
    assert.strictEqual(m.manifest_version, 3);
    assert.strictEqual(m.version, "0.5.6", "发布包版本必须递增，不能覆盖 v0.5.5");
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

  console.log("\n========================================");
  console.log("  通过: " + passed + "  失败: " + failed);
  console.log("========================================");
  if (failed > 0) process.exit(1);
}

main();
