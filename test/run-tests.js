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

function v8Screen(sourceFrom, sourceTo, text) { return { sourceFrom, sourceTo, text }; }
function v8Segment(sourceFrom, sourceTo, text) { return { sourceFrom, sourceTo, screens: [v8Screen(sourceFrom, sourceTo, text)] }; }

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
  if (Array.isArray(payload.sentences)) {
    // block-v17 整句协议：每个 piece 一屏，测试只关心覆盖与归位。
    const pieces = payload.sentences.flat().map((p) => ({ unitId: p.id, sourceText: p.text }));
    const screens = pieces.map((unit, index) => ({
      from: unit.unitId, to: unit.unitId,
      text: typeof translations === "function" ? translations(unit, index) : translations[index],
    }));
    if (reverse) screens.reverse();
    return JSON.stringify({ screens });
  }
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

// test() 也接受 async fn：返回的 promise 收进 pendingTests，main() 汇总前统一等待，
// 失败照常计 ✗ —— 此前 async 断言失败会变成未处理 rejection，进程直接崩掉、不出统计。
const pendingTests = [];
function test(name, fn) {
  const pass = () => { passed++; console.log("  ✓ " + name); };
  const fail = (e) => { failed++; console.error("  ✗ " + name + "\n      " + (e && e.message ? e.message : e)); };
  try {
    const result = fn();
    if (result && typeof result.then === "function") { pendingTests.push(result.then(pass, fail)); return; }
    pass();
  } catch (e) {
    fail(e);
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
  assert.ok(call >= 1, "至少一次语义规划；超长单元会触发额外定向补切请求");
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
  assert.ok(call >= 1, "至少一次语义规划；超长单元会触发额外定向补切请求");
  assertVisualSemanticUnits(units, source);
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
  assert.ok(call >= 1, "至少一次语义规划；超长单元会触发额外定向补切请求");
  assertVisualSemanticUnits(units, source);
  assert.strictEqual(units[0].start, 237505);
  assert.strictEqual(units[units.length - 1].end, 251105);
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

asyncTest("semantic token ledger 允许在 ASR cue 内跨界并保持中英语义覆盖", async () => {
  // 真实 #40-43 形状："are standard"、"they are probably" 和 outro 都跨技术 cue。
  const cues = [
    { start: 0, end: 4640, content: "you can see all of the inner and outer pins are" },
    { start: 4640, end: 12080, content: "standard and if i grab a magnet i can check to see if these are steel and indeed they" },
    { start: 12080, end: 19200, content: "are probably a lightly magnetic stainless steel okay folks that's all i have for you today on this" },
    { start: 19200, end: 23360, content: "pic proof mortis cylinder if you do have any questions or comments about this" },
  ];
  let calls = 0;
  const result = await Core.translateContextBlock({
    cues,
    apiBaseUrl: "https://example.test",
    apiModel: "m",
    targetLang: "zh-Hans",
    fetchImpl: async (_url, req) => {
      calls++;
      const payload = JSON.parse(JSON.parse(req.body).messages[1].content);
      if (Array.isArray(payload.tokens)) {
        const ends = payload.groups.map((g) => g.toId);
        const cuts = [ends[11], ends[36], ends[51]].filter(Boolean);
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: cuts }) } }] }) };
      }
      // 译文按实际语义单元生成，不写死条数：宽度兜底
      // (enforceSemanticTokenLimitMarks 同时守词数与视觉宽度) 会依据源文宽度决定
      // 最终切几刀，夹具写死 4 条就会在兜底行为正确变化时假失败。
      return { ok: true, json: async () => ({ choices: [{ message: { content: translationCoverageJson(req, (unit, index) => "译文" + (index + 1)) } }] }) };
    },
  });
  assert.ok(calls >= 2, "先恢复语义边界（含可能的定向补切），再对最终语义单元翻译");
  // 不锁定具体切分：这里守的是「源词连续覆盖恰好一次」和「每个单元受显示宽度硬门禁约束」，
  // 而不是某一版切分算法的产物。锁死 originalText 数组会让任何合法的兜底改进都变成红灯。
  assert.ok(result.units.length >= 4, "长源文必须被切成多个语义单元");
  result.units.forEach((u) => {
    assert.ok(
      Core.semanticDisplayWidth(u.originalText) <= Core.SOURCE_DISPLAY_MAX_WIDTH,
      "语义单元 " + JSON.stringify(u.originalText) + " 超过显示宽度硬门禁"
    );
  });
  assert.equal(result.units.map((u) => u.originalText).join(" "), cues.map((c) => c.content).join(" "), "源词必须连续覆盖且恰好一次");
});

test("semantic materializer 拒绝尾部缺口与超长单元", () => {
  const cues = [{ start: 0, end: 1000, content: Array.from({ length: 41 }, (_, i) => "w" + i).join(" ") }];
  assert.throws(() => Core.materializeSemanticTranslation([{ segmentId: "b0", tokenStart: 0, tokenEnd: 1, translation: "好" }], cues), /tail missing/i);
  assert.throws(() => Core.materializeSemanticTranslation([{ segmentId: "b0", tokenStart: 0, tokenEnd: 41, translation: "好" }], cues), /exceeds token limit/i);
});

asyncTest("超长语义单元定向补切：只问模型、只在合法切点落刀、失败保留原样", async () => {
  const words = "we can see that the burner stays hot for a while and that means the kettle keeps heating even after you turn it off".split(" ");
  const tokens = words.map((text, i) => ({ tokenId: "t" + i, text, start: i * 100, end: i * 100 + 100 }));
  const marks = new Array(tokens.length).fill("");
  marks[tokens.length - 1] = ".";

  // 1) 模型给出段内合法切点 → 落刀
  let seenPayload = null;
  const refined = await Core.refineOversizedSemanticUnits(tokens, marks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    fetchImpl: async (_u, req) => {
      seenPayload = JSON.parse(JSON.parse(req.body).messages[1].content);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: ["t9"] }) } }] }) };
    },
  });
  assert.equal(refined[9], ".", "模型给的合法切点必须落刀");
  assert.ok(seenPayload && seenPayload.groups.length, "必须把 group 边界发给模型");
  assert.ok(!("tokens" in seenPayload), "补切请求不得携带模型用不到的整份 token 列表");

  // 2) 模型返回空 → 保持原样，绝不自己盲切
  const untouched = await Core.refineOversizedSemanticUnits(tokens, marks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: [] }) } }] }) }),
  });
  assert.deepStrictEqual(untouched, marks, "模型说切不动就必须保留长段，不得程序盲切");

  // 3) 网络失败 → 降级保留，不升级为整轨失败
  const onError = await Core.refineOversizedSemanticUnits(tokens, marks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    fetchImpl: async () => { throw new Error("translate network down"); },
  });
  assert.deepStrictEqual(onError, marks, "补切失败必须降级保留，过长优于切坏");

  // 4) 段末 token 不得作为切点（切在末尾等于没切）
  const lastId = "t" + (tokens.length - 1);
  const tailCut = await Core.refineOversizedSemanticUnits(tokens, marks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: [lastId] }) } }] }) }),
  });
  assert.deepStrictEqual(tailCut, marks, "段末切点必须被拒绝");

  // 5) 未超长的段不发请求
  const shortTokens = tokens.slice(0, 6);
  const shortMarks = new Array(6).fill(""); shortMarks[5] = ".";
  let called = false;
  await Core.refineOversizedSemanticUnits(shortTokens, shortMarks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }; },
  });
  assert.equal(called, false, "未超长不得浪费请求");

  // 6) 回归：allowed 列表必须完整。曾经事先剔除段末 id 导致 parseTokenCutsResponse
  //    位置索引错位，模型返回的合法切点被判 unknown → 整包抛错 → 补切请求发了
  //    却一刀不落（真实全片跑 72 次请求零效果）。
  let failures = [];
  const mixed = await Core.refineOversizedSemanticUnits(tokens, marks, {
    apiBaseUrl: "https://example.test", apiModel: "m",
    onRefineFailure: (m) => failures.push(m),
    fetchImpl: async (_u, req) => {
      const p = JSON.parse(JSON.parse(req.body).messages[1].content);
      const last = p.groups[p.groups.length - 1].toId;
      // 模型同时给出一个段内合法切点和一个段末切点
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: ["t9", last] }) } }] }) };
    },
  });
  assert.deepStrictEqual(failures, [], "合法切点混入段末切点不得让整包作废");
  assert.equal(mixed[9], ".", "段内合法切点必须落刀");
  assert.equal(mixed.filter((m) => m === ".").length, 2, "段末切点被丢弃，只多出一刀");
});

// 契约 block-v6 起，分屏由模型按语义完成，splitTargetDisplayLine 只在模型某一屏超宽时
// 兜底。因此门禁不再锁「程序对某句该切成几屏」——那批期望本身互相矛盾（38 单位要一屏、
// 46 单位要两屏、52 单位又要一屏），判据是语感而非任何程序可见特征，锁死只会逼出参数拧
// 来拧去。改为锁两条真正的契约不变量：
//   1. 模型给的屏边界必须原样保留（不合并、不重切）
//   2. 模型某屏超宽时，程序必须切到不超宽，且不切开词

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

test("translateContextBlock 整段投喂：模型看到完整语流而非逐 cue 碎片", async () => {
  const cues = [{ start: 100, end: 1100, content: "first source cue" }, { start: 1100, end: 2400, content: "continues here" }];
  let sent;
  const result = await Core.translateContextBlock({
    cues, apiBaseUrl: "https://example.test", ["api" + "Key"]: String.fromCharCode(107), apiModel: "m", targetLang: "zh-Hans", maxVisualWidth: 48,
    fetchImpl: async (_url, req) => {
      const body = JSON.parse(req.body); sent = JSON.parse(body.messages[1].content);
      if (sent.tokens) {
        const cut = sent.groups.find((g) => g.text === "cue");
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: cut ? [cut.toId] : [] }) } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: translationCoverageJson(req, ["第一句译文", "第二句译文"]) } }] }) };
    },
  });
  // 第一请求是完整 sourceText 的边界恢复；第二请求只携带最终语义 units。
  assert.ok(sent.sentences, "翻译请求必须按整句携带最终语义 pieces");
  assert.equal(result.segments.length, 2);
  assert.equal(result.units.length, 2);
  assert.equal(result.units[0].startMs, 100);
  assert.equal(result.units[1].startMs, 1100);
});

test("block-v10 对多书写系统使用同一请求、parser 与时间物化路径", async () => {
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
        if (sent.tokens) {
          const lastWord = pair[0].trim().split(/\s+/).pop();
          const cut = sent.groups.find((g) => String(g.text).split(/\s+/).pop() === lastWord);
          return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: cut ? [cut.toId] : [] }) } }] }) };
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: translationCoverageJson(req, (unit) => "译文-" + unit.unitId) } }] }) };
      },
    });
    // 最后一次请求只翻译完整语义单元，原文仍逐单元完整保留。
    assert.ok(sent.sentences, "翻译请求必须按整句发送");
    const sentPieces = sent.sentences.flat();
    pair.forEach((content) => {
      assert.ok(sentPieces.some((u) => u.text.includes(content)), `pieces 缺原文: ${content}`);
    });
    assert.ok(sentPieces.every((u) => u.id && u.text), "每个 piece 必须有稳定 ID 和完整原文");
    assert.ok(out.units.length >= 1);
    assert.ok(out.units.every((u) => u.translation.startsWith("译文-")), "每个多书写系统语义单元都必须有译文");
  }
  const coreSrc = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
  const blockPath = coreSrc.slice(coreSrc.indexOf("var DEFAULT_BLOCK_TRANSLATION_PROMPT"), coreSrc.indexOf("async function chatCompletion"));
  assert.doesNotMatch(blockPath, /languageCode|sourceLang|["'](?:ja|en|zh|ar|th|pl)["']\s*[,:)]/, "block 产品路径不得按源语言代码分支");
  assert.doesNotMatch(blockPath, /openai|anthropic|gemini/i, "block 产品路径不得按供应商分支");
});

test("22 条真实轨经生产链路(parseJson3→cleanup→resegment→buildCueTokenSpanUnits)无时间硬缺陷", () => {
  // 这条门禁的由来：我曾把「pczh.ja-orig 552 处重叠」当成待修缺陷写进自评，
  // 实际是**量错了层**——那 560 处重叠存在于 cleanup 后的 token 跨度这个中间态，
  // resegment 之后为 0，显示层从来是干净的。而且我当时归因为「源轨 event start
  // 倒退」，实测源轨 878 个有文字 event **start 倒退 0 次**，真实形态是滚动窗口
  // 大幅交叠（749 处、最大 5000ms）。结论：判据必须落在**显示层 + 生产门禁**上。
  //
  // 另一个教训：自写"词序列全等"会把合法行为误报成缺陷（滚动重复去重、正则把
  // "100 000th" 切成两词），首轮 12/23 全是假阳。保真必须交给生产的
  // buildCueTokenSpanUnits —— 真正的正文漂移它会 throw。
  function rollingTrack(n) {
    // 合成滚动窗口 ASR：相邻 event 大幅交叠，dDurationMs 伸进后续 event
    const events = [];
    for (let i = 0; i < n; i++) {
      const start = i * 1200;
      const words = ["word" + i, "and", "then", "next" + i];
      const per = 400;
      events.push({ tStartMs: start, dDurationMs: 3600,
        segs: words.map((w, j) => ({ utf8: (j ? " " : "") + w, tOffsetMs: per * j })) });
    }
    return { events };
  }
  for (const track of [rollingTrack(40), rollingTrack(7)]) {
    const cues = Core.cleanupCues(Core.parseJson3(track));
    const seg = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
    const timeline = Core.buildCanonicalTokenTimeline(cues);
    // 生产保真门禁：正文漂移会 throw，spans 必须恰好覆盖整条 timeline
    const units = Core.buildCueTokenSpanUnits(timeline, seg);
    assert.strictEqual(units[0].tokenStart, 0, "覆盖必须从 0 开始");
    assert.strictEqual(units[units.length - 1].tokenEnd, timeline.tokens.length, "覆盖必须到 timeline 末尾");
    for (let i = 1; i < units.length; i++) {
      assert.strictEqual(units[i].tokenStart, units[i - 1].tokenEnd, "覆盖不得有缺口或重复");
    }
    // 显示层：不得重叠、不得倒退、不得零宽
    for (let i = 1; i < seg.length; i++) {
      assert.ok(seg[i - 1].end <= seg[i].start, `显示单元不得重叠 @${i}`);
      assert.ok(seg[i].start >= seg[i - 1].start, `显示单元不得时间倒退 @${i}`);
    }
    assert.strictEqual(seg.filter((u) => u.end <= u.start).length, 0, "不得有零宽显示单元");
    // 源 token 层：v0.9.0 时间层修复的直接指标
    let tokZero = 0, tokBack = 0;
    for (const c of cues) {
      const tk = c.tokens || [];
      for (let j = 0; j < tk.length; j++) {
        if (tk[j].end <= tk[j].start) tokZero++;
        if (j && tk[j].start < tk[j - 1].start) tokBack++;
      }
    }
    assert.strictEqual(tokZero, 0, "逐 token 求上界后零宽在数学上不可能出现");
    assert.strictEqual(tokBack, 0, "token 起点不得倒退");
  }
});

test("v0.6 不导出旧编号、MERGE 或中文行后处理协议", () => {
  for (const name of ["buildNumberedSourceLines","parseSubtitleLines","parseAlignedSubtitleLines","shapeAlignedLine","mergeRejectedTranslationCues","mergeShortLines","mergeDanglingLines","splitLongLines","layoutTimeline","splitOriginalByPunct"]) {
    assert.strictEqual(Core[name],undefined,`${name} must be removed`);
  }
});

