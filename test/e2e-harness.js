/*
 * test/e2e-harness.js — 真·E2E 调试 harness（node 直接跑，零外部依赖除 fetch）
 * =============================================================================
 * v0.5.1 架构：模型按编号把每个源 cue 翻成一条中文，译文/原文/时间轴 1:1。
 *   本 harness 跑完整主链路：cleanupCues → resegmentCues → sliceClipsByCue
 *     → translateClipLines(编号解析与安全换行)
 *     → buildClipUnits(沿用对应 cue 原文与时间轴) → buildSrt
 *   产出 SRT + 并排 HTML（原文 | 译文 | 时间轴）供肉眼核对断句/丢字，并打点延迟统计。
 *
 * 两种模型后端：
 *  --real   走真实 OpenAI 兼容网关（base/key/model 见下）。需要 key。
 *  --mock   (默认) 离线 mock 模型：用数据集里真实 ref_zh（旧程序逐 cue 中文，本身被 char-split
 *           切碎）按时间重叠拼回整段，再【只在标点边界】重切成自然字幕行返回 —— 模拟新模型
 *           「直接吐自然行」的行为（绝不在词中间断），故 mock 产物本身不含切词。mock 还注入
 *           ~首字节延迟 + 按字数吐字延迟，用于演练延迟统计/超时。
 *
 * API key 注入优先级（--real 时）：
 *   --key=<k>  >  env DUALSUB_API_KEY  >  env OPENAI_API_KEY  >  --key-file=<path>
 *
 * 用法：
 *   node test/e2e-harness.js                 # mock，前 limit 条
 *   node test/e2e-harness.js --full          # mock，全量 373 条
 *   node test/e2e-harness.js --limit=80      # mock，前 80 条
 *   node test/e2e-harness.js --real --key-file=/tmp/dskey [--limit=40]
 *
 * 输出目录：test/e2e-out/（subtitles.srt, review.html, stats.json）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");

/* ----------------------------- 参数解析 ----------------------------- */
function parseArgs(argv) {
  const a = {
    real: false,
    full: false,
    limit: 50,
    mock: true,
    key: "",
    keyFile: "",
    base: "https://armjp.102345.xyz:322/v1",
    model: "gpt-5.4-mini",
    target: "zh-Hans",
    // 调优旋钮（默认取 core DEFAULT_CONFIG，命令行可覆盖）。
    clipSeconds: Core.DEFAULT_CONFIG.clipSeconds,
    firstClipSeconds: Core.DEFAULT_CONFIG.firstClipSeconds,
    minLineChars: Core.DEFAULT_CONFIG.minLineChars,
    reasoningEffort: Core.DEFAULT_CONFIG.reasoningEffort,
    timeoutMs: 0, // 0=按模式默认(real 90s/mock 20s)
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--real") { a.real = true; a.mock = false; }
    else if (arg === "--mock") { a.mock = true; a.real = false; }
    else if (arg === "--full") { a.full = true; }
    else if (arg.startsWith("--limit=")) a.limit = parseInt(arg.slice(8), 10) || 50;
    else if (arg.startsWith("--key=")) a.key = arg.slice(6);
    else if (arg.startsWith("--key-file=")) a.keyFile = arg.slice(11);
    else if (arg.startsWith("--base=")) a.base = arg.slice(7);
    else if (arg.startsWith("--model=")) a.model = arg.slice(8);
    else if (arg.startsWith("--target=")) a.target = arg.slice(9);
    else if (arg.startsWith("--clip-seconds=")) a.clipSeconds = parseFloat(arg.slice(15)) || a.clipSeconds;
    else if (arg.startsWith("--first-clip-seconds=")) a.firstClipSeconds = parseFloat(arg.slice(21)) || a.firstClipSeconds;
    else if (arg.startsWith("--min-line-chars=")) a.minLineChars = parseInt(arg.slice(17), 10);
    else if (arg.startsWith("--reasoning=")) a.reasoningEffort = arg.slice(12);
    else if (arg.startsWith("--timeout-ms=")) a.timeoutMs = parseInt(arg.slice(13), 10) || 0;
  }
  return a;
}

function resolveKey(a) {
  if (a.key && a.key !== "***") return a.key;
  if (process.env.DUALSUB_API_KEY) return process.env.DUALSUB_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (a.keyFile && fs.existsSync(a.keyFile)) return fs.readFileSync(a.keyFile, "utf8").trim();
  return "";
}

