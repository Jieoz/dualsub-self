"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Core = require("../core.js");
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "semantic-adversarial-corpus.json"), "utf8"));
const base = process.env.DUALSUB_AUDIT_BASE, key = process.env.DUALSUB_AUDIT_KEY, model = process.env.DUALSUB_AUDIT_MODEL;
if (!base || !key || !model) throw new Error("missing runtime audit API configuration");
function plain(x) { return x.replace(/\s*\|\s*/g, " ").trim(); }
function markedSegments(x) { return x.split(/\s*\|\s*/).map(v => v.trim()).filter(Boolean); }
function tokensOf(text) { return text.split(/\s+/).map((word, i) => ({ text: word, start: i * 240, end: (i + 1) * 240, nativeTiming: true })); }
(async () => {
  const results = [];
  for (const item of corpus) {
    const source = plain(item.marked), tokens = tokensOf(source);
    try {
      const cues = await Core.restoreAndPackTokens({ tokens, apiBaseUrl: base, apiKey: key, apiModel: model, reasoningEffort: "low", preferredMaxWords: 10, maxWords: 12, attempts: 2, timeoutMs: 60000 });
      if (cues.some(c => c.content.split(/\s+/).length > 12)) throw new Error("oversized cue escaped");
      if (cues.map(c => c.content).join(" ") !== source) throw new Error("source word stream changed");
      if (item.exactSegments) assert.deepStrictEqual(cues.map(c => c.content), markedSegments(item.marked), `${item.name}: semantic boundary drift`);
      const screens = await Core.translateSentenceScreens({ pieces: cues, apiBaseUrl: base, apiKey: key, apiModel: model, reasoningEffort: "low", targetLang: "简体中文", timeoutMs: 60000 });
      screens.forEach((s, i) => { if (!s.text) throw new Error(`empty Chinese screen ${i + 1}`); if (s.text.includes("。")) throw new Error(`Chinese full stop escaped in screen ${i + 1}`); });
      results.push({ name: item.name, outcome: "translated", screens: screens.map((s) => ({ start: cues[s.from].start, end: cues[s.to].end, english: cues.slice(s.from, s.to + 1).map(c => c.content).join(" "), chinese: s.text })) });
    } catch (e) {
      results.push({ name: item.name, outcome: "fallback", reason: String(e && e.message || e).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") });
    }
  }
  for (let i = 0; i < corpus.length; i++) {
    assert.strictEqual(results[i].outcome, corpus[i].outcome === "success" ? "translated" : "fallback", `${corpus[i].name}: unexpected ${results[i].outcome}`);
  }
  const out = { generatedAt: new Date().toISOString(), model, results };
  fs.writeFileSync(process.env.DUALSUB_AUDIT_OUT || "/tmp/dualsub-v0512-real-corpus.json", JSON.stringify(out, null, 2));
  const translated = results.filter(x => x.outcome === "translated").length;
  console.log(`REAL_CORPUS translated=${translated} fallback=${results.length - translated} total=${results.length}`);
  if (!translated) process.exit(2);
})().catch(e => { console.error(e.message); process.exit(1); });
