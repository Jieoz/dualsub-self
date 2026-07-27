/*
 * isolated.js — 运行在 world: "ISOLATED"（扩展沙箱）
 * =============================================================
 * 职责：
 *  1. 接收 main.js 推来的字幕轨道清单（RPC）。
 *  2. 拉取并解析字幕（json3 / vtt），清洗时间轴。
 *  3. 调用用户配置的 OpenAI 兼容翻译 API：连续 cue block 整体翻译并由目标语言自然分屏；
 *     源、译使用独立时间轴，配合预取、缓存和失败退避重试。
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
  var RPC_PEER = "main";

  // ---- 配置 ----
  var STORAGE_KEY = "dualsub:" + location.origin; // 按 origin 存
  // 每个缓存 entry 使用独立 storage key；不同标签页写不同 entry 不再共享对象 RMW 覆盖。
  var CACHE_ENTRY_PREFIX = "dualsub:cache-entry-v90:";
  var CACHE_MAX_ENTRIES = 800;
  var DEFAULT_CONFIG = Core.DEFAULT_CONFIG;

  // 跨 clip 的全局 in-flight 翻译请求上限（每个内容脚本实例一个信号量）。
  // 滑动窗口预取(planPrefetch)会让当前/下一个/下下个… clip 几乎同时各发起一次
  // translateContextBlock（一个 block = 一次请求）。若不封顶，瞬时并发可达窗口深度
  // → 网关 429 → 退避 → 反而更卡。这里把所有 clip 的请求收敛到一个全局上限下排队，
  // 在 cap 内仍尽量保持最大领先，但绝不冲垮网关。可被 config.globalConcurrency 覆盖。
  var GLOBAL_INFLIGHT_DEFAULT = 4;
  var gateMax = GLOBAL_INFLIGHT_DEFAULT; // 当前 gate 的配置上限（cap 会随 429/超时自适应回缩，故单独记配置值）
  var globalGate = Core.makeAdaptiveGate({ max: GLOBAL_INFLIGHT_DEFAULT, min: 1 });

  /** 按配置（重）建自适应 gate；仅当配置上限变了才换，避免丢弃在途令牌（cap 自适应不触发重建） */
  function ensureGate() {
    var want = parseInt(config.globalConcurrency, 10);
    if (!Number.isFinite(want) || want < 1) want = GLOBAL_INFLIGHT_DEFAULT;
    if (!globalGate || gateMax !== want) {
      gateMax = want;
      globalGate = Core.makeAdaptiveGate({ max: want, min: 1 });
    }
    return globalGate;
  }

  var config = Object.assign({}, DEFAULT_CONFIG);

  // ---- 运行状态 ----
  var state = {
    videoId: null,
    tracks: [], // main.js 推来的轨道清单
    activeTrack: null, // 当前选中的轨道
    cues: [], // 最终原文 cue（由 timelineSnapshot 的 token spans 唯一重建）
    sourceTimeline: null, // 当前轨唯一 canonical token 流；fallback/semantic/renderer/SRT 共享
    timelineSnapshot: null, // 不可变 TimelineSnapshot；所有译文提交均生成新 revision
    segmentationMode: "block", // 连续源 cue block 整体翻译；原文与译文使用独立时间轴
    timelineEpoch: 0, // 每次整轨切换递增，拒绝旧异步翻译结果写入新分段
    requestGeneration: 0, // 视频/轨道/翻译身份变化即递增；所有异步副作用都必须持有同代快照
    requestControllers: [], // 当前代在途 fetch；身份失效时主动 abort，而非只拒绝迟到写入
    translationInflight: {}, // 完整缓存身份 -> Promise；semantic/实时/seek 共享同一个请求
    cacheWriteChain: Promise.resolve(), // chrome.storage read-modify-write 串行化，防并发覆盖
    clips: [], // 按 cue 边界切的 clip
    cueMap: [], // 全局 cue 下标 -> {clipIdx,cueIdx}（cueClipIndexMap 建表）
    // 每个 block 直接产出 [{srcStart,srcEnd,originalText,translation,startMs,endMs}]。
    clipUnits: {}, // clipIndex -> 渲染单元数组（成功翻译才有；缺失=未翻/翻译中→回退显原文）
    renderUnits: [], // 全局渲染时间轴（各 clip 的渲染单元按 start 升序拼接）。findCueIndexAt 在此上查当前行
    clipState: {}, // clipIndex -> 'pending'|'done'|'error'|'failed'（error=可重试；failed=达 maxFails 终态）
    clipBackoff: {}, // clipIndex -> backoff 控制器（失败退避）
    clipInflight: {}, // clipIndex -> bool：translateClip 进行中（重入互斥，防同 clip 并发）
    retryTimer: null, // 后台失败重试调度器 id（第2层；只在有 error clip 时活跃）
    renderer: null, // 叠加层 DOM
    videoEl: null,
    fontObserver: null, // ResizeObserver：观察播放器高度变化，同比缩放字号（全屏放大）
    // ---- 运行循环 / 生命周期（低配机占用优化）----
    renderTimer: null, // 仅无帧回调 API 时的兜底 setInterval id
    renderFrameHandle: null, // requestVideoFrameCallback / rAF 句柄
    trackRetryTimer: null,   // 轨道加载重试定时器
    trackFailure: null,      // 重试用尽后的失败原因,供 popup 显示
    renderDriver: null, // "vfc" | "raf" | "interval"，决定用哪个 cancel
    prefetchTimer: null, // 预取定时器 id（与渲染解耦、降频）
    seekTimer: null, // seek 防抖定时器 id
    listeners: [], // 已绑定的监听器 [{target,type,fn}]，teardown 时统一解绑
    lastHitCueIdx: -1, // 上次命中的全局 cue 下标（findCueIndexAt 的 O(1) 提示）
    lastPrefetchMs: -1e9, // 上次 prefetch 的播放位置（节流）
    seeking: false, // 进度条拖动中（防抖期间不渲染/不预取目标外位置）
    waitPausedByUs: false,
    waitTimer: null,
    firstClipReady: false,
    apiUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, requests: 0 },
    cacheWriteSeq: 0,
    srtJob: null,
    // MAIN world 与页面同权，事件 sender 字符串不是认证。首次通过 URL/video/track
    // 严格绑定的清单会锁定本视频轨道身份，后续只允许同身份刷新签名 URL。
    manifestIdentity: null,
  };


  function beginRuntimeRequest() {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var context = { generation: state.requestGeneration, controller: controller };
    state.requestControllers.push(context);
    return context;
  }

  function endRuntimeRequest(context) {
    if (!context) return;
    var next = [];
    for (var i = 0; i < state.requestControllers.length; i++) {
      if (state.requestControllers[i] !== context) next.push(state.requestControllers[i]);
    }
    state.requestControllers = next;
  }

  function isRuntimeRequestCurrent(context) {
    return !!config.enabled && !!context && context.generation === state.requestGeneration &&
      !(context.controller && context.controller.signal && context.controller.signal.aborted);
  }

  // 区间换入时无条件废弃全部在途请求。曾考虑按源文本指纹保留区间外的在途请求
  // （每次换入砍掉约 2 个），但那需要同时绕过 requestGeneration 失效判定，而这个
  // epoch 不变量是防止旧断句译文错写进新时间轴的唯一保障 —— 收益(每 120s 省 1-2 次
  // 请求)远小于风险，故保持全砍。
  function invalidateRuntimeRequests() {
    if (state.srtJob && (state.srtJob.status === "running" || state.srtJob.status === "cancelling")) {
      state.srtJob.cancelRequested = true;
      state.srtJob.status = "cancelled";
      state.srtJob.error = "运行时身份已变化";
    }
    state.requestGeneration++;
    var active = state.requestControllers.slice();
    state.requestControllers = [];
    for (var i = 0; i < active.length; i++) {
      try { if (active[i].controller) active[i].controller.abort(); } catch (e) {}
    }
    state.clipInflight = {};
    state.translationInflight = {};
  }

  function runtimeAbortError() {
    var error = new Error("runtime request superseded");
    error.name = "AbortError";
    return error;
  }

  // 保底渲染节拍(ms)。与帧回调并存 —— 帧回调给精度,它给活性
  // (rVFC 只在合成新帧时触发,无媒体源/缓冲/暂停时不产帧)。见 startRenderLoop。
  var PREFETCH_INTERVAL_MS = 1000;
  var RENDER_FALLBACK_INTERVAL_MS = 250;

  // 字幕轨加载失败后的重试节奏。YouTube 在限流/降级时会返回 200 + 合法 JSON
  // 但 events 为空,解析出 0 条 cue —— 这是**瞬态**故障,重试通常就拿到真轨。
  // 递增间隔避免在真的持续故障时打死端点;用尽后才向用户报错。
  var TRACK_RETRY_DELAYS_MS = [800, 2000, 5000];
  var SEEK_SETTLE_MS = 350; // seek 停稳多少 ms 后才翻目标 clip
  var RETRY_INTERVAL_MS = 3000; // 失败 clip 后台重试调度节拍（第2层）

  /* =====================================================
   * 配置存取
   * ===================================================== */
  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (res) {
          var saved = res && res[STORAGE_KEY];
          if (saved && typeof saved === "object") {
            // 平滑迁移旧配置（布尔 stroke/shadow → 新 strokeWidth/shadowStrength），老配置不炸
            config = Core.migrateConfig(Object.assign({}, DEFAULT_CONFIG, saved));
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
  // v0.5.2：JSON3 词级时间可用时，先做严格词流等价的句子/从句恢复。
  // 所有失败都整轨回落，绝不把模型改写或半段边界混进字幕时间轴。
  function recordApiUsage(usage) {
    if (!usage || typeof usage !== "object") return;
    var prompt = Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0;
    var completion = Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0;
    var total = Number(usage.total_tokens) || (prompt + completion);
    var details = usage.completion_tokens_details || usage.output_tokens_details || {};
    var reasoning = Number(details.reasoning_tokens) || 0;
    state.apiUsage.promptTokens += prompt;
    state.apiUsage.completionTokens += completion;
    state.apiUsage.totalTokens += total;
    state.apiUsage.reasoningTokens += reasoning;
    state.apiUsage.requests++;
  }

  function commitPendingUsage(context, pendingUsage) {
    if (!isRuntimeRequestCurrent(context)) return false;
    (pendingUsage || []).forEach(recordApiUsage);
    pendingUsage.length = 0;
    return true;
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (res) { resolve(res && typeof res === "object" ? res : {}); }); }
      catch (_) { resolve({}); }
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, resolve); } catch (_) { resolve(); }
    });
  }

  function storageRemove(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.remove(keys, resolve); } catch (_) { resolve(); }
    });
  }

  function entryStorageKey(prefix, key) { return prefix + String(key || ""); }

  async function readEntry(prefix, key) {
    var storageKey = entryStorageKey(prefix, key);
    var values = await storageGet([storageKey]);
    var entry = values[storageKey];
    return entry && typeof entry === "object" ? entry : null;
  }

  async function pruneEntryNamespace(prefix, maxEntries) {
    var all = await storageGet(null);
    var entries = Object.keys(all).filter(function (key) { return key.indexOf(prefix) === 0; }).map(function (key) {
      return { key: key, t: Number(all[key] && all[key].t) || 0 };
    }).sort(function (a, b) { return b.t - a.t; });
    var stale = entries.slice(Math.max(0, Number(maxEntries) || 0)).map(function (item) { return item.key; });
    if (!stale.length || !chrome.storage.local.remove) return;
    await new Promise(function (resolve) { try { chrome.storage.local.remove(stale, resolve); } catch (_) { resolve(); } });
  }

  async function removeEntryIfCurrentWrite(storageKey, marker) {
    var current = await storageGet([storageKey]);
    if (current[storageKey] && current[storageKey]._writeMarker === marker) await storageRemove([storageKey]);
  }

  async function writeEntry(prefix, key, value, maxEntries, generation, isAccepted) {
    if (generation != null && (generation !== state.requestGeneration || !config.enabled)) return false;
    if (isAccepted && !isAccepted()) return false;
    var storageKey = entryStorageKey(prefix, key);
    var marker = String(generation == null ? "free" : generation) + ":" + (++state.cacheWriteSeq) + ":" + Date.now();
    var obj = {}; obj[storageKey] = Object.assign({ t: Date.now(), _writeMarker: marker }, value);
    await storageSet(obj);
    if ((generation != null && (generation !== state.requestGeneration || !config.enabled)) || (isAccepted && !isAccepted())) {
      await removeEntryIfCurrentWrite(storageKey, marker);
      return false;
    }
    pruneEntryNamespace(prefix, maxEntries).catch(function () {});
    return true;
  }

  function clipCueFingerprint(clip) {
    return (clip && clip.cues || []).map(function (cue) {
      return [cue.start, cue.end, String(cue.content || "").replace(/\s+/g, " ").trim()].join(":");
    }).join("~");
  }

  function translationIdentitySnapshot() {
    return {
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      apiModel: config.apiModel,
      targetLang: config.targetLang,
      systemPrompt: config.systemPrompt || "",
      reasoningEffort: config.reasoningEffort,
      maxLineChars: config.maxLineChars,
    };
  }

  function clipCacheKey(clip, segmentationMode, identity) {
    identity = identity || translationIdentitySnapshot();
    return Core.makeCacheKey({
      videoId: state.videoId,
      trackCode: state.activeTrack ? state.activeTrack.code : "",
      targetLang: identity.targetLang,
      apiModel: identity.apiModel,
      apiBaseUrl: identity.apiBaseUrl,
      systemPrompt: identity.systemPrompt || "",
      reasoningEffort: identity.reasoningEffort,
      maxLineChars: identity.maxLineChars,
      contractVersion: Core.BLOCK_CONTRACT_VERSION,
      segmentationMode: segmentationMode || state.segmentationMode,
      clipStartMs: clip.startMs,
      cueFingerprint: clipCueFingerprint(clip),
    });
  }

  function readCacheEntry(key) { return readEntry(CACHE_ENTRY_PREFIX, key); }

  function writeCache(key, payload, generation, isAccepted) {
    return writeEntry(CACHE_ENTRY_PREFIX, key, payload, CACHE_MAX_ENTRIES, generation, isAccepted);
  }


  /* =====================================================
   * RPC：接收 main.js 的轨道清单
   * ===================================================== */
  window.addEventListener(CHANNEL, function (ev) {
    var detail = ev && ev.detail;
    // sender/receiver 只用于路由，不是认证：MAIN world 与页面脚本同权，所有 content 均不可信。
    if (!detail || detail.sender !== RPC_PEER || detail.receiver !== SENDER || detail.subject !== "update-manifest") return;
    onManifest(detail.content);
  });

  function currentPageVideoId() {
    try {
      var url = new URL(location.href);
      var queryId = url.searchParams.get("v");
      if (queryId) return queryId;
      var match = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{1,128})(?:\/|$)/);
      return match ? match[1] : "";
    } catch (e) { return ""; }
  }

  function manifestIdentity(manifest) {
    return manifest.videoId + "|" + manifest.files.map(function (track) {
      return [track.code, track.languageCode, track.kind].join("\x1f");
    }).join("\x1e");
  }

  function onManifest(content) {
    var pageVideoId = currentPageVideoId();
    var manifest = Core.validateTrackManifest(content, { expectedVideoId: pageVideoId });
    if (!manifest) {
      console.warn("[dualsub] rejected subtitle manifest not bound to current page/video/track");
      return;
    }
    var nextIdentity = manifestIdentity(manifest);
    if (state.videoId === manifest.videoId && state.manifestIdentity && state.manifestIdentity !== nextIdentity) {
      console.warn("[dualsub] rejected track-identity mutation for active video");
      return;
    }
    var changedVideo = manifest.videoId !== state.videoId;
    state.videoId = manifest.videoId;
    state.tracks = manifest.files;
    if (changedVideo) {
      // 切换视频：清空所有缓存与渲染，并锁定当前页面实际视频的轨道身份。
      resetForNewVideo();
      state.manifestIdentity = nextIdentity;
    } else if (!state.manifestIdentity) {
      state.manifestIdentity = nextIdentity;
    }

    // 通知 popup 轨道清单已更新（popup 打开时用于填充源语言下拉）
    notifyPopupTracks();

    if (!config.enabled) return;
    var track = pickTrack(state.tracks, config.sourceLang);
    if (!track) {
      // 无可用轨 / 中文源被跳过：清渲染，避免上一视频字幕残留
      if (state.activeTrack || state.renderUnits.length || state.cues.length) {
        resetForNewVideo();
      }
      return;
    }
    if (state.activeTrack && state.activeTrack.url === track.url && state.cues.length) {
      return; // 已经在用这条轨道且已加载
    }
    switchTrack(track);
  }

  function switchTrack(track) {
    if (!track || !track.url) return;
    invalidateRuntimeRequests();
    state.timelineEpoch++;
    clearTrackRetryTimer();
    state.trackFailure = null;
    state.activeTrack = track;
    state.cues = [];
    state.sourceTimeline = null;
    state.timelineSnapshot = null;
    state.clips = [];
    state.cueMap = [];
    state.clipUnits = {};
    state.renderUnits = [];
    state.clipState = {};
    state.clipBackoff = {};
    state.clipInflight = {};
    state.lastHitCueIdx = -1;
    clearRenderer();
    loadTrack(track);
  }

  function resetForNewVideo() {
    invalidateRuntimeRequests();
    state.timelineEpoch++;
    state.activeTrack = null;
    state.cues = [];
    state.sourceTimeline = null;
    state.timelineSnapshot = null;
    state.clips = [];
    state.cueMap = [];
    state.clipUnits = {};
    state.renderUnits = [];
    state.clipState = {};
    state.clipInflight = {};
    state.lastHitCueIdx = -1;
    state.lastPrefetchMs = -1e9;
    clearTrackRetryTimer();
    state.trackFailure = null;
    restoreNativeCaptions();
    clearRenderer();
  }


  // 选轨是纯函数，实现在 core.js（可被单测直接调用）。此前它住在这里，测试只能用
  // 正则断言源码文本 —— 于是 auto 判据本身是错的时候门禁依然全绿（实测 3teflb1QNN4
  // 仍选中西语轨）。行为断言比源码断言可靠，所以逻辑搬到可测的层。
  function pickTrack(tracks, sourceLang) {
    return Core.pickTrack(tracks, sourceLang);
  }

  /* =====================================================
   * 拉取 + 解析 + 切 clip
   * ===================================================== */
  async function loadTrack(track, attempt) {
    var trackUrl = track && track.url;
    attempt = attempt || 0;
    function trackRequestCurrent(context) {
      return isRuntimeRequestCurrent(context) && !!state.activeTrack && state.activeTrack.url === trackUrl;
    }
    // 轨道请求是**可重试**的:YouTube 在限流/降级时会返回 200 + 合法 JSON 但
    // events 为空(或整个响应只有 pens/wsWinStyles),解析结果就是 0 条 cue。
    // 之前这里 console.warn 后直接 return —— 一次抖动就让整条轨永久失效,
    // 用户看到的就是「没有字幕」且无从判断原因,只能手动切换轨道。
    function retryLater(reason) {
      if (attempt >= TRACK_RETRY_DELAYS_MS.length) {
        reportTrackFailure(reason);
        return;
      }
      var delay = TRACK_RETRY_DELAYS_MS[attempt];
      console.warn("[dualsub] 字幕轨加载失败(" + reason + "),第 " + (attempt + 1) + " 次重试将在 " + delay + "ms 后");
      var epochAtSchedule = state.timelineEpoch;
      state.trackRetryTimer = setTimeout(function () {
        state.trackRetryTimer = null;
        if (epochAtSchedule !== state.timelineEpoch) return;
        if (!state.activeTrack || state.activeTrack.url !== trackUrl) return;
        loadTrack(track, attempt + 1);
      }, delay);
    }
    state.firstClipReady = false;
    state.waitPausedByUs = false;
    clearWaitTimer();
    clearTrackRetryTimer();
    var requestContext = beginRuntimeRequest();
    try {
      var resp = await fetch(track.url, {
        credentials: "omit",
        signal: requestContext.controller ? requestContext.controller.signal : undefined,
      });
      if (!trackRequestCurrent(requestContext)) return;
      if (!resp.ok) {
        endRuntimeRequest(requestContext);
        requestContext = null;
        retryLater("HTTP " + resp.status);
        return;
      }
      var text = await resp.text();
      if (!trackRequestCurrent(requestContext)) return;
      endRuntimeRequest(requestContext);
      requestContext = null;
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
        // 200 + 合法 JSON 但没有任何字幕内容 —— 典型的限流/降级响应,重试通常能拿到真轨
        retryLater("轨道为空");
        return;
      }
      // 先立即建立稳定 fallback 原文时间轴；技术 cue 不翻译。语义恢复是整轨模型工作，不能阻塞首字幕。
      var sourceTimeline = Core.buildCanonicalTokenTimeline(cues);
      // maxVisualWidth 让词数上限按文本实际宽度折算：拉丁轨维持既有行为，逐字文字
      // （日/中/韩/泰）不再被 12 个"词"=12 字符切成碎屏。
      var fallbackCues = Core.resegmentCues(cues, {
        tailTrimMs: config.tailTrimMs,
        maxWords: Core.DISPLAY_UNIT_MAX_WORDS,
        maxVisualWidth: Core.SOURCE_DISPLAY_MAX_WIDTH,
        continuationMaxWords: Core.SOURCE_UNIT_MAX_WORDS,
      });
      if (!installCueTimeline(fallbackCues, "block", { sourceTimeline: sourceTimeline })) {
        retryLater("解析后无有效字幕");
        return;
      }
      state.trackFailure = null;
      // 原文立即可见；同一批连续 cue 直接整块翻译并由目标语言自然重组。
      // 不再先恢复源文 display/semantic 边界，也不要求译文逐 cue 对齐。
      } catch (e) {
      if (requestContext && !isRuntimeRequestCurrent(requestContext)) return;
      endRuntimeRequest(requestContext);
      requestContext = null;
      // fetch 抛错(断网/超时/JSON 解析失败)同样可重试,不能一次就放弃整条轨
      retryLater((e && e.name === "AbortError") ? "请求被中止" : ("网络或解析错误: " + (e && e.message || e)));
    } finally {
      endRuntimeRequest(requestContext);
    }
  }

  /**
   * 轨道彻底加载失败(重试全部用尽)。记录到 state 供 popup 显示 —— 之前只有
   * 一行 console.warn,用户无从判断是扩展坏了还是网络问题。
   */
  function reportTrackFailure(reason) {
    state.trackFailure = { reason: String(reason || "未知原因"), at: Date.now() };
    console.warn("[dualsub] 字幕轨加载失败,重试已用尽:", state.trackFailure.reason);
    try {
      chrome.runtime.sendMessage({ type: "dualsub-track-failure", reason: state.trackFailure.reason });
    } catch (ignored) { /* popup 未打开时无接收方,忽略 */ }
  }

  function clearTrackRetryTimer() {
    if (state.trackRetryTimer) {
      clearTimeout(state.trackRetryTimer);
      state.trackRetryTimer = null;
    }
  }

  function sliceTimelineClips(cues) {
    // 新 block 翻译需要足够上下文；旧 4 条/12 秒 clip 会重新制造逐碎片翻译。
    // 用户配置仍可把块调大，但不能低于保证上下文的产品下限。
    var blockSeconds = Math.max(30, Number(config.clipSeconds) || 0);
    var firstSeconds = Math.max(12, Number(config.firstClipSeconds) || 0);
    var maxCues = Math.min(20, Math.max(12, Math.floor(Number(config.maxCuesPerClip) || 0)));
    var maxChars = Math.max(600, Math.floor(Number(config.maxSourceCharsPerClip) || 0));
    return Core.sliceClipsByCue(cues, blockSeconds * 1000, {
      firstTargetMs: firstSeconds * 1000,
      maxCuesPerClip: maxCues,
      maxSourceChars: maxChars,
      keepSemanticGroups: false,
    });
  }

  function clipIdxAtIn(clips, ms) {
    if (!clips || !clips.length) return -1;
    for (var i = 0; i < clips.length; i++) {
      if (ms >= clips[i].startMs && ms < clips[i].endMs) return i;
      // In a cue gap, prepare the next upcoming clip rather than an unrelated last clip.
      if (ms < clips[i].startMs) return i;
    }
    return clips.length - 1;
  }

  async function readVerifiedClipCache(clip, segmentationMode, identity, generation) {
    var key = clipCacheKey(clip, segmentationMode, identity);
    var cached = await readCacheEntry(key);
    if (generation !== state.requestGeneration || !config.enabled) throw runtimeAbortError();
    if (!cached || !Array.isArray(cached.segments)) return null;
    try {
      var units = Core.materializeBlockTranslation(cached.segments, clip.cues, { maxVisualWidth: identity.maxLineChars, requireIntegrity: true });
      return { key: key, cues: clip.cues, segments: cached.segments, units: units, fromCache: true };
    } catch (_) {
      try { await storageRemove([entryStorageKey(CACHE_ENTRY_PREFIX, key)]); } catch (_) {}
      return null;
    }
  }

  async function loadOrTranslateClip(clip, segmentationMode, priority) {
    var identity = translationIdentitySnapshot();
    var generation = state.requestGeneration;
    var key = clipCacheKey(clip, segmentationMode, identity);
    if (state.translationInflight[key]) return state.translationInflight[key];

    var task = (async function () {
      var context = beginRuntimeRequest();
      var pendingUsage = [];
      try {
        // Intent 先进入优先级 gate，再做异步 storage lookup。否则高优先级 seek 会在
        // cache callback 尚未返回时被稍后到达的低优先级全轨任务抢先占槽。
        var payload = await ensureGate().run(async function () {
          if (!isRuntimeRequestCurrent(context)) throw runtimeAbortError();
          var cachedResult = await readVerifiedClipCache(clip, segmentationMode, identity, generation);
          if (cachedResult) return { cached: cachedResult };
          if (!identity.apiBaseUrl || !identity.apiModel) throw new Error("translation configuration missing");
          var contextBefore = state.cues.slice(Math.max(0, clip.startIndex - 3), clip.startIndex);
          var contextAfter = state.cues.slice(clip.startIndex + clip.cues.length, clip.startIndex + clip.cues.length + 3);
          var result = await Core.translateContextBlock({
            cues: clip.cues,
            contextBefore: contextBefore,
            contextAfter: contextAfter,
            apiBaseUrl: identity.apiBaseUrl,
            apiKey: identity.apiKey,
            apiModel: identity.apiModel,
            targetLang: identity.targetLang,
            systemPrompt: identity.systemPrompt,
            reasoningEffort: identity.reasoningEffort,
            maxVisualWidth: identity.maxLineChars,
            timeoutMs: Core.TRANSLATE_TIMEOUT_MS,

            fetchImpl: function (u, o) { return fetch(u, o); },
            onUsage: function (usage) { pendingUsage.push(usage); },
            signal: context.controller ? context.controller.signal : undefined,
          });
          return { translated: result };
        }, priority == null ? 20 : priority);
        if (payload.cached) return payload.cached;
        if (!isRuntimeRequestCurrent(context) || generation !== state.requestGeneration) throw runtimeAbortError();
        var result = payload.translated;
        var out = {
          key: key,
          cues: clip.cues,
          segments: result && result.segments ? result.segments : [],
          units: result && result.units ? result.units : [],
          fromCache: false,
        };
        if (out.units.length) await writeCache(key, { segments: out.segments }, generation);
        if (!isRuntimeRequestCurrent(context) || generation !== state.requestGeneration) throw runtimeAbortError();
        commitPendingUsage(context, pendingUsage);
        return out;
      } finally {
        endRuntimeRequest(context);
      }
    })();

    state.translationInflight[key] = task;
    try {
      return await task;
    } finally {
      if (state.translationInflight[key] === task) delete state.translationInflight[key];
    }
  }

  // 仅在完整 cue 集合准备好时切换。递增 epoch 使旧分段的翻译请求自然失效。
  function installCueTimeline(cues, mode, prepared) {
    if (!cues || !cues.length) return false;

    // Prepare the complete candidate before changing epoch, mode, or any live timeline state.
    // In particular, model-derived seed construction may throw. A failure must leave the working
    // fallback timeline intact so the caller can enable fallback translation safely.
    var nextTimeline = prepared && prepared.sourceTimeline
      ? prepared.sourceTimeline
      : (state.sourceTimeline || Core.buildCanonicalTokenTimeline(cues));
    var nextSourceUnits;
    var nextSnapshot;
    var canonicalCues;
    try {
      nextSourceUnits = Core.buildCueTokenSpanUnits(nextTimeline, cues);
      nextSnapshot = Core.createTimelineSnapshot({
        revision: state.timelineSnapshot ? state.timelineSnapshot.revision + 1 : 0,
        videoId: state.videoId,
        trackCode: state.activeTrack && (state.activeTrack.code || state.activeTrack.languageCode) || "",
        timeline: nextTimeline,
        units: nextSourceUnits,
      });
      canonicalCues = Core.cuesFromTimelineSnapshot(nextSnapshot);
    } catch (snapshotError) {
      console.warn("[dualsub] reject invalid timeline snapshot", snapshotError && snapshotError.message);
      return false;
    }
    var nextClips = sliceTimelineClips(canonicalCues);
    var nextCueMap = Core.cueClipIndexMap(nextClips);
    var nextClipUnits = {};
    var nextClipState = {};


    invalidateRuntimeRequests();
    state.timelineEpoch++;

    state.segmentationMode = mode;
    state.sourceTimeline = nextSnapshot.timeline;
    state.timelineSnapshot = nextSnapshot;
    state.cues = canonicalCues;
    state.clips = nextClips;
    state.cueMap = nextCueMap;
    state.clipUnits = nextClipUnits;
    state.renderUnits = [];
    state.clipState = nextClipState;
    state.clipBackoff = {};
    state.clipInflight = {};
    state.lastHitCueIdx = -1;
    rebuildRenderTimeline();
    ensureRenderer();
    bindVideo();
    prefetchAround(currentTimeMs(), true);
    requestRender();
    return true;
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
   * 预取策略（带节流）：进入某 clip 立即翻当前 clip + 滑动窗口预取后续若干 clip。
   * force=true 时跳过节流（拖动进度条 / 刚加载）。
   * 用 Core.planPrefetch 算出 [idx, idx+1, idx+2...]（已裁越界）；每个下标各自
   * 独立发起 translateClip——"下下个"不被"下一个还 pending"阻塞。窗口由全局信号量
   * (ensureGate)封顶，避免多 clip 并发冲垮网关。
   * 已翻 / 正在翻 / 退避中的 clip 由 translateClip 内部跳过。
   * block 模式：一个连续源块一次请求，模型可自由合并并返回任意数量目标语言屏。
   */

  function clearWaitTimer() {
    if (state.waitTimer != null) { clearTimeout(state.waitTimer); state.waitTimer = null; }
  }

  function releaseWaitPause() {
    state.waitTimer = null;
    state.firstClipReady = true;
    if (state.waitPausedByUs) {
      state.waitPausedByUs = false;
      var v = videoEl();
      if (v && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    }
    requestRender();
  }

  /**
   * 「等首块译文」的兜底解锁，不是等待上限。
   *
   * 曾经这里是固定 8000ms 死超时：到点无条件恢复播放。但首块真实耗时实测
   * 12.7s / 18.0s / 23.6s（gpt-5.4-mini，DGdsIrAjp3k 首块 7 条 cue）—— 三次全部超过
   * 8s，于是自动暂停几乎每次都在译文到达前就放行了，等于这个功能没生效。
   *
   * 固定时长猜不中：网关快慢、块大小、模型都在变。所以改成等真实完成信号 ——
   * 首块 done 时 maybeResumeAfterFirstTranslation 立即恢复播放（那才是正常路径）；
   * 这个定时器只负责「翻译已经不在跑了」时别把视频永久卡住。到点仍在翻译中就继续等。
   */
  function scheduleWaitDeadline() {
    var ms = Number(config.waitForFirstTranslationCheckMs);
    if (!Number.isFinite(ms) || ms <= 0) ms = 2000;
    state.waitTimer = setTimeout(function () {
      state.waitTimer = null;
      if (state.firstClipReady) return;
      // 首块仍在正常翻译中（排队/在飞/等重试）→ 继续等，不放行。
      var st = state.clipState[0];
      var stillWorking = state.clipInflight[0] === true || st === "pending" || st === "error";
      if (stillWorking) {
        scheduleWaitDeadline();
        return;
      }
      releaseWaitPause();
    }, ms);
  }
  function maybePauseForFirstTranslation(clipIdx) {
    if (!config.waitForFirstTranslation) return;
    if (state.firstClipReady) return;
    if (clipIdx !== 0) return;
    var v = videoEl();
    if (!v || v.paused) return;
    try {
      v.pause();
      state.waitPausedByUs = true;
      setRendererText((state.renderUnits[0] && state.renderUnits[0].originalText) || "", "", true, false);
      clearWaitTimer();
      scheduleWaitDeadline();
    } catch (e) {}
  }
  function maybeResumeAfterFirstTranslation(clipIdx) {
    if (clipIdx !== 0) return;
    state.firstClipReady = true;
    clearWaitTimer();
    if (!state.waitPausedByUs) return;
    state.waitPausedByUs = false;
    var v = videoEl();
    if (v && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  }

  function prefetchAround(ms, force) {
    if (!config.enabled || !state.clips.length) return;
    // 语义恢复尚未结束时，fallback 只保证原文立即可见；机械碎片绝不进入翻译。
    if (state.segmentationMode === "fallback") return;
    // 节流：预取循环低频(1.5s)调用，位置没明显移动就不重复跑昂贵逻辑
    if (!force && Math.abs(ms - state.lastPrefetchMs) < 1000) return;
    state.lastPrefetchMs = ms;

    var idx = clipIdxAt(ms);
    if (idx === -1) idx = 0;

    // 当前段剩余播放时间（段末 endMs - 当前播放位置）。接近段尾时 planPrefetch 自动多预取一段，
    // 追平被网关限速拖慢的窗口。endMs 取不到时用 clip 末条 cue 的 end 兜算。
    var curClip = state.clips[idx];
    var endMs = curClip
      ? (curClip.endMs != null
          ? curClip.endMs
          : (curClip.cues && curClip.cues.length ? curClip.cues[curClip.cues.length - 1].end : ms))
      : ms;
    var remainMsInCurrent = endMs - ms;

    // 滑动窗口下标列表（含当前段）。每段整段一起翻。
    // 调度判据收敛到 Core.planTranslationWindow（单一权威 + 可被门禁覆盖）。
    // 所有 block 统一由 planTranslationWindow 决定当前与后续预取，不在调用点旁路。
    var plan = Core.planTranslationWindow({
      currentIdx: idx,
      clipCount: state.clips.length,
      remainMsInCurrent: remainMsInCurrent,
      // 翻译不得跑到语义恢复前面。
      //
      // 根因（用户轨 BhtgINeaJWg 实测）：预取窗口领先约 56s，而语义区间换入发生在
      // 播放接近已恢复边界时。于是「先按 fallback 断句翻好 → 换入改断句 → 边界交叉 →
      // 译文作废 → 重翻」。真机一次换入 28 条新单元里交叉切开 17 条，丢掉 56~68%
      // 已翻词。同一段内容翻两遍，这才是「翻译永远跟不上字幕」。
      //
      // 语义恢复比播放快 3.5x，因此把预取截到已恢复边界内不会让翻译闲着 ——
      // 只是不再把算力花在马上要作废的断句上。
      semanticReadyUntilMs: null,
      clipStartMs: state.clips.map(function (c) { return c ? c.startMs : NaN; }),
    }).plan;
    // force（刚加载/seek）时：先只踢当前段，下一 macrotask 再铺后续预取，
    // 让首包请求更早离开浏览器、更少与同批预取抢模型算力。
    if (force && plan.length > 1) {
      translateClip(plan[0], 100);
      var rest = plan.slice(1);
      var scheduledEpoch = state.timelineEpoch;
      var scheduledGeneration = state.requestGeneration;
      setTimeout(function () {
        if (scheduledEpoch !== state.timelineEpoch || scheduledGeneration !== state.requestGeneration) return;
        for (var j = 0; j < rest.length; j++) translateClip(rest[j], j === 0 && remainMsInCurrent < 15000 ? 60 : 10);
      }, 0);
    } else {
      for (var i = 0; i < plan.length; i++) {
        translateClip(plan[i], plan[i] === idx ? 100 : (plan[i] === idx + 1 && remainMsInCurrent < 15000 ? 60 : 10));
      }
    }
  }

  function getBackoff(idx) {
    // maxFails 6 / base 2s / max 30s：失败 clip 由后台调度器(startRetryScheduler)按此退避反复重翻，
    // 达 maxFails 才真正放弃(clipState=failed 终态，UI 可见标「翻译失败」)。
    if (!state.clipBackoff[idx]) state.clipBackoff[idx] = Core.makeBackoff({ maxFails: 6, baseMs: 2000, maxMs: 30000 });
    return state.clipBackoff[idx];
  }

  async function translateClip(idx, priority) {
    var timelineEpoch = state.timelineEpoch;
    var segmentationModeAtStart = state.segmentationMode;
    var requestGeneration = state.requestGeneration;
    var clip = state.clips[idx];
    if (!clip || state.clipState[idx] === "done" || state.clipState[idx] === "failed" || state.clipInflight[idx]) return;

    var backoff = getBackoff(idx);
    if (!backoff.shouldTry()) return;
    state.clipInflight[idx] = true;
    try {
      state.clipState[idx] = "pending";
      if (idx === 0) maybePauseForFirstTranslation(0);
      var result = await loadOrTranslateClip(clip, segmentationModeAtStart, priority);
      if (requestGeneration !== state.requestGeneration || timelineEpoch !== state.timelineEpoch || segmentationModeAtStart !== state.segmentationMode) return;
      applyBlockUnits(idx, clip, result.key, result.units, { skipCacheWrite: true });
    } catch (e) {
      var stale = requestGeneration !== state.requestGeneration || timelineEpoch !== state.timelineEpoch || segmentationModeAtStart !== state.segmentationMode;
      var aborted = e && (e.name === "AbortError" || /aborted|superseded/i.test(String(e.message || "")));
      // stale：整轨/身份已换代，这个 clip 的状态属于旧世代，交给 resetTrackState 处理，
      // 这里不写状态（写了会污染新世代）。
      if (stale) return;
      // abort：当代请求被中止（seek/配置变更打断在途请求）。此前直接 return，clipState
      // 停在 "pending"、clipInflight 停在 true —— 重试调度器只捡 "error"，预取窗口只向前
      // 不回头，于是这个 clip 永久没人再碰。真实后果：西语轨 E4HGfagANiQ 块3 全空而块4
      // 已译（144.1s→208.1s 无译文），中间留洞。中止不是失败，不计入 maxFails，但必须
      // 回到可重翻状态。
      if (aborted) {
        state.clipState[idx] = "error";
        ensureRetryScheduler();
        return;
      }
      if (/configuration missing/i.test(String(e && e.message || ""))) {
        state.clipState[idx] = "error";
        return;
      }
      ensureGate().reportError(Core.errorKind(e));
      console.warn("[dualsub] clip", idx, "翻译失败：", e && e.message, "→ 退避重试");
      state.clipState[idx] = "error";
      backoff.fail();
      ensureRetryScheduler();
    } finally {
      // 无论是否换代，inflight 都必须复位：它是「本次调用是否在跑」的互斥标记，不是世代状态。
      // 旧代残留 true 会让 translateClip 开头的守卫永久拒绝该 clip（僵尸态的另一半）。
      state.clipInflight[idx] = false;
      if (requestGeneration !== state.requestGeneration || timelineEpoch !== state.timelineEpoch || segmentationModeAtStart !== state.segmentationMode) return;
      if (state.clipState[idx] === "pending") {
        state.clipState[idx] = "error";
        getBackoff(idx).fail();
        ensureRetryScheduler();
      }
    }
  }

  /**
   * 处理 translateContextBlock 已验证并物化的目标语言单元。
   *  - units 非空：直接存入独立译文时间轴；
   *  - units 空：error + 退避，交后台调度器重试；
   *    渲染层此时对该 clip 回退显原文（rebuildRenderTimeline 用 cue 铺空译文单元）。
   * 不再有「部分接受 / 缺口逐行补翻」—— 模型一步到位直接分行，代码只配时间轴。
   */
  function applyBlockUnits(idx, clip, key, units, opts) {
    opts = opts || {};
    var backoff = getBackoff(idx);
    var valid = !!(units && units.length && units.every(function (unit) {
      return unit && unit.endMs > unit.startMs && String(unit.translation || "").trim();
    }));
    if (valid) {
      state.clipUnits[idx] = units;
      state.clipState[idx] = "done";
      if (idx === 0) maybeResumeAfterFirstTranslation(0);
      backoff.reset();
      if (!opts.skipCacheWrite) console.warn("[dualsub] block units without normalized segments are not cached");
      if (!opts.deferRender) {
        rebuildRenderTimeline();
        requestRender();
      }
    } else {
      // 模型空响应：无译文 → 退避重试（不写缓存，避免把空结果固化）。
      console.warn("[dualsub] clip", idx, "模型空响应（无 block units）→ 退避重试");
      delete state.clipUnits[idx];
      state.clipState[idx] = "error";
      backoff.fail();
      rebuildRenderTimeline();
      requestRender();
      ensureRetryScheduler();
    }
  }

  function usageSnapshot() {
    return Object.assign({}, state.apiUsage);
  }

  function usageDelta(start) {
    var now = state.apiUsage;
    return {
      promptTokens: now.promptTokens - start.promptTokens,
      completionTokens: now.completionTokens - start.completionTokens,
      totalTokens: now.totalTokens - start.totalTokens,
      reasoningTokens: now.reasoningTokens - start.reasoningTokens,
      requests: now.requests - start.requests,
    };
  }

  function fullSrtStatus() {
    var job = state.srtJob;
    if (!job) return { status: "idle", totalUnits: state.cues.length, completedUnits: 0 };
    return {
      id: job.id,
      status: job.status,
      totalUnits: job.totalUnits,
      completedUnits: job.completedUnits,
      completedBatches: job.completedBatches,
      totalBatches: job.totalBatches,
      error: job.error || "",
      usage: usageDelta(job.usageStart),
    };
  }

  async function translateFullSrtBatch(batch, job, identity, mode) {
    if (!batch || batch.length !== 1) throw new Error("full SRT block batch must contain exactly one clip");
    var item = batch[0];
    var clip = item.clip;
    // 完整 SRT 与前台播放/seek 必须共享同一 keyed in-flight Promise。
    // 取消 full-SRT 只停止这个等待者；不能 abort 可能同时被前台使用的请求。
    var result = await loadOrTranslateClip(clip, mode, 1);
    if (job.cancelRequested || job.generation !== state.requestGeneration || !config.enabled) throw runtimeAbortError();
    applyBlockUnits(item.idx, clip, result.key, result.units, { skipCacheWrite: true, deferRender: true });
    job.completedUnits += clip.cues.length;
    job.completedBatches++;
    rebuildRenderTimeline();
    requestRender();
  }

  async function runFullSrtPreparation(job) {
    var identity = translationIdentitySnapshot();
    var mode = state.segmentationMode;
    try {
      var missing = [];
      for (var idx = 0; idx < state.clips.length; idx++) {
        if (job.cancelRequested || job.generation !== state.requestGeneration) throw runtimeAbortError();
        var clip = state.clips[idx];
        if (state.clipState[idx] === "done" && state.clipUnits[idx]) {
          job.completedUnits += clip.cues.length;
          continue;
        }
        var cached = await readVerifiedClipCache(clip, mode, identity, job.generation);
        if (cached) {
          applyBlockUnits(idx, clip, cached.key, cached.units, { skipCacheWrite: true, deferRender: true });
          job.completedUnits += clip.cues.length;
        } else {
          missing.push({ idx: idx, clip: clip, cues: clip.cues });
        }
      }
      rebuildRenderTimeline();
      requestRender();
      var batches = missing.map(function (item) { return [item]; });
      job.totalBatches = batches.length;
      for (var bi = 0; bi < batches.length; bi++) {
        if (job.cancelRequested) {
          job.status = "cancelled";
          return;
        }
        if (job.generation !== state.requestGeneration || !config.enabled) throw runtimeAbortError();
        await translateFullSrtBatch(batches[bi], job, identity, mode);
      }
      job.status = "completed";
    } catch (e) {
      if (job.cancelRequested || (e && e.name === "AbortError")) {
        job.status = "cancelled";
      } else {
        job.status = "failed";
        job.error = String(e && e.message || e);
      }
    }
  }

  function startFullSrtPreparation() {
    if (state.srtJob && (state.srtJob.status === "running" || state.srtJob.status === "cancelling")) return state.srtJob;
    var job = {
      id: "srt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      status: "running",
      generation: state.requestGeneration,
      cancelRequested: false,
      totalUnits: state.cues.length,
      completedUnits: 0,
      completedBatches: 0,
      totalBatches: 0,
      usageStart: usageSnapshot(),
      error: "",
      activeContext: null,
    };
    state.srtJob = job;
    runFullSrtPreparation(job);
    return job;
  }

  /* =====================================================
   * 第2层：失败 clip 后台重试调度器
   * =====================================================
   * clipState==="error" 的 clip 不能永久停摆。一个低频循环按 backoff 时间反复重翻，
   * 直到成功(done)或达 maxFails(failed 终态)。只在有 error clip 时活跃，全 done 时停。
   */
  function retryTick() {
    var anyError = false;
    for (var ci in state.clipState) {
      if (state.clipState[ci] !== "error") continue;
      var idx = parseInt(ci, 10);
      // 没配 API 的 error 不是瞬态错误，不重试也不让调度器为它空转
      if (!config.apiBaseUrl || !config.apiModel) continue;
      var backoff = getBackoff(idx);
      if (backoff.stopped) {
        state.clipState[idx] = "failed"; // 达 maxFails：终态，UI 标「翻译失败」
        rebuildRenderTimeline();
        requestRender();
        continue;
      }
      anyError = true;
      if (backoff.shouldTry() && !state.clipInflight[idx]) {
        translateClip(idx); // 异步，不 await；重入由 clipInflight 互斥
      }
    }
    if (!anyError) stopRetryScheduler(); // 没有可重试的 error clip → 停循环省 CPU
  }

  function ensureRetryScheduler() {
    if (state.retryTimer != null) return;
    if (!config.enabled) return;
    state.retryTimer = setInterval(retryTick, RETRY_INTERVAL_MS);
  }
  function stopRetryScheduler() {
    if (state.retryTimer != null) {
      clearInterval(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /**
   * 重建全局渲染时间轴 state.renderUnits（v0.4.0：clip 渲染单元优先、原文兜底）。
   * 按 clip 顺序遍历，每个 clip：
   *  - 已翻好(clipUnits[idx]) → 直接使用目标语言独立渲染单元；
   *  - 未翻好 → 逐条 cue 铺一个单元，原文用 cue.content、译文留空（未到时显原文 / 转「翻译中…」）。
   * 产出按 start 升序的单元数组，渲染 tick 用 findCueIndexAt 在其上二分查当前行。
   * 每个单元：{ start, end, originalText, translation, clipIdx }。
   */
  function rebuildRenderTimeline() {
    if (!state.timelineSnapshot) {
      state.renderUnits = [];
      state.lastHitCueIdx = -1;
      updateNativeCaptionVisibility();
      return;
    }
    var render = [];
    for (var ci = 0; ci < state.clips.length; ci++) {
      var clip = state.clips[ci];
      var translated = state.clipState[ci] === "done" ? state.clipUnits[ci] : null;
      if (clip && translated && translated.length) {
        for (var ti = 0; ti < translated.length; ti++) {
          var unit = translated[ti];
          render.push({
            unitId: "block:" + ci + ":" + ti,
            sourceFingerprint: state.timelineSnapshot.sourceFingerprint || "",
            tokenStart: null,
            tokenEnd: null,
            start: unit.startMs,
            end: unit.endMs,
            originalText: unit.originalText,
            translation: unit.translation,
            clipIdx: ci,
          });
        }
      } else if (clip) {
        for (var fi = 0; fi < clip.cues.length; fi++) {
          var cue = clip.cues[fi];
          render.push({
            unitId: cue.unitId || "source:" + ci + ":" + fi,
            sourceFingerprint: cue.sourceFingerprint || clipCueFingerprint(clip),
            tokenStart: Number.isInteger(cue.tokenStart) ? cue.tokenStart : null,
            tokenEnd: Number.isInteger(cue.tokenEnd) ? cue.tokenEnd : null,
            start: cue.start,
            end: cue.end,
            originalText: cue.content,
            translation: null,
            clipIdx: ci,
          });
        }
      }
    }
    render.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    // 去重叠必须在这里做 —— 整条时间线只有汇合后才完整。
    //
    // materializeBlockTranslation 里的去重叠只看得见**单个块**，块与块之间没人管；
    // 而滚动窗口 ASR 轨（YouTube 自动字幕）相邻 cue 天然大幅交叉（实测 DGdsIrAjp3k
    // 188/202 条重叠），块边界两侧的屏于是重叠上屏，播放器同时命中两屏 —— 用户看到
    // 的现象是「译文和原文错位、串行」。
    //
    // 只截 end、不动 start：出现时刻是唯一必须精确贴合音轨的量（红线）。
    Core.enforceDisplayMonotonicity(render, Core.BLOCK_MIN_DISPLAY_MS, {
      startKey: "start", endKey: "end",
    });
    state.renderUnits = render;
    updateNativeCaptionVisibility();
    state.lastHitCueIdx = -1;
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

  /** 确保叠加层 DOM 存在并挂到当前播放器上（全屏/影院/SPA 换播放器时重挂） */
  function ensureRenderer() {
    var player = playerEl();
    if (!player) return;
    // 已存在且仍挂在当前播放器下 → 只刷新样式
    if (state.renderer && state.renderer.parentNode === player) {
      applyStyleVars();
      return;
    }
    // 渲染器还在但挂错了父节点（播放器被换/重建）→ 迁移到当前播放器
    if (state.renderer) {
      try {
        player.appendChild(state.renderer);
      } catch (e) {}
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
    teardownFontObserver();
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
      "  width:100%; padding:0 2%; box-sizing:border-box;",
      "}",
      ".dualsub-subtitle{",
      "  display:inline-block; max-width:100%; line-height:1.25;",
      "  font-size:calc(var(--ds-fontsize,22px) * var(--ds-fit-scale,1));",
      "  font-family:var(--ds-fontfamily,'YouTube Noto',Roboto,Arial,sans-serif);",
      "  font-weight:var(--ds-fontweight,500);",
      "  white-space:nowrap; overflow:visible;",
      "}",
      ".dualsub-subtitle.dualsub-orig{ color:var(--ds-orig-color,#fff); }",
      ".dualsub-trans{ color:var(--ds-trans-color,#7fdfff); }",
      // 描边/阴影改为变量驱动（width=0 即无描边，无需 class 开关）。
      // paint-order:stroke fill 让描边描在文字下方，不啃掉字形。
      ".dualsub-subtitle{",
      "  -webkit-text-stroke: var(--ds-stroke-width,1.2px) var(--ds-stroke-color,#000);",
      "  paint-order:stroke fill;",
      "  text-shadow: var(--ds-shadow, 0 0 4px #000,0 1px 2px #000);",
      "}",
      ".dualsub-bg .dualsub-subtitle{",
      "  background:rgba(0,0,0,0.6); padding:1px 8px; border-radius:4px;",
      "}",
      ".dualsub-trans.dualsub-pending{ opacity:0.55; font-style:italic; }",
      ".dualsub-trans.dualsub-failed{ opacity:0.6; font-style:italic; color:#ff8a8a; }",
      ".dualsub-hidden{ display:none !important; }",
      ".dualsub-hide-native-captions .ytp-caption-window-container{ display:none !important; }",
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
    applyFontSize(); // 字号随播放器高度同比缩放（全屏放大），并(重)挂 ResizeObserver
    // 字重：直接写 CSS（"400"|"500"|"700"…）。空/非法回落默认。
    var fw = String(config.fontWeight == null ? "" : config.fontWeight).trim();
    r.style.setProperty("--ds-fontweight", fw || DEFAULT_CONFIG.fontWeight);
    // 字体族：空 = 用内置默认族（CSS 里 var 的 fallback 生效）；否则整串写入（仅本地/系统字体）。
    var ff = String(config.fontFamily == null ? "" : config.fontFamily).trim();
    if (ff) {
      r.style.setProperty("--ds-fontfamily", ff);
    } else {
      r.style.removeProperty("--ds-fontfamily");
    }
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
    // 描边：粗细(px) + 颜色，变量驱动。strokeWidth=0 → 0px 即无描边（不再用 class 开关）。
    var sw = Core.normalizeStrokeWidth(config.strokeWidth, DEFAULT_CONFIG.strokeWidth);
    r.style.setProperty("--ds-stroke-width", sw + "px");
    r.style.setProperty(
      "--ds-stroke-color",
      Core.normalizeColor(config.strokeColor, DEFAULT_CONFIG.strokeColor)
    );
    // 阴影：按 shadowStrength 查表注入整串 text-shadow（none→无阴影）。
    r.style.setProperty("--ds-shadow", Core.shadowCss(config.shadowStrength));
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

  function updateNativeCaptionVisibility() {
    var player = playerEl();
    if (!player) return;
    if (!config.enabled || !state.renderer) {
      player.classList.remove("dualsub-hide-native-captions");
      return;
    }
    var domHasDualsubText = state.renderer && (
      String(state.renderer._orig && state.renderer._orig.textContent || "").trim() !== "" ||
      String(state.renderer._trans && state.renderer._trans.textContent || "").trim() !== ""
    );
    var timelineHasDualsubText = state.renderUnits.some(function (u) {
      return u && (String(u.originalText || "").trim() !== "" || String(u.translation || "").trim() !== "");
    });
    player.classList.toggle("dualsub-hide-native-captions", !!(domHasDualsubText || timelineHasDualsubText));
  }

  function restoreNativeCaptions() {
    var player = playerEl();
    if (player) player.classList.remove("dualsub-hide-native-captions");
  }

  /**
   * 按当前播放器高度算实际字号写 CSS 变量（全屏放大、退出缩小）。
   * fontSize 配置语义为"基准高度(480)下的字号"，Core.computeFontPx 同比缩放并 clamp。
   * 取不到高度（加载早期）时回落基准字号。每次调用顺带确保 ResizeObserver 已挂在当前播放器。
   */
  function fitSubtitleRows() {
    var r = state.renderer;
    if (!r) return;
    var available = Math.max(1, r.clientWidth * 0.96);
    [r._orig, r._trans].forEach(function (row) {
      if (!row) return;
      row.style.setProperty("--ds-fit-scale", "1");
      var natural = row.scrollWidth;
      // 字号只做小幅安全调整；0.85 以下属于分段失败，必须显式标记，不能用小字掩盖。
      var scale = natural > available ? Math.max(0.85, available / natural) : 1;
      row.style.setProperty("--ds-fit-scale", String(Math.round(scale * 1000) / 1000));
      row.classList.toggle("dualsub-overflow", natural * scale > available + 1);
    });
  }

  function applyFontSize() {
    var r = state.renderer;
    if (!r) return;
    var player = playerEl();
    var h = player ? player.clientHeight : 0;
    var px = Core.computeFontPx(h, config.fontSize);
    r.style.setProperty("--ds-fontsize", px + "px");
    fitSubtitleRows();
    setupFontObserver(player);
  }

  /**
   * 在播放器上挂 ResizeObserver：尺寸变化（全屏/影院/窗口缩放）时重算字号。
   * 幂等：已观察当前播放器则跳过；播放器换了先 disconnect 旧的再观察新的。
   * 环境无 ResizeObserver 时静默降级（仍有 applyFontSize 在样式刷新/重挂时兜底）。
   */
  function setupFontObserver(player) {
    if (typeof ResizeObserver === "undefined") return;
    if (!player) return;
    if (state.fontObserver) {
      if (state.fontObserver._target === player) return; // 已在观察当前播放器
      teardownFontObserver(); // 播放器换了 → 解绑旧的
    }
    var ro = new ResizeObserver(function () {
      var rr = state.renderer;
      if (!rr) return;
      var p = playerEl();
      var px = Core.computeFontPx(p ? p.clientHeight : 0, config.fontSize);
      rr.style.setProperty("--ds-fontsize", px + "px");
      fitSubtitleRows();
    });
    try {
      ro.observe(player);
      ro._target = player;
      state.fontObserver = ro;
    } catch (e) {}
  }

  function teardownFontObserver() {
    if (state.fontObserver) {
      try {
        state.fontObserver.disconnect();
      } catch (e) {}
      state.fontObserver = null;
    }
  }

  /* =====================================================
   * 运行循环 + 生命周期（低配机占用优化）
   * -----------------------------------------------------
   * 原实现：timeupdate 监听 + setInterval(250) 双触发，每次都线性扫 cue +
   * 无条件 prefetch，即使字幕没变也每秒约 4 次全量计算；定时器/监听器还泄漏。
   * 现实现：
   *  - 单一节流渲染循环（250ms）。cue 未变化 → 提前 return，零 DOM/查找工作。
   *  - 预取与渲染解耦：单独 1.5s 一次的低频循环。
   *  - 二分查找 + 上次命中下标提示（Core.findCueIndexAt），大多数 tick O(1)。
   *  - 完整生命周期：所有 timer id / listener 引用都存下，切视频 / 禁用 /
   *    video 更换 / 标签页隐藏 / 暂停时彻底停循环、解绑，空闲零开销。
   *  - seek 防抖：拖动进度条停稳后才翻目标 clip。
   * ===================================================== */

  /** 注册监听器并记账，便于 teardown 统一解绑（杜绝泄漏） */
  function addListener(target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    state.listeners.push({ target: target, type: type, fn: fn, opts: opts });
  }

  function removeAllListeners() {
    for (var i = 0; i < state.listeners.length; i++) {
      var l = state.listeners[i];
      try {
        l.target.removeEventListener(l.type, l.fn, l.opts);
      } catch (e) {}
    }
    state.listeners = [];
  }

  /**
   * 启动渲染循环(幂等)。仅在启用 + 有字幕时跑。
   *
   * 双驱动,缺一不可:
   *  1) 帧回调(requestVideoFrameCallback,无则 rAF)—— 提供精度。字幕出现时刻
   *     必须跟随视频时间,而非一个与视频无关的定时器。原先仅 250ms setInterval
   *     使每条字幕平均晚 127ms、最坏晚 248ms(449 单元中 17.8% 晚于 200ms),
   *     且时长不足一个 tick 的短单元被整条跳过(实测 5 条 <250ms)。
   *  2) 定时器保底 —— 提供活性。rVFC **只在真正合成新视频帧时**触发:无媒体源、
   *     缓冲、暂停、隐藏标签页都不产帧,单靠它会完全停摆(CI headless replay
   *     即因此漏掉两个语义单元没画出来)。保底节拍确保任何情况下都在推进。
   *
   * 两者都调用同一个 onRenderTick,后者按 lastRenderedKey 去重,重复调用无副作用。
   * 低配机上帧回调随浏览器降帧自动降频,页面隐藏时浏览器暂停回调,占用不高于原方案。
   */
  function startRenderLoop() {
    if (state.renderTimer != null || state.renderFrameHandle != null) return;
    if (!config.enabled || !state.cues.length) return;

    // 保底节拍:始终存在,与帧回调并存(onRenderTick 幂等,不会重复画)
    state.renderTimer = setInterval(onRenderTick, RENDER_FALLBACK_INTERVAL_MS);

    var v = state.videoEl;
    if (v && typeof v.requestVideoFrameCallback === "function") {
      state.renderDriver = "vfc";
      var stepVfc = function () {
        state.renderFrameHandle = null;
        if (state.renderDriver !== "vfc") return;
        onRenderTick();
        var vid = state.videoEl;
        if (vid && typeof vid.requestVideoFrameCallback === "function") {
          state.renderFrameHandle = vid.requestVideoFrameCallback(stepVfc);
        }
      };
      state.renderFrameHandle = v.requestVideoFrameCallback(stepVfc);
      return;
    }

    if (typeof requestAnimationFrame === "function") {
      state.renderDriver = "raf";
      var stepRaf = function () {
        state.renderFrameHandle = null;
        if (state.renderDriver !== "raf") return;
        onRenderTick();
        state.renderFrameHandle = requestAnimationFrame(stepRaf);
      };
      state.renderFrameHandle = requestAnimationFrame(stepRaf);
      return;
    }

    state.renderDriver = "interval"; // 只有保底节拍
  }
  function stopRenderLoop() {
    var driver = state.renderDriver;
    var handle = state.renderFrameHandle;
    state.renderDriver = null;
    state.renderFrameHandle = null;
    if (handle != null) {
      try {
        if (driver === "vfc" && state.videoEl && typeof state.videoEl.cancelVideoFrameCallback === "function") {
          state.videoEl.cancelVideoFrameCallback(handle);
        } else if (driver === "raf" && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(handle);
        }
      } catch (e) {}
    }
    if (state.renderTimer != null) {
      clearInterval(state.renderTimer);
      state.renderTimer = null;
    }
  }

  /** 启动预取循环（幂等、低频，与渲染解耦） */
  function startPrefetchLoop() {
    if (state.prefetchTimer != null) return;
    if (!config.enabled || !state.clips.length) return;
    state.prefetchTimer = setInterval(function () {
      if (state.seeking) return; // 拖动中不预取（防抖统一在 seeked 后处理）
      prefetchAround(currentTimeMs(), false);
    }, PREFETCH_INTERVAL_MS);
  }
  function stopPrefetchLoop() {
    if (state.prefetchTimer != null) {
      clearInterval(state.prefetchTimer);
      state.prefetchTimer = null;
    }
  }

  /** 视频在播放且页面可见时才需要循环；否则停掉省占用 */
  function loopsShouldRun() {
    if (!config.enabled || !state.cues.length) return false;
    if (document.hidden) return false;
    var v = state.videoEl;
    if (!v) return false;
    return !v.paused && !v.ended;
  }

  /** 按当前状态决定起停循环（播放/暂停/可见性变化时调用） */
  function syncLoops() {
    if (loopsShouldRun()) {
      startRenderLoop();
      startPrefetchLoop();
    } else {
      stopRenderLoop();
      stopPrefetchLoop();
    }
  }

  /**
   * 绑定 video 的生命周期事件，建立单一渲染循环。
   * 每次调用先彻底 teardown 旧绑定（切 video / SPA 换视频时防泄漏）。
   */
  function bindVideo() {
    var v = videoEl();
    if (!v) return;
    // 同一 video 已绑定：只确保循环状态正确即可
    if (state.videoEl === v && state.listeners.length) {
      syncLoops();
      return;
    }
    // 换了 video（或首次）：清掉旧的一切
    teardownRuntime(false);
    state.videoEl = v;

    // 播放状态变化 → 起停循环（暂停/结束时零开销）
    addListener(v, "play", syncLoops);
    addListener(v, "playing", syncLoops);
    addListener(v, "pause", function () {
      onRenderTick(); // 暂停瞬间补刷一帧，保证停在正确字幕
      syncLoops();
    });
    addListener(v, "ended", function () {
      setRendererText("", "", false);
      syncLoops();
    });
    // seek：拖动进度条防抖，停稳后才翻目标 clip
    addListener(v, "seeking", onSeeking);
    addListener(v, "seeked", onSeeked);
    // 标签页切到后台 → 停循环；切回来恢复
    addListener(document, "visibilitychange", function () {
      syncLoops();
      if (!document.hidden) onRenderTick();
    });

    syncLoops();
    onRenderTick(); // 立即渲染一帧（暂停在某处加载时也能先显原文）
  }

  function onSeeking() {
    state.seeking = true;
    if (state.seekTimer != null) clearTimeout(state.seekTimer);
  }
  function onSeeked() {
    if (state.seekTimer != null) clearTimeout(state.seekTimer);
    // 停稳 SEEK_SETTLE_MS 后才认为 seek 结束，避免中间位置逐个触发翻译/预取
    state.seekTimer = setTimeout(function () {
      state.seeking = false;
      state.lastHitCueIdx = -1; // 跳转后命中下标失效，下次走二分
      prefetchAround(currentTimeMs(), true); // 立即翻目标位置所在 clip
      requestRender();
      syncLoops();
    }, SEEK_SETTLE_MS);
  }

  /** 强制下一帧重渲染（清缓存键），并在循环没跑时（暂停/隐藏）补刷一帧 */
  function requestRender() {
    lastRenderedKey = "";
    if (config.enabled && state.renderer) onRenderTick();
  }

  var lastRenderedKey = "";
  /**
   * 单一渲染 tick：找当前 cue，未变化则提前 return（idle 零工作）。
   * 不在这里做预取（预取已解耦到独立低频循环）。
   */
  function onRenderTick() {
    if (!config.enabled || !state.renderer || !state.renderUnits.length) return;
    if (state.seeking) return; // 拖动中不渲染，停稳后统一刷
    // 渲染器被播放器重建踢出 DOM（全屏/影院/SPA）→ 重挂（isConnected 是 O(1)）
    if (!state.renderer.isConnected) {
      ensureRenderer();
      lastRenderedKey = "";
    }
    var ms = currentTimeMs();

    // 二分 + 上次命中提示：在渲染时间轴(renderUnits)上查当前行，大多数相邻 tick O(1)
    var unitIdx = Core.findCueIndexAt(state.renderUnits, ms, state.lastHitCueIdx);

    if (unitIdx === -1) {
      // 落在间隙/越界：仅当之前有字幕时才清一次（避免每 tick 重复写 DOM）
      if (state.lastHitCueIdx !== -1 || lastRenderedKey !== "") {
        state.lastHitCueIdx = -1;
        setRendererText("", "", false);
        if (state.renderer) {
          delete state.renderer.dataset.unitId;
          delete state.renderer.dataset.tokenStart;
          delete state.renderer.dataset.tokenEnd;
          delete state.renderer.dataset.sourceFingerprint;
        }
        lastRenderedKey = "";
      }
      return;
    }
    state.lastHitCueIdx = unitIdx;

    var unit = state.renderUnits[unitIdx];
    var trans = unit.translation;
    // 原文与译文是两条独立时间轴：译文可自由合并/重分屏，原文始终按当前源 cue 显示。
    var sourceIdx = Core.findCueIndexAt(state.cues, ms, -1);
    var sourceText = sourceIdx >= 0 && state.cues[sourceIdx] ? String(state.cues[sourceIdx].content || "") : "";
    var st = state.clipState[unit.clipIdx];
    // 未翻好时的指示标记（纯函数，见 core.clipDisplayFlags，便于单测）：
    //  - 有译文 → 都 false。
    //  - 无译文 + failed(达 maxFails) → 显「翻译失败」。
    //  - 无译文 + 未结案(undefined=未翻 / pending=在翻) → 显「翻译中…」。
    //  - 无译文 + 已结案(done/error 但该行无译文=覆盖缺口/降级) → 优雅显原文，不再永久转圈(症状1)。
    // fallback 尚在等待完整语义边界，译文层保持空白；只有 semantic 走真实翻译状态。
    var flags = state.segmentationMode !== "fallback" ? Core.clipDisplayFlags(trans, st) : {
      failed: false,
      pending: false,
    };
    var failed = flags.failed;
    var pending = flags.pending;

    // 命中键：单元下标 + 译文 + 状态标记。键未变 → 不动 DOM（idle 零开销）
    var stTag = pending ? "p" : failed ? "f" : "";
    var key = unitIdx + ":" + sourceIdx + ":" + (trans || "") + ":" + stTag;
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    state.renderer.dataset.unitId = unit.unitId || "";
    state.renderer.dataset.tokenStart = String(unit.tokenStart);
    state.renderer.dataset.tokenEnd = String(unit.tokenEnd);
    state.renderer.dataset.sourceFingerprint = unit.sourceFingerprint || "";
    setRendererText(sourceText, trans, pending, failed);
  }

  /**
   * 写字幕文本。
   *  - orig/trans 为当前 cue 的原文/译文。
   *  - pending=true 且无译文时，按配置显示轻量"翻译中…"指示（不闪烁）。
   *  - failed=true 且无译文时，显示「翻译失败」标记（不静默当原文）。
   */
  function setRendererText(orig, trans, pending, failed) {
    var r = state.renderer;
    if (!r) return;
    // 原文行
    r._orig.textContent = config.showOriginal ? orig || "" : "";
    r._orig.classList.toggle("dualsub-hidden", !config.showOriginal || !orig);
    // 译文行：有译文显译文；翻译中显「翻译中…」；失败显「翻译失败」；否则留空
    if (trans) {
      r._trans.textContent = trans;
      r._trans.classList.remove("dualsub-hidden", "dualsub-pending", "dualsub-failed");
    } else if (pending && config.showLoading && orig) {
      r._trans.textContent = "翻译中…";
      r._trans.classList.remove("dualsub-hidden", "dualsub-failed");
      r._trans.classList.add("dualsub-pending");
    } else if (failed && config.showLoading && orig) {
      r._trans.textContent = "翻译失败";
      r._trans.classList.remove("dualsub-hidden", "dualsub-pending");
      r._trans.classList.add("dualsub-failed");
    } else {
      r._trans.textContent = "";
      r._trans.classList.add("dualsub-hidden");
      r._trans.classList.remove("dualsub-pending", "dualsub-failed");
    }
    updateNativeCaptionVisibility();
    fitSubtitleRows();
  }

  /**
   * 彻底清理运行时（定时器 + 监听器 + seek 防抖）。
   * full=true 时连 renderer 也移除（禁用扩展）；false 仅清循环/监听（换 video）。
   */
  function teardownRuntime(full) {
    clearWaitTimer();
    if (state.waitPausedByUs) {
      state.waitPausedByUs = false;
      var waitingVideo = videoEl();
      if (waitingVideo && waitingVideo.paused) {
        var resumePromise = waitingVideo.play();
        if (resumePromise && resumePromise.catch) resumePromise.catch(function () {});
      }
    }
    stopRenderLoop();
    stopPrefetchLoop();
    stopRetryScheduler();
    clearTrackRetryTimer();
    if (state.seekTimer != null) {
      clearTimeout(state.seekTimer);
      state.seekTimer = null;
    }
    removeAllListeners();
    state.seeking = false;
    state.videoEl = null;
    state.lastHitCueIdx = -1;
    if (full) {
      clearRenderer();
      restoreNativeCaptions();
      lastRenderedKey = "";
    }
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
        segmentationMode: state.segmentationMode,
        apiUsage: Object.assign({}, state.apiUsage),
      });
      return true;
    }

    if (msg.type === "set-config") {
      if (msg.config && msg.config.targetLang != null && !Core.normalizeTargetLang(msg.config.targetLang)) {
        sendResponse({ ok: false, error: "当前版本仅支持简体中文译文（zh-Hans）" });
        return true;
      }
      var prevSource = config.sourceLang;
      var prevEnabled = config.enabled;
      var prevModel = config.apiModel;
      var prevTarget = config.targetLang;
      var prevBase = config.apiBaseUrl;
      var prevKey = config.apiKey;
      var prevPrompt = config.systemPrompt;
      var prevReasoning = config.reasoningEffort;
      var prevMaxLineChars = config.maxLineChars;
      config = Core.migrateConfig(Object.assign({}, config, msg.config || {}));
      saveConfig();
      // 样式即时生效
      applyStyleVars();
      // 用户改了 API/语言/模型 → 视为手动重试：清退避，让停掉的 clip 能重翻
      var apiChanged =
        config.apiBaseUrl !== prevBase ||
        config.apiKey !== prevKey ||
        config.apiModel !== prevModel ||
        config.targetLang !== prevTarget ||
        config.systemPrompt !== prevPrompt ||
        config.reasoningEffort !== prevReasoning ||
        config.maxLineChars !== prevMaxLineChars;
      var translationIdentityChanged =
        config.apiBaseUrl !== prevBase ||
        config.apiModel !== prevModel ||
        config.targetLang !== prevTarget ||
        config.systemPrompt !== prevPrompt ||
        config.reasoningEffort !== prevReasoning ||
        config.maxLineChars !== prevMaxLineChars;
      if (apiChanged) {
        invalidateRuntimeRequests();
        state.clipBackoff = {};
        state.clipInflight = {};
        // model/语言变了，旧译文已不适用 → 丢内存缓存重翻（持久缓存按新 key 自然不命中）
        if (translationIdentityChanged) {
          state.clipUnits = {};
          state.renderUnits = [];
          state.clipState = {};
          if (state.timelineSnapshot) {
            state.timelineSnapshot = Core.createTimelineSnapshot({
              revision: state.timelineSnapshot.revision + 1,
              videoId: state.timelineSnapshot.videoId,
              trackCode: state.timelineSnapshot.trackCode,
              timeline: state.timelineSnapshot.timeline,
              units: state.timelineSnapshot.units,
            });
          }
        } else {
          // 仅 base/key 变：把 error/failed 态清掉以便重试，已成功的保留
          for (var ci in state.clipState) {
            if (state.clipState[ci] === "error" || state.clipState[ci] === "failed") state.clipState[ci] = undefined;
          }
        }
      }
      if (!config.enabled) {
        // 禁用先失效代际并主动取消，再拆循环/DOM；任何迟到 continuation 都无法提交。
        invalidateRuntimeRequests();
        state.timelineEpoch++;
                teardownRuntime(true);
      } else {
        ensureRenderer();
        // 源语言变了 → 重新选轨并重载
        if (config.sourceLang !== prevSource || !prevEnabled) {
          var track = pickTrack(state.tracks, config.sourceLang);
          if (track) {
            switchTrack(track); // 单一 transition：先取消旧轨，再加载新轨
          } else {
            // 没轨道也要把循环按当前状态接起来
            bindVideo();
          }
        } else if (apiChanged || !prevEnabled) {
          // 配置变了但轨道没变：重绑循环、立即按当前播放位置重新预取并刷新
          bindVideo();
          prefetchAround(currentTimeMs(), true);
          requestRender();
        } else {
          // 仅样式/显示项变化：刷新一帧即可
          requestRender();
        }
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "prepare-full-srt") {
      if (msg.confirmed !== true) {
        sendResponse({ ok: false, error: "需要明确确认全轨翻译费用" });
        return true;
      }
      if (!config.enabled || !state.clips.length || !config.apiBaseUrl || !config.apiModel) {
        sendResponse({ ok: false, error: "当前轨道或翻译配置尚未就绪" });
        return true;
      }
      var startedJob = startFullSrtPreparation();
      sendResponse(Object.assign({ ok: true }, fullSrtStatus(), { id: startedJob.id }));
      return true;
    }

    if (msg.type === "cancel-full-srt") {
      if (state.srtJob && state.srtJob.status === "running") {
        state.srtJob.cancelRequested = true;
        state.srtJob.status = "cancelling";
      }
      sendResponse(Object.assign({ ok: true }, fullSrtStatus()));
      return true;
    }

    if (msg.type === "full-srt-status") {
      sendResponse(Object.assign({ ok: true }, fullSrtStatus()));
      return true;
    }

    if (msg.type === "export-srt") {
      // popup 请求导出当前视频双语 SRT：返回已翻译的渲染单元（clip 渲染单元优先、原文兜底）+ 元信息。
      // 时间轴重建一次确保最新；renderUnits 内部用 start/end，转成 startMs/endMs 供 Core.buildSrt。
      rebuildRenderTimeline();
      var exportSnapshot = state.timelineSnapshot;
      var realUnits = state.renderUnits.filter(function (u) {
        return u && String(u.originalText || "").trim() !== "";
      });
      var allTranslated = realUnits.length > 0 && realUnits.every(function (u) {
        return String(u.translation || "").trim() !== "";
      });
      sendResponse({
        ok: allTranslated,
        videoId: state.videoId,
        targetLang: config.targetLang,
        sourceFingerprint: exportSnapshot ? exportSnapshot.sourceFingerprint : "",
        snapshotRevision: state.timelineEpoch,
        missingUnits: realUnits.filter(function (u) { return !String(u.translation || "").trim(); }).length,
        preparation: fullSrtStatus(),
        units: state.renderUnits.map(function (u) {
          return {
            unitId: u.unitId,
            tokenStart: u.tokenStart,
            tokenEnd: u.tokenEnd,
            startMs: u.start,
            endMs: u.end,
            originalText: u.originalText,
            translation: u.translation,
          };
        }),
      });
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
      var connectionUsage = null;
      var result = await Core.translateContextBlock({
        cues: [{ start: 0, end: 1200, content: "hello world" }],
        apiBaseUrl: cfg.apiBaseUrl,
        apiKey: cfg.apiKey,
        apiModel: cfg.apiModel,
        targetLang: cfg.targetLang || "zh-Hans",
        systemPrompt: cfg.systemPrompt,
        reasoningEffort: cfg.reasoningEffort,
        onUsage: function (usage) { connectionUsage = usage; },
      });
      return { ok: true, sample: result.units && result.units[0] ? result.units[0].translation : "(空响应)", usage: connectionUsage };
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