/* --------------------------- 数据加载 + 链路前段 --------------------------- */
const CUES_PATH = process.env.DUALSUB_CUES_PATH ||
  path.resolve(__dirname, "../../../cache/dualsub-harness-yMMTVVJI4c-en-cues.json");

function loadOriginalCues(limit) {
  const raw = JSON.parse(fs.readFileSync(CUES_PATH, "utf8"));
  const sliced = limit > 0 ? raw.slice(0, limit) : raw;
  return sliced.map((c) => ({
    start: c.start, end: c.end,
    duration: (c.end - c.start) > 0 ? c.end - c.start : 0,
    content: c.content,
    ref_zh: c.ref_zh || "",
  }));
}

/* ---------------- mock 模型：按源 cue 编号 1:1 返回中文 ---------------- */
function cueZhFromRefs(cue, originalCues) {
  let zh = "";
  for (const oc of originalCues) {
    if (!oc.ref_zh) continue;
    const overlap = Math.min(cue.end, oc.end) - Math.max(cue.start, oc.start);
    if (overlap <= 0) continue;
    const piece = oc.ref_zh.trim();
    if (piece && !zh.endsWith(piece)) zh += piece;
  }
  return Core.collapseWhitespace(zh) || "暂无译文";
}

function makeMockFetch(clipLinesResolver, stats, opts) {
  opts = opts || {};
  const REASON_MS = opts.reasonMs != null ? opts.reasonMs : 20;
  const PER_CHAR_MS = opts.perCharMs != null ? opts.perCharMs : 1;
  return function mockFetch(url, fetchOpts) {
    const body = JSON.parse(fetchOpts.body);
    const user = (body.messages[1] && body.messages[1].content) || "";
    const lines = clipLinesResolver(user);
    const content = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
    const t0 = Date.now();
    const thinkMs = REASON_MS + content.length * PER_CHAR_MS;
    return new Promise((resolve) => setTimeout(() => {
      stats.requestMs.push(Date.now() - t0);
      resolve({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => "",
      });
    }, thinkMs));
  };
}

/* ------------------------------ 真实 fetch（--real） ------------------------------ */
function makeRealFetch(stats) {
  return function realFetch(url, fetchOpts) {
    const t0 = Date.now();
    return fetch(url, fetchOpts).then((resp) => {
      stats.requestMs.push(Date.now() - t0);
      if (resp.status === 429) stats.retries429++;
      return resp;
    });
  };
}

