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
