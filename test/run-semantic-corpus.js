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
    const globalSemanticCuts = new Set(sourceMarks.map((mark, index) => mark === "." ? `t${index}` : null).filter(Boolean));
    const invoke = () => Core.restoreAndPackTokens({
      tokens, apiBaseUrl: "https://example.test", apiKey: "x", apiModel: "m",
      preferredMaxWords: 10, maxWords: 12, attempts: 1,
      fetchImpl: async (_url, req) => ({ ok: true, json: async () => {
        calls++;
        const body = JSON.parse(req.body), payload = JSON.parse(body.messages[1].content);
        return { choices: [{ message: { content: JSON.stringify({
          semanticCutsAfter: payload.tokens.map(t => t.id).filter(id => globalSemanticCuts.has(id)),
        }) } }] };
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
    assert.ok(units.every(u => Core.semanticDisplayWidth(u.content) <= Core.SOURCE_DISPLAY_MAX_WIDTH), `${item.name}: unit exceeds visual width cap`);
    assert.strictEqual(units[0].start, tokens[0].start, `${item.name}: start timing changed`);
    assert.strictEqual(units[units.length - 1].end, tokens[tokens.length - 1].end, `${item.name}: end timing changed`);
    for (let i = 1; i < units.length; i++) assert.strictEqual(units[i - 1].end, units[i].start, `${item.name}: timeline is not contiguous`);
    assert.strictEqual(new Set(units.map(u => u.semanticGroupId)).size, 1, `${item.name}: display cuts lost semantic group`);
    success++;
  }
  console.log(`PASS semantic adversarial corpus: ${success} split, ${fallback} explicit fallback, ${cases.length} total`);
})().catch(err => { console.error(err.stack || err); process.exit(1); });