/* ============================== 主链路编排 ============================== */
async function run() {
  const a = parseArgs(process.argv);
  const limit = a.full ? 0 : a.limit;
  const originalCues = loadOriginalCues(limit);

  // 链路前段（与 isolated.js 一致）：清洗 → 语义重组 → 按 cue 切 clip
  const cleaned = Core.cleanupCues(originalCues);
  const reseg = Core.resegmentCues(cleaned, { tailTrimMs: 120 });
  const clips = Core.sliceClipsByCue(reseg, a.clipSeconds * 1000, {
    firstTargetMs: (a.firstClipSeconds > 0 ? a.firstClipSeconds : a.clipSeconds) * 1000,
    maxCuesPerClip: Core.DEFAULT_CONFIG.maxCuesPerClip || 0,
    maxSourceChars: Core.DEFAULT_CONFIG.maxSourceCharsPerClip || 0,
  });

  const stats = { requestMs: [], retries429: 0, clipFallbacks: 0, emptyClips: 0,
                  firstUnitMs: null, totalMs: 0, clipMs: [] };

  // mock 中文按每个重组 cue 的时间窗从真实 ref_zh 聚合，再按编号 1:1 返回。
  const clipByFirstContent = new Map();
  for (const clip of clips) {
    const key = Core.collapseWhitespace(clip.cues[0] ? clip.cues[0].content : "");
    clipByFirstContent.set(key, clip.cues.map((cue) => cueZhFromRefs(cue, originalCues)));
  }
  const clipLinesResolver = (userContent) => {
    const first = userContent.split("\n").map((l) => l.match(/^\s*\d+\.\s+(.*)$/)).find(Boolean);
    const key = first ? Core.collapseWhitespace(first[1]) : "";
    return clipByFirstContent.get(key) || ["暂无译文"];
  };

  let fetchImpl, mode;
  if (a.real) {
    const key = resolveKey(a);
    if (!key) {
      console.error("\n[harness] --real 需要 API key，但未找到（--key= / DUALSUB_API_KEY / OPENAI_API_KEY / --key-file=）。\n");
      process.exit(2);
    }
    a.apiKey = key;
    fetchImpl = makeRealFetch(stats);
    mode = "REAL @ " + a.base + " (" + a.model + ")";
  } else {
    a.apiKey = "mock-key";
    a.base = "http://mock.local/v1";
    fetchImpl = makeMockFetch(clipLinesResolver, stats, {});
    mode = "MOCK (offline structural 1:1 using legacy fragmented ref_zh)";
  }

  console.log("\n=== dualsub E2E harness (v0.5.1) ===");
  console.log("mode      :", mode);
  console.log("cues      :", originalCues.length, "original →", reseg.length, "resegmented →", clips.length, "clips");
  console.log("tuning    : clipSeconds=" + a.clipSeconds + " firstClipSeconds=" + a.firstClipSeconds +
              " minLineChars=" + a.minLineChars +
              " reasoning=" + (a.reasoningEffort || "(default)") +
              " timeoutMs=" + (a.timeoutMs || (a.real ? 90000 : 20000)));
  console.log("");

  const apiCfg = {
    apiBaseUrl: a.base, apiKey: a.apiKey, apiModel: a.model,
    targetLang: a.target, reasoningEffort: a.reasoningEffort, maxLineChars: Core.DEFAULT_CONFIG.maxLineChars,
    timeoutMs: a.timeoutMs || (a.real ? 90000 : 20000), fetchImpl,
  };

  const t0 = Date.now();
  const renderUnits = [];
  for (let ci = 0; ci < clips.length; ci++) {
    const clip = clips[ci];
    const ct0 = Date.now();
    let lines;
    try {
      lines = await Core.translateClipLines(Object.assign({ cues: clip.cues }, apiCfg));
    } catch (e) {
      console.warn("[harness] clip", ci, "翻译失败：", e.message);
      stats.clipFallbacks++;
      lines = [];
    }
    if (!lines || !lines.length) {
      stats.emptyClips++;
      // 兜底：每条 cue 一行、译文留空（渲染层回退显原文）。仍配时间轴。
      for (const cue of clip.cues) {
        renderUnits.push({ start: cue.start, end: cue.end, originalText: cue.content, translation: "" });
      }
    } else {
      const units = Core.buildClipUnits(lines, clip.startMs, clip.endMs, clip.cues);
      for (const u of units) {
        renderUnits.push({ start: u.startMs, end: u.endMs, originalText: u.originalText, translation: u.translation });
      }
      if (stats.firstUnitMs == null) stats.firstUnitMs = Date.now() - t0;
    }
    stats.clipMs.push(Date.now() - ct0);
  }
  stats.totalMs = Date.now() - t0;

  writeOutputs(renderUnits, stats, a, mode);
  printStats(stats, renderUnits, a);
  // 切词/丢字自检：先跑检测器自检（对照样本必须 FAIL），再审真实产物（应 PASS）。
  const detectorOk = auditSelfTest();
  const audit = auditWordCuts(renderUnits);
  const oneToOneOk = renderUnits.length === reseg.length &&
    renderUnits.every((u) => u.originalText && u.translation && u.start < u.end);
  console.log("结构 1:1      :", oneToOneOk ? "PASS" : "FAIL");
  if (!detectorOk || !oneToOneOk || (a.real && !audit.pass)) process.exitCode = 1;
  if (!a.real && !audit.pass) {
    console.log("说明          : MOCK 使用旧逐 cue 碎片译文，只验证 1:1/时轴/空响应；语言切词告警仅作提示，不冒充真实模型质量。" );
  }
}

/* ============================== 产物输出 ============================== */
const OUT_DIR = process.env.DUALSUB_E2E_OUT || path.join(__dirname, "e2e-out");
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function htmlEscape(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtMs(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000), x = t % 1000;
  const pad = (v, n) => String(v).padStart(n, "0");
  return (h ? pad(h, 2) + ":" : "") + pad(m, 2) + ":" + pad(s, 2) + "." + pad(x, 3);
}
function avg(arr) {
  if (!arr || !arr.length) return 0;
  return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}