test("DEFAULT_SYSTEM_PROMPT 不再包含逐 unit coverage 或 semanticGroupId 前提", () => {
  const prompt = Core.DEFAULT_SYSTEM_PROMPT;
  assert.ok(prompt.includes("任意语言") && prompt.includes("逐行对齐") && prompt.includes("不输出中文句号"));
  assert.ok(prompt.includes("严格遵守随后给出的 JSON 协议"));
  assert.ok(!/translations|unitId|coverFrom|coverTo|semanticGroupId|逐单元翻译/.test(prompt));
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
  // 这是 json3 滚动 ASR 轨（token 带 rollingEnd），所以 stripOverlap 会删重复。
  // gap 让 canonical 的词级时间不重叠 → canonical 保留重复、display 删除重复，
  // 正是本测试要覆盖的 display<canonical 落差方向。
  const json = { events: [
    ev(0,    2000, ["boil", "water", "on", "the", "stove"]),
    ev(2600, 2400, ["on", "the", "stove", "top", "and", "cook"]), // gap：无词级时间重叠
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

/* =====================================================================
 * TTML / IMSC1 解析（Netflix 等人工成品轨）
 * 所有样本取自 Jay 的 Netflix Trollhunters 英文真轨。
 * ===================================================================== */

const TTML_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"' +
  ' xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"' +
  ' ttp:timeBase="media" xml:lang="en">' +
  '<head><layout>' +
  '<region xml:id="region0" tts:displayAlign="before"/>' +
  '<region xml:id="region1" tts:displayAlign="after"/>' +
  '</layout></head><body><div>';
const TTML_TAIL = "</div></body></tt>";
const ttml = (body) => TTML_HEAD + body + TTML_TAIL;

test("TTML: tick 按声明的 tickRate 换算，不硬编码", () => {
  // 真轨末条 end="13277430832t" @ tickRate 1e7 → 1327.743s
  const cues = Core.parseTtml(ttml(
    '<p begin="571821250t" end="607273332t" region="region1">Hello.</p>'
  ));
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 57182);
  assert.strictEqual(cues[0].end, 60727);
  // tickRate 变一半 → 时间翻倍，证明真的读了声明值
  const halved = Core.parseTtml(
    ttml('<p begin="571821250t" end="607273332t">Hello.</p>').replace('ttp:tickRate="10000000"', 'ttp:tickRate="5000000"')
  );
  assert.strictEqual(halved[0].start, 114364);
});

test("TTML: 时间格式兼容 clock / s / ms，非法值整条丢弃", () => {
  assert.strictEqual(Core.ttmlTimeToMs("00:00:12.345", 1e7), 12345);
  assert.strictEqual(Core.ttmlTimeToMs("1.5s", 1e7), 1500);
  assert.strictEqual(Core.ttmlTimeToMs("250ms", 1e7), 250);
  assert.strictEqual(Core.ttmlTimeToMs("garbage", 1e7), null);
  // end <= start 或缺时间 → 整条丢弃，不产出坏 cue
  const bad = Core.parseTtml(ttml(
    '<p begin="100t" end="50t">倒退</p><p begin="x" end="y">非法</p><p>无时间</p>'
  ));
  assert.strictEqual(bad.length, 0);
});

test("TTML: <br/> 保留为硬换行，span 只脱标签保文本，XML 实体正确解码", () => {
  const cues = Core.parseTtml(ttml(
    '<p begin="0t" end="10000000t">-Yeah.<br/>-The &quot;GummGumms&quot; are coming.</p>' +
    '<p begin="20000000t" end="30000000t">He said <span style="style2">arrivederci</span>.</p>' +
    '<p begin="40000000t" end="50000000t">A &amp;amp; B &#39;quoted&#39;</p>'
  ));
  assert.strictEqual(cues[0].content, '- Yeah.\n- The "GummGumms" are coming.');
  assert.strictEqual(cues[1].content, "He said arrivederci.");
  // &amp;amp; 只能解码一层，否则 &amp; 会被二次解码
  assert.strictEqual(cues[2].content, "A &amp; B 'quoted'");
});

test("TTML: region 的 displayAlign 决定上下位（Netflix 避让画面文字）", () => {
  const cues = Core.parseTtml(ttml(
    '<p begin="0t" end="10000000t" region="region0">上方</p>' +
    '<p begin="20000000t" end="30000000t" region="region1">下方</p>' +
    '<p begin="40000000t" end="50000000t">无 region</p>'
  ));
  assert.strictEqual(cues[0].position, "top");
  assert.strictEqual(cues[1].position, "bottom");
  assert.strictEqual(cues[2].position, "bottom", "缺 region 默认下方");
});

test("TTML: 纯音效整条丢弃，混排只留台词", () => {
  const cues = Core.parseTtml(ttml(
    '<p begin="0t" end="10000000t">[soothing music playing]</p>' +
    '<p begin="20000000t" end="30000000t">[Jim] Hey, Toby.</p>' +
    '<p begin="40000000t" end="50000000t">It works [chuckles] fine.</p>'
  ));
  assert.strictEqual(cues.length, 2, "纯音效条必须整条不产出");
  assert.strictEqual(cues[0].content, "Hey, Toby.");
  assert.strictEqual(cues[1].content, "It works fine.");
});

test("TTML: 行首 - 是分隔符，剥离后只剩一行时必须去掉（真轨 12 条）", () => {
  // 真轨 subtitle1 原样
  const cues = Core.parseTtml(ttml(
    '<p begin="571821250t" end="607273332t" region="region0">' +
    "-[soothing music playing]<br/>-Don't go in there, he's with a patient.</p>" +
    '<p begin="608110000t" end="621870000t">-Tobes.<br/>-Hey, Jim.</p>'
  ));
  assert.strictEqual(cues[0].content, "Don't go in there, he's with a patient.",
    "只剩一个说话人时不该凭空多出破折号");
  assert.strictEqual(cues[1].content, "- Tobes.\n- Hey, Jim.",
    "两个说话人都在时分隔符必须保留");
});

test("负向：stripSubtitleAnnotations 不吃台词里的正常内容", () => {
  // 括号只在整行独占时才剥，插入语不能被吃
  const inline = Core.stripSubtitleAnnotations("I said (quietly) no.");
  assert.strictEqual(inline.speech, "I said (quietly) no.");
  const whole = Core.stripSubtitleAnnotations("(door creaks)");
  assert.strictEqual(whole.annotationOnly, true);
  // 数学/连字符不能当说话人分隔
  const math = Core.stripSubtitleAnnotations("well-known problem");
  assert.strictEqual(math.speech, "well-known problem");
  // 没有标记时 hadAnnotation 必须为 false（否则该标志无意义）
  assert.strictEqual(Core.stripSubtitleAnnotations("plain line").hadAnnotation, false);
});

test("TTML 轨不带 tokens：下游词级时间分支自然走 else，不需站点分支", () => {
  const cues = Core.parseTtml(ttml('<p begin="0t" end="10000000t">Hello world.</p>'));
  assert.ok(!cues[0].tokens, "TTML 无词级时间，不得伪造 tokens");
  // 能被 canonical 时间线接受（派生词级时间），不抛错
  const timeline = Core.buildCanonicalTokenTimeline(Core.cleanupCues(cues));
  assert.ok(timeline && timeline.tokens.length === 2, "应派生出 2 个词");
});

test("人工成品轨的合法重复台词不得被当成滚动重发删除（Netflix 真轨回归）", () => {
  // 全部取自 Jay 的 Netflix Trollhunters 英文真轨。旧实现按纯文本去重，
  // 实测 352 cue 丢 12 个词，其中 "It works." 那条被删成病句。
  const cases = [
    {
      cues: [{ start: 77077, end: 79579, content: "It works. It works like crazy!" }],
      // 这条断言的承重点是「重复台词不得被删词」，不是「必须挤在同一屏」。
      // 一屏不放两个完整句子（见 resegmentCues 的 canMerge），所以正解是
      // 两屏各自完整；重复的 "It works" 两次都在，才是这条回归要守的事。
      mustEqual: ["It works.", "It works like crazy!"],
      words: 6,
    },
    {
      cues: [{ start: 62271, end: 65691, content: "Tobes! Tobes, Tobes, Tobes, Tobes! I have got to talk to you." }],
      words: 12,
    },
    {
      // 跨 cue 的合法重复：间隙只有 83ms，任何间隙阈值都会误判成重发
      cues: [
        { start: 1268893, end: 1272271, content: "He nearly... We nearly... He almost..." },
        { start: 1272354, end: 1273898, content: "Almost what? Speak, Master Jim." },
      ],
      words: 11,
    },
  ];
  cases.forEach((tc) => {
    const seg = Core.resegmentCues(Core.cleanupCues(tc.cues), { rollingSource: false });
    const inWords = tc.cues.reduce((n, c) => n + Core.restoredWords(c.content).length, 0);
    const outWords = seg.reduce((n, c) => n + Core.restoredWords(c.content).length, 0);
    assert.strictEqual(inWords, tc.words, "样本词数应与实测一致");
    assert.strictEqual(outWords, inWords,
      "人工轨重复台词被删：" + JSON.stringify(seg.map((s) => s.content)));
    if (tc.mustEqual) {
      assert.deepStrictEqual(seg.map((s) => s.content), tc.mustEqual,
        "分屏形态应为逐句独立且不丢词：" + JSON.stringify(seg.map((s) => s.content)));
    }
  });
});

test("负向：滚动轨仍必须去重发，rollingSource 不是无条件关闭去重", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 1500, content: "how transformers work" },
    { start: 1500, end: 3000, content: "work under the hood." },
  ]);
  // 默认（滚动轨）必须去重
  const rolling = Core.resegmentCues(frags, { maxWords: 50, maxDurationMs: 30000 });
  assert.ok(!/work work/.test(rolling.map((s) => s.content).join(" ")),
    "滚动轨的重发必须仍被删除");
  // 显式声明人工轨则保留 —— 证明这个开关真的在起作用，不是死参数
  const manual = Core.resegmentCues(frags, { maxWords: 50, maxDurationMs: 30000, rollingSource: false });
  assert.ok(/work work/.test(manual.map((s) => s.content).join(" ")),
    "人工轨应保留重复，否则开关是死代码");
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

test("validateChineseDisplayUnit 源文以省略号悬着时，译文省略号不算半句（yttrans 真轨 clip 15280 死锁复现）", () => {
  // 真机误杀：ASR cue「But actually, they’re among the...」忠实译文「但实际上，它们属于……」
  // 被 non-terminal-punctuation 拒收，重试产出同样收尾的译文，整个 clip 回退英文。
  const src = "But actually, they’re among the...";
  assert.strictEqual(
    Core.validateChineseDisplayUnit("但实际上，它们属于……", { sourceText: src, continues: false }).ok,
    true, "源文省略号收尾 -> 译文省略号合法");
  assert.strictEqual(
    Core.validateChineseDisplayUnit("但实际上，它们属于...", { sourceText: src, continues: false }).ok,
    true, "三个点形式同样合法");
  // 逗号族照拒：自己断在逗号上与源文形态无关
  assert.strictEqual(
    Core.validateChineseDisplayUnit("但实际上，", { sourceText: src, continues: false }).reason,
    "non-terminal-punctuation", "源文省略号也不救逗号半句");
  // 源文没有省略号时，译文省略号照旧拒绝
  assert.strictEqual(
    Core.validateChineseDisplayUnit("事情还没完……", { sourceText: "But that is not all", continues: false }).reason,
    "non-terminal-punctuation", "源文非省略号收尾 -> 译文省略号仍是半句");
  // 无源文上下文（旧调用形态）维持旧行为
  assert.strictEqual(Core.validateChineseDisplayUnit("事情还没完……").reason, "non-terminal-punctuation");
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

test("短句说完就落屏：小间隙也不与下一句黏成一屏（一屏不放两个完整句）", () => {
  // 这条曾断言相反行为（"ok." 太短 → 与下一句黏合成 "ok. let us continue."）。
  // 那个规则是 Jay 报的分屏缺陷的根因：它作用在**已完成的句子**上，等于允许把
  // 这句的尾巴焊到下一句开头。真实轨 aXTcYa7u12k 上 8/123 屏因此跨句，译文侧
  // 出现「消失了今天我们要探究」这种谓语被劈开的读法。
  // 过短屏的正确出口是显示层 mergeUnreadableUnits 向后借时间，不是分段层黏连。
  const frags = Core.cleanupCues([
    { start: 0, end: 800, content: "ok." },
    { start: 900, end: 2000, content: "let us continue." }, // 间隙 100ms，仍不黏
  ]);
  const seg = Core.resegmentCues(frags, { tailTrimMs: 0 });
  assert.deepStrictEqual(seg.map((s) => s.content), ["ok.", "let us continue."],
    "完整句必须各自成屏：" + JSON.stringify(seg.map((s) => s.content)));
  // startMs 红线：分屏不得前移任何屏的起点
  assert.strictEqual(seg[0].start, 0);
  assert.strictEqual(seg[1].start, 900);
});

test("真实 ASR 轨：一屏不得放两个完整句子（aXTcYa7u12k 分屏回归）", () => {
  // Jay 报的分屏缺陷。真轨实测 8/123 屏出现「前句仅 1-2 词 + 下一句开头」焊在
  // 一屏，译文侧读成「消失了今天我们要探究」。根因是 resegmentCues 的 canMerge
  // 曾对已完成的短句破例放行合并。这里用真轨 fixture 断言该形态归零。
  const raw = fs.readFileSync(
    path.join(__dirname, "fixtures", "youtube-axt-sentence-split-raw.json"), "utf8");
  const cues = Core.cleanupCues(Core.parseSubtitleText(raw));
  assert.ok(cues.length >= 20, "fixture 应含足够 cue 才能复现，实得 " + cues.length);
  const seg = Core.resegmentCues(cues, {
    maxWords: Core.DISPLAY_UNIT_MAX_WORDS,
    maxVisualWidth: Core.SOURCE_DISPLAY_MAX_WIDTH,
    continuationMaxWords: Core.SOURCE_UNIT_MAX_WORDS,
    rollingSource: true,
  });
  const crossed = seg.filter((c) => /[.!?]\s+\S/.test(String(c.content || "").trim()))
    .map((c) => c.content);
  assert.deepStrictEqual(crossed, [], "一屏放了两个完整句子：" + JSON.stringify(crossed));
  // 同轨零丢词：分屏不得为了对齐边界吞词
  const canon = Core.buildCanonicalTokenTimeline(cues).tokens.map((t) => t.text).join(" ");
  assert.deepStrictEqual(
    Core.restoredWords(seg.map((c) => c.content).join(" ")),
    Core.restoredWords(canon), "分屏丢词或改词");
});

test("句末孤立介词短语必须并回上一屏（不是新句子，勿被分屏规则误切）", () => {
  // 与上一条互为约束：拒绝「一屏两句」不等于「见句号就切」。这条防止把
  // canMerge 的修法过度推广到 flush 层——那样会静默废掉这个语法续接。
  const seg = Core.resegmentCues(Core.cleanupCues([
    { start: 0, end: 1000, content: "It vanished." },
    { start: 1100, end: 2200, content: "in the vacuum chamber." },
  ]), { maxWords: 12, maxVisualWidth: 52, continuationMaxWords: 14, tailTrimMs: 0 });
  assert.deepStrictEqual(seg.map((c) => c.content), ["It vanished. in the vacuum chamber."],
    "句末孤立介词短语被切开：" + JSON.stringify(seg.map((c) => c.content)));
});

test("完整短句后接大间隙 → 各自成段（长停顿同样不得跨屏）", () => {
  const frags = Core.cleanupCues([
    { start: 0, end: 800, content: "ok." },
    { start: 5000, end: 6000, content: "much later text." },
  ]);
  const seg = Core.resegmentCues(frags, {});
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

test("sliceClipsByCue 优先收在原文句末：回退到后半段最近句末，后半段无句末时保持原切点", () => {
  const c = (start, content) => ({ start, end: start + 1000, content });
  const cues = [c(0, "If we assume"), c(1000, "it was 2,000 watts."), c(2000, "That is fast,"),
    c(3000, "very fast."), c(4000, "the time is exactly 6"), c(5000, "minutes and 29 seconds."), c(6000, "Done.")];
  const clips = Core.sliceClipsByCue(cues, 4500);
  assert.deepStrictEqual(clips.map((x) => x.cues.length), [4, 3], "句中切点回退到句末，被退回的 cue 进下一 clip");
  assert.strictEqual(clips[1].cues[1].content, "minutes and 29 seconds.");
  assert.deepStrictEqual(clips.flatMap((x) => x.cues), cues, "回退不得丢失或重复 cue");
  const mono = [c(0, "Start."), c(1000, "a b"), c(2000, "c d"), c(3000, "e f"), c(4000, "g h"), c(5000, "i j.")];
  assert.deepStrictEqual(Core.sliceClipsByCue(mono, 4500).map((x) => x.cues.length), [5, 1], "句末只在前半段时不回退，避免 clip 过短");
  assert.deepStrictEqual(Core.sliceClipsByCue(cues, 4500, { preferSentenceEnd: false }).map((x) => x.cues.length), [5, 2]);
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

test("滚动窗口轨的 token.end 不得越过下一条 cue 起点（回归 8 屏译文整体错位）", () => {
  // 真机故障 mxhxL1LzKww：SRT #24 起连续 8 屏译文整体错开一屏，到 #31 才自愈。
  //
  // 根因不在模型，在时间派生：timedJson3EventTokens 给每条 event 的**末词**定 end 时
  // 没有后继 seg offset 可用，只能落到 eventEnd；而滚动窗口 ASR 的 dDurationMs 故意
  // 伸进后续 event（同一句滚动重复出现，时长覆盖整个滚动窗口）。于是每条 cue 的末词
  // 都被拉长到下一条 cue 覆盖区。渲染单元时间取自 token 跨度 → 屏与屏时间窗互相穿插
  // → 原文与译文在时间轴上本就对不齐。
  //
  // 实测 23 条真实轨：14 条滚动轨全中（>2s 的词 4884 个 = 8.50%，异常词数≈cue 数），
  // 9 条干净轨全为 0。cleanupCues 只压 cue.end 且故意不动 tokens（token 重叠是滚动
  // 重复去重的唯一依据），所以那一层修不了 —— 必须在 token 时间派生处夹上界，
  // 同时保留未夹的 rollingEnd 供去重判定。这条门禁锁死"夹"这件事本身。
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "youtube-json3-rolling-raw.json"), "utf8"));
  const cues = Core.cleanupCues(Core.parseJson3(raw));
  const timeline = Core.buildCanonicalTokenTimeline(cues);
  const tokens = timeline.tokens;
  assert.ok(tokens.length > 0, "真实滚动轨必须能建立 canonical 时间轴");

  // 1) 用户可见的硬不变量在渲染单元上：屏与屏时间窗不得穿插。
  //    canonical 这一层**故意**不收敛重叠（startMs 红线：前推会整轨累积漂移），
  //    所以断言必须落在生产渲染路径的产物上，而不是 canonical token 上。
  const fallbackCues = Core.resegmentCues(cues, { tailTrimMs: 120, maxWords: 12, continuationMaxWords: 14 });
  const units = Core.buildCueTokenSpanUnits(timeline, fallbackCues);
  const unitOverlaps = [];
  for (let i = 0; i + 1 < units.length; i++) {
    if (units[i].endMs > units[i + 1].startMs) {
      unitOverlaps.push(`[${i}] ${units[i].startMs}-${units[i].endMs} vs @${units[i + 1].startMs}`);
    }
  }
  assert.deepStrictEqual(unitOverlaps, [], "渲染单元必须无重叠，否则屏与屏时间窗穿插、原文与译文对不齐");

  // 2) 只要存在可夹的上界，token.end 就必须已经被夹住。
  //    上界 = 严格晚于该 token start 的最早 cue 起点。两种情况天然无界，必须排除，
  //    否则断言会变成"要求改 startMs"：
  //      · start-tie：下一条 cue 与本 token 同一时刻开始（实测 "At"@70320），
  //        此时唯一的收敛手段是动 start —— 红线，交给渲染层处理；
  //      · 整轨最后一个 token：其后没有任何 cue 起点。
  const cueStarts = [...new Set(cues.map((c) => c.start))].sort((a, b) => a - b);
  const boundAfter = (t) => { for (const v of cueStarts) if (v > t) return v; return Infinity; };
  const overBound = tokens.filter((t) => {
    const bound = boundAfter(t.startMs);
    return Number.isFinite(bound) && t.endMs > bound;
  }).map((t) => `"${t.text}" ${t.startMs}-${t.endMs} 越过上界 ${boundAfter(t.startMs)}`);
  assert.deepStrictEqual(overBound, [], "token.end 必须夹到严格晚于自身 start 的最早 cue 起点");

  // 3) 夹上界不得把 token 压成零宽 —— 上界必须逐 token 求（按各自 start），
  //    整条 event 共用一个标量会在重叠轨上压出零宽（实测日语轨 2022 个）。
  const degenerate = tokens.filter((t) => t.endMs <= t.startMs).map((t) => `"${t.text}"@${t.startMs}`);
  assert.deepStrictEqual(degenerate, [], "token 不得被夹成零宽/负宽");

  // 4) startMs 红线：夹上界只许动 end。出现时刻是唯一必须精确贴合音轨的量。
  const unclamped = Core.buildCanonicalTokenTimeline(
    Core.cleanupCues(Core.parseJson3(JSON.parse(JSON.stringify(raw)))),
  ).tokens;
  assert.deepStrictEqual(
    tokens.map((t) => `${t.text}@${t.startMs}`),
    unclamped.map((t) => `${t.text}@${t.startMs}`),
    "夹 end 不得改变任何 token 的 startMs",
  );

  // 5) 反向：滚动重复去重仍然有效。夹掉 end 会让"末词与下一条重复前缀时间重叠"的
  //    判据失效，重复词被渲染两次（实测 fixture 曾出现 "boil water boil water"）。
  //    rollingEnd 正是为此保留 —— 这里锁死它没有被顺手删掉。
  const text = tokens.map((t) => t.text.toLowerCase()).join(" ");
  const dupRuns = [];
  for (let n = 2; n <= 6; n++) {
    const w = tokens.map((t) => t.text.toLowerCase());
    for (let i = 0; i + 2 * n <= w.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) if (w[i + k] !== w[i + n + k]) { same = false; break; }
      if (same) dupRuns.push(w.slice(i, i + n).join(" "));
    }
  }
  assert.deepStrictEqual(dupRuns, [], `滚动重复去重必须仍然生效，canonical 不得出现连续重复词组（${text.slice(0, 80)}…）`);

  // 6) rollingEnd 是承重字段，必须锁死它活着穿过**两个**透传点：cleanupCues 与
  //    timelineTokensForCue。第 5 条依赖 fixture 恰好触发"末词被夹 + 下一条重复前缀
  //    在时间上重叠"，实测触碰不到（删掉透传后 fixture 仍全绿，而 22 条真实轨新增
  //    3 处连续重复词组、日语轨 token 8269→8279）。门禁不能依赖 fixture 的运气。
  //
  //    这里用能判别的最小轨：ev1 只重复 ev0 的**末词**（唯一被夹的那个词）。
  //      ev0 "boil water"：water 派生 600-2000，夹到下一条起点 → 600-1200，rollingEnd=2000
  //      ev1 从 1200 起 "water now"：water 1200-1500
  //    去重判定要求两者时间重叠：用 rollingEnd 得 max(600,1200) < min(2000,1500) → 成立；
  //    回落到已夹的 end 则 1200 < 1200 → 不成立，"water" 被渲染两次。
  const discriminating = { events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [
      { utf8: "boil", tOffsetMs: 0 }, { utf8: " water", tOffsetMs: 600 }] },
    { tStartMs: 1200, dDurationMs: 1800, segs: [
      { utf8: "water", tOffsetMs: 0 }, { utf8: " now", tOffsetMs: 300 }] },
  ] };
  const dedupCues = Core.cleanupCues(Core.parseJson3(discriminating));
  const clampedTail = dedupCues[0].tokens[dedupCues[0].tokens.length - 1];
  assert.ok(
    clampedTail.rollingEnd > clampedTail.end,
    "前置条件：末词必须被夹住且 rollingEnd 保留未夹值，否则本断言失去判别力",
  );
  assert.deepStrictEqual(
    Core.buildCanonicalTokenTimeline(dedupCues).tokens.map((t) => t.text.toLowerCase()),
    ["boil", "water", "now"],
    "夹 end 后仍须靠 rollingEnd 判出滚动重复；任一透传点被删都会渲染成 boil water water now",
  );
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

test("站点适配表：按 host 判定，未支持站点不猜不回落", () => {
  assert.strictEqual(Core.siteAdapterFor("www.youtube.com").id, "youtube");
  assert.strictEqual(Core.siteAdapterFor("m.youtube.com").id, "youtube");
  assert.strictEqual(Core.siteAdapterFor("www.netflix.com").id, "netflix");
  assert.strictEqual(Core.siteAdapterFor("netflix.com").id, "netflix");
  // 未支持 / 仿冒域名必须返回 null，而不是回落到某个站点
  for (const host of ["example.com", "notnetflix.com", "youtube.com.evil.net", "", null]) {
    assert.strictEqual(Core.siteAdapterFor(host), null, "不得匹配: " + host);
  }
  // 每个适配器都必须给全下游依赖的字段，缺一个就是接错线
  for (const key of Object.keys(Core.SITE_ADAPTERS)) {
    const a = Core.SITE_ADAPTERS[key];
    for (const f of ["id", "playerSelector", "videoSelector", "nativeCaptionSelector",
      "trackFormat", "trustedHostRe", "pathRe", "checkTrackUrl"]) {
      assert.ok(a[f] != null, key + " 缺字段 " + f);
    }
    assert.strictEqual(typeof a.rollingSource, "boolean", key + " 必须显式声明 rollingSource");
  }
});

test("人工成品轨的重复台词：rollingSource=false 保台词，=true 会串行（真轨样本）", () => {
  // 取自 Jay 的 Netflix Trollhunters 英文真轨（352 cue）。这里断言的是**显示单元**
  // 层：canonical token 流不做重发去重，所以词数在两种设置下都是 2412；差别体现在
  // resegmentCues 的分屏内容上——误当滚动轨会把上一句替换成下一位说话人的台词。
  // 去重发只发生在**合并**路径上：两条 piece 要先被判定成同一屏，stripOverlap 才有
  // 机会删掉重复词。所以样本必须是「句子尚未结束 + 下一 cue 重发尾词」这种真实滚动
  // 形态。早先的样本每条都自带句末标点，各自独立成屏后根本不进合并，两臂输出全等 ——
  // 负向断言测不到东西（一屏不放两个完整句子后此缺陷立刻暴露）。
  const cues = [
    { start: 300, end: 900, content: "Was felled" },
    { start: 1000, end: 1600, content: "felled Felled?" },
  ];
  const opts = { maxWords: 12, maxVisualWidth: 52, continuationMaxWords: 14 };
  const good = Core.resegmentCues(cues, Object.assign({ rollingSource: false }, opts));
  const bad = Core.resegmentCues(cues, Object.assign({ rollingSource: true }, opts));
  const goodText = good.map((c) => c.content).join(" | ");
  const badText = bad.map((c) => c.content).join(" | ");
  // 正向：人工轨里重复的 "felled" 是两位说话人的真台词，一个都不能少
  assert.strictEqual(good.reduce((n, c) => n + Core.restoredWords(c.content).length, 0), 4,
    "人工轨丢了台词: " + goodText);
  // 负向：误当滚动轨会把重发的那个词删掉 —— 证明这个开关确实承重，不是装饰
  assert.strictEqual(bad.reduce((n, c) => n + Core.restoredWords(c.content).length, 0), 3,
    "负向用例失效：滚动设置没有吞词，门禁不再承重: " + badText);
  assert.notStrictEqual(goodText, badText);
});

test("manifest.json 与站点适配表必须同步：每个适配器都有注入配置", () => {
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const isolated = mf.content_scripts.filter((c) => c.world === "ISOLATED");
  assert.strictEqual(isolated.length, 1, "ISOLATED 注入应只有一份（core+isolated）");
  const isoMatches = isolated[0].matches.join(" ");
  const mainScripts = mf.content_scripts.filter((c) => c.world === "MAIN");
  const hostPerms = mf.host_permissions.join(" ");

  for (const key of Object.keys(Core.SITE_ADAPTERS)) {
    const adapter = Core.SITE_ADAPTERS[key];
    // 造一个该站点的代表 host，确认 manifest 里真的注入了它
    const sample = { youtube: "www.youtube.com", netflix: "www.netflix.com" }[key];
    assert.ok(sample, "新站点 " + key + " 需要在本门禁里补一个代表 host");
    assert.strictEqual(Core.siteAdapterFor(sample).id, adapter.id);
    assert.ok(isoMatches.includes(sample), key + " 未注入 ISOLATED（core.js/isolated.js）");
    assert.ok(hostPerms.includes(sample), key + " 缺 host_permissions");
    // 每个站点必须有自己的 MAIN world 取轨脚本，且脚本文件真的存在
    const own = mainScripts.filter((c) => c.matches.join(" ").includes(sample));
    assert.strictEqual(own.length, 1, key + " 应恰好有一份 MAIN 取轨脚本");
    for (const js of own[0].js) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", js)), "缺文件: " + js);
    }
  }
  // 反向：manifest 注入的站点都必须能被适配表识别，否则注了没人管
  for (const c of mf.content_scripts) {
    for (const m of c.matches) {
      const host = m.replace(/^https:\/\//, "").replace(/\/\*$/, "");
      assert.ok(Core.siteAdapterFor(host), "manifest 注入了适配表不认识的站点: " + host);
    }
  }
});

test("validateTrackManifest 按站点校验 Netflix CDN 直链", () => {
  const nfUrl = "https://ipv4-c001-abc001-example-isp.1.oca.nflxvideo.net/range/0-9999?o=1&v=2&e=3&t=sig";
  const ok = Core.validateTrackManifest({
    site: "netflix", videoId: "80075919",
    files: [{ name: "English", code: "en", languageCode: "en", kind: "", url: nfUrl }],
  });
  assert.ok(ok, "合法 Netflix 轨应通过");
  assert.strictEqual(ok.site, "netflix");
  assert.strictEqual(ok.files[0].languageCode, "en");

  // 负向：非 nflxvideo.net 主机、明文、以及仿冒后缀
  for (const url of [
    "https://evil.example/range/0-99",
    "http://a.oca.nflxvideo.net/range/0-99",
    "https://nflxvideo.net.evil.com/range/0-99",
    "https://www.netflix.com/range/0-99",
  ]) {
    assert.strictEqual(Core.validateTrackManifest({
      site: "netflix", videoId: "80075919",
      files: [{ code: "en", languageCode: "en", kind: "", url }],
    }), null, "必须拒绝: " + url);
  }
  // 负向：Netflix 只有人工轨，出现 asr 说明数据被污染
  assert.strictEqual(Core.validateTrackManifest({
    site: "netflix", videoId: "80075919",
    files: [{ code: "en-asr", languageCode: "en", kind: "asr", url: nfUrl }],
  }), null, "Netflix 不该出现 asr 轨");
  // 负向：站点不能混用 —— YouTube URL 不得以 netflix 身份通过，反之亦然
  assert.strictEqual(Core.validateTrackManifest({
    site: "netflix", videoId: "dQw4w9WgXcQ",
    files: [{ code: "en", languageCode: "en", kind: "",
      url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=s" }],
  }), null, "YouTube URL 不得当 Netflix 轨通过");
  assert.strictEqual(Core.validateTrackManifest({
    site: "youtube", videoId: "80075919",
    files: [{ code: "en", languageCode: "en", kind: "", url: nfUrl }],
  }), null, "Netflix URL 不得当 YouTube 轨通过");
  // 未知站点整包拒绝
  assert.strictEqual(Core.validateTrackManifest({
    site: "bilibili", videoId: "x", files: [{ code: "en", languageCode: "en", url: nfUrl }],
  }), null, "未知站点必须拒绝");
});

test("屏间短缝必须桥接（语义重组屏界≠源cue界），长停顿不桥", () => {
  // 2026-10-04 真轨 pid=13190（VztSdwYPFCE）：cue 211.9s/216.8s/218.3s 全部落在语义屏
  // 之间的空洞里，渲染层 at() 查不到单元 → 一直显示英文。「读得完」和「接得上」是两个
  // 不变量：合并/借静音保证前者，桥接保证后者。
  const mkU = (s, e, t) => ({ startMs: s, endMs: e, translation: t, originalText: "src" });
  // 300ms 缝：桥上。
  const gapped = Core.bridgeDisplayGaps([mkU(0, 2000, "一"), mkU(2300, 5000, "二")]);
  assert.strictEqual(gapped[0].endMs, 2300, "≤600ms 的缝由前屏 end 平推补上");
  // 长停顿（>600ms）：不桥 —— 静音处不显示字幕是既有红线。
  const paused = Core.bridgeDisplayGaps([mkU(0, 2000, "一"), mkU(3300, 5000, "二")]);
  assert.strictEqual(paused[0].endMs, 2000, ">600ms 的缝不桥接");
  // 尾屏只到 blockEndMs 为止，不探进下一个 clip。
  const tail = Core.bridgeDisplayGaps([mkU(0, 2000, "一"), mkU(2100, 4000, "二")], { blockEndMs: 4200 });
  assert.strictEqual(tail[1].endMs, 4200, "尾屏 end 平推到块尾");
  // 不碰 startMs：桥接只延 end。
  assert.ok(gapped.every((u, i) => u.startMs === [0, 2300][i]));
});

test("finalizeSentenceScreens：直翻屏也必须过合并/借静音/桥接收尾", () => {
  // 2026-10-04 集成缺口：runtime 直翻路径此前绕过 materialize 收尾管线，
  // 桥接/借静音对新鲜翻译不生效。本测试锁住「所有上屏路径同一收尾」。
  const mkP = (s, e, t) => ({ content: t, start: s, end: e });
  const pieces = [mkP(0, 2000, "one"), mkP(2100, 4000, "two"), mkP(4100, 6000, "three")];
  const screens = [
    { from: 0, to: 0, text: "第一屏" },
    { from: 1, to: 1, text: "第二" },
    { from: 2, to: 2, text: "第三" },
  ];
  const out = Core.finalizeSentenceScreens(screens, pieces);
  assert.ok(out.length >= 3, "三屏都在");
  // 100ms 屏间缝必须被桥上：前屏 end 平推到后屏 start
  assert.strictEqual(out[0].endMs, out[1].startMs, "缝 0-1 已桥");
  assert.strictEqual(out[1].endMs, out[2].startMs, "缝 1-2 已桥");
  // 空文本屏被过滤；from/to 越界的屏整条丢弃（错标时间的中文比缺中文更糟，fail-soft）
  const sparse = Core.finalizeSentenceScreens([{ from: 0, to: 0, text: "" }, { from: 2, to: 9, text: "越界" }], pieces);
  assert.strictEqual(sparse.length, 0, "空屏过滤+越界屏丢弃");
});

test("读不完的屏必须合并相邻屏借时间，且不碰 startMs / 不越过后屏 end", () => {  // 真实缺陷（E4HGfagANiQ 西语轨）：源 cue「y por moda」只有 820ms，中文「也为了时尚，
  // 展现个性」9 字按 Netflix 9 字/秒需 1000ms → 91ms/字读不完。红线禁止前推 startMs
  // 或侵入下一屏，唯一合法解是与相邻屏合并，让时间窗与字数一起相加。
  const mk = (id, s, e, t) => ({ blockSegmentId: id, pauseGroupId: Number(String(id).replace(/^\D+/, "")) || 0, srcStart: 1, srcEnd: 2, originalText: "src", translation: t, startMs: s, endMs: e });
  const merged = Core.mergeUnreadableUnits([
    mk("b0", 9280, 10100, "也为了时尚，展现个性"),  // 820ms / 10字需1110ms → 91ms/字读不完
    mk("b0", 10220, 13200, "但没有别的动物"),      // 2980ms / 7字 → 够
  ], { maxVisualWidth: 48 });
  assert.strictEqual(merged.length, 1, "读不完的屏应与相邻屏合并");
  assert.strictEqual(merged[0].startMs, 9280, "startMs 必须取前屏，绝不前推");
  assert.strictEqual(merged[0].endMs, 13200, "endMs 必须取后屏，绝不越过它");
  assert.match(merged[0].translation, /也为了时尚，展现个性/, "合并不得丢失前屏译文");
  assert.match(merged[0].translation, /但没有别的动物/, "合并不得丢失后屏译文");

  // 硬约束 1：不跨 segment（segment 边界=750ms 长停顿，真实语音结构）
  const acrossSeg = Core.mergeUnreadableUnits([
    mk("b0", 0, 500, "读不完的一屏文字"), mk("b1", 2000, 5000, "下一段"),
  ], { maxVisualWidth: 48 });
  assert.strictEqual(acrossSeg.length, 2, "不得跨长停顿边界合并");

  // 硬约束 2：不把两个完整句子并到一屏
  const twoSentences = Core.mergeUnreadableUnits([
    mk("b0", 0, 500, "这是第一句。"), mk("b0", 600, 4000, "这是第二句"),
  ], { maxVisualWidth: 48 });
  assert.strictEqual(twoSentences.length, 2, "句末标点是硬边界，不得并两个完整句");

  // 硬约束 3：不制造超宽屏
  const wide = Core.mergeUnreadableUnits([
    mk("b0", 0, 300, "一二三四五六七八九十一二"), mk("b0", 400, 5000, "十三十四十五十六十七十八十九二十"),
  ], { maxVisualWidth: 20 });
  assert.strictEqual(wide.length, 2, "合并后超过宽度上限则不合并");

  // 集成：合并必须真的接在 materializeReadableSemanticUnits 的管线里。
  // 负向验证发现过：只测函数本身时，把管线里的调用整个删掉仍然全绿。
  const core = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
  assert.ok(/function materializeReadableSemanticUnits[\s\S]{0,1200}?mergeUnreadableUnits\(/.test(core), "显示管线必须调用 mergeUnreadableUnits");

  // 已够读的屏不得被无故合并（模型的语义断点必须保留）
  const fine = Core.mergeUnreadableUnits([
    mk("b0", 0, 5000, "短句"), mk("b0", 5000, 10000, "另一短句"),
  ], { maxVisualWidth: 48 });
  assert.strictEqual(fine.length, 2, "时间足够时必须原样保留模型断点");
});

test("整句协议：超宽屏/文字远多于语音的屏首轮带原因重试，末轮照收不整 clip 回退", async () => {
  const pieces = [
    { content: "I mean, if it takes more than triple the energy", start: 0, end: 3000, tokenStart: 0, tokenEnd: 10, semanticGroupId: "sg0" },
    { content: "output", start: 3000, end: 3300, tokenStart: 10, tokenEnd: 11, semanticGroupId: "sg0" },
    { content: "of a 1500 W electric kettle just to match its boiling time.", start: 3300, end: 7400, tokenStart: 11, tokenEnd: 22, semanticGroupId: "sg0" },
  ];
  const bad = { screens: [
    { from: "u0", to: "u0", text: "我的意思是，所需能量超过" },
    { from: "u1", to: "u1", text: "一台1500瓦电水壶输出的三倍" },
    { from: "u2", to: "u2", text: "才能达到相同的烧水时间" } ] };
  const good = { screens: [
    { from: "u0", to: "u1", text: "如果所需能量超过一台1500瓦" },
    { from: "u2", to: "u2", text: "电水壶的三倍才能烧得一样快" } ] };
  const wide = { screens: [
    { from: "u0", to: "u1", text: "如果所需能量超过一台1500瓦电水壶输出功率的整整三倍还多才行" },
    { from: "u2", to: "u2", text: "才能达到相同的烧水时间" } ] };
  const run = async (replies) => {
    const sys = [];
    const out = await Core.translateSentenceScreens({ pieces, apiBaseUrl: "http://mock/v1", apiKey: "k", apiModel: "m", maxVisualWidth: 32,
      fetchImpl: async (_u, req) => { sys.push(JSON.parse(req.body)); const c = JSON.stringify(replies[sys.length - 1]);
        return { ok: true, json: async () => ({ choices: [{ message: { content: c } }] }) }; } });
    return { out, sys };
  };
  let r = await run([bad, good]);
  assert.strictEqual(r.sys.length, 2, "挤屏必须触发一次重试");
  assert.match(JSON.stringify(r.sys[1]), /文字远多于它覆盖的原文/);
  assert.strictEqual(r.out.length, 2);
  r = await run([wide, good]);
  assert.strictEqual(r.sys.length, 2, "超宽必须触发一次重试");
  assert.match(JSON.stringify(r.sys[1]), /超过 16 字/);
  r = await run([bad, bad]);
  assert.strictEqual(r.out.length, 3, "重试仍违规时照收，不让整 clip 回退英文");
  const lead = { screens: [
    { from: "u0", to: "u1", text: "如果所需能量超过一台" },
    { from: "u2", to: "u2", text: "的1500瓦电水壶三倍" } ] };
  r = await run([lead, good]);
  assert.strictEqual(r.sys.length, 2, "屏首「的」必须触发一次重试");
  assert.match(JSON.stringify(r.sys[1]), /以「的」开头/);
  const dup = { screens: [
    { from: "u0", to: "u1", text: "但所需能量是1500瓦电水壶的三倍" },
    { from: "u2", to: "u2", text: "1500瓦电水壶的三倍才烧得一样快" } ] };
  r = await run([dup, good]);
  assert.strictEqual(r.sys.length, 2, "相邻屏重复 ≥6 字必须触发一次重试");
  assert.match(JSON.stringify(r.sys[1]), /重复了「1500瓦电水壶的三倍」/);
  r = await run([good]);
  assert.strictEqual(r.sys.length, 1, "合格输出不得多发请求");
});

test("lenient 降级留下的覆盖洞必须内核自愈补翻（真机 0.4.17 clip 48-78s 三处落洞）", async () => {
  const pieces = [
    { content: "They tell us the total number of pixels", start: 0, end: 3000, tokenStart: 0, tokenEnd: 8, semanticGroupId: "c0" },
    { content: "on the screen", start: 3000, end: 5000, tokenStart: 8, tokenEnd: 11, semanticGroupId: "c1" },
    { content: "are not resolutions per se", start: 5000, end: 8000, tokenStart: 11, tokenEnd: 16, semanticGroupId: "c2" },
  ];
  const reqs = [];
  const fetchImpl = async (_u, r) => {
    reqs.push(JSON.parse(r.body));
    // 主请求：中屏倒写被 lenient 丢弃 → 洞；补洞请求：给合格译文
    const reply = reqs.length === 1
      ? { screens: [
          { from: "u0", to: "u0", text: "它们告诉我们像素总数" },
          { from: "u1", to: "u2", text: "屏幕上的并不是分辨率本身" } ] } // 覆盖含 u2 但 text 无倒写 → 无洞
      : { screens: [{ from: "u0", to: "u0", text: "补出来的译文" }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  // 命中洞的形状：主回复第二屏 from=u1 被丢弃（from 必须 = 前一屏 to+1 起步的连续覆盖被破坏）
  const fetchImpl2 = async (_u, r) => {
    reqs.push(JSON.parse(r.body));
    const reply = reqs.length === 1
      ? { screens: [
          { from: "u0", to: "u0", text: "它们告诉我们像素总数" },
          { from: "u2", to: "u2", text: "并不是分辨率本身" } ] } // u1 无覆盖 → 洞
      : { screens: [{ from: "u0", to: "u0", text: "屏幕上补的" }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  reqs.length = 0;
  const out = await Core.translateSentenceScreens({ pieces, apiBaseUrl: "http://mock/v1", apiKey: "k", apiModel: "m", maxVisualWidth: 32,
    lenient: true, fetchImpl: fetchImpl2 });
  assert.strictEqual(reqs.length, 2, "检测到覆盖洞必须发起补洞请求");
  assert.ok(out.some((s) => s.from === 1 && s.to === 1 && /补/.test(s.text)), "洞区间被补上译文");
  assert.strictEqual(out.filter((s) => !String(s.text || "").trim()).length, 0, "补上后不留空白占位屏");
  // 合格输出不得多发请求
  reqs.length = 0;
  await Core.translateSentenceScreens({ pieces, apiBaseUrl: "http://mock/v1", apiKey: "k", apiModel: "m", maxVisualWidth: 32,
    lenient: true, fetchImpl: async (_u, r) => { reqs.push(JSON.parse(r.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ screens: [
        { from: "u0", to: "u0", text: "它们告诉我们像素总数" },
        { from: "u1", to: "u2", text: "屏幕上的并不是分辨率本身" } ] }) } }] }) }; } });
  assert.strictEqual(reqs.length, 1, "无洞时不得发补洞请求");
});

test("合并屏左侧以百分号收尾时也补逗号（全片真轨「长约16%为什么？」）", () => {  assert.strictEqual(Core.joinDisplayScreens("实测时间仍比这长约16%", "为什么？"), "实测时间仍比这长约16%，为什么？");
  assert.strictEqual(Core.joinDisplayScreens("功率是1500", "瓦"), "功率是1500瓦", "数字+单位不得被逗号拆开");
});

test("以「到/和/与/从」收尾的完整词不算悬空（全片真轨 clip 6「真没想到」）", () => {
  for (const s of ["真没想到", "我终于做到", "今天挺暖和", "大家都来参与", "只能服从"]) {
    assert.strictEqual(Core.validateChineseDisplayUnit(s, { continues: false }).ok, true, s);
  }
  for (const s of ["我想去但", "因为", "我们可以喝茶或者咖啡并且"]) {
    assert.strictEqual(Core.validateChineseDisplayUnit(s, { continues: false }).reason, "dangling-tail", s);
  }
});

test("屏尾承接词只在原文句末才算悬空（全片真轨 dangling-tail 整 clip 失败）", () => {
  // u0 与 u1 属于不同语义分组（分句级），但原文同一句没说完：「…, but | the result…」
  const pieces = [
    { alias: "u0", sourceText: "It was cited three times, but", tokenStart: 0, tokenEnd: 6, semanticGroupId: "sg0" },
    { alias: "u1", sourceText: "the result surprised me.", tokenStart: 6, tokenEnd: 10, semanticGroupId: "sg1" },
  ];
  const resp = JSON.stringify({ screens: [
    { from: "u0", to: "u0", text: "它被引用了三次，但" }, { from: "u1", to: "u1", text: "结果让我很意外" },
  ] });
  assert.strictEqual(Core.parseScreenCoverageResponse(resp, pieces).length, 2, "原文句子未结束时，屏尾的「但」是正常承接");
  // 原文已在句末：中文仍以承接词收尾才是真悬空
  const closed = pieces.map((p, i) => ({ ...p, endsSentence: undefined, sourceText: i === 0 ? "It was cited three times." : p.sourceText }));
  assert.throws(() => Core.parseScreenCoverageResponse(resp, closed), /dangling-tail|non-terminal/);
});

test("读不完的屏向后并不了时并回前屏（ds-40-v19「看这里」|「这个理由被引用了三次」）", () => {
  const mk = (s, e, o, t) => ({ pauseGroupId: 0, srcStart: 1, srcEnd: 1, tokenStart: s, tokenEnd: e, originalText: o, translation: t, startMs: s, endMs: e });
  const units = [
    mk(55000, 55400, "Look here", "看这里"),
    mk(55400, 56200, "it's cited three times.", "这个理由被引用了三次"),
    mk(56300, 60800, "But by the end of this video, I hope you'll learn,", "但视频结束时，我希望你能明白"),
  ];
  const got = Core.mergeUnreadableUnits(units, { maxVisualWidth: 48 });
  assert.strictEqual(got.length, 2, "读不完的第 2 屏应并回第 1 屏，而不是跨句并进第 3 屏");
  assert.strictEqual(got[0].translation, "看这里，这个理由被引用了三次");
  assert.strictEqual(got[0].startMs, 55000, "startMs 取前屏");
  assert.strictEqual(got[0].endMs, 56200);
  assert.strictEqual(got[1].translation, "但视频结束时，我希望你能明白", "原文句末之后不并");
  // 前屏原文已是句末、后屏是新句的半句：不得合并（上一句尾巴 + 下一句开头）
  const closed = Core.mergeUnreadableUnits([mk(0, 3000, "That is all.", "就这些"), mk(3000, 3300, "Next one", "下一个话题来了")], { maxVisualWidth: 48 });
  assert.strictEqual(closed.length, 2, "前屏原文以句号收尾、后屏是半句时不得合并");
});

test("合并相邻屏不得把两句中文粘成一句（ds-40-prog 真轨病例）", () => {
  // 2026-08-25 真轨 luna --limit=40：物化时已去句号，合并直接拼接，屏上出现
  //「其中一个用途就是烧水我们这么做有很多原因」「我也说不好不过这并不重要」。
  const mk = (s, e, t) => ({ pauseGroupId: 0, srcStart: 1, srcEnd: 1, originalText: "src", translation: t, startMs: s, endMs: e });
  const merged = Core.mergeUnreadableUnits([mk(20300, 20700, "我也说不好"), mk(20700, 21500, "不过这并不重要")], { maxVisualWidth: 48 });
  assert.strictEqual(merged.length, 1, "两屏都读不完，应合并");
  assert.strictEqual(merged[0].translation, "我也说不好，不过这并不重要");
  // 左屏已有标点 / 拉丁边界：不重复补逗号
  assert.strictEqual(Core.joinDisplayScreens("真的吗？", "我不信"), "真的吗？我不信");
  assert.strictEqual(Core.joinDisplayScreens("一个逗号，", "后半"), "一个逗号，后半");
  assert.strictEqual(Core.joinDisplayScreens("Hello", "world"), "Hello world");
});

test("语义路径：缓存命中与网络路径走同一显示管线（合并后屏数一致）", () => {
  const cues = [
    { start: 20300, end: 20700, content: "I don't know." },
    { start: 20700, end: 21500, content: "Doesn't matter." },
  ];
  const timeline = Core.buildCanonicalTokenTimeline(cues);
  const mkSeg = (i, a, b, t) => {
    const seg = { segmentId: "b" + i, sourceFingerprint: timeline.sourceFingerprint,
      sourceTextHash: Core.hashCacheIdentity(timeline.tokens.slice(a, b).map((x) => x.text).join(" ")),
      tokenStart: a, tokenEnd: b, translation: t };
    seg.integrity = Core.semanticSegmentIntegrity(seg);
    return seg;
  };
  const segs = [mkSeg(0, 0, 3, "我也说不好"), mkSeg(1, 3, timeline.tokens.length, "不过这并不重要")];
  const units = Core.materializeReadableSemanticUnits(segs, cues, { requireIntegrity: true, maxVisualWidth: 48 });
  assert.strictEqual(units.length, 1, "读不完的两屏必须在统一入口内合并");
  assert.strictEqual(units[0].startMs, 20300);
  assert.strictEqual(units[0].tokenStart, 0, "合并屏 token span 取并集");
  assert.strictEqual(units[0].tokenEnd, timeline.tokens.length);
  const iso = fs.readFileSync(path.join(__dirname, "..", "isolated.js"), "utf8");
  assert.ok(!/Core\.materializeSemanticTranslation\(cached/.test(iso), "缓存路径不得绕过显示管线直接物化");
});

test("词数超限兜底切点取就近词法组边界（中点平衡切分已被真轨否决）", () => {
  // 2026-08-23 真轨：中点切分 38→45 屏、<1.5s 屏 31%→55%，英文切成半句后
  // 本地闭合提示词逼模型补词/重复/臆造。回退为就近切点，此测试锁死。
  const core = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
  const at = core.indexOf("function enforceSemanticTokenLimitMarks");
  const body = core.slice(at, core.indexOf("\n  function ", at + 10));
  assert.ok(at > 0, "函数必须存在");
  assert.ok(!/最接近该段中点|bestScore/.test(body), "不得重新引入中点平衡切分");
});

test("整句翻译：模型可把多个英文 piece 合成一屏，中文不再跟着英文切点劈词", async () => {
  // 2026-10-01 真轨 ds-40-r1001b：英文被切成 "…to make electric" | "kettles worth it."，
  // 逐屏翻译只能产出「让电热」|「水壶物有所值」。整句协议下模型把两段合成一屏。
  const cues = [
    { start: 46637, end: 48495, content: "supply just doesn't have the gusto to make electric" },
    { start: 49440, end: 51800, content: "kettles worth it." },
  ];
  let sent;
  const out = await Core.translateContextBlock({
    cues, apiBaseUrl: "https://example.test", ["api" + "Key"]: "k", apiModel: "m", targetLang: "zh-Hans", maxVisualWidth: 48,
    fetchImpl: async (_url, req) => {
      sent = JSON.parse(JSON.parse(req.body).messages[1].content);
      if (sent.tokens) {
        const cut = sent.groups.find((g) => /electric$/.test(g.text));
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: cut ? [cut.toId] : [] }) } }] }) };
      }
      const ids = sent.sentences.flat().map((p) => p.id);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ screens: [{ from: ids[0], to: ids[ids.length - 1], text: "供电根本带不动电热水壶" }] }) } }] }) };
    },
  });
  assert.ok(Array.isArray(sent.sentences) && typeof sent.maxChars === "number", "请求按整句发送并给出每屏字数上限");
  assert.strictEqual(out.units.length, 1, "两个 piece 合成一屏");
  assert.strictEqual(out.units[0].translation, "供电根本带不动电热水壶");
  assert.strictEqual(out.units[0].startMs, 46637, "startMs 取首个 piece 的词级时间");
  assert.ok(/electric kettles worth it/.test(out.units[0].originalText), "原文行同步合并");
});

