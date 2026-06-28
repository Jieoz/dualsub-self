/*
 * isolated.js — 运行在 world: "ISOLATED"（扩展沙箱）
 * =============================================================
 * 职责：
 *  1. 接收 main.js 推来的字幕轨道清单（RPC）。
 *  2. 拉取并解析字幕（json3 / vtt），清洗时间轴。
 *  3. 调用用户配置的 OpenAI 兼容翻译 API（分批 + 行号对齐 + 预取缓存）。
 *  4. 渲染双语叠加层，跟随 <video> 的 timeupdate 显示当前 cue。
 *  5. 读写 chrome.storage.local（按 origin 存配置）。
 *  6. 与 popup 通信（chrome.runtime.onMessage）：配置变更、测试连接。
 *
 * 纯逻辑（解析/清洗/翻译/clip 切分）复用 core.js（DualsubCore）。
 */
(function () {
  "use strict";

  var Core = window.DualsubCore;
  if (!Core) {
    console.error("[dualsub] core.js 未加载，isolated.js 退出");
    return;
  }

  // ---- RPC 通道（与 main.js 一致）----
  var CHANNEL = "__dualsub_rpc_8f3ad7c1b2e94__";
  var SENDER = "isolated";

  // ---- 配置 ----
  var STORAGE_KEY = "dualsub:" + location.origin; // 按 origin 存
  var DEFAULT_CONFIG = {
    enabled: true,
    apiBaseUrl: "",
    apiKey: "",
    apiModel: "gpt-4o-mini",
    sourceLang: "auto", // auto = 用第一条 ASR / 第一条轨道
    targetLang: "zh-Hans",
    systemPrompt: "", // 空 = 用 core 默认
    // 显示样式
    fontSize: 22, // px
    bottomOffset: 90, // px，距播放器底部
    fontColor: "#ffffff",
    transColor: "#7fdfff", // 译文颜色
    stroke: true, // 描边
    shadow: true, // 阴影
    background: false, // 背景框
    transOnTop: true, // true=译文在上，原文在下
    showOriginal: true, // 是否显示原文行
    clipSeconds: 60, // 每个翻译 clip 多少秒
    batchLines: 20, // 每批最多多少行（clip 内再分批）
  };

  var config = Object.assign({}, DEFAULT_CONFIG);

  // ---- 运行状态 ----
  var state = {
    videoId: null,
    tracks: [], // main.js 推来的轨道清单
    activeTrack: null, // 当前选中的轨道
    cues: [], // 清洗后的原文 cue
    clips: [], // 按时间切的 clip
    clipCache: {}, // clipIndex -> translated string[]（与该 clip cues 等长）
    clipState: {}, // clipIndex -> 'pending'|'done'|'error'
    renderer: null, // 叠加层 DOM
    videoEl: null,
    rafBound: false,
  };

  /* =====================================================
   * 配置存取
   * ===================================================== */
  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (res) {
          var saved = res && res[STORAGE_KEY];
          if (saved && typeof saved === "object") {
            config = Object.assign({}, DEFAULT_CONFIG, saved);
          }
          resolve(config);
        });
      } catch (e) {
        resolve(config);
      }
    });
  }

  function saveConfig() {
    try {
      var obj = {};
      obj[STORAGE_KEY] = config;
      chrome.storage.local.set(obj);
    } catch (e) {}
  }

  /* =====================================================
   * RPC：接收 main.js 的轨道清单
   * ===================================================== */
  window.addEventListener(CHANNEL, function (ev) {
    var detail = ev && ev.detail;
    if (!detail || detail.receiver !== SENDER) return;
    if (detail.subject === "update-manifest") {
      onManifest(detail.content);
    }
  });

  function onManifest(content) {
    if (!content || !Array.isArray(content.files)) return;
    var changedVideo = content.videoId !== state.videoId;
    state.videoId = content.videoId;
    state.tracks = content.files;

    if (changedVideo) {
      // 切换视频：清空所有缓存与渲染
      resetForNewVideo();
    }

    // 通知 popup 轨道清单已更新（popup 打开时用于填充源语言下拉）
    notifyPopupTracks();

    if (!config.enabled) return;
    var track = pickTrack(state.tracks, config.sourceLang);
    if (!track) return;
    if (state.activeTrack && state.activeTrack.url === track.url && state.cues.length) {
      return; // 已经在用这条轨道且已加载
    }
    state.activeTrack = track;
    loadTrack(track);
  }

  function resetForNewVideo() {
    state.activeTrack = null;
    state.cues = [];
    state.clips = [];
    state.clipCache = {};
    state.clipState = {};
    clearRenderer();
  }

  /**
   * 选轨道：
   *  - sourceLang === "auto"：优先第一条 ASR，其次第一条。
   *  - 否则按 languageCode / code 精确或前缀匹配。
   */
  function pickTrack(tracks, sourceLang) {
    if (!tracks || !tracks.length) return null;
    if (!sourceLang || sourceLang === "auto") {
      var asr = tracks.find(function (t) {
        return /-asr$/.test(t.code) || t.kind === "asr";
      });
      return asr || tracks[0];
    }
    var exact = tracks.find(function (t) {
      return t.code === sourceLang || t.languageCode === sourceLang;
    });
    if (exact) return exact;
    var prefix = tracks.find(function (t) {
      return (t.languageCode || "").split("-")[0] === sourceLang.split("-")[0];
    });
    return prefix || tracks[0];
  }

  /* =====================================================
   * 拉取 + 解析 + 切 clip
   * ===================================================== */
  async function loadTrack(track) {
    try {
      var resp = await fetch(track.url, { credentials: "omit" });
      if (!resp.ok) {
        console.warn("[dualsub] 字幕请求失败 HTTP", resp.status);
        return;
      }
      var text = await resp.text();
      var cues;
      // 优先按 json3 解析，失败再试 vtt
      var trimmed = text.trim();
      if (trimmed.startsWith("{")) {
        var json = JSON.parse(text);
        cues = Core.parseJson3(json);
      } else {
        cues = Core.parseVtt(text);
      }
      cues = Core.cleanupCues(cues);
      if (!cues.length) {
        console.warn("[dualsub] 解析后无有效字幕");
        return;
      }
      state.cues = cues;
      state.clips = Core.sliceClips(cues, config.clipSeconds * 1000);
      state.clipCache = {};
      state.clipState = {};
      ensureRenderer();
      bindVideo();
      // 立即预取当前播放位置所在的 clip
      prefetchAround(currentTimeMs());
    } catch (e) {
      console.warn("[dualsub] loadTrack 出错", e);
    }
  }

  /* =====================================================
   * 翻译编排：预取 + 缓存
   * ===================================================== */

  /** 找到 startMs 落在哪个 clip（返回 clips 数组下标，找不到返回 -1） */
  function clipIdxAt(ms) {
    for (var i = 0; i < state.clips.length; i++) {
      var c = state.clips[i];
      if (ms >= c.startMs && ms < c.endMs) return i;
    }
    // 超出最后一个 clip 的，归到最后一个
    if (state.clips.length && ms >= state.clips[state.clips.length - 1].startMs) {
      return state.clips.length - 1;
    }
    return -1;
  }

  /**
   * 预取策略：翻当前 clip，并在接近 clip 尾部时提前翻下一个 clip。
   * 已翻过 / 正在翻的 clip 跳过。
   */
  function prefetchAround(ms) {
    if (!config.enabled || !state.clips.length) return;
    var idx = clipIdxAt(ms);
    if (idx === -1) idx = 0;

    translateClip(idx);

    // 接近当前 clip 尾部（剩余 < 15s）就预取下一个
    var cur = state.clips[idx];
    if (cur && ms >= cur.endMs - 15000 && idx + 1 < state.clips.length) {
      translateClip(idx + 1);
    }
  }

  async function translateClip(idx) {
    var clip = state.clips[idx];
    if (!clip) return;
    if (state.clipState[idx] === "done" || state.clipState[idx] === "pending") return;

    // 没配置 API：不翻，只显示原文（避免静默失败）
    if (!config.apiBaseUrl || !config.apiModel) {
      state.clipState[idx] = "error";
      return;
    }

    state.clipState[idx] = "pending";
    try {
      // clip 内再按 batchLines 分批，逐批翻译并拼回
      var translated = new Array(clip.cues.length);
      var batchSize = config.batchLines > 0 ? config.batchLines : 20;
      var prevTail = null;
      for (var off = 0; off < clip.cues.length; off += batchSize) {
        var sub = clip.cues.slice(off, off + batchSize);
        var lines = await Core.translateBatch({
          cues: sub,
          apiBaseUrl: config.apiBaseUrl,
          apiKey: config.apiKey,
          apiModel: config.apiModel,
          targetLang: config.targetLang,
          systemPrompt: config.systemPrompt,
          contextTail: prevTail, // 上一批末尾作上下文，保证连贯
        });
        for (var k = 0; k < sub.length; k++) {
          translated[off + k] = lines[k];
        }
        // 取本批最后 2 句原文作为下一批上下文
        prevTail = sub.slice(-2).map(function (c) {
          return c.content;
        });
      }
      state.clipCache[idx] = translated;
      state.clipState[idx] = "done";
    } catch (e) {
      console.warn("[dualsub] clip", idx, "翻译失败：", e.message);
      state.clipState[idx] = "error"; // 兜底：渲染时只显示原文
    }
  }

  /** 取某条 cue 的译文（命中缓存才有，否则 null） */
  function translationFor(clipIdx, cueIdxInClip) {
    var arr = state.clipCache[clipIdx];
    return arr && arr[cueIdxInClip] != null ? arr[cueIdxInClip] : null;
  }

  /* =====================================================
   * 渲染叠加层
   * ===================================================== */

  function playerEl() {
    return document.querySelector(".html5-video-player");
  }

  function videoEl() {
    return document.querySelector(".html5-main-video, video");
  }

  function currentTimeMs() {
    var v = state.videoEl || videoEl();
    return v ? Math.floor(v.currentTime * 1000) : 0;
  }

  /** 确保叠加层 DOM 存在并挂到播放器上 */
  function ensureRenderer() {
    var player = playerEl();
    if (!player) return;
    if (state.renderer && state.renderer.parentNode) {
      applyStyleVars();
      return;
    }
    var r = document.createElement("div");
    r.className = "dualsub-renderer";
    var trans = document.createElement("div");
    trans.className = "dualsub-subtitle dualsub-trans";
    var orig = document.createElement("div");
    orig.className = "dualsub-subtitle dualsub-orig";
    // 译文在上 / 原文在上 由 transOnTop 决定
    if (config.transOnTop) {
      r.appendChild(trans);
      r.appendChild(orig);
    } else {
      r.appendChild(orig);
      r.appendChild(trans);
    }
    r._trans = trans;
    r._orig = orig;
    player.appendChild(r);
    state.renderer = r;
    injectStyleOnce();
    applyStyleVars();
  }

  function clearRenderer() {
    if (state.renderer && state.renderer.parentNode) {
      state.renderer.parentNode.removeChild(state.renderer);
    }
    state.renderer = null;
  }

  var STYLE_ID = "dualsub-style";
  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".dualsub-renderer{",
      "  position:absolute; left:0; right:0; bottom:var(--ds-bottom,90px);",
      "  z-index:60; text-align:center; pointer-events:none;",
      "  display:flex; flex-direction:column; align-items:center; gap:2px;",
      "  width:100%; padding:0 4%; box-sizing:border-box;",
      "}",
      ".dualsub-subtitle{",
      "  display:inline-block; max-width:96%; line-height:1.25;",
      "  font-size:var(--ds-fontsize,22px);",
      "  font-family:'YouTube Noto',Roboto,Arial,sans-serif; font-weight:500;",
      "  white-space:pre-wrap; word-break:break-word;",
      "}",
      ".dualsub-orig{ color:var(--ds-orig-color,#fff); }",
      ".dualsub-trans{ color:var(--ds-trans-color,#7fdfff); }",
      ".dualsub-stroke .dualsub-subtitle{",
      "  -webkit-text-stroke:0.5px #000; paint-order:stroke fill;",
      "}",
      ".dualsub-shadow .dualsub-subtitle{",
      "  text-shadow:0 0 4px #000,0 1px 2px #000;",
      "}",
      ".dualsub-bg .dualsub-subtitle{",
      "  background:rgba(0,0,0,0.6); padding:1px 8px; border-radius:4px;",
      "}",
      ".dualsub-hidden{ display:none !important; }",
    ].join("\n");
    var styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    document.documentElement.appendChild(styleEl);
  }

  /** 把配置里的样式写成 CSS 变量 + 开关 class */
  function applyStyleVars() {
    var r = state.renderer;
    if (!r) return;
    r.style.setProperty("--ds-fontsize", config.fontSize + "px");
    r.style.setProperty("--ds-bottom", config.bottomOffset + "px");
    r.style.setProperty("--ds-orig-color", config.fontColor);
    r.style.setProperty("--ds-trans-color", config.transColor);
    r.classList.toggle("dualsub-stroke", !!config.stroke);
    r.classList.toggle("dualsub-shadow", !!config.shadow);
    r.classList.toggle("dualsub-bg", !!config.background);
    // 重排译文/原文顺序
    if (r._trans && r._orig) {
      if (config.transOnTop && r.firstChild !== r._trans) {
        r.insertBefore(r._trans, r._orig);
      } else if (!config.transOnTop && r.firstChild !== r._orig) {
        r.insertBefore(r._orig, r._trans);
      }
    }
  }

  /** 绑定 video 的播放事件，按 currentTime 刷新显示 */
  function bindVideo() {
    var v = videoEl();
    if (!v) return;
    if (state.videoEl === v && state.rafBound) return;
    state.videoEl = v;
    state.rafBound = true;
    v.addEventListener("timeupdate", onTick);
    // timeupdate 频率不稳，再叠加一个轻量定时器兜底刷新
    setInterval(onTick, 250);
  }

  var lastRenderedKey = "";
  function onTick() {
    if (!config.enabled || !state.renderer || !state.cues.length) return;
    var ms = currentTimeMs();

    // 顺带触发预取
    prefetchAround(ms);

    // 找当前时间命中的 cue（线性查找，字幕量级不大；可优化为二分）
    var clipIdx = clipIdxAt(ms);
    var hitCue = null;
    var hitCueIdxInClip = -1;
    if (clipIdx !== -1) {
      var clip = state.clips[clipIdx];
      for (var i = 0; i < clip.cues.length; i++) {
        var c = clip.cues[i];
        if (ms >= c.start && ms < c.end) {
          hitCue = c;
          hitCueIdxInClip = i;
          break;
        }
      }
    }

    if (!hitCue) {
      setRendererText("", "");
      return;
    }
    var orig = hitCue.content;
    var trans = translationFor(clipIdx, hitCueIdxInClip);
    var key = clipIdx + ":" + hitCueIdxInClip + ":" + (trans || "");
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    setRendererText(orig, trans);
  }

  function setRendererText(orig, trans) {
    var r = state.renderer;
    if (!r) return;
    // 原文行
    r._orig.textContent = config.showOriginal ? orig || "" : "";
    r._orig.classList.toggle("dualsub-hidden", !config.showOriginal || !orig);
    // 译文行：没翻好时留空（原文照常显示）
    r._trans.textContent = trans || "";
    r._trans.classList.toggle("dualsub-hidden", !trans);
  }

  /* =====================================================
   * 与 popup 通信（chrome.runtime.onMessage）
   * ===================================================== */
  function notifyPopupTracks() {
    try {
      chrome.runtime.sendMessage({
        type: "tracks-updated",
        origin: location.origin,
        videoId: state.videoId,
        tracks: state.tracks.map(function (t) {
          return { code: t.code, name: t.name, languageCode: t.languageCode, kind: t.kind };
        }),
      });
    } catch (e) {
      // popup 没开时 sendMessage 会报错，忽略
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === "get-state") {
      sendResponse({
        config: config,
        tracks: state.tracks.map(function (t) {
          return { code: t.code, name: t.name, languageCode: t.languageCode, kind: t.kind };
        }),
        videoId: state.videoId,
      });
      return true;
    }

    if (msg.type === "set-config") {
      var prevSource = config.sourceLang;
      var prevEnabled = config.enabled;
      config = Object.assign({}, config, msg.config || {});
      saveConfig();
      // 样式即时生效
      applyStyleVars();
      if (!config.enabled) {
        clearRenderer();
      } else {
        ensureRenderer();
        // 源语言变了 → 重新选轨并重载
        if (config.sourceLang !== prevSource || !prevEnabled) {
          var track = pickTrack(state.tracks, config.sourceLang);
          if (track) {
            state.activeTrack = track;
            state.clipCache = {};
            state.clipState = {};
            loadTrack(track);
          }
        }
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "test-connection") {
      testConnection(msg.config)
        .then(function (res) {
          sendResponse(res);
        })
        .catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        });
      return true; // 异步响应
    }
  });

  /**
   * 测试连接：用 popup 传来的 API 三件套发一条最小翻译请求。
   * 在 isolated.js 里发（有 <all_urls> host 权限可跨域），把结果回传给 popup。
   */
  async function testConnection(cfg) {
    cfg = cfg || {};
    if (!cfg.apiBaseUrl || !cfg.apiModel) {
      return { ok: false, error: "请先填写 apiBaseUrl 和 apiModel" };
    }
    try {
      var lines = await Core.translateBatch({
        cues: [{ content: "hello world" }],
        apiBaseUrl: cfg.apiBaseUrl,
        apiKey: cfg.apiKey,
        apiModel: cfg.apiModel,
        targetLang: cfg.targetLang || "zh-Hans",
        systemPrompt: cfg.systemPrompt,
      });
      return { ok: true, sample: lines && lines[0] ? lines[0] : "(空响应)" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  /* =====================================================
   * 启动
   * ===================================================== */
  loadConfig().then(function () {
    // 配置就绪。轨道由 main.js 的 RPC 推来后触发 onManifest。
    if (config.enabled) {
      // 播放器可能已就绪，尝试挂渲染器（轨道来了才会真正显示）
      ensureRenderer();
    }
  });
})();

