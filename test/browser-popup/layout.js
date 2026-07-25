#!/usr/bin/env node
"use strict";
/**
 * Popup 布局可操作性门禁。
 *
 * 背景（v0.6.4 回归）：Chrome 扩展 popup 的高度是【由内容反推】的，不存在一个
 * 预先给定的视口高度。popup.html 里写 `html,body{height:100%}` 时，父级高度未定
 * → 百分比高度解析为 0 → body 塌缩成 0px → `flex:1` 的滚动区拿到 0 高度，叠加
 * `overflow:hidden` 后整个设置面板锁死：用户只看到两个分区标题，任何控件都无法
 * 操作，也无法滚动。
 *
 * 为什么既有 browser-popup/run.js 没抓到：它只验证 SRT 导出的确认/进度/导出/取消
 * 流程，从不检查控件是否真的可见可操作；而在普通浏览器标签里视口高度是确定的，
 * `height:100%` 能正常解析 —— 用固定视口测 popup 等于先给了 Chrome 不会给的东西。
 *
 * 因此本门禁把 popup.html 放进一个【高度不受约束】的 iframe，复现"高度由内容决定"
 * 这一 popup 特有条件，然后断言关键控件确实可见、可操作、在面板边界内。
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const endpoint = process.env.DUALSUB_CDP_URL || "http://172.19.0.33:9222";
const publicHost =
  process.env.DUALSUB_REPLAY_HOST ||
  Object.values(os.networkInterfaces())
    .flat()
    .find((x) => x && x.family === "IPv4" && !x.internal && /^172\./.test(x.address))?.address ||
  "127.0.0.1";

// Chrome popup 的高度上限。面板总高必须留在此之内，否则外层会出现第二条滚动条。
const POPUP_MAX_HEIGHT = 600;
// 滚动区至少要有这么高才算"可用"（低于此值说明发生了塌缩）。
const MIN_USABLE_CONTENT_HEIGHT = 300;

// 首屏必须可直接操作的常用控件：总开关、API 三项、字号、保存。
const CRITICAL_CONTROLS = ["enabled", "apiBaseUrl", "apiKey", "apiModel", "fontSize", "saveBtn"];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// 宿主页把 popup.html 塞进一个不给高度的 iframe，模拟 popup 由内容定高。
const HOST_PAGE = `<!DOCTYPE html><meta charset="utf-8"><title>popup layout host</title>
<style>html,body{margin:0;padding:0}iframe{width:380px;border:0;display:block}</style>
<iframe id="f" height="0" src="./popup.html"></iframe>`;

function serve(overrides) {
  const allowed = new Set(["popup.html", "popup.js", "core.js"]);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://x").pathname.replace(/^\//, "") || "host.html";
      if (name === "host.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(HOST_PAGE);
      }
      if (!allowed.has(name)) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.setHeader(
        "content-type",
        name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8"
      );
      let body = fs.readFileSync(path.join(ROOT, name), "utf8");
      // 故障注入用：把修复退回成 v0.6.4 的写法，验证门禁真的会变红。
      if (overrides && overrides[name]) body = overrides[name](body);
      res.setHeader("cache-control", "no-store");
      res.end(body);
    });
    server.listen(0, "0.0.0.0", () => resolve(server));
  });
}

async function connect() {
  const v = await fetch(endpoint + "/json/version").then((r) => r.json());
  const ws = new WebSocket(
    v.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, endpoint.replace(/^http/, "ws"))
  );
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return new CDP(ws);
}

// popup.js 需要 chrome.* 才能完成初始化；缺失会抛错并中断渲染。
const bootstrap = String.raw`(()=>{window.chrome={runtime:{lastError:null},storage:{local:{get(_k,cb){cb({})},set(_v,cb){if(cb)cb()}}},tabs:{query(_q,cb){cb([{id:1,url:"https://www.youtube.com/watch?v=fixture-video"}])},sendMessage(_id,m,cb){setTimeout(()=>cb({ok:true,videoId:"fixture-video",tracks:[],apiUsage:{promptTokens:0,completionTokens:0,totalTokens:0,requests:0}}),0)}}}})();`;

async function evaluate(cdp, sid, expression) {
  const out = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sid
  );
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "evaluation failed");
  return out.result.value;
}

async function waitFor(cdp, sid, expr, label, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await evaluate(cdp, sid, expr);
      if (last) return;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

/** 在宿主页里量取 iframe 内 popup 的真实布局。 */
const MEASURE = `(() => {
  const d = document.getElementById('f').contentDocument;
  const w = document.getElementById('f').contentWindow;
  const body = d.body;
  const content = d.querySelector('.content');
  const rect = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  const controls = {};
  for (const id of ${JSON.stringify(CRITICAL_CONTROLS)}) {
    const el = d.getElementById(id);
    controls[id] = el ? rect(el) : null;
  }
  const details = [...d.querySelectorAll('details')];
  const expand = open => details.forEach(x => { x.open = open; });
  const bodyH = () => Math.round(body.getBoundingClientRect().height);
  const collapsedHeight = bodyH();
  expand(true);
  const expandedHeight = bodyH();
  const expandedContent = content ? content.scrollHeight : 0;
  expand(false);
  return {
    bodyHeight: collapsedHeight,
    bodyComputedHeight: w.getComputedStyle(body).height,
    contentClientHeight: content ? content.clientHeight : 0,
    contentScrollHeight: content ? content.scrollHeight : 0,
    expandedBodyHeight: expandedHeight,
    expandedContentScrollHeight: expandedContent,
    detailsCount: details.length,
    controls,
  };
})()`;