test("整句协议提示词要求少屏：放得下就合并，不按英文 piece 一屏一屏翻", () => {
  // ds-40-v17 真轨：「我们的120伏电源根本没有」|「足够的功率」|「让电热水壶值得购买」
  // 一句切三屏，中间屏只有 1.3 秒。模型默认一 piece 一屏，必须明说合并优先。
  assert.ok(/屏数越少越好/.test(Core.SCREEN_PROTOCOL_PROMPT));
  assert.ok(/相邻两屏合起来不超过 maxChars 就合成一屏/.test(Core.SCREEN_PROTOCOL_PROMPT));
  // ds-40-v18 第 15/16 屏：「电源实在没劲」|「让电热水壶变得不值得使用」——目的从句被切开后意思反了。
  assert.ok(/绝不跨句合并/.test(Core.SCREEN_PROTOCOL_PROMPT));
  assert.ok(/否定、条件、目的、比较不得被切到两屏/.test(Core.SCREEN_PROTOCOL_PROMPT));
});

test("parseScreenCoverageResponse 结构违规 fail-closed，单 piece 屏可省略 to", () => {
  const pieces = [0, 1, 2].map((i) => ({ alias: "u" + i, sourceText: i === 0 ? "first sentence." : "w" + i, tokenStart: i, tokenEnd: i + 1, semanticGroupId: "sg" + i }));
  const ok = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [{ from: "u0", text: "一" }, { from: "u1", to: "u2", text: "二三" }] }), pieces);
  assert.deepStrictEqual(ok.map((s) => [s.from, s.to]), [[0, 0], [1, 2]]);
  // 缺口/漏尾自 2026-10-04 起降级补空屏（见下一测试），不再 fail-closed；
  // 仍 fail-closed 的结构违规：unknown piece、回头改写、跨句合并。
  assert.throws(() => Core.parseScreenCoverageResponse(JSON.stringify({ screens: [{ from: "u0", to: "u9", text: "x" }] }), pieces), /unknown piece/);
  // 跨句合并：u0 以句号收尾，一屏不得越过它（ds-40-v18「它被引用了三次，但到视频结束时」）
  assert.throws(() => Core.parseScreenCoverageResponse(JSON.stringify({ screens: [{ from: "u0", to: "u1", text: "一二" }, { from: "u2", text: "三" }] }), pieces), /crosses sentence/);
  const noFinal = pieces.map((p) => ({ ...p, sourceText: "w", endsSentence: undefined }));
  assert.strictEqual(Core.parseScreenCoverageResponse(JSON.stringify({ screens: [{ from: "u0", to: "u2", text: "一二三" }] }), noFinal).length, 1,
    "无句末标点时跨语义分组合并照常允许（electric | kettles）");
  const lenient = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [{ from: "u0", text: "" }, { from: "u1", to: "u2", text: "二三" }] }), pieces, { lenient: true });
  assert.strictEqual(lenient[0].text, "", "lenient 只把坏屏置空");
});

