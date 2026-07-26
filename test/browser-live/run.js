#!/usr/bin/env node
/**
 * 真实运行验证：在真 Chromium 里跑真 ASR 轨 + 真模型，按真实速率播 N 分钟。
 *
 * 与 test/browser-replay 的区别：那套用 fixture 轨 + stub 翻译，验状态机；
 * 这套不 stub 任何模型调用，验"用户真实观看时屏幕上有没有中文"。
 */
const assert = require("assert");
const CDP = process.env.DUALSUB_CDP_URL;
const HOST = process.env.DUALSUB_REPLAY_HOST;
const TRACKS = (process.env.DUALSUB_LIVE_TRACKS || "").split(",").filter(Boolean);
const MINUTES = Number(process.env.DUALSUB_LIVE_MINUTES || 5);
const SOURCE_LANG = process.env.DUALSUB_LIVE_LANG || "en";
const BASE = process.env.DS_BASE, MODEL = process.env.DS_MODEL, KEY = process.env.DS_KEY;
assert.ok(CDP && HOST, "need DUALSUB_CDP_URL + DUALSUB_REPLAY_HOST");
assert.ok(TRACKS.length, "need DUALSUB_LIVE_TRACKS");
assert.ok(BASE && MODEL && KEY, "need DS_BASE / DS_MODEL / DS_KEY");

async function newTab(url) {
  const r = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`newTab ${r.status}`);
  return r.json();
}
async function closeTab(id) { try { await fetch(`${CDP}/json/close/${id}`); } catch {} }

