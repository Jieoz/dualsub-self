#!/usr/bin/env node
/**
 * 静默 fail-soft catch 检查器（承重门禁）
 * =====================================
 *
 * 为什么存在
 * ---------
 * 2026-08-22 真实全片跑：语义补切 `refineOversizedSemanticUnits` 发出 72 次额外
 * 模型请求，最长单元却纹丝不动（40 词 / 16.0 秒，与补切前完全一致）。
 * 根因是 `allowed` 传了预过滤列表导致 parseTokenCutsResponse 位置索引错位，
 * 合法切点被判 unknown 而整包抛错 —— 但那个 catch 块**什么都没做**，
 * 于是失败被静默吞掉，日志一片正常，bug 藏满整整一轮真实验证（约 26 分钟）。
 *
 * 这类分支的危害不是"出错了"，而是**功能可以完全空跑而所有门禁保持全绿**：
 * 单测绿、mock E2E 绿、真实跑零失败，唯独功能没生效。人靠自觉记不住，
 * 所以把它变成机器检查。
 *
 * 规则
 * ----
 * 降级路径（catch / .catch()）必须可观测。catch 块里至少要有下列之一：
 *   1. 重新抛出        throw
 *   2. 上报回调        onXxxFailure / onError / onFailure(...)
 *   3. 日志            console.warn / console.error / log(...)
 *   4. 计数器自增      xxxFailures.push(...) / xxxErrors++ / stats.xxx++
 *   5. 显式豁免注释    // fail-soft-ok: <理由>
 *
 * 只有 5 需要人写理由，前 4 项是正常写法就自动满足。
 *
 * 用法
 * ----
 *   node test/check-silent-catch.js            # 检查默认文件集（对照 baseline）
 *   node test/check-silent-catch.js a.js b.js  # 检查指定文件
 *   node test/check-silent-catch.js --update-baseline   # 重新冻结存量
 *
 * baseline 说明
 * ------------
 * 仓库存在历史存量（多为 UI/兼容性的无害分支）。一次性全改风险大于收益，
 * 因此把存量冻结进 `test/silent-catch-baseline.json`：**存量不报错，新增一律拦截**。
 * 这样门禁立刻生效且不需要为了变绿而放宽规则。
 * 修掉存量后重新 `--update-baseline` 即可收紧，基线只应变小。
 *
 * 退出码：0 = 通过，1 = 发现新增的静默降级分支。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hash(s) {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
}

const DEFAULT_TARGETS = [
  "core.js",
  "main.js",
  "isolated.js",
  "popup.js",
];

const EXEMPT_MARKER = /fail-soft-ok/i;

// catch 块内被视为“可观测”的证据。
// 注意：`throw` 只有在**无条件**重抛时才算数。条件式重抛（if (...) throw e）
// 意味着不满足条件的绝大多数失败仍然静默 —— v18 真实样本正是这个形状：
//     catch (error) {
//       if (error && /translate aborted/i.test(...)) throw error;   // 只重抛 abort
//     }                                                            // 其余全吞
// 用最容易检测的形状建门禁，等于给自己发免罪符。这里必须单独判定。
const OBSERVABLE = [
  /\bconsole\s*\.\s*(warn|error|log|info|debug)\s*\(/,
  /\bon[A-Z]\w*(Failure|Error|Fail)\s*\(/,
  /\bon(Failure|Error|Fail)\s*\(/,
  /\b\w*(Failures|Errors|Fails)\s*\.\s*push\s*\(/,
  /\b\w*(Failures|Errors|Fails|Count)\s*\+\+/,
  /\+\+\s*\w*(Failures|Errors|Fails|Count)\b/,
  /\b\w+\s*\.\s*\w*(Failures|Errors|Fails|Count)\s*(\+\+|\+=)/,
  /\blog(Warn|Error|Failure)?\s*\(/,
  /\breport\w*\s*\(/,
  /\bemit\w*\s*\(/,
  /\btrack\w*\s*\(/,
  // 用户可见的错误反馈，等价于日志：失败没有被藏起来。
  /\bsetStatus\s*\([^)]*(err|失败|错误)/i,
  /\bsendResponse\s*\(\s*\{[^}]*\berror\b/,
  /\breturn\s*\{[^}]*\bok\s*:\s*false[^}]*\berror\b/,
  /\balert\s*\(/,
];

/**
 * 判断 catch 体内是否存在**无条件** throw。
 *
 * 做法：剥掉所有 if / else if / for / while 等条件与循环语句所控制的部分，
 * 看剩下的顶层语句里还有没有 throw。这里用保守的近似：若某个 throw 之前
 * 在同一层级出现过 `if (` 且该 throw 落在该 if 的控制范围内，则不算无条件。
 * 简化实现：逐行扫描顶层（去掉嵌套块），只认独立成句的 throw。
 */