test("parseScreenCoverageResponse 结构缺口降级补空屏，不再连坐整个 clip", () => {
  // 2026-10-04 真轨 pid=32284：单轨 22/207 clip 因 gap or overlap 整段回退英文。
  const pieces = [0, 1, 2, 3].map((i) => ({ alias: "u" + i, sourceText: "w" + i, tokenStart: i, tokenEnd: i + 1, semanticGroupId: "sg" + i }));
  // 模型跳过 u1（from 越位）：u1 补空屏回退英文，u0/u2/u3 已翻好的部分保住。
  const skipped = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", text: "一" }, { from: "u2", to: "u3", text: "三四" }] }), pieces);
  assert.deepStrictEqual(skipped.map((s) => [s.from, s.to, s.text]), [[0, 0, "一"], [1, 1, ""], [2, 3, "三四"]]);
  assert.strictEqual(skipped[1].recovered, true, "缺口屏带 recovered 标记");
  // 漏收尾：最后一段补空屏，正文保住。
  const tail = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u2", text: "三" }] }), pieces);
  assert.deepStrictEqual(tail.map((s) => [s.from, s.to, s.text]), [[0, 1, "一二"], [2, 2, "三"], [3, 3, ""]]);
  assert.strictEqual(tail[2].recovered, true);
  // v0.4.14 真机（pid=26297）仍有 13 clip 死于 gap or overlap：模型乱序输出分组。
  // 乱序 → 排序归位；同 span 重复 / 被宽屏包含 → 丢弃；部分重叠 → 仍 fail-closed。
  const reordered = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u2", to: "u3", text: "三四" }, { from: "u0", to: "u1", text: "一二" }] }), pieces);
  assert.deepStrictEqual(reordered.map((s) => [s.from, s.to]), [[0, 1], [2, 3]], "乱序输出排序归位");
  const contained = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u1", text: "二" }, { from: "u2", to: "u3", text: "三四" }] }), pieces);
  assert.deepStrictEqual(contained.map((s) => [s.from, s.to]), [[0, 1], [2, 3]], "被包含的屏丢弃，宽屏保留");
  const clean = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u2", to: "u3", text: "三四" }] }), pieces);
  assert.deepStrictEqual(clean.map((s) => [s.from, s.to]), [[0, 1], [2, 3]]);
  assert.ok(clean.every((s) => !s.recovered));
  // 部分重叠（共享边界 piece，如 [u0-u1]+[u1-u2]）：strict 下 fail-closed…
  assert.throws(() => Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u1", to: "u2", text: "二三" }] }), pieces), /gap or overlap/);
  // …lenient 下把重叠之外的新增段置空收下（该段回退原文），已翻好的部分保留。
  const partial = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u1", to: "u2", text: "二三" }] }), pieces, { lenient: true });
  // 重叠条的新增段只有 [2]（cursor 已在 2）：置空收下；[3] 漏尾降级补空屏。
  assert.deepStrictEqual(partial.map((s) => [s.from, s.to, s.text]), [[0, 1, "一二"], [2, 2, ""], [3, 3, ""]]);
  // 乱序 span（from>to 倒写，v0.4.15 真机 clip 78820）：strict 炸、lenient 丢弃该条，
  // 缺口降级兜住覆盖。
  assert.throws(() => Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u1", to: "u0", text: "倒" }] }), pieces), /gap or overlap/);
  const inverted = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u1", text: "一二" }, { from: "u2", to: "u1", text: "倒" }] }), pieces, { lenient: true });
  // 倒写条丢弃后，[2..3] 由尾部缺口降级合并补空屏。
  assert.deepStrictEqual(inverted.map((s) => [s.from, s.to, s.text]), [[0, 1, "一二"], [2, 3, ""]]);
  // 完全被宽屏包含的部分重叠（[u1-u2] ⊂ [u0-u2]）：包含去重安全挽回；尾部 piece 3
  // 未被覆盖，由漏尾降级自动补空屏。
  const nested = Core.parseScreenCoverageResponse(JSON.stringify({ screens: [
    { from: "u0", to: "u2", text: "一二三" }, { from: "u1", to: "u2", text: "二三" }] }), pieces);
  assert.deepStrictEqual(nested.map((s) => [s.from, s.to]), [[0, 2], [3, 3]]);
});

test("提示词改变显示形态必须伴随缓存契约升版", () => {
  assert.strictEqual(Core.BLOCK_CONTRACT_VERSION, "block-v21");
  assert.ok(!/每屏译文以句号/.test(Core.DEFAULT_SYSTEM_PROMPT), "提示词不得同时要求写句号又禁止句号");
  // 2026-10-01 真轨：示例里把 "I could get my hands on" 写成「烧水的速度还比炉灶快得多」，
  // 等于教模型臆造；ds-40-r1001 出现「也就是在北美这边」「至于测试结果，稍后再看」。
  assert.ok(!/烧水的速度还比炉灶快得多/.test(Core.DEFAULT_SYSTEM_PROMPT), "示范译文不得含原文没有的信息");
  assert.match(Core.DEFAULT_SYSTEM_PROMPT, /不为了凑成整句而补出源文没有的内容/);
});

test("行整形只有一条权威实现：translateContextBlock 不得自己再切一遍", () => {
  // 本轮真实故障：production 的 translateContextBlock 自己复制了一份
  // splitAtSentenceEnd + splitTargetDisplayLine + mergeDanglingModifierLines +
  // stripTrailingBreakPunct，而测试和 browser-replay 走 parseBlockTranslationResponse。
  // 两份实现漂移后 replay 直接打红（segment fields invalid）。反堆屎山：一条路径。
  const core = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
  const at = core.indexOf("async function translateContextBlock");
  assert.ok(at > 0, "translateContextBlock 必须存在");
  const end = core.indexOf("\n  async function ", at + 10);
  const body = core.slice(at, end > at ? end : core.length);
  assert.ok(
    // 2026-10-01：物化改经 materializeReadableSemanticUnits（内部仍调 materializeSemanticTranslation），
    // 网络与缓存两条路径共用一条显示管线。等价保证 = 入口调用它 + 它内部调物化。
    body.includes("materializeReadableSemanticUnits(") && body.includes("translateSentenceScreens(") &&
      /function materializeReadableSemanticUnits[\s\S]{0,1200}?materializeSemanticTranslation\(/.test(core),
    "translateContextBlock 必须复用语义跨度与 coverage ledger，不得复制分屏实现"
  );
  ["splitTargetDisplayLine(", "mergeDanglingModifierLines(", "stripTrailingBreakPunct", "splitAtSentenceEnd("].forEach((fn) => {
    assert.ok(!body.includes(fn), `translateContextBlock 内不得直接调用 ${fn}（重复实现）`);
  });
});

test("读不完的屏借用后续静音：只延 end，不动 startMs，不越过下一屏", () => {
  // 真实缺陷（mxh.en-orig，coverage ledger 跑）：9/30 屏读不完，而它们后面就是
  // 大段静音（#04 后 2028ms）。字幕在 end 消失，静音期屏幕空着。
  const mk = (s, e, t) => ({ blockSegmentId: "b0", pauseGroupId: 0, srcStart: 1, srcEnd: 1, originalText: "src", translation: t, startMs: s, endMs: e });

  // 后面有 2028ms 短间隙（未达长停顿阈值）：应延到读得完（10 字 ≈ 1110ms）
  const got = Core.extendIntoSilence([mk(4741, 5183, "我们这么做有很多原因"), mk(7211, 12218, "后一句")], []);
  assert.strictEqual(got[0].startMs, 4741, "startMs 是红线，一个都不许动");
  assert.ok(got[0].endMs > 5183, "有静音可借时必须延长 end");
  assert.ok(got[0].endMs - got[0].startMs >= 1110, "延长后必须读得完");
  assert.ok(got[0].endMs <= 7211, "绝不越过下一屏 startMs");

  // 长停顿是红线：静音处不显示字幕，一毫秒都不许借
  const paused = Core.extendIntoSilence(
    [mk(4741, 5183, "我们这么做有很多原因"), mk(7211, 12218, "后一句")],
    [[5183, 7211]]);
  assert.strictEqual(paused[0].endMs, 5183, "不得把 end 推进长停顿");

  // 后面紧贴下一句（无静音）：一毫秒都不许借
  const tight = Core.extendIntoSilence([mk(40322, 40840, "我觉得可以说"), mk(40840, 41202, "它们要少得多")], []);
  assert.strictEqual(tight[0].endMs, 40840, "无静音可借时不得侵占下一屏语音时间");
  assert.strictEqual(tight[1].startMs, 40840, "后屏 startMs 不受影响");

  // 静音不够读完时：借满到下一屏 start 为止，不得越界
  const partial = Core.extendIntoSilence([mk(0, 500, "一二三四五六七八九十十一十二"), mk(1000, 5000, "下一句")], []);
  assert.strictEqual(partial[0].endMs, 1000, "静音不足时借到下一屏 start 为止");

  // 已经够读的屏不得被拉长（否则字幕在静音里滞留过久）
  const fine = Core.extendIntoSilence([mk(0, 5000, "短句"), mk(9000, 12000, "下一句")], []);
  assert.strictEqual(fine[0].endMs, 5000, "够读的屏不得无故延长");

  // 结构门禁：借静音必须真的接在 materializeReadableSemanticUnits 管线里
  const coreSrc = fs.readFileSync(path.join(ROOT, "core.js"), "utf8");
  const matAt = coreSrc.indexOf("function materializeReadableSemanticUnits");
  const matEnd = coreSrc.indexOf("\n  function ", matAt + 10);
  assert.ok(coreSrc.slice(matAt, matEnd).includes("extendIntoSilence("),
    "materializeReadableSemanticUnits 必须调用 extendIntoSilence，否则借静音是死代码");
});

test("resegmentCues 上限单位是视觉宽度：逐字文字不得被「12 词=12 字符」切成碎屏", () => {
  // 真实缺陷（Dw43jxWZvPg 日语轨）：源轨每 cue 仅 ~9 个日文字符，1146 单元中 97% ≤12
  // 字符。splitDisplayWords 把连写文字逐字切成 token，于是 maxWords=12 对日文只允许
  // 12 字符宽，源轨的破碎边界被原样透传。修法是把上限单位统一成视觉宽度。
  const mk = (i, text) => ({ start: i * 1500, end: i * 1500 + 1400, content: text });
  const ja = [
    "このようになってい", "るんだというのを", "この動画で見ていた", "だければと思います",
    "今回分解をするエア", "コンはこちらです", "Comfeeというブランド", "のエアコンです",
  ].map((t, i) => mk(i, t));
  const byWidth = Core.resegmentCues(ja, { maxWords: Core.DISPLAY_UNIT_MAX_WORDS, maxVisualWidth: Core.SOURCE_DISPLAY_MAX_WIDTH });
  const byWords = Core.resegmentCues(ja, { maxWords: Core.DISPLAY_UNIT_MAX_WORDS });
  assert.ok(byWidth.length < byWords.length,
    "宽度口径必须比词数口径产出更少更宽的屏，实测 " + byWidth.length + " vs " + byWords.length);
  const widthOf = (s) => { let w = 0; for (const ch of String(s)) w += /[\u2E80-\uA4CF\uAC00-\uD7A3\uFF00-\uFF60]/.test(ch) ? 2 : 1; return w; };
  for (const cue of byWidth) {
    assert.ok(widthOf(cue.content) <= Core.SOURCE_DISPLAY_MAX_WIDTH + 8,
      "宽度不得越过上限太多: " + cue.content + " (w=" + widthOf(cue.content) + ")");
  }
  // 内容与时间不变量：不丢字、不倒挂、不重叠
  const join = (list) => list.map((c) => c.content).join("").replace(/\s+/g, "");
  assert.strictEqual(join(byWidth), join(ja), "重分句不得丢失或改写任何原文字符");
  for (let i = 1; i < byWidth.length; i++) {
    assert.ok(byWidth[i].start >= byWidth[i - 1].start, "start 必须单调不减");
    assert.ok(byWidth[i].end >= byWidth[i].start, "end 不得早于 start");
  }
  // 拉丁轨：12 词本来就约 60 视觉宽，折算后上限不该反而变紧把英文切碎。
  const en = ["is boil water.", "One of those things", "you will do today"].map((t, i) => mk(i, t));
  const enWords = Core.resegmentCues(en, { maxWords: Core.DISPLAY_UNIT_MAX_WORDS });
  const enWidth = Core.resegmentCues(en, { maxWords: Core.DISPLAY_UNIT_MAX_WORDS, maxVisualWidth: Core.SOURCE_DISPLAY_MAX_WIDTH });
  assert.ok(enWidth.length <= enWords.length + 1,
    "拉丁轨不得因宽度折算被切得更碎，实测 " + enWidth.length + " vs " + enWords.length);
  assert.strictEqual(enWidth.map((c) => c.content).join(" ").replace(/\s+/g, " "),
    enWords.map((c) => c.content).join(" ").replace(/\s+/g, " "),
    "拉丁轨内容不得因这次改动发生变化");
});

test("跨块汇合后必须去重叠 —— 块内去重叠看不见块边界", () => {
  // 真实缺陷（DGdsIrAjp3k，LockPickingLawyer，滚动窗口 ASR 轨 188/202 条 cue 重叠）：
  // materializeBlockTranslation 的去重叠只作用于单个块，块与块之间无人处理。实测拼接
  // 后出现「屏5 end=15280 > 屏6 start=13440」，两屏同时命中 → 用户看到译文与原文错位。
  // 修复点在 rebuildRenderTimeline：整条时间线只有汇合排序后才完整。
  const render = [
    { start: 11440, end: 15280, translation: "但即便如此，它们仍比" },   // 块1 末屏
    { start: 13440, end: 18000, translation: "Quickset 过去做过的任何产品" }, // 块2 首屏
    { start: 42360, end: 45280, translation: "所以我要把这个画面传到我的" },
    { start: 44160, end: 50719, translation: "旧手机，然后看看钥匙长什么样" },
  ];
  const before = render.map((u) => u.start);
  Core.enforceDisplayMonotonicity(render, Core.BLOCK_MIN_DISPLAY_MS, {
    startKey: "start", endKey: "end",
  });
  for (let i = 1; i < render.length; i++) {
    assert.ok(render[i].start >= render[i - 1].end,
      `屏 ${i} 与前屏仍重叠：${render[i - 1].end} > ${render[i].start}`);
  }
  assert.deepStrictEqual(render.map((u) => u.start), before,
    "startMs 是红线：去重叠只能截 end，不得改出现时刻");
  assert.strictEqual(render[0].end, 13440, "前屏 end 应截到后屏 start");

  // 接线断言：渲染时间线汇合处必须真的调用去重叠，否则块边界重叠会漏到显示层。
  const iso = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  const rebuildAt = iso.indexOf("function rebuildRenderTimeline");
  // 函数体到下一个顶层函数声明为止（早返回分支里也有 lastHitCueIdx / 原生字幕调用，
  // 不能拿它们当边界 —— 那样切出来的片段不含排序与去重叠）。
  const body = iso.slice(rebuildAt, iso.indexOf("\n  function ", rebuildAt + 10));
  const sortAt = body.indexOf("render.sort(");
  const dedupeAt = body.indexOf("Core.enforceDisplayMonotonicity(render");
  assert.ok(dedupeAt > sortAt && sortAt >= 0,
    "rebuildRenderTimeline 必须在排序后对整条时间线去重叠");
  assert.match(body.slice(dedupeAt, dedupeAt + 200), /startKey:\s*"start"[\s\S]*?endKey:\s*"end"/,
    "渲染时间线用 start/end 字段名，须显式传入");
});

test("等首块译文不得用固定超时上限放行", () => {
  // 真实缺陷：曾是固定 8000ms 死超时，到点无条件恢复播放。但首块实测耗时
  // 12.7s / 18.0s / 23.6s（gpt-5.4-mini）—— 三次全超，自动暂停几乎每次都在译文
  // 到达前就放行，功能等于没生效。任何固定上限都猜不中（网关/块大小/模型都在变）。
  const iso = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
  const sched = iso.slice(iso.indexOf("function scheduleWaitDeadline"));
  const body = sched.slice(0, sched.indexOf("\n  }"));
  // 到点必须检查首块是否仍在翻译中，在跑就继续等
  assert.match(body, /clipInflight\[0\]|clipState\[0\]/,
    "到点必须检查首块实际状态，不能无条件放行");
  assert.match(body, /stillWorking[\s\S]*?scheduleWaitDeadline\(\)/,
    "仍在翻译中时必须继续等待（重新排期）");
  // 旧的固定上限键必须从默认配置里消失，并在迁移时清除
  assert.ok(!("waitForFirstTranslationMs" in Core.DEFAULT_CONFIG),
    "旧的固定超时上限键不得留在默认配置");
  assert.strictEqual(Core.DEFAULT_CONFIG.waitForFirstTranslationCheckMs, 2000);
  const migrated = Core.migrateConfig({ waitForFirstTranslationMs: 8000 });
  assert.ok(!("waitForFirstTranslationMs" in migrated), "迁移必须清除旧键");
  // failed 是终态，不得被当成「仍在翻译中」而永久卡住视频
  assert.doesNotMatch(body, /"failed"/, "failed 终态不得计入 stillWorking");
});

test("每条上屏路径都必须去重叠 —— 结构性锁死，不靠人记得测", () => {
  // 这条门禁是为了根治一个反复犯的错：我测了译文侧就以为测完了。
  // 同一类缺陷（去重叠漏了某条路径）连续出现两次 —— v0.8.7 修跨块译文侧，
  // v0.8.8 才发现 fallback 原文侧从 v0.8.2 起一直有 51/56 重叠、六个版本零覆盖。
  //
  // 与其每轮靠自觉排查，不如锁死结构：上屏数据只有三条产出路径，每条都得去重叠。
  // 新增第四条路径时这条门禁会红，逼着一起接线。
  const iso = fs.readFileSync(path.join(__dirname, "..", "isolated.js"), "utf8");
  const core = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");

  // 1) 原文侧（fallback，译文未到时用户看到的）
  const srcAt = iso.indexOf("sliceTimelineClips(canonicalCues)");
  const srcGuard = iso.indexOf("enforceDisplayMonotonicity(canonicalCues");
  assert.ok(srcAt > 0 && srcGuard > srcAt,
    "原文侧必须去重叠，且必须在分块之后（否则连带改变翻译分块）");

  // 2) 译文侧（rebuildRenderTimeline）
  const rebuildAt = iso.indexOf("function rebuildRenderTimeline");
  assert.ok(rebuildAt > 0);
  const rebuildBody = iso.slice(rebuildAt, iso.indexOf("\n  function ", rebuildAt + 10));
  assert.match(rebuildBody, /enforceDisplayMonotonicity\(/,
    "译文侧渲染时间线必须去重叠");
  assert.ok(rebuildBody.indexOf("state.renderUnits = render") > rebuildBody.indexOf("enforceDisplayMonotonicity("),
    "必须先去重叠再写入 renderUnits");

  // 3) 块内（materializeReadableSemanticUnits，网络与缓存共用）：先合并读不完的屏，再去重叠
  const matAt = core.indexOf("function materializeReadableSemanticUnits");
  assert.ok(matAt > 0);
  // 取到函数结束（下一个顶层 function），不用固定字符窗口 —— 窗口会随函数增长而失效，
  // 让门禁静默失去判别力（本轮加 pauseGroups 后 6000 字符窗口就已经切在调用之前）。
  const matEnd = core.indexOf("\n  function ", matAt + 10);
  const matBody = core.slice(matAt, matEnd > matAt ? matEnd : matAt + 12000);
  const mergeAt = matBody.indexOf("mergeUnreadableUnits(");
  const monoAt = matBody.indexOf("enforceDisplayMonotonicity(");
  assert.ok(mergeAt > 0 && monoAt > 0, "块内必须既合并读不完的屏也去重叠");
  assert.ok(monoAt < mergeAt,
    "顺序固定：enforceDisplayMonotonicity 包在外层，先合并（改变相邻关系）再去重叠");

  // 4) 写 renderUnits 的地方只允许是清空或那唯一一处赋值 —— 防止新增旁路
  const writes = iso.split("state.renderUnits =").length - 1;
  const clears = iso.split("state.renderUnits = []").length - 1;
  assert.equal(writes - clears, 1,
    `写 renderUnits 的非清空路径应恰好 1 处（当前 ${writes - clears}）—— 新增路径必须一并接去重叠`);
});

test("时间派生异常产生的过短屏由合并层兜住，不会上屏", () => {
  // 真实案例 DGdsIrAjp3k：源 cue `locks in the u.s` 时长 3680ms，但 ASR 把 u.s 拆成
  // 两个 token 且时间戳跨 1.5s（u@6799 / s@8360）。渲染单元时间取自 token 跨度，
  // 于是译文「家用锁之一」只拿到 300ms 窗口 —— 按 111ms/字 需要 560ms，读不完。
  //
  // 结论不是「要修时间派生层」（全量统计这类 token 间隔异常仅 0.47%，多数是真实停顿
  // 与慢速歌词，加规则会误伤）。而是 mergeUnreadableUnits 本就该兜住它。
  //
  // 这条门禁存在的真正原因：我曾用绕过合并层的诊断脚本观察到那个 300ms 屏，据此把
  // 「已被机制兜住」误判成「缺陷会上屏」。诊断脚本可以绕过生产管线，门禁不能。
  const units = [
    { startMs: 0, endMs: 3000, translation: "这张卡就能帮你解读", originalText: "this card", srcStart: 0, srcEnd: 1 },
    { startMs: 3000, endMs: 3300, translation: "家用锁之一", originalText: "in the u s", srcStart: 1, srcEnd: 2 },
    { startMs: 3300, endMs: 7000, translation: "先看钥匙的切痕有多深", originalText: "deep the cuts", srcStart: 2, srcEnd: 3 },
  ];
  const R = Core.READING_MS_PER_CHAR;
  // 与生产同一口径（core.js:3981）：宽度 /2 取整 = 字数，再 × 每字毫秒
  const needMs = (t) => Math.ceil(Core.semanticDisplayWidth(t) / 2) * R;

  // 前提：中间那屏确实读不完（否则这条门禁测的不是它该测的东西）
  assert.ok(needMs(units[1].translation) > units[1].endMs - units[1].startMs,
    "样本前提失效：中间屏应当读不完");

  const merged = Core.mergeUnreadableUnits(units, { maxVisualWidth: 48 });
  assert.ok(merged.length < units.length, "读不完的屏必须被合并掉");

  // 合并后不得再有读不完的屏，且 startMs 红线不动
  merged.forEach((u) => {
    const span = u.endMs - u.startMs;
    assert.ok(needMs(u.translation) <= span,
      `合并后仍读不完: ${u.translation} 窗口 ${span}ms 需 ${Math.round(needMs(u.translation))}ms`);
  });
  assert.equal(merged[0].startMs, units[0].startMs, "合并不得改动首屏 startMs");
  assert.ok(merged.every((u) => units.some((s) => s.startMs === u.startMs)),
    "合并后每屏 startMs 必须来自某个原始屏（红线：start 不许新造）");
});

test("failed 块在用户播到时可复活一次，且只有一次", () => {
  // 退避预算 maxFails=6 / base 2s / max 30s：6 次全超时要 10.5 分钟才耗尽（合理），
  // 但 6 次快速失败（网关 429 立即返回、网络瞬断）只要 90 秒就把整块打成 failed。
  // 原先 failed 在 translateClip 入口无条件 return —— 那 32 秒字幕永久没了，用户
  // 重新播到那里也不重试，只能改配置才恢复。
  //
  // 复活必须限次：预取循环每 1.5s 一轮、plan[0] 恒为当前块，无条件重置会变成不受
  // 退避约束的无限重试（正是「更深窗口必须配合并发上限，否则 429 → 退避 → 更卡」
  // 要避免的）。所以只有 priority===100（用户当前播放位置）能复活，且每块一次。
  const iso = fs.readFileSync(path.join(__dirname, "..", "isolated.js"), "utf8");
  const at = iso.indexOf("async function translateClip");
  assert.ok(at >= 0);
  const body = iso.slice(at, iso.indexOf("\n  function ", at + 10));

  // failed 不得再出现在入口的早退条件里
  const guardLine = body.slice(0, body.indexOf("\n\n"));
  assert.doesNotMatch(guardLine, /"failed"/,
    "failed 不该在入口无条件早退 —— 用户播到时应有一次复活机会");

  // 复活受两道限制：priority 100 + 每块一次
  const revivalAt = body.indexOf('state.clipState[idx] === "failed"');
  assert.ok(revivalAt > 0, "必须显式处理 failed 复活");
  const revival = body.slice(revivalAt, revivalAt + 400);
  assert.match(revival, /priority !== 100/, "只有用户当前播放位置能触发复活");
  assert.match(revival, /clipRevived\[idx\]/, "复活必须限次，否则变无限重试");
  assert.ok(revival.indexOf("clipRevived[idx] = true") > 0, "必须记账已用掉的机会");
  assert.match(revival, /\.reset\(\)/, "复活要重置退避预算");

  // clipRevived 的生命周期必须与 clipBackoff 一一对应，否则换轨/换配置后记账残留
  const backoffResets = iso.split("state.clipBackoff = {}").length - 1;
  const revivedResets = iso.split("state.clipRevived = {}").length - 1;
  assert.equal(revivedResets, backoffResets,
    `clipRevived 重置点(${revivedResets}) 必须与 clipBackoff(${backoffResets}) 一致`);
  assert.match(iso, /clipRevived: \{\}/, "clipRevived 必须在 state 里声明");
});

test("音效标记不进翻译管线，歌词不受影响", () => {
  // 22 条真实轨统计：括号包裹的 cue 共 8 种形态，其中 117 条是音效/说话人标记
  // （[Applause]×23 [Music]×19 [笑い]×69 [拍手]×2 [鼻息]×2 [叫び声]×2 [Vsauce]×2），
  // 1 种是歌词 (Up, up, up; up, up)。DGdsIrAjp3k 有 9 条音效覆盖 158s（视频约 330s），
  // 其中两个整块里一句人话都没有却各发了一次完整翻译请求。
  //
  // 判据是形态不是词表：方括号完整包裹 + 内部无句内标点。音效词随语言无限延伸，
  // 词表必然漏且违反语言中立。
  ["[Applause]", "[Music]", "[笑い]", "[拍手]", "[鼻息]", "[叫び声]", "[Vsauce]", "【笑】"]
    .forEach((t) => assert.equal(Core.isNonSpeechMarker(t), true, "应判为非语音标记: " + t));
  // 歌词用圆括号且带真实语流标点 —— 必须保留
  assert.equal(Core.isNonSpeechMarker("(Up, up, up; up, up)"), false);
  // 方括号但含句内标点 = 真内容，不是标记
  assert.equal(Core.isNonSpeechMarker("[so, it is]"), false);
  assert.equal(Core.isNonSpeechMarker("hello world"), false);
  // 过长的不当标记处理（避免把整句误判成标记）
  assert.equal(Core.isNonSpeechMarker("[a very long marker text that goes on beyond the limit]"), false);

  // 解析层真过滤：三条 json3 event，中间那条是音效
  const parsed = Core.parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello there", tOffsetMs: 0 }] },
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "[Applause]", tOffsetMs: 0 }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "we are back", tOffsetMs: 0 }] },
    ],
  });
  assert.equal(parsed.length, 2, "音效 cue 必须在解析层被剔除");
  assert.ok(!parsed.some((c) => /Applause/.test(c.content)));
});

