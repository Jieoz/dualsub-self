/*
 * test/srt-demo.js — buildSrt 三种 mode 输出演示（离线，无网络）
 * =============================================================
 * 用一组样例渲染单元（句级优先 / 逐行兜底那套 renderUnits 结构）打印
 * Core.buildSrt 在三种 mode 下的 SRT 文本，供肉眼核对时间戳/顺序/上下文。
 *
 * 用法：node test/srt-demo.js
 */
"use strict";
const Core = require("../core.js");

// 模拟 isolated.js rebuildRenderTimeline 产出的渲染单元（这里用 startMs/endMs；
// buildSrt 同时兼容 isolated 内部的 start/end 命名）。含一条空译文测试回退。
const UNITS = [
  { startMs: 0, endMs: 1800, originalText: "So today we take a look at how large language models work.", translation: "今天我们来看看大语言模型是怎么工作的。" },
  { startMs: 2600, endMs: 3700, originalText: "They predict the next token one step at a time.", translation: "它们一次预测一个 token。" },
  { startMs: 4600, endMs: 5200, originalText: "And that is basically it.", translation: "" }, // 空译文 → 回退原文
];

function show(mode) {
  console.log("\n" + "=".repeat(60));
  console.log("  mode = " + mode);
  console.log("=".repeat(60));
  console.log(Core.buildSrt(UNITS, { mode: mode }));
}

show("bilingual_orig_top");
show("bilingual_trans_top");
show("only_translated");

// 顺带演示 A1 本地拆分回填：模型把 3 行合并成一条译文 → 本地拆 3 份回填。
console.log("\n" + "=".repeat(60));
console.log("  A1 splitTranslation 演示：一条合并译文 → 3 份");
console.log("=".repeat(60));
const merged = "今天我们来看看模型。它一步步预测下一个词。基本就是这样。";
console.log("原合并译文: " + merged);
console.log("拆 3 份:    " + JSON.stringify(Core.splitTranslation(merged, 3)));
console.log("无标点 17 字拆 3 份: " + JSON.stringify(Core.splitTranslation("这是一段没有标点的连续中文译文内容", 3)));
