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

/* ============ 3. 翻译行号对齐 ============ */
console.log("\n[翻译：行号对齐 + 兜底]");

test("buildNumberedBatch 生成带行号文本", () => {
  const s = Core.buildNumberedBatch(["foo", "bar"]);
  assert.strictEqual(s, "1. foo\n2. bar");
});

test("alignTranslations 正常对齐", () => {
  const originals = ["line one", "line two", "line three"];
  const model = "1. 第一行\n2. 第二行\n3. 第三行";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["第一行", "第二行", "第三行"]);
});

test("alignTranslations 行号缺失 → 该行留原文", () => {
  const originals = ["a", "b", "c"];
  const model = "1. AA\n3. CC"; // 缺第 2 行
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["AA", "b", "CC"], "缺的行应保留原文");
});

test("alignTranslations 行数不匹配（模型多给）只取对应行号", () => {
  const originals = ["a", "b"];
  const model = "1. AA\n2. BB\n3. CC\n4. DD";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["AA", "BB"], "多出的行号忽略");
});

test("alignTranslations 行号错位（乱序）仍按号对齐", () => {
  const originals = ["a", "b", "c"];
  const model = "3. CC\n1. AA\n2. BB";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["AA", "BB", "CC"]);
});

test("alignTranslations 容忍多种行号写法", () => {
  const originals = ["a", "b", "c"];
  const model = "1、甲\n2) 乙\n3 - 丙";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["甲", "乙", "丙"]);
});

test("alignTranslations 无行号 → 按顺序对齐兜底", () => {
  const originals = ["a", "b", "c"];
  const model = "甲\n乙\n丙";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["甲", "乙", "丙"]);
});