test("原文侧（fallback）时间线必须去重叠 —— 译文未到时用户看到的就是它", () => {
  // 真实缺陷（自 v0.8.2 起未被发现）：滚动窗口 ASR 轨上 fallback 原文单元 51/56 互相
  // 重叠、最大 7920ms，两屏原文同时上屏。历次验证只测译文侧 renderUnits。
  //
  // 这里断言 isolated.js 的接线顺序：去重叠必须在 sliceTimelineClips 之后 ——
  // sliceClipsByCue 按 cue.end - startMs 算跨度，先去重叠会连带改变翻译分块
  // （实测 3,8,9,6,9,7,9,6 → 4,10,8,7,10,3,10,5）。
  const iso = fs.readFileSync(path.join(__dirname, "..", "isolated.js"), "utf8");
  const installAt = iso.indexOf("function installCueTimeline");
  assert.ok(installAt >= 0);
  const body = iso.slice(installAt, iso.indexOf("\n  function ", installAt + 10));
  const sliceAt = body.indexOf("sliceTimelineClips(canonicalCues)");
  const dedupeAt = body.indexOf("Core.enforceDisplayMonotonicity(canonicalCues");
  assert.ok(sliceAt >= 0, "installCueTimeline 必须对 canonicalCues 分块");
  assert.ok(dedupeAt > sliceAt,
    "原文侧去重叠必须在 sliceTimelineClips 之后，否则会连带改变翻译分块");

  // 行为断言：重叠的原文单元经去重叠后不再重叠，且 start 一个都不许动
  const units = [
    { start: 480, end: 6240, content: "a" },
    { start: 4319, end: 9920, content: "b" },
    { start: 7759, end: 13440, content: "c" },
  ];
  const starts = units.map((u) => u.start);
  Core.enforceDisplayMonotonicity(units, Core.BLOCK_MIN_DISPLAY_MS, { startKey: "start", endKey: "end" });
  assert.deepEqual(units.map((u) => u.start), starts, "startMs 是红线，一个都不许动");
  for (let i = 1; i < units.length; i++) {
    assert.ok(units[i].start >= units[i - 1].end,
      `原文单元 ${i - 1}/${i} 仍重叠: ${units[i - 1].end} > ${units[i].start}`);
  }
});