async function measure(cdp, overrides) {
  const server = await serve(overrides);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const sid = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
    .sessionId;
  try {
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap }, sid);
    await cdp.send(
      "Page.navigate",
      { url: `http://${publicHost}:${server.address().port}/host.html` },
      sid
    );
    await waitFor(
      cdp,
      sid,
      "(()=>{const f=document.getElementById('f');return document.readyState==='complete'&&f&&f.contentDocument&&f.contentDocument.readyState==='complete'&&!!f.contentDocument.querySelector('.content')})()",
      "popup iframe ready"
    );
    return await evaluate(cdp, sid, MEASURE);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    server.close();
  }
}

function checkLayout(m) {
  const problems = [];
  if (m.contentClientHeight < MIN_USABLE_CONTENT_HEIGHT) {
    problems.push(
      `滚动区塌缩：可视高 ${m.contentClientHeight}px < ${MIN_USABLE_CONTENT_HEIGHT}px（内容 ${m.contentScrollHeight}px）`
    );
  }
  if (m.bodyHeight < MIN_USABLE_CONTENT_HEIGHT) {
    problems.push(`面板塌缩：body 高 ${m.bodyHeight}px（computed ${m.bodyComputedHeight}）`);
  }
  if (m.expandedBodyHeight > POPUP_MAX_HEIGHT) {
    problems.push(
      `全部分区展开后面板高 ${m.expandedBodyHeight}px 超出 Chrome popup 上限 ${POPUP_MAX_HEIGHT}px`
    );
  }
  for (const [id, r] of Object.entries(m.controls)) {
    if (!r) {
      problems.push(`控件缺失：#${id}`);
      continue;
    }
    if (r.w <= 0 || r.h <= 0) {
      problems.push(`控件不可见：#${id} 尺寸 ${r.w}x${r.h}`);
      continue;
    }
    // 控件必须落在面板可见范围内，而不是被挤到 0 高容器之外。
    if (r.bottom <= 0 || r.top >= m.bodyHeight) {
      problems.push(`控件在面板可见区之外：#${id} top=${r.top} bottom=${r.bottom} 面板高=${m.bodyHeight}`);
    }
  }
  return problems;
}

(async () => {
  const cdp = await connect();
  try {
    // 1) 当前实现必须通过
    const now = await measure(cdp, null);
    const problems = checkLayout(now);
    if (problems.length) {
      console.error("FAIL popup 布局可操作性门禁:");
      problems.forEach((p) => console.error("  - " + p));
      console.error("  实测: " + JSON.stringify(now));
      process.exit(1);
    }
    assert.ok(now.detailsCount > 0, "预期存在可折叠分区");

    // 2) 故障注入：退回 v0.6.4 的 height:100% + overflow:hidden 写法，门禁必须变红。
    //    否则这个门禁是装饰性的。
    const injected = await measure(cdp, {
      "popup.html": (src) =>
        src.replace(
          /body \{\n        display: flex;\n        flex-direction: column;\n      \}/,
          "html, body { height: 100%; }\n      body {\n        display: flex;\n        flex-direction: column;\n        max-height: 594px;\n        overflow: hidden;\n      }"
        ),
    });
    const injectedProblems = checkLayout(injected);
    if (!injectedProblems.length) {
      console.error(
        "FAIL 故障注入未被捕获：把 popup 退回 v0.6.4 的 height:100% 写法后门禁仍然通过，" +
          "说明该门禁无法防止塌缩回归。实测: " + JSON.stringify(injected)
      );
      process.exit(1);
    }

    console.log(
      `PASS popup 布局可操作性门禁（面板 ${now.bodyHeight}px / 滚动区 ${now.contentClientHeight}px 可视 ` +
        `${now.contentScrollHeight}px 内容 / ${CRITICAL_CONTROLS.length} 个关键控件可操作；` +
        `故障注入被捕获：${injectedProblems[0]}）`
    );
  } finally {
    cdp.ws.close();
  }
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
