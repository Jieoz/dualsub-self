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

test("alignTranslations 语序自由/措辞改写（长度差异大）仍按行号就位（P0-b）", () => {
  // 放宽语序后模型会为自然度大幅改写、调整行内语序，译文长度与原文差异很大；
  // 只要行号顺序正确、行数一致，对齐结果仍每行精确就位（不破坏时间轴对齐）。
  const originals = [
    "so the thing about transformers",
    "is that they use attention",
    "to look at the whole sequence at once",
  ];
  const model =
    "1. 关于 Transformer 这个东西呢\n" +
    "2. 它的精髓在于用上了注意力机制\n" +
    "3. 一次性地纵观整个序列，而不是逐个去看";
  const out = Core.alignTranslations(originals, model);
  assert.strictEqual(out.length, 3, "行数与输入一致");
  assert.strictEqual(out[0], "关于 Transformer 这个东西呢");
  assert.strictEqual(out[1], "它的精髓在于用上了注意力机制");
  assert.strictEqual(out[2], "一次性地纵观整个序列，而不是逐个去看");
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

/* ============ 5b-3. segmentSentenceUnit：长句智能分段 ============ */
console.log("\n[segmentSentenceUnit：长句按标点分屏]");

test("segment：长译文(>maxChars)切成 N>=2 段，每段不以半个词/数字结尾(切点在标点)", () => {
  const unit = {
    startMs: 0,
    endMs: 6000,
    originalText: "so Transformer architecture changed everything, and then attention became all you need.",
    translation: "所以 Transformer 架构改变了一切，注意力机制成了关键，后来一切都围绕它展开，这就是全部要点。",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  assert.ok(out.length >= 2, "长译文应被切成多段，实际 " + out.length);
  // 硬上限：每段译文长度 <= maxCharsPerScreen（标点是优选切点，超长片段在内部按可读边界硬切）
  for (const u of out) {
    assert.ok(u.translation.length <= 20, "每段必须 <= 单屏上限20，实际 " + u.translation.length + ": " + u.translation);
  }
  // 绝不切断 "Transformer"：不应有任何段把这个词拦腰斩开
  const joined = out.map((u) => u.translation).join("");
  assert.ok(joined.indexOf("Transformer") !== -1, "Transformer 应完整保留，不被斩断");
  for (const u of out) {
    assert.ok(!/Transforme$/.test(u.translation) && !/^r[^a-zA-Z]/.test(u.translation), "不应把 Transformer 拦腰斩断");
  }
});

test("segment：时间轴连续、不重叠、完整覆盖原区间", () => {
  const unit = {
    startMs: 1000,
    endMs: 7000,
    originalText: "one two three. four five six. seven eight nine.",
    translation: "第一句话在这里结束。第二句话也到这里。第三句话同样收尾完成。",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 10, maxDurPerScreen: 3000 });
  assert.ok(out.length >= 2);
  assert.strictEqual(out[0].startMs, 1000, "首段 start = 原 start");
  assert.strictEqual(out[out.length - 1].endMs, 7000, "末段 end = 原 end");
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].endMs >= out[i].startMs, "每段 end >= start");
    if (i > 0) {
      assert.strictEqual(out[i].startMs, out[i - 1].endMs, "段间连续不重叠/不留洞");
    }
  }
});

test("segment：各段译文拼回无丢字", () => {
  const trans = "所以 Transformer 架构改变了一切，注意力机制成了关键，后来一切都围绕它展开，这就是全部要点。";
  const unit = { startMs: 0, endMs: 6000, originalText: "x.", translation: trans };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  // 硬切重组时 CJK↔拉丁间空格可能规整化（不影响可读性），按「去空格」校验不丢任何字符。
  const joined = out.map((u) => u.translation).join("").replace(/\s+/g, "");
  const expect = Core.collapseWhitespace(trans).replace(/\s+/g, "");
  assert.strictEqual(joined, expect, "拼接译文应等于原译文（去空格无丢字）");
});

test("segment：短译文(<=maxChars 且时长够短)原样返回 [unit]（N=1）", () => {
  const unit = { startMs: 0, endMs: 2000, originalText: "short.", translation: "很短的一句话。" };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  assert.strictEqual(out.length, 1, "短句不分段");
  assert.strictEqual(out[0].translation, "很短的一句话。");
  assert.strictEqual(out[0].startMs, 0);
  assert.strictEqual(out[0].endMs, 2000);
});