// 写 subtitles.srt(bilingual) + review.html(三列) + stats.json。
function writeOutputs(renderUnits, stats, a, mode) {
  ensureDir(OUT_DIR);
  // 1) SRT — 双语（原文在上，译文在下），走 core.buildSrt（与线上同一产出路径）。
  const srt = Core.buildSrt(renderUnits, { mode: "bilingual_orig_top" });
  fs.writeFileSync(path.join(OUT_DIR, "subtitles.srt"), srt, "utf8");

  // 2) review.html — 三列：时间轴 | 原文 | 译文。
  const rows = renderUnits.map((u, i) => {
    const ts = fmtMs(u.start) + " → " + fmtMs(u.end);
    return "<tr><td class=n>" + (i + 1) + "</td><td class=t>" + htmlEscape(ts) +
      "</td><td class=o>" + htmlEscape(u.originalText) +
      "</td><td class=z>" + htmlEscape(u.translation) + "</td></tr>";
  }).join("\n");
  const html =
    "<!doctype html><html lang=zh><head><meta charset=utf-8>" +
    "<title>dualsub E2E review — " + htmlEscape(mode) + "</title><style>" +
    "body{font:14px/1.6 system-ui,Segoe UI,Arial;margin:24px;color:#222}" +
    "h1{font-size:18px}.meta{color:#666;margin-bottom:12px}" +
    "table{border-collapse:collapse;width:100%}" +
    "th,td{border:1px solid #ddd;padding:6px 8px;vertical-align:top}" +
    "th{background:#f5f5f5;text-align:left;position:sticky;top:0}" +
    "td.n{color:#999;text-align:right;width:40px}td.t{color:#888;white-space:nowrap;font-family:monospace;width:170px}" +
    "td.o{color:#555;width:42%}td.z{color:#06c;font-weight:600}" +
    "tr:nth-child(even){background:#fafafa}</style></head><body>" +
    "<h1>dualsub E2E review (v0.5.0)</h1><div class=meta>mode: " + htmlEscape(mode) +
    " &nbsp;|&nbsp; render units: " + renderUnits.length +
    " &nbsp;|&nbsp; clipSeconds=" + a.clipSeconds + " minLineChars=" + a.minLineChars + "</div>" +
    "<table><thead><tr><th>#</th><th>时间轴</th><th>原文</th><th>译文</th></tr></thead><tbody>" +
    rows + "</tbody></table></body></html>";
  fs.writeFileSync(path.join(OUT_DIR, "review.html"), html, "utf8");

  // 3) stats.json — 延迟统计。
  const sorted = stats.requestMs.slice().sort((x, y) => x - y);
  const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const out = {
    mode,
    tuning: { clipSeconds: a.clipSeconds, firstClipSeconds: a.firstClipSeconds,
              minLineChars: a.minLineChars,
              reasoningEffort: a.reasoningEffort,
              timeoutMs: a.timeoutMs || (a.real ? 90000 : 20000) },
    totalMs: stats.totalMs,
    firstUnitMs: stats.firstUnitMs,
    clips: stats.clipMs.length,
    clipMs: { values: stats.clipMs, avg: avg(stats.clipMs), max: Math.max.apply(null, stats.clipMs.concat([0])) },
    requests: { count: stats.requestMs.length, avg: avg(stats.requestMs),
                p50: pct(0.5), p95: pct(0.95), max: Math.max.apply(null, stats.requestMs.concat([0])) },
    clipFallbacks: stats.clipFallbacks,
    emptyClips: stats.emptyClips,
    retries429: stats.retries429,
    renderUnits: renderUnits.length,
  };
  fs.writeFileSync(path.join(OUT_DIR, "stats.json"), JSON.stringify(out, null, 2), "utf8");
  return out;
}

function printStats(stats, renderUnits, a) {
  const clipAvg = avg(stats.clipMs);
  const clipMax = Math.max.apply(null, stats.clipMs.concat([0]));
  console.log("\n--- 延迟统计 ---");
  console.log("总耗时        :", stats.totalMs, "ms");
  console.log("首单元延迟    :", stats.firstUnitMs, "ms  (firstUnitMs)");
  console.log("clip 数       :", stats.clipMs.length);
  console.log("每 clip 耗时  : avg", clipAvg, "ms  max", clipMax, "ms");
  console.log("请求数        :", stats.requestMs.length, " avg", avg(stats.requestMs), "ms");
  console.log("clip 翻译失败 :", stats.clipFallbacks);
  console.log("空 clip(显原文):", stats.emptyClips);
  console.log("429 次数      :", stats.retries429);
  console.log("渲染单元总数  :", renderUnits.length);
}

