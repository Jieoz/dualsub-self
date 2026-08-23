#!/usr/bin/env node
/**
 * 检查器自检（防止门禁被悄悄改弱）
 * =================================
 * 承重门禁自己也必须被测试，否则某天有人放宽一条正则就没人知道了。
 * 这里用真实失败样本（2026-08-22 v18 的静默 catch 原样）验证：
 * 坏样本必报、好样本不误报。
 */

"use strict";

const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHECKER = path.join(__dirname, "check-silent-catch.js");

function runOn(source) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-")), "sample.js");
  fs.writeFileSync(tmp, source, "utf8");
  try {
    execFileSync("node", [CHECKER, tmp], { encoding: "utf8", stdio: "pipe" });
    return { failed: false, out: "" };
  } catch (e) {
    return { failed: true, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

const cases = [];
function t(name, fn) { cases.push([name, fn]); }

// ---------- 坏样本：必须报 ----------

t("v18 真实样本：条件式重抛，其余失败静默 → 必报", () => {
  const r = runOn(`
    async function refine() {
      try { doWork(); }
      catch (error) {
        // 网络/超时/解析失败都不升级为整轨失败
        if (error && /translate aborted/i.test(String(error.message || error))) throw error;
      }
    }
  `);
  assert.ok(r.failed, "条件式 throw 不能被当成可观测——这正是 v18 漏网的形状");
});

t("完全空的 catch → 必报", () => {
  assert.ok(runOn(`function a(){ try { risky(); } catch (e) {} }`).failed);
});

t("吞成 null → 必报", () => {
  assert.ok(runOn(`function a(){ try { return JSON.parse(s); } catch (_) { return null; } }`).failed);
});

t("注释里写了 console.warn 但代码没有 → 必报（不能被注释骗过）", () => {
  assert.ok(runOn(`function a(){ try { risky(); } catch (e) { /* 本该 console.warn 但没写 */ } }`).failed);
});

// ---------- 好样本：不得误报 ----------

t("console.warn → 放行", () => {
  assert.ok(!runOn(`function a(){ try { risky(); } catch (e) { console.warn("x", e); } }`).failed);
});

t("上报回调 → 放行", () => {
  assert.ok(!runOn(`function a(){ try { risky(); } catch (e) { opts.onRefineFailure(String(e)); } }`).failed);
});

t("无条件重抛 → 放行", () => {
  assert.ok(!runOn(`function a(){ try { risky(); } catch (e) { throw e; } }`).failed);
});

t("失败计数器自增 → 放行", () => {
  assert.ok(!runOn(`function a(){ try { risky(); } catch (e) { stats.refineFailures.push(String(e)); } }`).failed);
});

t("显式豁免注释 → 放行", () => {
  assert.ok(!runOn(`function a(){ try { risky(); } catch (e) { /* fail-soft-ok: 探测性调用，失败即视为不支持 */ } }`).failed);
});

t("字符串里的花括号不得干扰块扫描", () => {
  const r = runOn(`function a(){ try { risky(); } catch (e) { console.warn("}{", e); } }`);
  assert.ok(!r.failed, "字符串内的括号被算进深度会导致块解析错位");
});

// ---------- 执行 ----------

let pass = 0, fail = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.error("  ✗ " + name + "\n      " + e.message); fail++; }
}
console.log(`\n检查器自检: 通过 ${pass}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
