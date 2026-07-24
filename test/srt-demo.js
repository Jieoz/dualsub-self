/*
 * test/srt-demo.js — buildSrt 三种 mode 输出演示（离线，无网络）
 * =============================================================
 * 用一组 TimelineSnapshot 渲染单元打印 Core.buildSrt 在三种 mode 下的
 * SRT 文本，供肉眼核对时间戳、顺序和双语布局。
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

// 严格正式导出由 buildSrt(..., { requireTranslations: true }) fail-closed；
// 本演示仅展示三种布局，不再调用已经删除的本地猜分译文 API。