/* ============================== 切词/丢字自检 ============================== */
/*
 * 为什么不能只用 Intl.Segmenter：它把成语「隔三差五」切成 4 个单字词 [隔][三][差][五]，
 * 于是「隔三差」|「五要」边界被判为「落在两个独立单字之间」→ 合法 → 漏报（旧 audit 的盲区）。
 * 字幕后处理后的相邻行常为 CJK 收尾→CJK 起头；若把「裸 CJK 边界」一律判成切词，会
 * 把每个正常断行都误报。因此分三层检测，既抓 segmenter 漏网的成语，又不误伤干净断行：
 *  Tier1 拉丁/数字 token 跨行被劈（边界两侧都是字母/数字、无空格）。
 *  Tier2 segmenter 识别的 >=2 字普通词跨行被劈（治「经/常」「预/测」）。
 *  Tier3 成语/紧密搭配跨行被劈（治「隔三差/五」）：用 curated 成语表 —— segmenter 对成语
 *        欠分词，单靠它必漏；此表是「比 segmenter 多扫一层」的兜底，可持续扩充。
 *        判据：把 A 行尾若干 CJK + B 行首若干 CJK 拼起来，若某成语【跨越边界】出现 → 切词。
 */
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const ZH_SEG = (typeof Intl !== "undefined" && Intl.Segmenter)
  ? new Intl.Segmenter("zh", { granularity: "word" }) : null;

// 常见成语/紧密四字搭配（segmenter 会欠分词的）。命中即「不可在内部断行」。可扩充。
const IDIOMS = [
  "隔三差五", "三番五次", "乱七八糟", "一塌糊涂", "莫名其妙", "不三不四",
  "九牛一毛", "千方百计", "想方设法", "无论如何", "总而言之", "归根结底",
  "一如既往", "理所当然", "实事求是", "名副其实", "一举两得", "层出不穷",
];

function trailingCjk(s) { let i = s.length; while (i > 0 && CJK_RE.test(s[i - 1])) i--; return s.slice(i); }
function leadingCjk(s) { let i = 0; while (i < s.length && CJK_RE.test(s[i])) i++; return s.slice(0, i); }

// 相邻行 a(结尾)+b(开头) 拼接处是否劈开一个词/数字/成语。返回告警字符串或 null。
function detectCut(prevTrans, nextTrans) {
  const pa = (prevTrans || "").trim();
  const nb = (nextTrans || "").trim();
  if (!pa || !nb) return null;
  const lastCh = pa[pa.length - 1];
  const firstCh = nb[0];

  // Tier1：拉丁/数字 token 被劈（含数字千分位/小数点恰好落在行尾的情形：「3,」|「000」）。
  if (/[0-9A-Za-z]/.test(lastCh) && /[0-9A-Za-z]/.test(firstCh)) {
    return "拉丁/数字 token 跨行被劈: …「" + pa.slice(-8) + "」||「" + nb.slice(0, 8) + "」…";
  }
  if ((lastCh === "," || lastCh === "." || lastCh === "，") &&
      /[0-9]/.test(pa[pa.length - 2] || "") && /[0-9]/.test(firstCh)) {
    return "数字 token 跨行被劈(千分位/小数点): …「" + pa.slice(-8) + "」||「" + nb.slice(0, 8) + "」…";
  }

  if (CJK_RE.test(lastCh) && CJK_RE.test(firstCh)) {
    const tail = trailingCjk(pa);
    const head = leadingCjk(nb);
    const joined = tail + head;
    const boundary = tail.length; // joined[boundary-1] 是 A 末字，joined[boundary] 是 B 首字

    // Tier3：成语跨边界（segmenter 欠分词的核心盲区）。
    for (const idiom of IDIOMS) {
      let from = 0;
      while (true) {
        const at = joined.indexOf(idiom, from);
        if (at < 0) break;
        if (at < boundary && at + idiom.length > boundary) {
          return "成语跨行被劈: …「" + tail + "」||「" + head + "」… → 成语「" + idiom + "」";
        }
        from = at + 1;
      }
    }

    // Tier2：segmenter 的 >=2 字普通词跨边界。
    if (ZH_SEG) {
      for (const seg of ZH_SEG.segment(joined)) {
        const s0 = seg.index;
        const s1 = seg.index + seg.segment.length;
        if (s0 < boundary && s1 > boundary && seg.segment.length >= 2 && seg.isWordLike) {
          return "CJK 词跨行被劈: …「" + tail + "」||「" + head + "」… → 词「" + seg.segment + "」";
        }
      }
    }
  }
  return null;
}

