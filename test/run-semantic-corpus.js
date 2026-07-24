"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "semantic-adversarial-corpus.json"), "utf8"));
function plain(marked) { return marked.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim(); }
function tokensOf(text) { return text.split(/\s+/).map((word, i) => ({ text: word, start: i * 180, end: (i + 1) * 180, nativeTiming: true })); }
(async () => {
  let success = 0, fallback = 0;
  for (const item of cases) {
    const source = plain(item.marked);
    const tokens = tokensOf(source);
    let calls = 0;
    const sourceMarks = Core.restoredBoundaryMarks(tokens.map(t => t.text), item.marked.trim().replace(/\.?$/, "."));
    assert.ok(sourceMarks, `${item.name}: invalid corpus marks`);
    const globalCuts = new Set(sourceMarks.map((mark, index) => mark ? `t${index}` : null).filter(Boolean));
    const invoke = () => Core.restoreAndPackTokens({
      tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
      preferredMaxWords: 10, maxWords: 12, attempts: 1,
      fetchImpl: async (_url, req) => ({ ok: true, json: async () => {
        calls++;
        const body = JSON.parse(req.body), payload = JSON.parse(body.messages[1].content);
        return { choices: [{ message: { content: JSON.stringify({ cutsAfter: payload.tokens.map(t => t.id).filter(id => globalCuts.has(id)) }) } }] };
      } }),
    });
    if (item.outcome === "fallback") {
      await assert.rejects(invoke, /unresolved oversized semantic unit/i, item.name);
      assert.ok(calls <= 2, `${item.name}: fallback must remain bounded`);
      fallback++;
      continue;
    }
    const units = await invoke();
    assert.strictEqual(units.map(u => u.content).join(" "), source, `${item.name}: word stream changed`);
    assert.ok(units.length >= 2, `${item.name}: long source was not split`);
    assert.ok(units.every(u => u.content.split(/\s+/).length <= 12), `${item.name}: unit exceeds hard word cap`);
    assert.strictEqual(units[0].start, tokens[0].start, `${item.name}: start timing changed`);
    assert.strictEqual(units[units.length - 1].end, tokens[tokens.length - 1].end, `${item.name}: end timing changed`);
    for (let i = 1; i < units.length; i++) assert.strictEqual(units[i - 1].end, units[i].start, `${item.name}: timeline is not contiguous`);
    const boundaries = units.slice(0, -1).map((u, i) => {
      const leftWords = u.content.split(/\s+/);
      const rightText = units[i + 1].content;
      return { left: leftWords.at(-1).toLowerCase(), leftText: leftWords.join(" ").toLowerCase(), right: rightText.split(/\s+/)[0].toLowerCase(), rightText };
    });
    for (const { left, leftText, right, rightText } of boundaries) {
      // 用与整轨首遍完全相同的单一权威判据(flow 模式)验证产出边界:整轨字幕是
      // 连续语流,一屏以 which/because 等从句引导词开头是自然的;flow 模式只否决破坏
      // 词法绑定的切分(number+unit、比较结构)。不在测试里另写第二套安全规则。
      const leftWords = leftText.split(/\s+/), rightWords = rightText.split(/\s+/);
      const words = leftWords.concat(rightWords);
      const cut = leftWords.length - 1;
      const flowMarks = words.map((_, i) => (i === cut ? "|" : ""));
      const kept = Core.filterUnsafeRescueMarks(words, flowMarks, { mode: "flow" })[cut] === "|";
      assert.ok(kept, `${item.name}: flow 模式否决的边界不应出现: ${left} | ${right}`);
      assert.ok(!/^\d+(?:\.\d+)?$/.test(left) || !/^(?:volts?|watts?|amps?|percent|milliseconds?|seconds?)$/.test(right), `${item.name}: number/unit pair split`);
    }
    success++;
  }
  console.log(`PASS semantic adversarial corpus: ${success} split, ${fallback} explicit fallback, ${cases.length} total`);
})().catch(err => { console.error(err.stack || err); process.exit(1); });
