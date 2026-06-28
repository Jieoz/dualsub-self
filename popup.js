/*
 * popup.js — 设置 UI 逻辑（原生 JS，零依赖）
 * =============================================================
 * 与当前活动标签页里的 isolated.js 通过 chrome.tabs.sendMessage 通信：
 *  - get-state：拉当前配置 + 可用字幕轨道，填充表单。
 *  - set-config：保存配置（isolated.js 会即时生效并写 storage）。
 *  - test-connection：让 isolated.js 用当前表单的 API 三件套发测试请求
 *    （在内容脚本里发可借 <all_urls> host 权限跨域）。
 *
 * 注意：配置最终由 isolated.js 按 origin 存进 chrome.storage.local，
 * popup 不直接写 storage，避免两边 key 不一致。
 */
(function () {
  "use strict";

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
    TEXT_FIELDS.concat(COLOR_FIELDS).forEach(function (id) {
      if ($(id) && config[id] != null) $(id).value = config[id];
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
    TEXT_FIELDS.concat(COLOR_FIELDS).forEach(function (id) {
      if ($(id)) c[id] = $(id).value.trim();
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

  async function init() {
    var tab = await activeTab();
    if (!tab || !/youtube\.com/.test(tab.url || "")) {
      setStatus("请在 YouTube 页面打开本扩展。设置仍可填写并保存。", "");
    }
    currentTabId = tab ? tab.id : null;

    if (currentTabId != null) {
      var resp = await sendToTab(currentTabId, { type: "get-state" });
      if (resp && resp.config) {
        fillForm(resp.config);
        fillTracks(resp.tracks);
        if (resp.config.sourceLang) trySetSelect("sourceLang", resp.config.sourceLang);
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    init();

    $("saveBtn").addEventListener("click", async function () {
      var cfg = readForm();
      if (currentTabId == null) {
        setStatus("当前标签页不是 YouTube，配置未发送。请在 YouTube 页保存。", "err");
        return;
      }
      var resp = await sendToTab(currentTabId, { type: "set-config", config: cfg });
      if (resp && resp.ok) {
        setStatus("已保存 ✓", "ok");
      } else {
        setStatus("保存失败：内容脚本无响应（刷新 YouTube 页后重试）", "err");
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