function hasUnconditionalThrow(code) {
  // 移除所有嵌套的 { ... } 块内容，只留顶层语句序列
  let top = "";
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") { depth++; if (depth === 1) continue; }
    if (ch === "}") { depth--; if (depth === 0) continue; }
    if (depth === 1) top += ch;
  }

  // 顶层按分号/换行切句
  const statements = top.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const st of statements) {
    // 条件式重抛不算：if (...) throw x / cond && throw / cond ? ... :
    if (/^(if|else|for|while|switch|case|do)\b/.test(st)) continue;
    if (/^\}?\s*(else|catch|finally)\b/.test(st)) continue;
    if (/&&|\|\||\?/.test(st) && /\bthrow\b/.test(st)) continue;
    if (/^\s*throw\b/.test(st)) return true;
  }
  return false;
}


/**
 * 从 `catch` 关键字处扫描出配对的大括号块。
 * 逐字符扫描并跳过字符串/模板串/正则/注释，避免把这些里面的括号算进深度。
 */
function extractCatchBody(source, catchIndex) {
  let i = source.indexOf("{", catchIndex);
  if (i === -1) return null;
  const start = i;
  let depth = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // 注释
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // 字符串 / 模板串
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return { body: source.slice(start, i), endIndex: i };
      continue;
    }
    i++;
  }
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** 取 catch 块前若干行，用于识别豁免注释。 */
function precedingContext(source, index) {
  const from = Math.max(0, index - 400);
  return source.slice(from, index);
}

function checkFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return [];
  const source = fs.readFileSync(abs, "utf8");
  const violations = [];
  // 同一文件里多个形态相同的块（例如多个空 catch）指纹会碰撞，用出现序号消歧。
  const seen = new Map();

  const catchRe = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
  let match;
  while ((match = catchRe.exec(source)) !== null) {
    const extracted = extractCatchBody(source, match.index);
    if (!extracted) continue;
    const { body } = extracted;

    // 块内或紧邻上文标注豁免
    if (EXEMPT_MARKER.test(body) || EXEMPT_MARKER.test(precedingContext(source, match.index))) {
      continue;
    }

    // 去掉注释后判断是否真的有可观测动作（注释里的 console.warn 不算数）
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

    const observable = OBSERVABLE.some((re) => re.test(code)) || hasUnconditionalThrow(code);
    if (observable) continue;

    // 空 catch 与只有赋值/return 的 catch 都算静默降级。
    // 指纹用「文件 + 归一化后的块内容」而非行号：上下文增删行不该触发误报，
    // 但只要这个 catch 本身被改动，它就必须重新过审。
    const normalized = code.replace(/\s+/g, " ").trim();
    const base = `${path.basename(abs)}::${hash(normalized)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    violations.push({
      file: path.relative(process.cwd(), abs),
      line: lineOf(source, match.index),
      snippet: body.replace(/\s+/g, " ").slice(0, 120),
      fingerprint: `${base}#${n}`,
    });
  }
  return violations;
}

function main() {
  const argv = process.argv.slice(2);
  const updateBaseline = argv.includes("--update-baseline");
  const args = argv.filter((a) => !a.startsWith("--"));
  const targets = args.length ? args : DEFAULT_TARGETS;
  const adHoc = args.length > 0;

  let all = [];
  for (const t of targets) all = all.concat(checkFile(t));

  // 指定文件时不走 baseline（用于自检与临时排查）
  if (adHoc) return report(all, []);

  const baselinePath = path.join(__dirname, "silent-catch-baseline.json");

  if (updateBaseline) {
    const frozen = all.map((v) => v.fingerprint).sort();
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          note:
            "静默 fail-soft catch 的历史存量指纹。存量不报错，新增一律拦截。" +
            "修掉存量后重新运行 --update-baseline 收紧；这个列表只应变小。",
          generated: new Date().toISOString().slice(0, 10),
          count: frozen.length,
          fingerprints: frozen,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`已冻结 ${frozen.length} 处存量 → ${path.relative(process.cwd(), baselinePath)}`);
    process.exit(0);
  }

  let baseline = [];
  if (fs.existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).fingerprints || [];
    } catch (e) {
      console.error("baseline 文件损坏，无法解析：", e.message);
      process.exit(1);
    }
  }
  report(all, baseline);
}

function report(all, baseline) {
  const known = new Set(baseline);
  const fresh = all.filter((v) => !known.has(v.fingerprint));
  const stale = all.length - fresh.length;

  if (!fresh.length) {
    console.log(
      `静默 fail-soft catch 检查: PASS — 无新增静默降级分支` +
        (stale ? `（已知存量 ${stale} 处，见 baseline）。` : "。")
    );
    process.exit(0);
  }

  console.error("\n静默 fail-soft catch 检查: FAIL");
  console.error(
    "\n以下 catch 块吞掉失败且不留任何痕迹。这类分支能让功能完全空跑而门禁全绿\n" +
      "（实例：2026-08-22 语义补切发了 72 次请求零效果，藏满一轮真实验证）。\n"
  );
  for (const v of fresh) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    "\n修法（任选其一，前四项是正常写法）：\n" +
      "  · throw 重新抛出（注意：条件式 if(...)throw 不算，其余失败仍是静默的）\n" +
      "  · 调用上报回调 onXxxFailure(...)\n" +
      "  · console.warn / console.error 记录\n" +
      "  · 失败计数器自增，并在报告里打印出来\n" +
      "  · 确属有意静默：加注释 // fail-soft-ok: <具体理由>\n"
  );
  process.exit(1);
}

main();