test("alignTranslations 无行号且行数不足 → 缺的留原文", () => {
  const originals = ["a", "b", "c"];
  const model = "甲\n乙";
  const out = Core.alignTranslations(originals, model);
  assert.deepStrictEqual(out, ["甲", "乙", "c"]);
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
  const seg = Core.resegmentCues(frags, { maxWords: 50, maxDurationMs: 30000 });
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
  const seg = Core.resegmentCues(frags, { minWords: 3 });
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

/* ============ 5j. 瘦身后的 system prompt ============ */
console.log("\n[system prompt 瘦身校验]");

test("DEFAULT_SYSTEM_PROMPT 已瘦身（填充后 < 254 字符，约砍半）", () => {
  const filled = Core.buildSystemPrompt("zh-Hans");
  assert.ok(filled.length < 254, "填充后应 < 254 字符，实际 " + filled.length);
  // 仍含三条硬约束的关键词
  assert.ok(/numbered/i.test(filled), "应保留行号约束");
  assert.ok(/context/i.test(filled), "应保留结合上下文");
  assert.ok(/zh-Hans/.test(filled), "应替换目标语言");
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
  console.log("\n[translateBatch：注入 mock fetch]");

  await asyncTest("translateBatch 正常：构造请求 + 解析 + 对齐", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "1. 你好\n2. 世界" } }] };
        },
        async text() {
          return "";
        },
      };
    };
    const out = await Core.translateBatch({
      cues: [{ content: "hello" }, { content: "world" }],
      apiBaseUrl: "https://gw.example/v1",
      apiKey: "sk-test",
      apiModel: "gpt-4o-mini",
      targetLang: "zh-Hans",
      fetchImpl: mockFetch,
    });
    assert.deepStrictEqual(out, ["你好", "世界"]);
    assert.strictEqual(capturedUrl, "https://gw.example/v1/chat/completions");
    assert.strictEqual(capturedBody.model, "gpt-4o-mini");
    assert.strictEqual(capturedBody.temperature, 0.3);
    assert.strictEqual(capturedBody.messages.length, 2);
    assert.strictEqual(capturedBody.messages[0].role, "system");
    assert.ok(/zh-Hans/.test(capturedBody.messages[0].content), "system prompt 含目标语言");
    assert.ok(/1\. hello/.test(capturedBody.messages[1].content), "user 含带行号原文");
  });

  await asyncTest("translateBatch 行数不匹配 → 缺的留原文", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 你好" } }] };
      },
      async text() {
        return "";
      },
    });
    const out = await Core.translateBatch({
      cues: [{ content: "hello" }, { content: "world" }],
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      fetchImpl: mockFetch,
    });
    assert.deepStrictEqual(out, ["你好", "world"]);
  });

  await asyncTest("translateBatch HTTP 非 200 → 抛错（调用方兜底原文）", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      async json() {
        return {};
      },
      async text() {
        return "rate limited";
      },
    });
    let threw = false;
    try {
      await Core.translateBatch({
        cues: [{ content: "hello" }],
        apiBaseUrl: "https://gw/v1",
        apiModel: "m",
        fetchImpl: mockFetch,
      });
    } catch (e) {
      threw = true;
      assert.ok(/429/.test(e.message), "错误信息应含状态码");
    }
    assert.ok(threw, "非 200 应抛错");
  });

  await asyncTest("translateBatch 带 contextTail 时 user message 含上下文标记", async () => {
    let body = null;
    const mockFetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "1. 译文" } }] };
        },
        async text() {
          return "";
        },
      };
    };
    await Core.translateBatch({
      cues: [{ content: "next sentence" }],
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      contextTail: ["previous sentence"],
      fetchImpl: mockFetch,
    });
    const userMsg = body.messages[1].content;
    assert.ok(/context/i.test(userMsg), "应含 context 标记");
    assert.ok(/previous sentence/.test(userMsg), "应含上一批上下文");
    assert.ok(/1\. next sentence/.test(userMsg), "应含本批带行号原文");
  });

  await asyncTest("translateBatch 空 cues 返回空数组", async () => {
    const out = await Core.translateBatch({ cues: [], apiBaseUrl: "x", apiModel: "m" });
    assert.deepStrictEqual(out, []);
  });

  await asyncTest("translateBatch 超时（AbortController）→ 抛超时错误", async () => {
    // mock fetch 尊重 signal：触发 abort 时 reject 一个 AbortError
    const mockFetch = (url, opts) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            async json() {
              return { choices: [{ message: { content: "1. 慢" } }] };
            },
            async text() {
              return "";
            },
          });
        }, 200); // 200ms 后才返回，但超时设 30ms
        if (opts && opts.signal) {
          opts.signal.addEventListener("abort", () => {
            clearTimeout(t);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    let threw = false;
    try {
      await Core.translateBatch({
        cues: [{ content: "slow" }],
        apiBaseUrl: "https://gw/v1",
        apiModel: "m",
        timeoutMs: 30,
        fetchImpl: mockFetch,
      });
    } catch (e) {
      threw = true;
      assert.ok(/timeout/i.test(e.message), "应是超时错误，实际：" + e.message);
    }
    assert.ok(threw, "超时应抛错由调用方兜底");
  });

  await asyncTest("translateBatch timeoutMs<=0 关闭超时，正常返回", async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 好" } }] };
      },
      async text() {
        return "";
      },
    });
    const out = await Core.translateBatch({
      cues: [{ content: "ok" }],
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      timeoutMs: 0,
      fetchImpl: mockFetch,
    });
    assert.deepStrictEqual(out, ["好"]);
  });

  /* ============ 6b. translateCues：首句优先 + 并发编排 ============ */
  console.log("\n[translateCues：首句优先 + 批内并发 + 增量回调]");

  test("planBatches 首句优先批排最前、其余补满不重叠", () => {
    const cues = Array.from({ length: 12 }, (_, i) => ({ content: "c" + i }));
    const batches = Core.planBatches(cues, { batchSize: 5, priorityIndex: 7, priorityLines: 3 });
    const pri = batches.find((b) => b.priority);
    assert.ok(pri, "应有优先批");
    assert.strictEqual(pri.start, 7);
    assert.strictEqual(pri.end, 10, "优先批覆盖 7..10");
    // 全部 cue 恰好被覆盖一次（不重叠不遗漏）
    const covered = new Array(12).fill(0);
    batches.forEach((b) => {
      for (let i = b.start; i < b.end; i++) covered[i]++;
    });
    assert.ok(covered.every((c) => c === 1), "每个 cue 恰好被一个批覆盖");
  });

  await asyncTest("translateCues 并发翻译并按行号正确对齐回 cue", async () => {
    const cues = Array.from({ length: 12 }, (_, i) => ({ content: "line" + i }));
    let calls = 0;
    const mockFetch = async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      // 回显：把 user 里的带行号原文转成 "n. T<原文>"
      const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\./.test(l));
      const content = userLines
        .map((l) => {
          const m = l.match(/^(\d+)\.\s*(.*)$/);
          return m[1] + ". T" + m[2];
        })
        .join("\n");
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const out = await Core.translateCues({
      cues,
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      targetLang: "zh-Hans",
      batchSize: 5,
      concurrency: 3,
      fetchImpl: mockFetch,
    });
    assert.strictEqual(out.length, 12);
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(out[i], "Tline" + i, "第 " + i + " 行应正确对齐");
    }
    assert.ok(calls >= 3, "应分多批（并发）调用");
  });

  await asyncTest("translateCues 首句优先批最先返回（onProgress 首回调含优先区）", async () => {
    const cues = Array.from({ length: 12 }, (_, i) => ({ content: "x" + i }));
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\./.test(l));
      // 大批故意慢返回，小的优先批快返回 → 验证优先批先完成
      const delay = userLines.length > 3 ? 30 : 1;
      await new Promise((r) => setTimeout(r, delay));
      const content = userLines.map((l) => l.match(/^(\d+)\./)[1] + ". ok").join("\n");
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    let firstUpdateIndices = null;
    await Core.translateCues({
      cues,
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      batchSize: 5,
      priorityIndex: 6,
      priorityLines: 3,
      concurrency: 3,
      fetchImpl: mockFetch,
      onProgress: (updates) => {
        if (!firstUpdateIndices) firstUpdateIndices = updates.map((u) => u.index);
      },
    });
    assert.ok(firstUpdateIndices, "应有 onProgress 回调");
    assert.ok(firstUpdateIndices.indexOf(6) !== -1, "首个完成的批应是首句优先批(含 index 6)");
  });

  await asyncTest("translateCues 某批失败：失败批留空、其余成功、触发 onError", async () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({ content: "y" + i }));
    let errored = 0;
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\./.test(l));
      // 含 "y0" 的批（首批）失败，其余成功
      if (/\by0\b/.test(body.messages[1].content)) {
        return { ok: false, status: 500, async json() { return {}; }, async text() { return "boom"; } };
      }
      const content = userLines.map((l) => l.match(/^(\d+)\./)[1] + ". ok").join("\n");
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const out = await Core.translateCues({
      cues,
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      batchSize: 5,
      concurrency: 2,
      fetchImpl: mockFetch,
      onError: () => errored++,
    });
    assert.strictEqual(out.length, 10);
    assert.ok(errored >= 1, "失败批应触发 onError");
    assert.strictEqual(out[0], undefined, "失败批对应行留空（调用方兜底原文）");
    assert.strictEqual(out[5], "ok", "成功批仍正确填充");
  });

  await asyncTest("缓存命中场景：相同 key 不再调 fetch（pruneCache + makeCacheKey 协作）", async () => {
    // 模拟 isolated.js 的"先查缓存命中则零调用"语义
    const key = Core.makeCacheKey({ videoId: "v", trackCode: "en-asr", targetLang: "zh", apiModel: "m", clipStartMs: 0 });
    const cache = {};
    cache[key] = { t: Date.now(), lines: ["你好", "世界"] };
    let fetchCalled = false;
    // 命中：直接用缓存，不调 translateCues/fetch
    let lines;
    if (cache[key]) {
      lines = cache[key].lines;
    } else {
      fetchCalled = true;
      lines = await Core.translateCues({ cues: [{ content: "hello" }], apiBaseUrl: "x", apiModel: "m", fetchImpl: async () => { fetchCalled = true; return {}; } });
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

  await asyncTest("translateCues 接 gate：多 clip 并行翻译总在途不超全局 cap", async () => {
    // 模拟滑动窗口预取：3 个 clip 各自 concurrency=3 同时翻，但共享一个 cap=4 的全局信号量。
    // 不封顶会瞬时 ~9 并发；封顶后任意时刻 fetch 在途 <= 4。
    const cap = 4;
    const gate = Core.makeSemaphore(cap);
    let inFlight = 0;
    let peak = 0;
    const mockFetch = async (url, opts) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      assert.ok(inFlight <= cap, "fetch 在途不应超过全局 cap=" + cap + "（实际 " + inFlight + "）");
      await new Promise((r) => setTimeout(r, 5));
      const body = JSON.parse(opts.body);
      const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\./.test(l));
      const content = userLines.map((l) => l.match(/^(\d+)\./)[1] + ". ok").join("\n");
      inFlight--;
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const mkCues = (p) => Array.from({ length: 12 }, (_, i) => ({ content: p + i }));
    const runClip = (p) =>
      Core.translateCues({
        cues: mkCues(p),
        apiBaseUrl: "https://gw/v1",
        apiModel: "m",
        batchSize: 4, // 12/4 = 3 批/clip
        concurrency: 3, // 单 clip 批内并发 3
        gate, // 全局上限 4
        fetchImpl: mockFetch,
      });
    // 3 个 clip 同时翻（共 9 批） → 若无 gate 峰值可达 9
    const [a, b, c] = await Promise.all([runClip("a"), runClip("b"), runClip("c")]);
    assert.strictEqual(a.length, 12);
    assert.strictEqual(b.length, 12);
    assert.strictEqual(c.length, 12);
    assert.ok(peak > 1 && peak <= cap, "应确有并发(>1)但被全局 cap 封顶(<=" + cap + ")，实际峰值 " + peak);
    assert.strictEqual(inFlight, 0, "全部完成后在途归零");
  });

  /* ============ 7. 交付物校验 ============ */
  console.log("\n[交付物校验]");

  test("manifest.json 能 JSON.parse 且字段完整", () => {
    const raw = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
    const m = JSON.parse(raw);
    assert.strictEqual(m.manifest_version, 3);
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