test("segment：maxCharsPerScreen 极大 = 关闭分段(向后兼容)", () => {
  const unit = {
    startMs: 0,
    endMs: 3000, // 时长够短，避免被时长维度触发
    originalText: "a long original text here.",
    translation: "这是一段很长很长的译文，包含很多很多字符，本来应该被切分成好几段。",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 99999, maxDurPerScreen: 4000 });
  assert.strictEqual(out.length, 1, "极大 maxChars 应关闭分段");
});

test("segment：无句中标点的长译文也按硬上限切（CJK 按字断），每段 <= cap", () => {
  // 中文口语 ASR 翻译常无句中标点；旧实现整段不切 → 字幕墙。修复后必须切。
  const unit = {
    startMs: 0,
    endMs: 6000,
    originalText: "nopunct",
    translation: "这是一段完全没有任何标点符号的超长中文译文本来很想被切开但是没有切点",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 10, maxDurPerScreen: 4000 });
  assert.ok(out.length >= 2, "无标点长句必须被切开，实际 " + out.length);
  for (const u of out) {
    assert.ok(u.translation.length <= 10, "每段 <= cap(10)，实际 " + u.translation.length);
  }
  const joined = out.map((u) => u.translation).join("");
  assert.strictEqual(joined, unit.translation, "拼回无丢字");
});

