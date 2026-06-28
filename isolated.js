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
  var CACHE_KEY = "dualsub:cache"; // 翻译缓存（全 origin 共享，按 videoId/轨道/语言/model 区分）
  var CACHE_MAX_ENTRIES = 800; // 缓存条目上限（LRU 裁剪，防配额溢出）
  var DEFAULT_CONFIG = Core.DEFAULT_CONFIG;

  var config = Object.assign({}, DEFAULT_CONFIG);

  // ---- 运行状态 ----
  var state = {
    videoId: null,
    tracks: [], // main.js 推来的轨道清单
    activeTrack: null, // 当前选中的轨道
    cues: [], // 清洗 + 语义重组后的原文 cue
    clips: [], // 按 cue 边界切的 clip
    clipCache: {}, // clipIndex -> translated string[]（与该 clip cues 等长，可含空洞，边翻边填）
    clipState: {}, // clipIndex -> 'pending'|'done'|'error'
    clipBackoff: {}, // clipIndex -> backoff 控制器（失败退避）
    renderer: null, // 叠加层 DOM
    videoEl: null,
    rafBound: false,
    lastPrefetchMs: -1e9, // 上次 prefetch 的播放位置（节流）
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
   * 翻译持久缓存（chrome.storage.local，按 clip 维度）
   * key = videoId|轨道code|targetLang|model|clipStartMs
   * 命中直接用不重翻；写入时 LRU 裁剪防配额溢出。
   * ===================================================== */
  function clipCacheKey(clip) {
    return Core.makeCacheKey({
      videoId: state.videoId,
      trackCode: state.activeTrack ? state.activeTrack.code : "",
      targetLang: config.targetLang,
      apiModel: config.apiModel,
      clipStartMs: clip.startMs,
    });
  }

  function readCache() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([CACHE_KEY], function (res) {
          var c = res && res[CACHE_KEY];
          resolve(c && typeof c === "object" ? c : {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  /** 把某 clip 的整段译文写进持久缓存（仅在全部行翻完时调用） */
  function writeCache(key, lines) {
    readCache().then(function (cacheObj) {
      cacheObj[key] = { t: Date.now(), lines: lines };
      var pruned = Core.pruneCache(cacheObj, CACHE_MAX_ENTRIES);
      var obj = {};
      obj[CACHE_KEY] = pruned;
      try {
        chrome.storage.local.set(obj);
      } catch (e) {}
    });
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
      // 语义重组：合并 ASR 碎片、去滚动重叠词、按标点/停顿重新切句
      cues = Core.resegmentCues(cues);
      if (!cues.length) {
        console.warn("[dualsub] 解析后无有效字幕");
        return;
      }
      state.cues = cues;
      // 按 cue 边界切 clip（不在句子中间断、clip 间不重叠 → 省 token）
      state.clips = Core.sliceClipsByCue(cues, config.clipSeconds * 1000);
      state.clipCache = {};
      state.clipState = {};
      state.clipBackoff = {};
      ensureRenderer();
      bindVideo();
      // 立即预取当前播放位置所在的 clip
      prefetchAround(currentTimeMs(), true);
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
   * 预取策略（带节流）：进入某 clip 立即翻当前 clip + 预取下一个 clip。
   * force=true 时跳过节流（拖动进度条 / 刚加载）。
   * 已翻 / 正在翻 / 退避中的 clip 由 translateClip 内部跳过。
   */
  function prefetchAround(ms, force) {
    if (!config.enabled || !state.clips.length) return;
    // 节流：onTick 高频触发，位置没明显移动就不重复跑昂贵逻辑
    if (!force && Math.abs(ms - state.lastPrefetchMs) < 1000) return;
    state.lastPrefetchMs = ms;

    var idx = clipIdxAt(ms);
    if (idx === -1) idx = 0;

    // 当前 clip 首句优先：把播放位置附近的 cue 排到最前先翻先显示
    translateClip(idx, priorityCueIndex(idx, ms));
    // 进入某 clip 即预取下一个 clip（不等剩 15s）
    if (idx + 1 < state.clips.length) translateClip(idx + 1, 0);
  }

  /** 找播放位置 ms 在 clip 内最接近的 cue 下标（用作首句优先起点） */
  function priorityCueIndex(idx, ms) {
    var clip = state.clips[idx];
    if (!clip) return 0;
    for (var i = 0; i < clip.cues.length; i++) {
      if (ms < clip.cues[i].end) return i;
    }
    return 0;
  }

  function getBackoff(idx) {
    if (!state.clipBackoff[idx]) state.clipBackoff[idx] = Core.makeBackoff();
    return state.clipBackoff[idx];
  }

  async function translateClip(idx, priorityIndex) {
    var clip = state.clips[idx];
    if (!clip) return;
    if (state.clipState[idx] === "done" || state.clipState[idx] === "pending") return;

    // 没配置 API：不翻，只显示原文（避免静默失败）
    if (!config.apiBaseUrl || !config.apiModel) {
      state.clipState[idx] = "error";
      return;
    }
    // 失败退避：连续失败 N 次后停，不再无脑重试烧 token
    var backoff = getBackoff(idx);
    if (!backoff.shouldTry()) return;

    // 先查持久缓存：命中直接用，零 API 调用
    var key = clipCacheKey(clip);
    var cached = await readCache();
    if (cached[key] && Array.isArray(cached[key].lines)) {
      state.clipCache[idx] = cached[key].lines.slice();
      state.clipState[idx] = "done";
      lastRenderedKey = ""; // 强制下次 onTick 重渲染
      return;
    }

    state.clipState[idx] = "pending";
    // 边翻边填：clipCache[idx] 先建空数组，每批回调即时写入并触发重渲染
    if (!state.clipCache[idx]) state.clipCache[idx] = new Array(clip.cues.length);
    var hadError = false;
    try {
      var lines = await Core.translateCues({
        cues: clip.cues,
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        targetLang: config.targetLang,
        systemPrompt: config.systemPrompt,
        batchSize: config.batchLines > 0 ? config.batchLines : 10,
        priorityIndex: priorityIndex != null ? priorityIndex : 0,
        concurrency: 3,
        fetchImpl: function (u, o) {
          return fetch(u, o);
        },
        onProgress: function (updates) {
          var arr = state.clipCache[idx];
          for (var i = 0; i < updates.length; i++) arr[updates[i].index] = updates[i].text;
          lastRenderedKey = ""; // 让 onTick 立即把新译文刷上去
        },
        onError: function () {
          hadError = true;
        },
      });
      state.clipCache[idx] = lines;
      if (hadError) {
        // 部分批失败：标记 error 让退避接管，但已成功的行仍显示
        state.clipState[idx] = "error";
        backoff.fail();
      } else {
        state.clipState[idx] = "done";
        backoff.reset();
        writeCache(key, lines); // 整段成功才写持久缓存
      }
    } catch (e) {
      console.warn("[dualsub] clip", idx, "翻译失败：", e.message);
      state.clipState[idx] = "error"; // 兜底：渲染时只显示原文
      backoff.fail();
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
    // 颜色兜底：非法/空值回落默认色，绝不写空串导致 CSS 变量失效
    r.style.setProperty(
      "--ds-orig-color",
      Core.normalizeColor(config.fontColor, DEFAULT_CONFIG.fontColor)
    );
    r.style.setProperty(
      "--ds-trans-color",
      Core.normalizeColor(config.transColor, DEFAULT_CONFIG.transColor)
    );
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
      var prevModel = config.apiModel;
      var prevTarget = config.targetLang;
      var prevBase = config.apiBaseUrl;
      var prevKey = config.apiKey;
      config = Object.assign({}, config, msg.config || {});
      saveConfig();
      // 样式即时生效
      applyStyleVars();
      // 用户改了 API/语言/模型 → 视为手动重试：清退避，让停掉的 clip 能重翻
      var apiChanged =
        config.apiBaseUrl !== prevBase ||
        config.apiKey !== prevKey ||
        config.apiModel !== prevModel ||
        config.targetLang !== prevTarget;
      if (apiChanged) {
        state.clipBackoff = {};
        // model/语言变了，旧译文已不适用 → 丢内存缓存重翻（持久缓存按新 key 自然不命中）
        if (config.apiModel !== prevModel || config.targetLang !== prevTarget) {
          state.clipCache = {};
          state.clipState = {};
        } else {
          // 仅 base/key 变：把 error 态清掉以便重试，已成功的保留
          for (var ci in state.clipState) {
            if (state.clipState[ci] === "error") state.clipState[ci] = undefined;
          }
        }
      }
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
            state.clipBackoff = {};
            loadTrack(track);
          }
        } else if (apiChanged || !prevEnabled) {
          // 配置变了但轨道没变：立即按当前播放位置重新预取
          prefetchAround(currentTimeMs(), true);
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