function ws(url) {
  return new Promise((res, rej) => {
    const s = new WebSocket(url);
    s.onopen = () => res(s); s.onerror = (e) => rej(new Error("ws fail"));
  });
}
let msgId = 0;
function send(sock, method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      sock.removeEventListener("message", on);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
    sock.addEventListener("message", on);
    sock.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(sock, expr) {
  const r = await send(sock, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

(async () => {
  let failed = 0;
  for (const track of TRACKS) {
    const url = `http://${HOST}:8899/test/browser-live/index.html?track=${encodeURIComponent(track)}&minutes=${MINUTES}&lang=${encodeURIComponent(SOURCE_LANG)}&cb=${Date.now()}`;
    const tab = await newTab("about:blank");
    const sock = await ws(tab.webSocketDebuggerUrl);
    try {
      await send(sock, "Runtime.enable", {});
      await send(sock, "Page.enable", {});
      // 凭据注入到页面上下文，不进 URL（不留在历史/日志里）
      await send(sock, "Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__DS_BASE=${JSON.stringify(BASE)};window.__DS_MODEL=${JSON.stringify(MODEL)};window.__DS_KEY=${JSON.stringify(KEY)};`,
      });
      await send(sock, "Page.navigate", { url });

      const deadline = Date.now() + MINUTES * 60000 + 90000;
      let last = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15000));
        const st = await evaluate(sock, `(()=>{const R=window.__report;if(!R)return null;
          const s=R.paintSamples||[];const withTrans=s.filter(x=>x.trans&&x.trans.trim()).length;
          return {at:s.length?s[s.length-1].at:0,samples:s.length,withTrans,
            cov:s.length?Math.round(withTrans/s.length*100):0,api:R.apiCalls,fail:R.apiFails,aborts:R.apiAborts||0,
            errors:R.errors.length,mode:R.segmentationMode||'',finished:R.finished};})()`);
        if (!st) continue;
        if (st.at !== last) {
          console.log(`  [${track}] 播放 ${st.at}s | 有中文 ${st.cov}% (${st.withTrans}/${st.samples}) | API ${st.api}(失败${st.fail}) | err ${st.errors}`);
          last = st.at;
        }
        if (st.finished) break;
      }

      const R = await evaluate(sock, `(()=>{const R=window.__report;const s=R.paintSamples||[];
        // 首屏之后（跳过前 15s 冷启动）评价；但必须区分两种口径：
        // 1) wallCov = 全部墙钟采样里有中文的比例（会把演讲停顿/无原文静默算作“未译”）
        // 2) sourceCov = **屏幕有原文时**同步有中文的比例，才是“字幕跟不跟得上”的用户口径
        const after=s.filter(x=>x.at>15);
        const wallTranslated=after.filter(x=>x.trans&&x.trans.trim()).length;
        const source=after.filter(x=>x.orig&&x.orig.trim());
        const sourceTranslated=source.filter(x=>x.trans&&x.trans.trim()).length;
        // 最长漏译空窗只在“有原文却无译文”时累积；静默/无原文会清零，不能诬告产品。
        let gap=0,cur=0;for(const x of after){
          if(x.orig&&x.orig.trim()&&!(x.trans&&x.trans.trim())){cur++;if(cur>gap)gap=cur}else{cur=0}
        }
        const uniqTrans=new Set(after.map(x=>x.trans).filter(Boolean)).size;
        const uniqOrig=new Set(after.map(x=>x.orig).filter(Boolean)).size;
        return {samples:after.length,wallTranslated,wallCov:after.length?Math.round(wallTranslated/after.length*100):null,
          sourceSamples:source.length,sourceTranslated,sourceCov:source.length?Math.round(sourceTranslated/source.length*100):null,
          maxGapSec:gap*0.5,uniqTrans,uniqOrig,api:R.apiCalls,fail:R.apiFails,aborts:R.apiAborts||0,
          errors:R.errors.slice(0,5),warnings:R.warnings.slice(0,5),apiFailDetail:R.apiFailDetail||[],
          mode:R.segmentationMode,pauseCalls:R.pauseCalls,playCalls:R.playCalls,
          seeks:(R.seeks||[]).length,nativeHidden:s.length?s[s.length-1].nativeHidden:null,
          exportOk:!!(R.exportSrt&&R.exportSrt.ok),exportErr:R.exportSrt&&R.exportSrt.error,
        exportUntranslated:R.exportSrt&&R.exportSrt.untranslated};})()`);

      console.log(`\n[${track}] 结果`);
      console.log(`  有原文时译文覆盖: ${R.sourceCov == null ? "N/A（无原文样本）" : R.sourceCov + "% (" + R.sourceTranslated + "/" + R.sourceSamples + ")"}`);
      console.log(`  墙钟中文覆盖率  : ${R.wallCov == null ? "N/A" : R.wallCov + "% (" + R.wallTranslated + "/" + R.samples + ")"}（含静默，仅诊断）`);
      console.log(`  最长真实漏译空窗: ${R.maxGapSec}s`);
      console.log(`  不同译文条数 : ${R.uniqTrans}（原文 ${R.uniqOrig}）`);
      console.log(`  API          : ${R.api} 次，失败 ${R.fail}，主动取消 ${R.aborts}（区间换入废弃旧断句，预期）`);
      console.log(`  断句模式     : ${R.mode} | 原生字幕已隐藏: ${R.nativeHidden}`);
      console.log(`  暂停/播放    : ${R.pauseCalls}/${R.playCalls} | seek ${R.seeks}`);
      // 导出 fail-closed 要求全片译完；只播 N 分钟时后段本就未译，不算缺陷。
      console.log(`  导出 SRT     : ${R.exportOk ? "全片可导出" : "未全译(预期，只播了 " + MINUTES + " 分钟)"}`);
      if (R.errors.length) { console.log(`  ✗ JS 错误:`); R.errors.forEach((e) => console.log("    " + String(e).slice(0, 200))); failed++; }
      if (R.warnings.length) { console.log(`  警告:`); R.warnings.forEach((w) => console.log("    " + String(w).slice(0, 160))); }
      if (!R.sourceSamples) { console.log(`  ✗ 首屏后无原文样本，无法评价跟随效果`); failed++; }
      else if (R.sourceCov < 90) { console.log(`  ✗ 有原文时译文覆盖 ${R.sourceCov}% < 90%`); failed++; }
      if (R.maxGapSec > 12) { console.log(`  ✗ 真实漏译空窗 ${R.maxGapSec}s > 12s`); failed++; }
      if (R.fail > 0) {
        console.log(`  ✗ 有 ${R.fail} 次 API 失败`);
        (R.apiFailDetail || []).slice(0, 4).forEach((d) => console.log(`    ${JSON.stringify(d).slice(0, 260)}`));
        failed++;
      }
    } finally {
      sock.close(); await closeTab(tab.id);
    }
  }
  console.log(failed ? `\n✗ live run: ${failed} 项问题` : `\n✓ live run: ${TRACKS.length} 条轨全部通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("runner error:", e && e.message); process.exit(2); });