// 遍历相邻渲染单元做切词检测 + 整体有内容断言。打印 PASS / 具体告警行。返回 {pass,...}。
function auditWordCuts(renderUnits, focusN) {
  const warns = [];
  for (let i = 0; i + 1 < renderUnits.length; i++) {
    const cut = detectCut(renderUnits[i].translation, renderUnits[i + 1].translation);
    if (cut) warns.push({ line: i + 1, msg: cut });
  }
  const focus = focusN || 40;
  const focusWarns = warns.filter((w) => w.line <= focus);

  let cjkChars = 0, withTrans = 0;
  for (const u of renderUnits) {
    const t = (u.translation || "").trim();
    if (t) withTrans++;
    for (const ch of t) if (CJK_RE.test(ch)) cjkChars++;
  }

  console.log("\n--- 切词/丢字自检 (auditWordCuts) ---");
  console.log("扫描相邻单元对 :", Math.max(0, renderUnits.length - 1));
  console.log("有译文单元数   :", withTrans, "/", renderUnits.length, " CJK 字符总数", cjkChars);
  if (!warns.length) {
    console.log("结论          : PASS — 全程无切词、无半词/半成语跨行。");
  } else if (!focusWarns.length) {
    console.log("结论          : PASS (前 " + focus + " 行) — 前 " + focus + " 行无切词；全量另有 " +
                warns.length + " 处疑似(见下)。");
  } else {
    console.log("结论          : FAIL — 前 " + focus + " 行检出 " + focusWarns.length + " 处切词告警:");
  }
  for (const w of warns.slice(0, 20)) {
    const tag = w.line <= focus ? "  [告警]" : "  [远端]";
    console.log(tag + " 行" + w.line + ": " + w.msg);
  }
  return { warns, focusWarns, pass: focusWarns.length === 0, cjkChars, withTrans };
}

// 检测器自检（契约保证）：把已知「坏样本」喂给 detectCut，必须 FAIL（返回告警）；
// 把已知「好样本」喂给它，必须 PASS（返回 null）。任一不符 → 抛错中断（audit 不可信即视为失败）。
function auditSelfTest() {
  const mustCut = [
    ["如果你是个人类，你总会隔三差", "五要做的一件事，就是烧水", "成语「隔三差五」"],
    ["我们可以经", "常做这件事", "普通词「经常」"],
    ["处理3,", "000 个请求", "数字 token 3,000"],
  ];
  const mustPass = [
    ["如果你是人类", "你迟早会经常做的一件事", "干净短语边界"],
    ["我们烧水有很多原因", "从做饭到清洁消毒", "干净短语边界"],
    ["也许你会把它算到做饭那一类里吧", "我也不确定", "功能词边界(也|我)不应误报"],
  ];
  let ok = true;
  console.log("\n--- 检测器自检 (auditSelfTest) ---");
  for (const [a, b, label] of mustCut) {
    const r = detectCut(a, b);
    const pass = !!r;
    console.log((pass ? "  ✓" : "  ✗") + " 坏样本应 FAIL [" + label + "]: " + (r || "（漏报！）"));
    if (!pass) ok = false;
  }
  for (const [a, b, label] of mustPass) {
    const r = detectCut(a, b);
    const pass = !r;
    console.log((pass ? "  ✓" : "  ✗") + " 好样本应 PASS [" + label + "]: " + (r ? "（误报：" + r + "）" : "ok"));
    if (!pass) ok = false;
  }
  if (!ok) {
    console.error("\n[harness] auditSelfTest 失败：检测器契约不成立，audit 结果不可信。");
    process.exitCode = 1;
  } else {
    console.log("结论          : PASS — 检测器对坏样本必报、对干净边界不误报。");
  }
  return ok;
}

module.exports = { detectCut, auditWordCuts, auditSelfTest, cueZhFromRefs };

// 入口（被 require 时不自动跑）。
if (require.main === module) {
  run().catch((e) => {
    console.error("\n[harness] 运行失败：", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
