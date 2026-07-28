/**
 * audit-units.js — 对落盘的渲染单元做程序层复核（零 token）。
 *
 * 为什么存在
 * ----------
 * 真实模式跑一轨要烧 8 个块 × 12-23s 的真实翻译。此前每次想复核「可读性达标吗 /
 * 有重叠吗 / 超宽吗」都得重跑整轨，而这些量全是确定性的、只依赖已产出的单元。
 *
 * 铁律：所有判据必须调用 core.js 的生产函数，不许在这里另写一份。
 * 曾经的教训 —— 用自己拼装单元、绕过 mergeUnreadableUnits 的临时脚本观察到一个
 * 300ms 的「读不完」屏，据此把「已被合并层兜住」误判成「缺陷会上屏」。诊断脚本
 * 绕过生产管线，就会得出关于生产的错误结论。
 *
 * 用法
 * ----
 *   node test/audit-units.js                      # 默认读 test/e2e-out/units.json
 *   node test/audit-units.js path/to/units.json
 *   node test/audit-units.js --strict             # 有缺陷则 exit 1（可作门禁）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const Core = require("../core.js");

const DEFAULT_FILE = path.join(__dirname, "e2e-out", "units.json");

/** 与生产同一口径（core.js mergeUnreadableUnits）：宽度/2 取整=字数，× 每字毫秒 */
function readingMsFor(text) {
  return Math.ceil(Core.semanticDisplayWidth(text) / 2) * Core.READING_MS_PER_CHAR;
}

function audit(units) {
  const sorted = units.slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const findings = { overlap: [], unreadable: [], tooWide: [], untranslated: [], nonPositive: [] };

  sorted.forEach((u, i) => {
    const trans = String(u.translation || "").trim();
    const span = u.end - u.start;

    if (!trans) findings.untranslated.push({ i: i + 1, at: u.start, orig: u.originalText });
    if (span <= 0) findings.nonPositive.push({ i: i + 1, at: u.start, span: span });

    if (trans) {
      const need = readingMsFor(trans);
      if (span > 0 && need > span) {
        findings.unreadable.push({ i: i + 1, span: span, need: Math.round(need), text: trans });
      }
      const w = Core.semanticDisplayWidth(trans);
      if (w > 48 + Core.DISPLAY_SOFT_OVERFLOW) {
        findings.tooWide.push({ i: i + 1, width: w, text: trans });
      }
    }
    if (i && u.start < sorted[i - 1].end) {
      findings.overlap.push({ i: i + 1, by: sorted[i - 1].end - u.start, at: u.start });
    }
  });

  return { total: sorted.length, findings: findings };
}

function report(file, strict) {
  if (!fs.existsSync(file)) {
    console.log(`样本不存在: ${file}`);
    console.log("先跑一次 e2e-harness（真实模式会落盘 units.json），再来复核。");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const units = raw.units || raw;
  const r = audit(units);
  const f = r.findings;

  console.log(`样本 ${path.basename(file)} | 单元 ${r.total}` +
    (raw.mode ? ` | ${raw.mode}` : "") + (raw.contract ? ` | ${raw.contract}` : "") +
    (raw.savedAt ? ` | ${raw.savedAt}` : ""));
  console.log(`可读性口径 ${Core.READING_MS_PER_CHAR.toFixed(0)}ms/字（Netflix TTSG 简中成人 9 字/秒）`);
  console.log(`重叠 ${f.overlap.length} | 读不完 ${f.unreadable.length} | ` +
    `超宽 ${f.tooWide.length} | 未译 ${f.untranslated.length} | 非正时长 ${f.nonPositive.length}`);

  const show = (label, list, fmt) => {
    if (!list.length) return;
    console.log(`\n${label}（前 6）`);
    list.slice(0, 6).forEach((x) => console.log("  " + fmt(x)));
  };
  show("读不完", f.unreadable.slice().sort((a, b) => (b.need - b.span) - (a.need - a.span)),
    (x) => `#${x.i} 窗口 ${x.span}ms 需 ${x.need}ms | ${x.text}`);
  show("重叠", f.overlap, (x) => `#${x.i} @${x.at} 与前屏重叠 ${x.by}ms`);
  show("超宽", f.tooWide, (x) => `#${x.i} 宽 ${x.width} | ${x.text}`);
  show("未译", f.untranslated, (x) => `#${x.i} @${x.at} | ${x.orig}`);

  const bad = f.overlap.length + f.tooWide.length + f.untranslated.length + f.nonPositive.length;
  if (strict && bad) {
    console.log(`\nFAIL: ${bad} 处硬缺陷`);
    process.exit(1);
  }
  console.log(bad ? "\n有硬缺陷（未开 --strict，不作退出码判定）" : "\nPASS: 无硬缺陷");
  return r;
}

module.exports = { audit, readingMsFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const file = args.find((a) => !a.startsWith("--")) || DEFAULT_FILE;
  report(file, strict);
}
