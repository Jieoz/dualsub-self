"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "semantic-adversarial-corpus.json"), "utf8"));
function plain(marked) { return marked.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim(); }
function modelLine(marked) { return marked.trim().replace(/\.?$/, "."); }
function tokensOf(text) { return text.split(/\s+/).map((word, i) => ({ text: word, start: i * 180, end: (i + 1) * 180, nativeTiming: true })); }
(async () => {
  let success = 0, fallback = 0;
  for (const item of cases) {
    const source = plain(item.marked);
    const tokens = tokensOf(source);
    let calls = 0;
    const invoke = () => Core.restoreAndPackTokens({
      tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
      preferredMaxWords: 14, maxWords: 16, attempts: 1,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: (++calls, modelLine(item.marked)) } }] }) }),
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
    assert.ok(units.every(u => u.content.split(/\s+/).length <= 16), `${item.name}: unit exceeds hard word cap`);
    assert.strictEqual(units[0].start, tokens[0].start, `${item.name}: start timing changed`);
    assert.strictEqual(units[units.length - 1].end, tokens[tokens.length - 1].end, `${item.name}: end timing changed`);
    for (let i = 1; i < units.length; i++) assert.strictEqual(units[i - 1].end, units[i].start, `${item.name}: timeline is not contiguous`);
    const boundaries = units.slice(0, -1).map((u, i) => {
      const leftWords = u.content.split(/\s+/);
      const rightText = units[i + 1].content;
      return { left: leftWords.at(-1).toLowerCase(), leftText: leftWords.join(" ").toLowerCase(), right: rightText.split(/\s+/)[0].toLowerCase(), rightText };
    });
    for (const { left, leftText, right, rightText } of boundaries) {
      const completePhrasalVerb = /(?:get|got) (?:my|our|your|their|his|her) hands on$/.test(leftText);
      assert.ok(Core.classifySemanticBoundary(leftText, rightText).safe || completePhrasalVerb, `${item.name}: unsafe semantic boundary: ${left} | ${right}`);
      assert.ok(completePhrasalVerb || !/^(?:and|or|but|because|that|which|who|when|while|if|than|as|from|to|of|in|on|at|with|for|by|the|a|an)$/.test(left), `${item.name}: dangling word ends screen: ${left}`);
      assert.ok(!/^\d+(?:\.\d+)?$/.test(left) || !/^(?:volts?|watts?|amps?|percent|milliseconds?|seconds?)$/.test(right), `${item.name}: number/unit pair split`);
    }
    success++;
  }
  console.log(`PASS semantic adversarial corpus: ${success} split, ${fallback} explicit fallback, ${cases.length} total`);
})().catch(err => { console.error(err.stack || err); process.exit(1); });
