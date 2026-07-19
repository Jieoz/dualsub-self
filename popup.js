/*
 * popup.js — 设置 UI 逻辑（原生 JS，零依赖）
 * =============================================================
 * 配置读取链路（关键修复）：
 *  - popup 直接从 chrome.storage.local 按当前 tab 的 origin 读配置回显，
 *    不依赖内容脚本（isolated.js）是否已注入/运行。这样先开 popup、
 *    非播放页、刚装扩展时也能正确回显已存配置，不会回落到 #000000。
 *  - 颜色框初始化兜底到 DEFAULT_CONFIG 的颜色，绝不空值。
 *  - 保存时：popup 自己写一次 storage（冗余保证一致），并通过
 *    chrome.tabs.sendMessage(set-config) 让 isolated.js 即时生效。
 *    两边 key 统一为 "dualsub:" + origin。
 *  - 轨道清单仍向内容脚本要（get-state），拿不到就只填 auto。
 */
(function () {
  "use strict";

  var Core = window.DualsubCore || {};
  var DEFAULT_CONFIG = Core.DEFAULT_CONFIG || {};

  // 表单字段 id 列表（与 DEFAULT_CONFIG 对应）
  var TEXT_FIELDS = ["apiBaseUrl", "apiKey", "apiModel", "targetLang", "fontFamily"];
  var NUM_FIELDS = ["fontSize", "bottomOffset", "tailTrimMs", "maxCharsPerScreen", "maxDurPerScreen"];
  var COLOR_FIELDS = ["fontColor", "transColor", "strokeColor"];
  var BOOL_FIELDS = ["enabled", "background", "transOnTop", "showOriginal", "showLoading", "skipChineseSource"];
  var SELECT_FIELDS = ["sourceLang", "fontWeight", "shadowStrength"];
  // strokeWidth 是 0–3 的小数滑块，单独处理（NUM_FIELDS 走 parseInt 会截断小数）。

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    var el = $("status");
    el.textContent = msg || "";
    el.className = kind || "";
  }

  /** 获取当前活动标签页 */
  function activeTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  /** 从 tab.url 取 origin（用于拼 storage key） */
  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return null;
    }
  }

  /** 直接从 chrome.storage.local 读某 origin 的配置（与默认合并） */
  function loadConfigFromStorage(origin) {
    return new Promise(function (resolve) {
      if (!origin) {
        resolve(Object.assign({}, DEFAULT_CONFIG));
        return;
      }
      var key = "dualsub:" + origin;
      try {
        chrome.storage.local.get([key], function (res) {
          var saved = res && res[key];
          var merged = Object.assign({}, DEFAULT_CONFIG, saved && typeof saved === "object" ? saved : {});
          // 平滑迁移旧配置（布尔 stroke/shadow → strokeWidth/shadowStrength），让老用户控件正确回显
          if (Core.migrateConfig) merged = Core.migrateConfig(merged);
          resolve(merged);
        });
      } catch (e) {
        resolve(Object.assign({}, DEFAULT_CONFIG));
      }
    });
  }

  /** 直接把配置写回 storage（与 isolated.js 用同一 key，冗余一致） */
  function saveConfigToStorage(origin, config) {
    return new Promise(function (resolve) {
      if (!origin) {
        resolve(false);
        return;
      }
      var obj = {};
      obj["dualsub:" + origin] = config;
      try {
        chrome.storage.local.set(obj, function () {
          resolve(true);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** 给内容脚本发消息，封装成 Promise；标签页非 YouTube 时静默失败 */
  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, msg, function (resp) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** 用配置对象填充表单 */
  function fillForm(config) {
    if (!config) return;
    TEXT_FIELDS.forEach(function (id) {
      if ($(id) && config[id] != null) $(id).value = config[id];
    });
    // 颜色框：兜底到默认色，绝不留空（空值会显示成 #000000）
    COLOR_FIELDS.forEach(function (id) {
      if (!$(id)) return;
      var dflt = DEFAULT_CONFIG[id] || "#ffffff";
      $(id).value = normColor(config[id], dflt);
    });
    NUM_FIELDS.forEach(function (id) {
      if ($(id) && config[id] != null) $(id).value = config[id];
    });
    BOOL_FIELDS.forEach(function (id) {
      if ($(id)) $(id).checked = !!config[id];
    });
    // 描边粗细滑块（0–3 小数）+ 旁边数值显示
    if ($("strokeWidth")) {
      var sw = config.strokeWidth != null ? config.strokeWidth : (DEFAULT_CONFIG.strokeWidth != null ? DEFAULT_CONFIG.strokeWidth : 1.2);
      $("strokeWidth").value = sw;
      updateStrokeWidthLabel();
    }
    // 固定选项的下拉（如 fontWeight / shadowStrength）：直接按值选中
    if ($("shadowStrength") && config.shadowStrength != null) {
      trySetSelect("shadowStrength", String(config.shadowStrength));
    }
    if ($("fontWeight") && config.fontWeight != null) {
      trySetSelect("fontWeight", String(config.fontWeight));
    }
    if ($("sourceLang") && config.sourceLang != null) {
      // 选项可能还没填充，先记下来，填充轨道后再设
      $("sourceLang").dataset.want = config.sourceLang;
      trySetSelect("sourceLang", config.sourceLang);
    }
  }

  /** 颜色规整：优先用 Core.normalizeColor，无 Core 时本地兜底 */
  function normColor(v, fallback) {
    if (Core.normalizeColor) return Core.normalizeColor(v, fallback);
    var s = String(v == null ? "" : v).trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
  }

  function trySetSelect(id, value) {
    var sel = $(id);
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === value) {
        sel.value = value;
        return;
      }
    }
  }

  /** 实时刷新描边粗细旁的数值文本（拖动滑块时调用） */
  function updateStrokeWidthLabel() {
    var sl = $("strokeWidth");
    var lbl = $("strokeWidthVal");
    if (sl && lbl) lbl.textContent = Number(sl.value).toFixed(1) + " px";
  }

  /** 用轨道清单填充源语言下拉（保留 auto + 当前已选） */
  function fillTracks(tracks) {
    var sel = $("sourceLang");
    if (!sel) return;
    var want = sel.dataset.want || sel.value || "auto";
    sel.innerHTML = "";
    var optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "自动（优先自动字幕 ASR）";
    sel.appendChild(optAuto);
    (tracks || []).forEach(function (t) {
      var o = document.createElement("option");
      o.value = t.code;
      var tag = /-asr$/.test(t.code) || t.kind === "asr" ? " [自动]" : "";
      o.textContent = (t.name || t.code) + tag;
      sel.appendChild(o);
    });
    trySetSelect("sourceLang", want);
  }

  /** 从表单读出配置对象 */
  function readForm() {
    var c = {};
    TEXT_FIELDS.forEach(function (id) {
      if ($(id)) c[id] = $(id).value.trim();
    });
    // 颜色：空值/非法值丢弃回落默认，绝不把空串存进配置
    COLOR_FIELDS.forEach(function (id) {
      if ($(id)) c[id] = normColor($(id).value, DEFAULT_CONFIG[id] || "#ffffff");
    });
    NUM_FIELDS.forEach(function (id) {
      if ($(id)) c[id] = parseInt($(id).value, 10) || 0;
    });
    BOOL_FIELDS.forEach(function (id) {
      if ($(id)) c[id] = $(id).checked;
    });
    SELECT_FIELDS.forEach(function (id) {
      if ($(id)) c[id] = $(id).value;
    });
    // 描边粗细：0–3 的小数（保留小数，不能 parseInt 截断）。非法回落默认。
    if ($("strokeWidth")) {
      var sw = Number($("strokeWidth").value);
      if (!isFinite(sw)) sw = DEFAULT_CONFIG.strokeWidth != null ? DEFAULT_CONFIG.strokeWidth : 1.2;
      if (sw < 0) sw = 0;
      if (sw > 3) sw = 3;
      c.strokeWidth = sw;
    }
    return c;
  }

  /* ---------------- 初始化 ---------------- */
  var currentTabId = null;
  var currentOrigin = null;

  async function init() {
    var tab = await activeTab();
    currentTabId = tab ? tab.id : null;
    currentOrigin = tab ? originOf(tab.url || "") : null;
    if (!tab || !/youtube\.com/.test(tab.url || "")) {
      setStatus("请在 YouTube 页面打开本扩展。设置仍可填写并保存。", "");
    }

    // 关键：直接从 storage 读配置回显，不依赖内容脚本是否在跑
    var stored = await loadConfigFromStorage(currentOrigin);
    fillForm(stored);

    // 轨道清单仍向内容脚本要（拿不到就只有 auto）
    if (currentTabId != null) {
      var resp = await sendToTab(currentTabId, { type: "get-state" });
      if (resp && resp.tracks) {
        fillTracks(resp.tracks);
        trySetSelect("sourceLang", stored.sourceLang || "auto");
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    init();

    // 描边粗细滑块拖动时实时更新旁边数值文本
    if ($("strokeWidth")) {
      $("strokeWidth").addEventListener("input", updateStrokeWidthLabel);
    }

    $("saveBtn").addEventListener("click", async function () {
      var cfg = readForm();
      // 先直接写 storage（冗余保证一致，内容脚本不在也能存住）
      var wrote = await saveConfigToStorage(currentOrigin, cfg);
      // 再通知内容脚本即时生效（在 YouTube 页时）
      var resp = currentTabId != null ? await sendToTab(currentTabId, { type: "set-config", config: cfg }) : null;
      if (resp && resp.ok) {
        setStatus("已保存 ✓（已即时生效）", "ok");
      } else if (wrote) {
        setStatus("已保存到本地 ✓（在 YouTube 播放页刷新后生效）", "ok");
      } else {
        setStatus("保存失败：无法写入本地存储", "err");
      }
    });

    $("testBtn").addEventListener("click", async function () {
      var cfg = readForm();
      if (!cfg.apiBaseUrl || !cfg.apiModel) {
        setStatus("请先填写 API Base URL 和模型", "err");
        return;
      }
      setStatus("测试中…", "");
      if (currentTabId == null) {
        setStatus("请在 YouTube 页测试（测试请求由内容脚本发出）", "err");
        return;
      }
      var resp = await sendToTab(currentTabId, { type: "test-connection", config: cfg });
      if (!resp) {
        setStatus("无响应：请在 YouTube 标签页打开并刷新后重试", "err");
      } else if (resp.ok) {
        setStatus("连接成功 ✓\n示例翻译： " + (resp.sample || ""), "ok");
      } else {
        setStatus("连接失败：" + (resp.error || "未知错误"), "err");
      }
    });

    /* ---------------- 配置导入 / 导出 ---------------- */
    // 导出：把当前表单配置序列化下载为 JSON 文件（含 key，已在 UI 提示用户）
    $("exportBtn").addEventListener("click", function () {
      var cfg = readForm();
      var text = Core.exportConfig ? Core.exportConfig(cfg) : JSON.stringify({ config: cfg }, null, 2);
      try {
        var blob = new Blob([text], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "mydualsub-config.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        setStatus("已导出配置（文件含 API Key，请妥善保管）", "ok");
      } catch (e) {
        setStatus("导出失败：" + (e && e.message ? e.message : e), "err");
      }
    });

    // 导入：选 JSON 文件 → 解析 → 校验 → 回填表单（用户再点保存生效）
    $("importBtn").addEventListener("click", function () {
      $("importFile").click();
    });
    $("importFile").addEventListener("change", function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var res = Core.importConfig
          ? Core.importConfig(String(reader.result || ""))
          : { ok: false, error: "core.js 未加载" };
        if (res.ok) {
          fillForm(res.config);
          setStatus('已导入配置 ✓ 点"保存设置"生效', "ok");
        } else {
          setStatus("导入失败：" + (res.error || "未知错误"), "err");
        }
        $("importFile").value = ""; // 允许重复导入同一文件
      };
      reader.onerror = function () {
        setStatus("读取文件失败", "err");
      };
      reader.readAsText(file);
    });

    /* ---------------- 导出双语 SRT ---------------- */
    // 向当前 tab 的 isolated.js 取已翻译的渲染单元，用 Core.buildSrt 生成 SRT，
    // 走 a[download] + Blob 下载（不依赖 chrome.downloads，免加 manifest 权限）。
    $("exportSrtBtn").addEventListener("click", async function () {
      if (currentTabId == null) {
        setStatus("请在 YouTube 播放页导出（字幕数据来自内容脚本）", "err");
        return;
      }
      var mode = $("srtMode") ? $("srtMode").value : "bilingual_orig_top";
      var resp = await sendToTab(currentTabId, { type: "export-srt" });
      if (!resp) {
        setStatus("无响应：请在 YouTube 标签页打开并刷新后重试", "err");
        return;
      }
      if (!resp.ok || !resp.units || !resp.units.length) {
        setStatus("当前视频还没有可导出的译文，请先播放并等待翻译出现", "err");
        return;
      }
      var srt = Core.buildSrt ? Core.buildSrt(resp.units, { mode: mode }) : "";
      if (!srt) {
        setStatus("生成 SRT 为空（无有效字幕单元）", "err");
        return;
      }
      try {
        var blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = makeSrtFilename(resp.videoId, resp.targetLang);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
        setStatus("已导出 SRT ✓（" + (a.download) + "）", "ok");
      } catch (e) {
        setStatus("导出失败：" + (e && e.message ? e.message : e), "err");
      }
    });
  });

  /** 生成 ASCII 安全文件名：dualsub-<videoId>-<lang>.srt（非法字符替换为 _） */
  function makeSrtFilename(videoId, lang) {
    function safe(s, dflt) {
      var v = String(s == null ? "" : s).replace(/[^A-Za-z0-9_.-]/g, "_");
      return v || dflt;
    }
    return "dualsub-" + safe(videoId, "video") + "-" + safe(lang, "trans") + ".srt";
  }
})();
