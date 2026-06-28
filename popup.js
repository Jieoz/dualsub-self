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
  var TEXT_FIELDS = ["apiBaseUrl", "apiKey", "apiModel", "targetLang"];
  var NUM_FIELDS = ["fontSize", "bottomOffset"];
  var COLOR_FIELDS = ["fontColor", "transColor"];
  var BOOL_FIELDS = ["enabled", "stroke", "shadow", "background", "transOnTop", "showOriginal"];
  var SELECT_FIELDS = ["sourceLang"];

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
  });
})();