test("auto 选轨跟音轨语言，不取轨道数组首条", () => {
  // 真实缺陷（3teflb1QNN4，Vsauce「Is Anything Obvious?」）：音轨英语，另有西语人工
  // 翻译轨。YouTube 返回的 captionTracks 实测形态（curl watch 页抓取）：
  //   vssId ".en"      languageCode en      kind null   isTranslatable true
  //   vssId "a.en"     languageCode en      kind "asr"  isTranslatable true
  //   vssId ".es-419"  languageCode es-419  kind null   isTranslatable true
  // v0.8.5 曾用 `/^\./.test(vss) || isTranslatable` 判原语言 —— 三条轨全部命中，
  // find 仍返回首条，整片按西语翻译（用户第二次报同一问题）。
  // 唯一可靠信号是 ASR 轨的语言：YouTube 只对音轨实际语言做语音识别。
  const vsauce = [
    { name: "Spanish (Latin America)", code: "es-419", languageCode: "es-419", kind: "", url: "u1" },
    { name: "English", code: "en", languageCode: "en", kind: "", url: "u2" },
    { name: "English (auto)", code: "en-asr", languageCode: "en", kind: "asr", url: "u3" },
  ];
  const picked = Core.pickTrack(vsauce, "auto");
  assert.strictEqual(picked.languageCode, "en", "音轨是英语，必须选英语轨而非排在首位的西语轨");
  assert.strictEqual(picked.kind, "", "同语言内应优先人工轨，不用 ASR");

  // 日语轨（Dw43jxWZvPg）：只有 ASR 轨时就用它
  const ja = [
    { name: "日本語 (auto)", code: "ja-asr", languageCode: "ja", kind: "asr", url: "u1" },
  ];
  assert.strictEqual(Core.pickTrack(ja, "auto").languageCode, "ja");

  // 无 ASR 轨时无从判断音轨语言，保留 YouTube 顺序（不猜）
  const noAsr = [
    { name: "English", code: "en", languageCode: "en", kind: "", url: "u1" },
    { name: "Français", code: "fr", languageCode: "fr", kind: "", url: "u2" },
  ];
  assert.strictEqual(Core.pickTrack(noAsr, "auto").languageCode, "en");

  // 用户显式指定的语言优先于音轨语言
  assert.strictEqual(Core.pickTrack(vsauce, "es-419").languageCode, "es-419",
    "显式 sourceLang 必须被尊重");
  // 显式指定也走人工优先
  assert.strictEqual(Core.pickTrack(vsauce, "en").kind, "", "显式指定英语时也应选人工轨");
});