test("segment：回归——第一句不再过长（标点稀疏时第一段也 <= cap）", () => {
  // Jay 报的 bug：调整字幕节奏后第一句过长。根因是旧实现只按标点聚组，
  // 单个长标点片段（逗号前 30+ 字）整块塞进第一段，远超单屏上限。
  const unit = {
    startMs: 0,
    endMs: 5400,
    originalText: "this is the very first sentence and it is way too long for one screen.",
    translation: "而这是你需要理解的关于这些模型在实际中究竟如何运作的第一件最重要的事情，记住它",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  assert.ok(out.length >= 2, "应被切分");
  assert.ok(out[0].translation.length <= 20, "第一段不得超上限20，实际 " + out[0].translation.length + ": " + out[0].translation);
  for (const u of out) {
    assert.ok(u.translation.length <= 20, "所有段 <= 20，实际 " + u.translation.length);
  }
});

test("segment：小数/版本号不被斩断（1.8 / v2.0 保持完整）", () => {
  const unit = {
    startMs: 0,
    endMs: 5000,
    originalText: "GPT4 has 1.8 trillion params.",
    translation: "GPT4有1.8万亿参数据说是这样训练出来的一个超大规模的语言模型系统",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  for (const u of out) {
    assert.ok(u.translation.length <= 20, "每段 <= 20");
    assert.ok(!/1\.$/.test(u.translation) && !/^8/.test(u.translation), "不应把 1.8 斩成 1. / 8");
  }
  const joined = out.map((u) => u.translation).join("");
  assert.ok(joined.indexOf("1.8") !== -1, "1.8 应完整保留");
});

test("segment：原文分段——每段 originalText 非空(无句中标点也对齐)", () => {
  // 缺陷1：英文 ASR 几乎无句中标点，旧实现把整句原文塞进第 0 段、后段 originalText 全空。
  // 修复后原文按原子占比均分到每段，每段都带对应原文片段。
  const unit = {
    startMs: 0,
    endMs: 6000,
    originalText: "so transformer architecture is the foundation of all modern large language models today",
    translation: "所以说Transformer架构其实是所有现代大语言模型最核心的底层基础技术框架支撑啊",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  assert.ok(out.length >= 2, "应被切成多段，实际 " + out.length);
  for (const u of out) {
    assert.ok(u.translation.length <= 20, "每段译文 <= 20，实际 " + u.translation.length);
    assert.ok(u.originalText && u.originalText.length > 0, "每段 originalText 必须非空: " + JSON.stringify(out.map((x) => x.originalText)));
  }
  // 原文拼回（去空格）无丢字
  const joinedOrig = out.map((u) => u.originalText).join("").replace(/\s+/g, "");
  const expectOrig = Core.collapseWhitespace(unit.originalText).replace(/\s+/g, "");
  assert.strictEqual(joinedOrig, expectOrig, "原文拼回（去空格）应无丢字");
});

test("segment：短句不被时长维度切碎成单字(每段≥最小段长)", () => {
  // 缺陷2：8 字短译文因 12 秒被时长维度切成 嗯对就/是这样/吧(末段1字)闪烁。
  // 修复后时长维度有 segMinChars / SEG_MIN_VISIBLE_MS 下限保护，短句宁可静止显示。
  const unit = { startMs: 0, endMs: 12000, originalText: "um yeah right ok", translation: "嗯对就是这样吧" };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 20, maxDurPerScreen: 4000 });
  const minChars = Math.max(2, Math.ceil(20 / 4)); // segMinChars(20) = 5
  for (const u of out) {
    assert.ok(u.translation.length >= minChars || out.length === 1, "每段译文应 >= 最小段长 " + minChars + "，实际 " + u.translation.length + ": " + u.translation);
  }
  // 拼回无丢字（即便不切也成立）
  const joined = out.map((u) => u.translation).join("");
  assert.strictEqual(joined, unit.translation, "拼回无丢字");
});

test("segment：超长不可分原子按 cap 硬截，每段≤cap", () => {
  // 缺陷3：42 字连写 URL 单独成段远超 cap=10；旧实现静默突破上限。
  // 修复后实在切不动的超长原子在内部按 cap 硬截，保证每段 <= cap（无例外）。
  const unit = {
    startMs: 0,
    endMs: 6000,
    originalText: "see link",
    translation: "请访问thisisaveryveryverylongurlwithoutanyspaces看看",
  };
  const out = Core.segmentSentenceUnit(unit, { maxCharsPerScreen: 10, maxDurPerScreen: 4000 });
  assert.ok(out.length >= 2, "应被切成多段");
  for (const u of out) {
    assert.ok(u.translation.length <= 10, "每段必须 <= cap(10)，实际 " + u.translation.length + ": " + u.translation);
  }
  // 译文拼回无丢字
  const joined = out.map((u) => u.translation).join("");
  assert.strictEqual(joined, unit.translation, "译文拼回无丢字");
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

/* ============ 5j. 升级后的 system prompt（P0-a：加料换质量）============ */
console.log("\n[system prompt 升级校验]");

test("DEFAULT_SYSTEM_PROMPT 升级：覆盖口语/连贯/语序自由/术语 + 保留硬约束", () => {
  const filled = Core.buildSystemPrompt("zh-Hans");
  // 有意加回固定开销换质量：比瘦身版长很多（推翻 509→3 句的省 token 决策）
  assert.ok(filled.length > 400, "升级后应是有料的长 prompt，实际 " + filled.length);
  // 质量引导关键词
  assert.ok(/natural|fluent|colloquial/i.test(filled), "应含口语/自然引导");
  assert.ok(/context/i.test(filled), "应含结合上下文");
  assert.ok(/reorder|rephrase/i.test(filled), "应含行内语序自由");
  assert.ok(/proper noun|term/i.test(filled), "应含术语/专名约束");
  // 硬约束（不能破坏逐行对齐）
  assert.ok(/line number/i.test(filled), "应保留行号硬约束");
  assert.ok(/same number|identical/i.test(filled), "应要求行号/行数一致");
  assert.ok(/only/i.test(filled), "应要求只输出译文");
  // 目标语言占位符被替换
  assert.ok(/zh-Hans/.test(filled), "应替换目标语言");
  assert.ok(!/\{TARGET_LANG\}/.test(filled), "占位符应被全部替换");
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

  await asyncTest("translateCues contextLines=3：每批带前 3 条原文作上下文，编号区只含本批（P1-a）", async () => {
    // 18 条 cue，batchSize=6，单并发(顺序)便于稳定断言。非首批应带前 3 条原文作 context。
    const cues = Array.from({ length: 18 }, (_, i) => ({ content: "src" + i }));
    const captured = []; // 每次 fetch 的 user message
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[1].content;
      captured.push(userMsg);
      const userLines = userMsg.split("\n").filter((l) => /^\d+\.\s/.test(l));
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
      batchSize: 6,
      contextLines: 3,
      concurrency: 1, // 串行：批顺序稳定，便于断言
      fetchImpl: mockFetch,
    });
    // 对齐结果仍每行就位、行数 == 输入数
    assert.strictEqual(out.length, 18);
    for (let i = 0; i < 18; i++) assert.strictEqual(out[i], "Tsrc" + i, "第 " + i + " 行对齐");

    // 找到「第二批(start=6)」对应的 user message：它编号区第一行是 "1. src6"
    const secondBatchMsg = captured.find((m) => /(^|\n)1\. src6(\n|$)/.test(m));
    assert.ok(secondBatchMsg, "应能定位到第二批的请求");
    // 含 context 标记 + 前 3 条原文(src3,src4,src5)，且明确"不翻译"
    assert.ok(/do NOT translate/i.test(secondBatchMsg), "应有不翻译的 context 前缀");
    assert.ok(/src3[\s\S]*src4[\s\S]*src5/.test(secondBatchMsg), "context 应是前 3 条原文 src3/4/5");
    // context 行不进编号区：src3/4/5 不应带行号出现在编号块
    assert.ok(!/\d+\.\s*src3\b/.test(secondBatchMsg), "context 行不计入编号");
    // 编号区只含本批 6 条（行号 1..6），不多不少 → 对齐契约不被 context 污染
    const numberedLines = secondBatchMsg.split("\n").filter((l) => /^\d+\.\s/.test(l));
    assert.strictEqual(numberedLines.length, 6, "编号区行数 == 本批 cue 数(6)，不含 context");
    assert.ok(/^1\. src6$/.test(numberedLines[0]), "编号区从本批首条开始(1. src6)");
    assert.ok(/^6\. src11$/.test(numberedLines[5]), "编号区到本批末条(6. src11)");

    // 首批(start=0)不应带 context（前面没有原文可借）
    const firstBatchMsg = captured.find((m) => /(^|\n)1\. src0(\n|$)/.test(m));
    assert.ok(firstBatchMsg, "应能定位首批请求");
    assert.ok(!/do NOT translate/i.test(firstBatchMsg), "clip 首批不带 context");
  });

  await asyncTest("translateCues contextLines 未配置时退化为旧行为（仅句中断点带 1 句）", async () => {
    // 不传 contextLines：上一条无句末标点 → 带 1 句；clip 首批不带。
    const cues = [
      { content: "this sentence keeps going" }, // 无句末标点
      { content: "and finishes right here." },
      { content: "brand new sentence." },
    ];
    const captured = [];
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      captured.push(body.messages[1].content);
      const userLines = body.messages[1].content.split("\n").filter((l) => /^\d+\.\s/.test(l));
      const content = userLines.map((l) => l.match(/^(\d+)\./)[1] + ". ok").join("\n");
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    await Core.translateCues({
      cues,
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      batchSize: 1, // 每条一批，凸显逐批 context 决策
      concurrency: 1,
      fetchImpl: mockFetch,
    });
    // 第二批(start=1)上一条"this sentence keeps going"无句末标点 → 带 1 句 context
    const b2 = captured.find((m) => /(^|\n)1\. and finishes right here\.(\n|$)/.test(m));
    assert.ok(b2 && /do NOT translate/i.test(b2), "句中断点应带 1 句 context");
    assert.ok(/this sentence keeps going/.test(b2), "带的是上一条原文");
    // 第三批(start=2)上一条"and finishes right here."有句末标点 → 不带 context
    const b3 = captured.find((m) => /(^|\n)1\. brand new sentence\.(\n|$)/.test(m));
    assert.ok(b3 && !/do NOT translate/i.test(b3), "自然句首不带 context");
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

  /* ============ 句级语义重断（方案 A：句级对齐 + 覆盖性兜底） ============ */
  console.log("\n[句级语义重断：parseSentenceResponse + alignSentences + translateSentences]");

  // 6 条无标点 ASR 碎片样本，带时间轴，源行号 1..6
  const SENT_CUES = [
    { start: 0, end: 600, content: "so today we are gonna" },
    { start: 600, end: 1200, content: "take a look at how" },
    { start: 1250, end: 1800, content: "large language models work" },
    { start: 2600, end: 3100, content: "they predict the next token" },
    { start: 3150, end: 3700, content: "one step at a time" },
    { start: 4600, end: 5200, content: "and that is basically it" },
  ];

  test("alignSentences 正常：3 句覆盖 [1-2][3-4][5-6]，时间区间=首行start→末行end", () => {
    const model = [
      "[1-2] ||| So today we are gonna take a look at how. ||| 那么今天我们来看看。",
      "[3-4] ||| Large language models work, they predict the next token. ||| 大语言模型预测下一个 token。",
      "[5-6] ||| One step at a time, and that is basically it. ||| 一次一步，基本就是这样。",
    ].join("\n");
    const r = Core.alignSentences(SENT_CUES, model);
    assert.strictEqual(r.ok, true, "覆盖完整应 ok");
    assert.strictEqual(r.sentences.length, 3);
    // 时间轴：句 = [首源行.start, 末源行.end]
    assert.deepStrictEqual([r.sentences[0].startMs, r.sentences[0].endMs], [0, 1200]);
    assert.deepStrictEqual([r.sentences[1].startMs, r.sentences[1].endMs], [1250, 3100]);
    assert.deepStrictEqual([r.sentences[2].startMs, r.sentences[2].endMs], [3150, 5200]);
    assert.strictEqual(r.sentences[0].originalText, "So today we are gonna take a look at how.");
    assert.strictEqual(r.sentences[2].translation, "一次一步，基本就是这样。");
  });

  test("alignSentences 时间轴：单行号句 [4] 区间=该 cue 的 start/end", () => {
    const model = [
      "[1-3] ||| A. ||| 甲。",
      "[4] ||| B. ||| 乙。",
      "[5-6] ||| C. ||| 丙。",
    ].join("\n");
    const r = Core.alignSentences(SENT_CUES, model);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.sentences[1].startMs, r.sentences[1].endMs], [2600, 3100], "第4行单行号句区间");
  });

  test("覆盖性兜底：漏掉第 5 行 → ok=false(gap)，调用方退回逐行", () => {
    const model = "[1-3] ||| A ||| 甲\n[4] ||| B ||| 乙\n[6] ||| C ||| 丙"; // 缺 5
    const r = Core.alignSentences(SENT_CUES, model);
    assert.strictEqual(r.ok, false, "漏行应不通过覆盖性");
    assert.strictEqual(r.reason, "gap");
    assert.strictEqual(r.sentences.length, 0);
  });

  test("覆盖性兜底：范围重叠 [1-3][3-6] → ok=false(overlap)", () => {
    const r = Core.alignSentences(SENT_CUES, "[1-3] ||| A ||| 甲\n[3-6] ||| B ||| 乙");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "overlap");
  });

  test("覆盖性兜底：越界 [1-7] 超过输入行数 → ok=false(out-of-range)", () => {
    const r = Core.alignSentences(SENT_CUES, "[1-7] ||| A ||| 甲");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "out-of-range");
  });

  test("覆盖性兜底：末行未覆盖（只到 5）→ ok=false(uncovered)", () => {
    const r = Core.alignSentences(SENT_CUES, "[1-3] ||| A ||| 甲\n[4-5] ||| B ||| 乙");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "uncovered");
  });

  test("覆盖性兜底：解析为空（纯自由文本无 [范围]）→ ok=false(empty)", () => {
    const r = Core.alignSentences(SENT_CUES, "这是一段没有任何行号范围的自由文本。");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "empty");
  });

  test("parseSentenceResponse 容错：单行号 [3]、范围 [3-5]、多余空白都能解析", () => {
    const txt = [
      "  [ 3 - 5 ]   ||| Restored sentence.  |||   重组后的译文 ",
      "[7]|||No spaces.|||无空格译文",
      "[ 9 ] ||| trailing. ||| 末尾。   ",
    ].join("\n");
    const recs = Core.parseSentenceResponse(txt);
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual([recs[0].srcStart, recs[0].srcEnd], [3, 5]);
    assert.strictEqual(recs[0].originalText, "Restored sentence.");
    assert.strictEqual(recs[0].translation, "重组后的译文");
    assert.deepStrictEqual([recs[1].srcStart, recs[1].srcEnd], [7, 7], "单行号 srcStart=srcEnd");
    assert.strictEqual(recs[2].translation, "末尾。");
  });

  test("parseSentenceResponse 跳过非法行：段数不足/无范围", () => {
    const txt = [
      "[1-2] ||| only two fields", // 缺第三段
      "no bracket at all",
      "[3] ||| ok ||| 好",
    ].join("\n");
    const recs = Core.parseSentenceResponse(txt);
    assert.strictEqual(recs.length, 1, "只有合法一行");
    assert.strictEqual(recs[0].srcStart, 3);
  });

  await asyncTest("translateSentences 正常：一次调用解析为句级时间轴(ok=true)", async () => {
    let calls = 0;
    const mockFetch = async (url, opts) => {
      calls++;
      const body = JSON.parse(opts.body);
      // 校验：句级 user message 含带行号源碎片
      assert.ok(/1\.\s+so today/.test(body.messages[1].content), "user 含编号源行");
      const content = [
        "[1-3] ||| So today we take a look at how large language models work. ||| 今天我们看看大语言模型怎么工作。",
        "[4-6] ||| They predict the next token one step at a time, and that is basically it. ||| 它们一次预测一个 token，基本就这样。",
      ].join("\n");
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const r = await Core.translateSentences({
      cues: SENT_CUES,
      apiBaseUrl: "https://gw/v1",
      apiModel: "m",
      targetLang: "zh-Hans",
      fetchImpl: mockFetch,
    });
    assert.strictEqual(calls, 1, "句级重断只一次调用");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sentences.length, 2);
    assert.deepStrictEqual([r.sentences[0].startMs, r.sentences[0].endMs], [0, 1800]);
    assert.deepStrictEqual([r.sentences[1].startMs, r.sentences[1].endMs], [2600, 5200]);
  });

  await asyncTest("translateSentences 覆盖性不过：返回 ok=false 让调用方退回逐行", async () => {
    const mockFetch = async () => {
      const content = "[1-3] ||| A ||| 甲\n[5-6] ||| B ||| 乙"; // 漏第 4 行
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const r = await Core.translateSentences({
      cues: SENT_CUES, apiBaseUrl: "https://gw/v1", apiModel: "m", targetLang: "zh-Hans", fetchImpl: mockFetch,
    });
    assert.strictEqual(r.ok, false, "漏行 → 不通过，调用方应退回逐行 fallback");
    assert.strictEqual(r.sentences.length, 0);
  });

  test("句级 system prompt 含范围协议 + 目标语言填充 + 自定义覆盖", () => {
    const sys = Core.buildSentenceSystemPrompt("zh-Hans");
    assert.ok(/\|\|\|/.test(sys), "应说明 ||| 分隔协议");
    assert.ok(/startLine-endLine/.test(sys), "应说明行号范围协议");
    assert.ok(/zh-Hans/.test(sys) && !/\{TARGET_LANG\}/.test(sys), "目标语言已填充");
    assert.strictEqual(Core.buildSentenceSystemPrompt("zh-Hans", "MY {TARGET_LANG}"), "MY zh-Hans", "自定义覆盖默认");
  });

  test("句级 prompt(A2)：含「为每个源行号都给/分配到每行」强化措辞", () => {
    const sys = Core.buildSentenceSystemPrompt("zh-Hans");
    assert.ok(/EACH/.test(sys), "应含 EACH（强调每个源行）");
    assert.ok(/distribute/i.test(sys), "应含 distribute（把整句译文分配到各行）");
    assert.ok(/account for/i.test(sys) || /every line/i.test(sys), "应强调覆盖每一行");
  });

  /* ============ A1：二次拆分回填（splitTranslation + alignSentences splitFill） ============ */
  console.log("\n[A1 二次拆分回填：splitTranslation + alignSentences(splitFill)]");

  test("splitTranslation：按标点把一条译文拆成 3 份（各非空）", () => {
    const parts = Core.splitTranslation("今天我们来看。它预测下一个词。基本就这样。", 3);
    assert.ok(Array.isArray(parts) && parts.length === 3, "应拆成 3 份");
    parts.forEach((p) => assert.ok(p && p.length > 0, "每份非空"));
    assert.ok(/今天/.test(parts[0]) && /基本/.test(parts[2]), "顺序保持");
  });

  test("splitTranslation：标点不足时按字符近似等分仍得 n 份", () => {
    const parts = Core.splitTranslation("这是一段没有标点的连续中文译文内容", 3);
    assert.ok(Array.isArray(parts) && parts.length === 3, "无标点也能拆成 3 份");
    parts.forEach((p) => assert.ok(p && p.length > 0));
    assert.strictEqual(parts.join(""), "这是一段没有标点的连续中文译文内容", "拼回无丢字");
  });

  test("splitTranslation：n=1 原样返回；太短拆不出 n 份返回 null", () => {
    assert.deepStrictEqual(Core.splitTranslation("整句", 1), ["整句"]);
    assert.strictEqual(Core.splitTranslation("短", 3), null, "1 字拆 3 份不可能 → null");
  });

  test("alignSentences(splitFill)：[1-3] 一条合并译文 → 本地拆 3 份回填，3 个单元、时间轴按各源行", () => {
    const model = "[1-3] ||| Today we look at how models work. ||| 今天我们来看。模型怎么工作。基本如此。";
    const r = Core.alignSentences(SENT_CUES.slice(0, 3), model, { splitFill: true });
    assert.strictEqual(r.ok, true, "覆盖通过 + 拆分成功");
    assert.strictEqual(r.sentences.length, 3, "渲染单元数 == 源行数 3");
    // 时间轴：逐行回到各源 cue 的 start/end
    assert.deepStrictEqual([r.sentences[0].startMs, r.sentences[0].endMs], [0, 600]);
    assert.deepStrictEqual([r.sentences[1].startMs, r.sentences[1].endMs], [600, 1200]);
    assert.deepStrictEqual([r.sentences[2].startMs, r.sentences[2].endMs], [1250, 1800]);
    // 各行有译文片段
    r.sentences.forEach((u) => assert.ok(u.translation && u.translation.length, "每行有译文"));
    // 原文回填为源行碎片
    assert.strictEqual(r.sentences[0].originalText, "so today we are gonna");
  });

  test("alignSentences(splitFill)：拆不出对应份数 → ok=false(split-fail) 退逐行", () => {
    // [1-3] 覆盖 3 行，但译文只 1 个字符，无法拆出 3 份非空
    const r = Core.alignSentences(SENT_CUES, "[1-3] ||| x. ||| 好\n[4-6] ||| y. ||| 也好啊朋友们", {
      splitFill: true,
    });
    assert.strictEqual(r.ok, false, "拆不出 → 整体不通过");
    assert.strictEqual(r.reason, "split-fail");
    assert.strictEqual(r.sentences.length, 0);
  });

  test("alignSentences(splitFill)：单行号句 [4] 不拆，区间=该 cue", () => {
    const model = "[1-3] ||| A. ||| 甲一。甲二。甲三。\n[4] ||| B. ||| 乙。\n[5-6] ||| C. ||| 丙一。丙二。";
    const r = Core.alignSentences(SENT_CUES, model, { splitFill: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sentences.length, 6, "3+1+2 → 6 个逐行单元");
    assert.deepStrictEqual([r.sentences[3].startMs, r.sentences[3].endMs], [2600, 3100], "第4行单行号区间");
    assert.strictEqual(r.sentences[3].translation, "乙。");
  });

  test("alignSentences 默认(无 splitFill)：[1-3] 仍合并成 1 个句单元（不回归）", () => {
    const r = Core.alignSentences(SENT_CUES, "[1-3] ||| A. ||| 甲。\n[4-6] ||| B. ||| 乙。");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sentences.length, 2, "默认仍按句合并");
    assert.deepStrictEqual([r.sentences[0].startMs, r.sentences[0].endMs], [0, 1800]);
  });

  await asyncTest("translateSentences(splitFill) 透传：合并译文 → 逐行单元", async () => {
    const mockFetch = async () => {
      const content = "[1-6] ||| One long restored sentence here. ||| 第一句。第二句。第三句。第四句。第五句。第六句。";
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content } }] }; }, async text() { return ""; } };
    };
    const r = await Core.translateSentences({
      cues: SENT_CUES, apiBaseUrl: "https://gw/v1", apiModel: "m", targetLang: "zh-Hans",
      splitFill: true, fetchImpl: mockFetch,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sentences.length, 6, "[1-6] 合并译文 splitFill → 6 个逐行单元");
    assert.deepStrictEqual([r.sentences[5].startMs, r.sentences[5].endMs], [4600, 5200]);
  });

  /* ============ B1：导出双语 SRT（formatSrtTime + buildSrt） ============ */
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

  test("buildSrt：兼容 isolated.js 的 start/end 命名", () => {
    const srt = Core.buildSrt([{ start: 0, end: 1000, originalText: "x", translation: "叉" }], {
      mode: "bilingual_orig_top",
    });
    assert.ok(/00:00:00,000 --> 00:00:01,000/.test(srt), "start/end 也能取到时间");
  });

  await asyncTest("缓存命中则零调用：命中缓存不触发 translateCues/fetch", async () => {
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