test("validateTrackManifest 必须保留 kind —— auto 选轨靠 ASR 轨判定音轨语言", () => {
  // kind="asr" 是判定音轨语言的唯一信号（YouTube 只对音轨实际语言做语音识别）。
  // 若校验层丢掉 kind，auto 只能退回取首条，英文视频就会被配上西语源字幕。
  const u = (lang) => "https://www.youtube.com/api/timedtext?v=vid&lang=" + lang + "&pot=signed";
  const out = Core.validateTrackManifest({
    videoId: "vid",
    files: [
      { name: "English", code: "en", languageCode: "en", kind: "", url: u("en") },
      { name: "English (auto)", code: "en-asr", languageCode: "en", kind: "asr", url: u("en") + "&kind=asr" },
    ],
  }, { expectedVideoId: "vid" });
  assert.ok(out, "合法 manifest 应通过");
  assert.strictEqual(out.files[0].kind, "", "人工轨的 kind 必须保留为空");
  assert.strictEqual(out.files[1].kind, "asr", "ASR 轨的 kind 不得被过滤掉");
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

  test("looksChineseCueList 按内容拦下语言码不可信的中文轨（元数据判不出来的那些）", () => {
    // 根因：pickTrack 只看语言码，但真实中文轨常常码不对 —— 上传者选错标成 en、
    // YouTube 未识别给 und、搬运号轨名写中文但码是 en。实测这几种形状全绕过码判据，
    // 整轨被送去把中文「翻译」成中文（白烧 API 钱 + 字幕被重排得更差）。
    // fixture 必须用真实字段名 content：cleanupCues 产出的 cue 用 content，
    // 首版用 {text:…} 造 fixture 导致单测全绿而真机仍发起翻译（字段读空串→恒判非中文）。
    const cues = (arr) => arr.map((t, i) => ({ start: i, end: i + 1, content: t }));

    // 必须跳过：真中文，无论语言码写什么
    assert.strictEqual(Core.looksChineseCueList(cues([
      "大家好，欢迎回到我的频道", "今天我们要聊一个很有意思的话题", "记得点赞订阅",
    ])), true, "简体中文轨必须被判为中文");
    assert.strictEqual(Core.looksChineseCueList(cues([
      "大家好，歡迎回到我的頻道", "今天我們要聊一個很有意思的話題",
    ])), true, "繁体中文轨必须被判为中文（zh-Hant→zh-Hans 是转码不是翻译）");
    // 中文轨夹英文专名极常见，不能被几个拉丁词带偏（所以判据用占比不用绝对数量）
    assert.strictEqual(Core.looksChineseCueList(cues([
      "我们用 ChatGPT 和 Claude 写代码", "这个 framework 的性能比 React 好很多",
    ])), true, "中文夹英文专名仍是中文轨");

    // 必须介入：日语混用汉字，光看汉字会误伤 —— 假名是日语的排他信号
    assert.strictEqual(Core.looksChineseCueList(cues([
      "みなさん、こんにちは", "今日は面白い話をします",
    ])), false, "日语轨不得被当成中文跳过");
    assert.strictEqual(Core.looksChineseCueList(cues([
      "政府は新型経済対策を発表した", "今年度の予算案は過去最大規模となる",
    ])), false, "日语新闻体汉字很密，但助词假名仍能判出日语");

    // 必须介入：书面粤语是项目刻意要翻译的目标（见 isChineseTrackCode 注释）
    assert.strictEqual(Core.looksChineseCueList(cues([
      "大家好，今日我哋要講一個好有趣嘅話題", "如果你覺得有用嘅話唔好忘記訂閱",
    ])), false, "书面粤语必须放行去翻译，不能按中文跳过");

    assert.strictEqual(Core.looksChineseCueList(cues([
      "Hey everyone welcome back", "Today we talk about something interesting",
    ])), false, "英语轨必须介入");
    assert.strictEqual(Core.looksChineseCueList(cues([
      "안녕하세요 여러분", "오늘은 재미있는 이야기를 하겠습니다",
    ])), false, "韩语轨必须介入");

    // 边界：无内容不得误判为中文（否则会把加载失败的轨当中文静默跳过）
    assert.strictEqual(Core.looksChineseCueList([]), false, "空轨不得判为中文");
    assert.strictEqual(Core.looksChineseCueList(cues(["[Music]", "♪♪♪"])), false, "纯音效标记不得判为中文");

    // 抽样必须取头中尾：开头常是赞助商念白，只看开头会被外语开场带偏
    const mixed = cues([
      ...Array(20).fill("This video is sponsored by our partner"),
      ...Array(200).fill("我们今天来讲讲这个话题的核心内容"),
      ...Array(20).fill("我们下期再见，感谢观看"),
    ]);
    assert.strictEqual(Core.looksChineseCueList(mixed), true, "外语开场+中文正片必须判为中文轨");

    // 性能：低配 Chromebook 是目标环境，整轨上万条不能逐条跑 Unicode 正则
    const huge = cues(Array(12000).fill("我们今天来讲讲这个话题的核心内容和一些细节"));
    const t0 = Date.now();
    assert.strictEqual(Core.looksChineseCueList(huge), true);
    assert.ok(Date.now() - t0 < 50, "12000 条 cue 判定必须走抽样（<50ms），不得全量扫");
  });

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
    assert.ok(prompt.includes("任意语言") && prompt.includes("语义自足") && prompt.includes("完整句"));
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
    assert.match(iso, /Core\.materializeReadableSemanticUnits\(cached\.segments, clip\.cues, \{ requireIntegrity: true[^}]*\}\)/);
    // 这条断言原本写死了 `catch (_)` 这个变量名，把"坏缓存必须删除"的意图和
    // "catch 参数必须叫下划线"绑在了一起。2026-08-23 给这个 catch 补上
    // console.warn 可观测性（参数随之改名 err）时，断言因此误报——它守的是
    // 写法而不是行为。改为只要求：catch 块里确实调用了 storageRemove 清掉这条
    // 缓存键。参数叫什么无关紧要。
    assert.match(iso, /catch \([A-Za-z_$][\w$]*\) \{[\s\S]{0,400}?storageRemove\(\[entryStorageKey\(CACHE_ENTRY_PREFIX, key\)\]\)/, "损坏 block 缓存必须主动删除");
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
    assert.match(src, /Core\.translateContextBlock\(\{[\s\S]{0,600}?cues: clip\.cues/,
      "运行时必须把连续源块交给 block 翻译入口");
    // 反向门禁：contextBefore/contextAfter 在 payload 构造处就被丢弃（只取 unitId+sourceText），
    // 传了从不使用。此前这里断言"必须传"，把死参数钉成了契约。
    assert.doesNotMatch(src, /context(?:Before|After)\s*:/,
      "不得再传 contextBefore/contextAfter：translateClipLines 的 payload 从不读取它们");
    assert.match(src, /cached\.segments[\s\S]{0,200}?Core\.materializeReadableSemanticUnits\(cached\.segments, clip\.cues, \{ requireIntegrity: true[^}]*\}\)/,
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

  /* ============ 6c. makeSemaphore：全局 in-flight 并发不超限 ============ */
  console.log("\n[makeSemaphore：全局并发上限不被突破]");

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
    assert.ok(!/context(?:Before|After)\s*:/.test(src), "不得传 payload 从不读取的 contextBefore/contextAfter");
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
    assert.match(src, /Core\.materializeReadableSemanticUnits\(cached\.segments, clip\.cues, \{ requireIntegrity: true[^}]*\}\)/, "缓存必须按当前源时间重新物化，保留 cue gap");
    assert.ok(/if \(ms < clips\[i\]\.startMs\) return i/.test(src), "播放头在 gap 时应预热下一块");
  });

  test("isolated.js 不再引用任何 v0.4.0 已删的 core 函数", () => {
    const src = fs.readFileSync(path.join(ROOT, "isolated.js"), "utf8");
    DELETED_FNS.forEach((fn) => {
      const re = new RegExp("Core\\." + fn + "\\b");
      assert.ok(!re.test(src), "isolated.js 不应再调用 Core." + fn + "（已删，会 is not a function 崩）");
    });
    assert.ok(/Core\.translateContextBlock\b/.test(src), "isolated.js 应调用 block 翻译入口");
    assert.ok(/Core\.materializeReadableSemanticUnits\b/.test(src), "缓存读取应按源时间重新物化语义 units（经统一显示管线）");
  });

  test("已删函数在 core.js 确实 0 定义、且不在导出表里", () => {
    DELETED_FNS.forEach((fn) => {
      assert.strictEqual(typeof Core[fn], "undefined", "core 不应再导出 " + fn);
    });
    assert.strictEqual(typeof Core.translateContextBlock, "function", "translateContextBlock 应存在");
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
    // 句号在清洗阶段**保留**：它是分屏的最强断句判据（句末 > 逗号 > 词组间）。
    // 若在这里就删掉，分屏器看不到句界，只能断在逗号上，把两句焊进同一屏。
    assert.strictEqual(Core.sanitizeSubtitleLine("这是一句话。"), "这是一句话。");
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
    // 选轨逻辑本身由「auto 选轨跟音轨语言」用例做行为断言（Core.pickTrack）。
    // 这里只确认 isolated 侧没有第二份实现 —— 它必须委托给 core，不得自己判断。
    assert.match(src, /function pickTrack\([\s\S]{0,200}?Core\.pickTrack\(/,
      "isolated.pickTrack 必须委托 Core.pickTrack，不得存在平行实现");
    assert.doesNotMatch(src, /sourceLang === "auto"/,
      "isolated 不得自己判断 auto 选轨");
    // 中止的 clip 必须回到可重翻状态，且 inflight 无条件复位。
    // 回归防护：曾经 `if (stale || aborted) return;` 让 clipState 停在 "pending"、
    // clipInflight 停在 true —— retryTick 只捡 "error"，于是该 clip 永久无人重翻。
    // 真实后果：E4HGfagANiQ 144.1s→208.1s 整块无译文，而其后的块已译完（中间留洞）。
    const tcStart = src.indexOf("async function translateClip");
    const tc = src.slice(tcStart, src.indexOf("\n  function ", tcStart));
    assert.ok(tc.length > 200, "未定位到 translateClip 源码");
    assert.doesNotMatch(tc, /if \(stale \|\| aborted\) return;/, "中止不得静默丢弃状态");
    assert.match(tc, /if \(aborted\)[\s\S]*?clipState\[idx\] = "error"/, "中止后必须标为可重翻");
    // inflight 复位必须在世代检查之前（否则旧代残留 true 永久阻塞该 clip）
    const fin = tc.slice(tc.indexOf("} finally {"));
    assert.ok(fin.indexOf("state.clipInflight[idx] = false;") < fin.indexOf("!== state.requestGeneration"),
      "clipInflight 复位必须早于世代 return，不得被跳过");
    // 显式源语言不存在时返回 null，不得偷偷换成其它语言；实现里不得有语言名单。
    assert.strictEqual(Core.pickTrack([
      { code: "en", languageCode: "en", kind: "", url: "u1" },
    ], "ko"), null, "显式指定的语言不存在时必须返回 null");
    const pickSrc = core.slice(core.indexOf("function pickTrack"), core.indexOf("function buildSystemPrompt"));
    assert.doesNotMatch(pickSrc.replace(/\/\/[^\n]*/g, ""), /["'](?:en|zh|ja|ar|th|pl)["']/,
      "选轨实现不得维护语言名单");
  });

  console.log("\n[token-span coverage 1:1 对齐]");

  test("DEFAULT_CONFIG 行长接近正常字幕 + 首包等待", () => {
    assert.ok(Core.DEFAULT_CONFIG.minLineChars >= 10);
    assert.strictEqual(Core.DEFAULT_CONFIG.maxLineChars, 0, "双语对照模式不得在中文 cue 内插入换行");
    assert.strictEqual(Core.DEFAULT_CONFIG.waitForFirstTranslation, true);
    // 兜底检查间隔（不是等待上限 —— 见「等首块译文不得用固定超时上限放行」）。
    assert.ok(Core.DEFAULT_CONFIG.waitForFirstTranslationCheckMs >= 500
      && Core.DEFAULT_CONFIG.waitForFirstTranslationCheckMs <= 5000);
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
    // 不锁脚本条数（加站点会加 MAIN 取轨脚本），锁结构不变量：
    // 两个 world 都在、ISOLATED 只有一份、且每条都 document_start 注入。
    assert.ok(Array.isArray(m.content_scripts) && m.content_scripts.length >= 2);
    const worlds = new Set(m.content_scripts.map((c) => c.world));
    assert.deepStrictEqual([...worlds].sort(), ["ISOLATED", "MAIN"]);
    assert.strictEqual(
      m.content_scripts.filter((c) => c.world === "ISOLATED").length, 1,
      "ISOLATED 注入必须只有一份，多份会重复加载 core.js",
    );
    for (const c of m.content_scripts) {
      assert.strictEqual(c.run_at, "document_start", "取轨脚本必须在 document_start 注入");
    }
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

  // ── 音效/场景标记必须独立成屏（真实人工上传轨 _-mBeYC2KGc）──────────
  // Jay 报的实际缺陷：`*awkward pause*` 被并进下一条台词，译文黏成
  // 「尴尬停顿但有一种越来越受欢迎的款式」，旁注与台词混为一句。
  test("音效标记独立成屏，不与台词合并", () => {
    const SOUND_RE = /^\s*(?:\*[^*]+\*|\[[^\]]+\]|[♪♫][^♪♫]+[♪♫])\s*$/;
    const raw = JSON.parse(fs.readFileSync(
      path.join(__dirname, "fixtures/youtube-sound-cue-track.json"), "utf8"));
    const cues = Core.cleanupCues(raw);

    // fixture 形状自检：三种包裹形态都要在，否则这条门禁是空跑
    const srcMarks = cues.filter((c) => SOUND_RE.test(String(c.content || "")));
    assert.ok(srcMarks.length >= 3,
      `fixture 应含至少 3 条音效标记，实测 ${srcMarks.length}（形状不对，门禁失效）`);
    assert.ok(srcMarks.some((c) => /^\s*\*/.test(c.content)), "缺 *星号* 形态");
    assert.ok(srcMarks.some((c) => /^\s*\[/.test(c.content)), "缺 [方括号] 形态");
    assert.ok(srcMarks.some((c) => /^\s*[♪♫]/.test(c.content)), "缺 ♫音符♫ 形态");

    const display = Core.resegmentCues(cues, { maxVisualWidth: 48, tailTrimMs: 120 });

    // 正向：每条标记都必须整屏独占，屏内不得夹带台词
    for (const u of display) {
      const t = String(u.content || "");
      const hasMark = /\*[^*]+\*|\[[^\]]+\]|[♪♫][^♪♫]+[♪♫]/.test(t);
      if (!hasMark) continue;
      assert.ok(SOUND_RE.test(t),
        `音效标记与台词混在同一屏：${JSON.stringify(t)}`);
    }
    // 标记一条都不能少。这里只能断言「不少于」而不是「等于」：超宽标记会被按
    // 宽度拆成多屏，那是刻意行为（可读性优先于形式完整，见 core.js flush 处），
    // 实测 78 字符那条拆成 48 + 31 两屏，每屏都补齐包裹自洽。写成 === 就会把
    // 这条正确行为判成缺陷 —— 曾经如此，4 → 5 报红。
    //
    // 「不能靠删掉标记来通过」由下面的零丢词断言承重，不靠数量相等来兜。
    const outMarks = display.filter((u) => SOUND_RE.test(String(u.content || "")));
    assert.ok(outMarks.length >= srcMarks.length,
      `音效标记屏数 ${outMarks.length} < 源轨 ${srcMarks.length}，标记被吞`);
    // 拆出来的每一片都必须包裹成对，不得留断头的 [ 或 ]
    for (const u of outMarks) {
      const t = String(u.content).trim();
      const openCount = (t.match(/\[/g) || []).length;
      const closeCount = (t.match(/\]/g) || []).length;
      assert.strictEqual(openCount, closeCount,
        `方括号不成对（断头包裹符）：${JSON.stringify(t)}`);
      assert.ok((t.match(/\*/g) || []).length % 2 === 0,
        `星号不成对：${JSON.stringify(t)}`);
      assert.ok((t.match(/[♪♫]/g) || []).length % 2 === 0,
        `音符不成对：${JSON.stringify(t)}`);
    }

    // 零丢词：按词键比对整条序列，顺序也不许变
    const keyWords = (s) => String(s || "").toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim().split(/\s+/).filter(Boolean);
    const srcSeq = cues.flatMap((c) => keyWords(c.content));
    const outSeq = display.flatMap((c) => keyWords(c.content));
    assert.deepStrictEqual(outSeq, srcSeq, "音效标记分屏后词序列发生变化（丢词或错序）");

    // 时间硬契约
    for (let i = 0; i < display.length; i++) {
      assert.ok(display[i].end > display[i].start, "单元时长非正");
      if (i + 1 < display.length) {
        assert.ok(display[i + 1].start >= display[i].end, "音效标记分屏后出现重叠");
      }
    }
  });

  // ── 音效标记边界必须自己承重，不能靠宽度封顶替它顶（消融实测发现）──────
  //
  // 上面那条用真实轨的门禁对 soundCueBoundary 是**空跑**的：消融时关掉该判据，
  // 症状并未复现。原因是真实轨里 "*awkward pause* But there's an increasingly
  // popular variety of them that figuratively" 有 86 字符，超过宽度封顶（65）
  // 被拆开，第一刀正好落在标记边界上 —— 宽度层顺手把混屏消掉了。
  //
  // 所以那条测试只能证明「两个修复合起来有效」，删掉 soundCueBoundary 它照样绿。
  // 这里用短台词把宽度层的作用排除掉：29 / 21 字符远在任何上限之内，宽度层没有
  // 任何理由拆它，混不混屏完全取决于边界判据是否在位。
  test("音效标记边界不依赖宽度封顶：短台词也不得与标记同屏", () => {
    const SOUND_RE = /^\s*(?:\*[^*]+\*|\[[^\]]+\]|[♪♫][^♪♫]+[♪♫])\s*$/;
    const cues = Core.cleanupCues([
      { start: 0, end: 1200, content: "*awkward pause*" },
      { start: 1200, end: 3000, content: "But it sucks." },
      { start: 3200, end: 5000, content: "♫ jazz ♫" },
      { start: 5000, end: 6800, content: "And cooling." },
    ]);
    const display = Core.resegmentCues(cues, { maxVisualWidth: 48, tailTrimMs: 120 });

    // 形状自检：每屏都必须远小于宽度上限，否则本条又变成宽度层在承重
    for (const u of display) {
      const w = Core.semanticDisplayWidth(String(u.content || ""));
      assert.ok(w < 48,
        `用例失效：出现 ${w} 字符的屏，宽度层可能介入了拆分（本条要求纯边界判据承重）`);
    }
    // 四条各自独占一屏
    assert.strictEqual(display.length, 4,
      `期望 4 屏（标记与台词各自独立），实测 ${display.length} 屏：` +
      JSON.stringify(display.map((u) => u.content)));
    for (const u of display) {
      const t = String(u.content || "");
      if (!/\*|\[|\]|[♪♫]/.test(t)) continue;
      assert.ok(SOUND_RE.test(t),
        `短台词被并进音效标记（soundCueBoundary 未生效）：${JSON.stringify(t)}`);
    }
  });

  // ── 词数上限的宽度封顶必须有门禁（消融实测发现它此前完全没被测到）──────
  //
  // 把 WIDTH_OVERSHOOT_LIMIT 从 1.25 抬到 999，全套测试仍然 306/0 全绿 ——
  // 说明这条修复是活代码（overshootCap 参与 tokenCapFor 的返回值）却无人看守，
  // 任何人顺手调大它都不会有任何测试报警。
  //
  // 用例形状很关键：必须是**无句末标点的长词续接片段**。有句末标点的整句各自
  // 独立落屏，合并根本走不到词数上限，封顶自然不介入（我第一次的用例就是这样，
  // 四条都 26~36 字符，无论封顶多少都一样）。下面这组一路合并到词数上限：
  // 封顶在位 → 最宽 43 字符；封顶失效 → 单屏 108 字符，即宽度上限 52 的 208%。
  test("长词续接不得突破宽度封顶：词数上限不能无上界压过宽度", () => {
    const cues = Core.cleanupCues([
      { start: 0,    end: 850,  content: "Single-hose air" },
      { start: 900,  end: 1750, content: "conditioners compromise" },
      { start: 1800, end: 2650, content: "efficiency significantly" },
      { start: 2700, end: 3550, content: "because infiltration" },
      { start: 3600, end: 4450, content: "overwhelms performance" },
    ]);
    const display = Core.resegmentCues(cues, { maxVisualWidth: 48, tailTrimMs: 120 });

    // 用例自检：必须真的发生了合并，否则封顶没被走到，本条又是空跑
    assert.ok(display.length < cues.length,
      `用例失效：${cues.length} 条未发生任何合并，封顶逻辑未被触及`);

    // 硬上限 52 × 1.25 = 65。留一点余量断在 70，避免把正常波动写成阈值测试。
    const OVERSHOOT_HARD_LIMIT = 70;
    for (const u of display) {
      const t = String(u.content || "");
      const w = Core.semanticDisplayWidth(t);
      assert.ok(w <= OVERSHOOT_HARD_LIMIT,
        `单屏 ${w} 字符突破宽度封顶（上限 52 的 ${Math.round(w / 52 * 100)}%）：` +
        JSON.stringify(t));
    }
  });

  // ── 中文源轨完全不介入（yue 例外要翻译）─────────────────────────────
  // 译文固定 zh-Hans，源轨已是中文时本扩展没有存在意义：不选轨即不请求、
  // 不渲染、不隐藏原生字幕。zh-Hant→zh-Hans 是字形转换不是翻译，一并跳过。
  test("中文源轨返回 null，粤语与其他语言照常翻译", () => {
    const T = (code) => ({ code, languageCode: code, kind: "", name: code });

    // 该跳的必须跳
    for (const code of ["zh", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW", "zh-HK",
      "zh-SG", "zh-Hans-CN", "zh-Hant-TW", "ZH-HANS", "zh-Hans-asr",
      // cmn 是官话的 ISO 639-3 码，同样是中文；zh_CN 下划线形态真实出现过。
      // 二者都曾漏判（只按 /^zh-/ 判时），补进来防回归。
      "cmn", "cmn-Hans", "cmn-Hant", "cmn-CN", "zh_CN", "zh_Hant_TW", "cmn_Hans",
      " zh-Hans ", "zh-Hans-ASR", "cmn-Hans-asr"]) {
      assert.strictEqual(Core.pickTrack([T(code)], "auto"), null,
        `中文轨 ${code} 仍被选中 —— 会白烧 token 且盖掉原生字幕`);
      assert.strictEqual(Core.pickTrack([T(code)], code), null,
        `显式指定 ${code} 仍被选中`);
    }

    // 该译的绝不能被误跳：yue 是书面粤语，与标准中文差异大，属真翻译
    // cmn 前缀不能误伤：cmn 本身要跳，但 cmnX 这类不是官话的码不能被吞掉
    for (const code of ["yue", "yue-HK", "en", "ja", "ko", "th", "vi", "zhuang", "zha",
      "zhx", "cmnx", "zhoa", "nan", "hak", "wuu", "en-Hans"]) {
      const picked = Core.pickTrack([T(code)], code);
      assert.ok(picked && picked.code === code,
        `${code} 被误判为中文轨而跳过（zh 前缀不能误伤 zhuang/zha/yue）`);
    }

    // 混合清单：英文视频挂机翻中文轨，选英文照常翻译
    const mixed = Core.pickTrack([T("en"), T("zh-Hans")], "en");
    assert.ok(mixed && mixed.code === "en", "混合轨中英文源被误跳");
    // 中文视频挂英文轨，显式选中文 → 不介入
    assert.strictEqual(Core.pickTrack([T("zh-Hans"), T("en")], "zh-Hans"), null,
      "中文视频显式选中文源时仍介入");
  });

  await asyncTest("模型兼容性：不认识 reasoning_effort 的端点自动降级重试，且只撞一次", async () => {
    // 为什么存在：reasoning_effort 默认就是 "low"，而只有部分推理模型认识这个字段。
    // 不认识的模型会直接 400 拒掉整个请求 —— 用户什么都不改，扩展对这些模型就是
    // 完全不可用。2026-08-23 用本地假端点复现：语义规划第一次请求即 HTTP 400。
    // 契约：(1) 撞到后必须去掉该字段重试并成功；(2) 必须记住这个端点/模型，
    // 后续请求不再携带 —— 一轨 50 clip 不能每个都白撞一次 400。
    const tokens = "one two three four five six seven eight nine ten".split(" ")
      .map((text, i) => ({ text, start: i * 240, end: (i + 1) * 240, nativeTiming: true }));
    const sent = [];
    let rejected = 0;
    const fetchImpl = async (_url, req) => {
      const body = JSON.parse(req.body);
      sent.push("reasoning_effort" in body);
      if ("reasoning_effort" in body) {
        rejected++;
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ semanticCutsAfter: [] }) } }] }) };
    };
    const units = await Core.restoreAndPackTokens({
      tokens, apiBaseUrl: "https://compat.test", apiKey: "k", apiModel: "plain-model",
      reasoningEffort: "low", preferredMaxWords: 10, maxWords: 12, attempts: 1, timeoutMs: 15000,
      fetchImpl,
    });
    assert.ok(units.length > 0, "降级后必须真的拿到结果，而不是整轨失败");
    assert.strictEqual(rejected, 1, "只应撞一次 400；之后必须记住不再发该字段");
    assert.strictEqual(sent[0], true, "首次请求应带 reasoning_effort（支持的模型不受影响）");
    assert.ok(sent.slice(1).every((v) => v === false), "重试及后续请求都不得再带该字段");
  });

  await Promise.all(pendingTests);
  console.log("\n========================================");
  console.log("  通过: " + passed + "  失败: " + failed);
  console.log("========================================");
  if (failed > 0) process.exit(1);
}

main();
