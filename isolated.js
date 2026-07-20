/*
 * isolated.js — 运行在 world: "ISOLATED"（扩展沙箱）
 * =============================================================
 * 职责：
 *  1. 接收 main.js 推来的字幕轨道清单（RPC）。
 *  2. 拉取并解析字幕（json3 / vtt），清洗时间轴。
 *  3. 调用用户配置的 OpenAI 兼容翻译 API：每个 clip 一次 translateClipLines（模型一步到位
 *     直接吐自然分行的中文字幕行）→ buildClipUnits 配时间轴；预取 + 缓存 + 失败退避重试。
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

  // 跨 clip 的全局 in-flight 翻译请求上限（每个内容脚本实例一个信号量）。
  // 滑动窗口预取(planPrefetch)会让当前/下一个/下下个… clip 几乎同时各发起一次
  // translateClipLines（v0.4.0：一个 clip = 一次请求）。若不封顶，瞬时并发可达窗口深度
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
    cues: [], // 最终原文 cue（优先严格词流语义恢复，否则稳定回退 resegmentCues）
    segmentationMode: "fallback", // 'semantic' | 'fallback'，用于缓存隔离与可观测性
    timelineEpoch: 0, // 每次整轨切换递增，拒绝旧异步翻译结果写入新分段
    clips: [], // 按 cue 边界切的 clip
    cueMap: [], // 全局 cue 下标 -> {clipIdx,cueIdx}（cueClipIndexMap 建表）
    // v0.4.0：每个 clip 一次 translateClipLines → buildClipUnits 得到渲染单元，按 clip 存这里。
    // 单元结构 [{srcStart,srcEnd,originalText,translation,startMs,endMs}]（buildClipUnits 产物）。
    // 统一了旧的 clipCache(逐行)/clipSentences(句级) 两套语义 —— 新架构只有这一种。
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
    renderTimer: null, // 单一节流渲染定时器 id
    prefetchTimer: null, // 预取定时器 id（与渲染解耦、降频）
    seekTimer: null, // seek 防抖定时器 id
    listeners: [], // 已绑定的监听器 [{target,type,fn}]，teardown 时统一解绑
    lastHitCueIdx: -1, // 上次命中的全局 cue 下标（findCueIndexAt 的 O(1) 提示）
    lastPrefetchMs: -1e9, // 上次 prefetch 的播放位置（节流）
    seeking: false, // 进度条拖动中（防抖期间不渲染/不预取目标外位置）
    waitPausedByUs: false,
    waitTimer: null,
    firstClipReady: false,
  };

  // 渲染/预取节拍（ms）。渲染 250ms 人眼无感；预取 1s 一次（比渲染低频，但比旧 1.5s 更跟手），与渲染解耦。
  var RENDER_INTERVAL_MS = 250;
  var PREFETCH_INTERVAL_MS = 1000;
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
  async function restoreSemanticCuesIfAvailable(cues) {
    if (!config.apiBaseUrl || !config.apiKey || !config.apiModel) return null;
    if (!Core.hasNativeTokenTiming(cues, 0.8)) return null;
    var tokens = Core.collectSemanticTokens(cues);
    if (!tokens.length) return null;
    try {
      var restored = await Core.restoreAndPackTokens({
        tokens: tokens,
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        reasoningEffort: config.reasoningEffort,
        chunkWords: 120,
        overlapWords: 30,
        preferredMaxWords: 16,
        maxWords: 20,
        attempts: 2,
        timeoutMs: 20000,
        fetchImpl: function (u, o) { return fetch(u, o); },
      });
      return restored && restored.length ? Core.cleanupCues(restored) : null;
    } catch (e) {
      console.warn("[dualsub] 语义恢复未通过词流契约，回退 ASR 重组：", e && e.message);
      return null;
    }
  }

  function clipCueFingerprint(clip) {
    return (clip && clip.cues || []).map(function (cue) {
      return [cue.start, cue.end, String(cue.content || "").replace(/\s+/g, " ").trim()].join(":");
    }).join("~");
  }

  function clipCacheKey(clip) {
    return Core.makeCacheKey({
      videoId: state.videoId,
      trackCode: state.activeTrack ? state.activeTrack.code : "",
      targetLang: config.targetLang,
      apiModel: config.apiModel,
      segmentationMode: state.segmentationMode,
      clipStartMs: clip.startMs,
      cueFingerprint: clipCueFingerprint(clip),
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

  /** 把某 clip 的译文写进持久缓存（仅在翻译成功时调用）。
   *  payload 为 { lines: string[] }（模型直接吐的自然中文字幕行；命中后重跑 buildClipUnits 配时间轴）。 */
  function writeCache(key, payload) {
    readCache().then(function (cacheObj) {
      cacheObj[key] = Object.assign({ t: Date.now() }, payload);
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
    state.activeTrack = track;
    loadTrack(track);
  }

  function resetForNewVideo() {
    state.timelineEpoch++;
    state.activeTrack = null;
    state.cues = [];
    state.clips = [];
    state.cueMap = [];
    state.clipUnits = {};
    state.renderUnits = [];
    state.clipState = {};
    state.clipInflight = {};
    state.lastHitCueIdx = -1;
    state.lastPrefetchMs = -1e9;
    clearRenderer();
  }

  /**
   * 选轨道：
   *  - sourceLang === "auto"：优先非中文 ASR → 任意非中文轨 → 再退回第一条 ASR/第一条。
   *  - 否则按 languageCode / code 精确或前缀匹配。
   *  - skipChineseSource 时：若最终选中轨是中文，返回 null（调用方跳过本视频）。
   */
  function isAsrTrack(t) {
    return t && (/-asr$/.test(t.code) || t.kind === "asr");
  }
  function isChineseTrack(t) {
    return !!(t && Core.shouldSkipChineseSource(t, {
      skipChineseSource: true, // 只复用语言判定
      sourceLang: "auto",
    }));
  }
  function pickTrack(tracks, sourceLang) {
    if (!tracks || !tracks.length) return null;
    var list = tracks;
    var picked = null;
    if (!sourceLang || sourceLang === "auto") {
      var nonZhAsr = list.find(function (t) { return isAsrTrack(t) && !isChineseTrack(t); });
      var nonZhAny = list.find(function (t) { return !isChineseTrack(t); });
      var anyAsr = list.find(isAsrTrack);
      picked = nonZhAsr || nonZhAny || anyAsr || list[0];
    } else {
      var exact = list.find(function (t) {
        return t.code === sourceLang || t.languageCode === sourceLang;
      });
      var prefix = list.find(function (t) {
        return (t.languageCode || "").split("-")[0] === sourceLang.split("-")[0];
      });
      picked = exact || prefix || list[0];
    }
    if (
      picked &&
      Core.shouldSkipChineseSource(picked, {
        skipChineseSource: config.skipChineseSource,
        sourceLang: sourceLang || config.sourceLang,
      })
    ) {
      return null;
    }
    return picked;
  }

  /* =====================================================
   * 拉取 + 解析 + 切 clip
   * ===================================================== */
  async function loadTrack(track) {
    state.firstClipReady = false;
    state.waitPausedByUs = false;
    clearWaitTimer();
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
      // 先立即建立稳定 fallback 原文时间轴；技术 cue 不翻译。语义恢复是整轨模型工作，不能阻塞首字幕。
      var fallbackCues = Core.resegmentCues(cues, { tailTrimMs: config.tailTrimMs });
      if (!installCueTimeline(fallbackCues, "fallback")) {
        console.warn("[dualsub] 解析后无有效字幕");
        return;
      }
      // 完整验证成功后才原子切换到语义时间轴；失败保持已工作的 fallback。
      var loadEpoch = state.timelineEpoch;
      setTimeout(function () {
        restoreSemanticCuesIfAvailable(cues).then(function (semanticCues) {
          if (loadEpoch !== state.timelineEpoch || !semanticCues || !semanticCues.length) return;
          return stageSemanticTimeline(Core.applyTailTrim(semanticCues, config.tailTrimMs), loadEpoch);
        }).catch(function (e) {
          // The fallback timeline is already active; unexpected semantic errors are non-fatal.
          console.warn("[dualsub] semantic restore failed; keeping fallback timeline", e);
        });
      }, 0);
    } catch (e) {
      console.warn("[dualsub] loadTrack 出错", e);
    }
  }

  function sliceTimelineClips(cues) {
    var firstSec = Number(config.firstClipSeconds);
    if (!Number.isFinite(firstSec) || firstSec <= 0) firstSec = config.clipSeconds;
    return Core.sliceClipsByCue(cues, config.clipSeconds * 1000, {
      firstTargetMs: firstSec * 1000,
      maxCuesPerClip: config.maxCuesPerClip || 0,
      maxSourceChars: config.maxSourceCharsPerClip || 0,
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

  function translatePreparedClip(clip) {
    return ensureGate().run(function () {
      return Core.translateClipWithBoundaryRepair({
        cues: clip.cues,
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        targetLang: config.targetLang,
        systemPrompt: config.systemPrompt || "",
        reasoningEffort: config.reasoningEffort,
        maxLineChars: config.maxLineChars,
        timeoutMs: 20000,
        fetchImpl: function (u, o) { return fetch(u, o); },
      });
    });
  }

  // Keep the working fallback visible while translating the semantic clip at the current playhead.
  // Revalidate after every await: playback or a seek may move to another clip while the request is queued.
  // Only install when the clip on screen has a ready translation, so semantic takeover cannot regress to
  // "翻译中…" or blank Chinese. Three attempts bound extra work under adversarial repeated seeks.
  async function stageSemanticTimeline(cues, loadEpoch) {
    if (!cues || !cues.length || loadEpoch !== state.timelineEpoch) return false;
    var clips = sliceTimelineClips(cues);
    if (!clips.length) return false;
    var seeds = {};
    for (var attempt = 0; attempt < 3; attempt++) {
      var currentIdx = clipIdxAtIn(clips, currentTimeMs());
      if (currentIdx < 0) return false;
      if (!seeds[currentIdx]) {
        var translated = await translatePreparedClip(clips[currentIdx]);
        if (loadEpoch !== state.timelineEpoch || !translated || !translated.lines || !translated.lines.length) return false;
        if (translated.repaired) clips[currentIdx].cues = translated.cues;
        seeds[currentIdx] = translated.lines;
      }
      var installIdx = clipIdxAtIn(clips, currentTimeMs());
      if (installIdx === currentIdx && seeds[installIdx]) {
        var installedCues = [];
        for (var ci = 0; ci < clips.length; ci++) installedCues = installedCues.concat(clips[ci].cues || []);
        return installCueTimeline(installedCues, "semantic", { clips: clips, seeds: seeds });
      }
    }
    return false;
  }

  // 仅在完整 cue 集合准备好时切换。递增 epoch 使旧分段的翻译请求自然失效。
  function installCueTimeline(cues, mode, prepared) {
    if (!cues || !cues.length) return false;
    state.timelineEpoch++;
    // fallback 已经给用户可播放首屏；后台语义切换绝不再次暂停视频等翻译。
    if (mode === "semantic") state.firstClipReady = true;
    state.segmentationMode = mode;
    state.cues = cues;
    state.clips = prepared && prepared.clips ? prepared.clips : sliceTimelineClips(cues);
    state.cueMap = Core.cueClipIndexMap(state.clips);
    state.clipUnits = {};
    state.renderUnits = [];
    state.clipState = {};
    state.clipBackoff = {};
    state.clipInflight = {};
    if (prepared && prepared.seeds) {
      for (var preparedIdx in prepared.seeds) {
        var seedIdx = parseInt(preparedIdx, 10);
        var seedLines = prepared.seeds[preparedIdx];
        var seedClip = state.clips[seedIdx];
        if (!seedClip || !seedLines || !seedLines.length) continue;
        state.clipUnits[seedIdx] = Core.buildClipUnits(
          seedLines,
          seedClip.startMs,
          seedClip.endMs,
          seedClip.cues
        );
        state.clipState[seedIdx] = "done";
      }
    }
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
   * semantic 模式：一个 clip = 一次 translateClipLines，按完整语义单元编号 1:1 返回；fallback 不进入翻译。
   */

  function clearWaitTimer() {
    if (state.waitTimer != null) { clearTimeout(state.waitTimer); state.waitTimer = null; }
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
      var ms = Number(config.waitForFirstTranslationMs);
      if (!Number.isFinite(ms) || ms <= 0) ms = 8000;
      state.waitTimer = setTimeout(function () {
        state.waitTimer = null;
        state.firstClipReady = true;
        if (state.waitPausedByUs) {
          state.waitPausedByUs = false;
          var vv = videoEl();
          if (vv && vv.paused) { var p = vv.play(); if (p && p.catch) p.catch(function () {}); }
        }
        requestRender();
      }, ms);
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
    // fallback 只保证原文立即可见；技术 cue 不得送翻译，否则会生成六字左右的碎中文。
    // semantic 当前 clip 由 stageSemanticTimeline 直接预热，接管后才启用常规预取。
    if (state.segmentationMode !== "semantic") return;
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
    var plan = Core.planPrefetch(idx, state.clips.length, undefined, {
      remainMsInCurrent: remainMsInCurrent,
    });
    // 当前 clip 必须排队首：先抢信号量/网关，避免与预取段并行抢跑拖慢首包。
    plan = Core.prioritizePrefetch(plan, idx);
    // force（刚加载/seek）时：先只踢当前段，下一 macrotask 再铺后续预取，
    // 让首包请求更早离开浏览器、更少与同批预取抢模型算力。
    if (force && plan.length > 1) {
      translateClip(plan[0]);
      var rest = plan.slice(1);
      setTimeout(function () {
        for (var j = 0; j < rest.length; j++) translateClip(rest[j]);
      }, 0);
    } else {
      for (var i = 0; i < plan.length; i++) {
        translateClip(plan[i]);
      }
    }
  }

  function getBackoff(idx) {
    // maxFails 6 / base 2s / max 30s：失败 clip 由后台调度器(startRetryScheduler)按此退避反复重翻，
    // 达 maxFails 才真正放弃(clipState=failed 终态，UI 可见标「翻译失败」)。
    if (!state.clipBackoff[idx]) state.clipBackoff[idx] = Core.makeBackoff({ maxFails: 6, baseMs: 2000, maxMs: 30000 });
    return state.clipBackoff[idx];
  }

  async function translateClip(idx) {
    var timelineEpoch = state.timelineEpoch;
    var clip = state.clips[idx];
    if (!clip) return;
    if (state.clipState[idx] === "done") return;
    if (state.clipState[idx] === "failed") return; // 达 maxFails 的终态，不再自动重试
    // 重入互斥：同一 clip 不并发跑两个 translateClip。clipInflight 是唯一的互斥源；
    // 不再用 clipState==="pending" 当门禁——否则一旦某次跑动抛在 applyClipLines
    // （pending 已置但 done/error 未写）就永久卡 pending，retryTick 只重试 error 永远救不回来
    // → UI 永久「翻译中…」(症状1根因)。改由下方 finally 兜底把残留 pending 降级为 error 可重试。
    if (state.clipInflight[idx]) return;

    // 没配置 API：不翻，只显示原文（非瞬态错误，不进重试调度）
    if (!config.apiBaseUrl || !config.apiModel) {
      state.clipState[idx] = "error";
      return;
    }
    // 失败退避：未到下次允许时间就跳过（由后台调度器到点再来）
    var backoff = getBackoff(idx);
    if (!backoff.shouldTry()) return;

    state.clipInflight[idx] = true;
    try {
      // 先查持久缓存：命中直接用，零 API 调用。缓存存的是模型吐的自然中文行(lines)，
      // 命中后重跑 buildClipUnits 按当前 clip 时间窗配时间轴（时间轴不入缓存，避免跨会话漂移）。
      var key = clipCacheKey(clip);
      var cached = await readCache();
      if (timelineEpoch !== state.timelineEpoch) return;
      if (cached[key] && Array.isArray(cached[key].lines)) {
        if (Array.isArray(cached[key].cues) && cached[key].cues.length === cached[key].lines.length) {
          clip.cues = cached[key].cues;
        }
        state.clipUnits[idx] = Core.buildClipUnits(
          cached[key].lines,
          clip.startMs,
          clip.endMs,
          clip.cues
        );
        state.clipState[idx] = "done";
        if (idx === 0) maybeResumeAfterFirstTranslation(0);
        backoff.reset();
        rebuildRenderTimeline();
        requestRender();
        return;
      }

      state.clipState[idx] = "pending";
      if (idx === 0) maybePauseForFirstTranslation(0);

      // 主路径（v0.4.0）：一次 translateClipLines，模型直接吐「自然分行的中文字幕行」。
      // 代码只用 buildClipUnits 按字符占比配时间轴，绝不切译文（切词 bug 根治）。
      var translationResult;
      try {
        translationResult = await ensureGate().run(function () {
          return Core.translateClipWithBoundaryRepair({
            cues: clip.cues,
            apiBaseUrl: config.apiBaseUrl,
            apiKey: config.apiKey,
            apiModel: config.apiModel,
            targetLang: config.targetLang,
            systemPrompt: config.systemPrompt || "",
            reasoningEffort: config.reasoningEffort,
            maxLineChars: config.maxLineChars,
            timeoutMs: 20000,
            fetchImpl: function (u, o) {
              return fetch(u, o);
            },
          });
        });
      } catch (e) {
        // 翻译调用失败（网络/超时/HTTP）→ 回报 gate 降并发 + 退避，交后台调度器重试。
        ensureGate().reportError(Core.errorKind(e));
        console.warn("[dualsub] clip", idx, "翻译调用失败：", e && e.message, "→ 退避重试");
        state.clipState[idx] = "error";
        backoff.fail();
        ensureRetryScheduler();
        return;
      }

      if (timelineEpoch !== state.timelineEpoch) return;
      if (translationResult && translationResult.repaired) {
        // 缓存仍写入本次请求的输入 key；下次以同一原始 cue 查询即可命中，
        // value 内携带回修后的 cues，命中后原子恢复同批时间轴。
        clip.cues = translationResult.cues;
      }
      applyClipLines(idx, clip, key, translationResult ? translationResult.lines : []);
    } catch (e) {
      if (timelineEpoch !== state.timelineEpoch) return;
      // applyClipLines / readCache / rebuildRenderTimeline 等意外抛出：绝不让 clip 卡死。
      // 降级为 error + 退避，交后台调度器重试（达 maxFails 才 failed），不再永久 pending。
      console.warn("[dualsub] clip", idx, "translateClip 意外异常 → 降级 error 重试：", e && e.message);
      state.clipState[idx] = "error";
      getBackoff(idx).fail();
      ensureRetryScheduler();
    } finally {
      if (timelineEpoch !== state.timelineEpoch) return;
      state.clipInflight[idx] = false;
      // 兜底：跑完后仍残留 pending（任何路径漏写终态）→ 当作可重试 error，杜绝永久「翻译中…」。
      if (state.clipState[idx] === "pending") {
        state.clipState[idx] = "error";
        getBackoff(idx).fail();
        ensureRetryScheduler();
      }
    }
  }

  /**
   * 处理 translateClipLines 的产出（v0.4.0 主路径收尾）。
   *  - lines 非空：buildClipUnits 按字符占比配时间轴 → 存 clipUnits[idx] → done + 写缓存(lines)。
   *  - lines 空（模型空响应）：不算硬失败但也没内容 → error + 退避，交后台调度器重试；
   *    渲染层此时对该 clip 回退显原文（rebuildRenderTimeline 用 cue 铺空译文单元）。
   * 不再有「部分接受 / 缺口逐行补翻」—— 模型一步到位直接分行，代码只配时间轴。
   */
  function applyClipLines(idx, clip, key, lines) {
    var backoff = getBackoff(idx);
    if (lines && lines.length) {
      state.clipUnits[idx] = Core.buildClipUnits(lines, clip.startMs, clip.endMs, clip.cues);
      state.clipState[idx] = "done";
      if (idx === 0) maybeResumeAfterFirstTranslation(0);
      backoff.reset();
      writeCache(key, { lines: lines, cues: clip.cues });
      rebuildRenderTimeline();
      requestRender();
    } else {
      // 模型空响应：无译文 → 退避重试（不写缓存，避免把空结果固化）。
      console.warn("[dualsub] clip", idx, "模型空响应（无字幕行）→ 退避重试");
      delete state.clipUnits[idx];
      state.clipState[idx] = "error";
      backoff.fail();
      rebuildRenderTimeline();
      requestRender();
      ensureRetryScheduler();
    }
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
   *  - 已翻好(clipUnits[idx]) → 直接用其渲染单元（buildClipUnits 已配好时间轴 + 就近归并原文 + 译文）；
   *  - 未翻好 → 逐条 cue 铺一个单元，原文用 cue.content、译文留空（未到时显原文 / 转「翻译中…」）。
   * 产出按 start 升序的单元数组，渲染 tick 用 findCueIndexAt 在其上二分查当前行。
   * 每个单元：{ start, end, originalText, translation, clipIdx }。
   */
  function rebuildRenderTimeline() {
    var units = [];
    for (var ci = 0; ci < state.clips.length; ci++) {
      var clipUnits = state.clipUnits[ci];
      if (clipUnits && clipUnits.length) {
        for (var s = 0; s < clipUnits.length; s++) {
          var u = clipUnits[s];
          units.push({
            start: u.startMs,
            end: u.endMs,
            originalText: u.originalText,
            translation: u.translation != null && u.translation !== "" ? u.translation : null,
            clipIdx: ci,
          });
        }
        continue;
      }
      // 原文兜底：clip 的每条 cue 一个单元，原文用 cue.content，译文留空（未翻/翻译中/失败）。
      var clip = state.clips[ci];
      for (var k = 0; k < clip.cues.length; k++) {
        var cue = clip.cues[k];
        units.push({
          start: cue.start,
          end: cue.end,
          originalText: cue.content,
          translation: null,
          clipIdx: ci,
        });
      }
    }
    state.renderUnits = units;
    // 时间轴重建后旧的命中下标失效（单元数/边界变了）
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
      // 保持两行和字形比例：超宽时等比缩小该行字号；0.72 是可读底线，低于则显式标记溢出。
      var scale = natural > available ? Math.max(0.72, available / natural) : 1;
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

  /** 启动渲染循环（幂等）。仅在启用 + 有字幕时跑 */
  function startRenderLoop() {
    if (state.renderTimer != null) return;
    if (!config.enabled || !state.cues.length) return;
    state.renderTimer = setInterval(onRenderTick, RENDER_INTERVAL_MS);
  }
  function stopRenderLoop() {
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
        lastRenderedKey = "";
      }
      return;
    }
    state.lastHitCueIdx = unitIdx;

    var unit = state.renderUnits[unitIdx];
    var trans = unit.translation;
    var st = state.clipState[unit.clipIdx];
    // 未翻好时的指示标记（纯函数，见 core.clipDisplayFlags，便于单测）：
    //  - 有译文 → 都 false。
    //  - 无译文 + failed(达 maxFails) → 显「翻译失败」。
    //  - 无译文 + 未结案(undefined=未翻 / pending=在翻) → 显「翻译中…」。
    //  - 无译文 + 已结案(done/error 但该行无译文=覆盖缺口/降级) → 优雅显原文，不再永久转圈(症状1)。
    // fallback 技术 cue 从不翻译，因此译文层必须保持空白，不得误显示「翻译中…」。
    var flags = state.segmentationMode === "semantic" ? Core.clipDisplayFlags(trans, st) : {
      failed: false,
      pending: false,
    };
    var failed = flags.failed;
    var pending = flags.pending;

    // 命中键：单元下标 + 译文 + 状态标记。键未变 → 不动 DOM（idle 零开销）
    var stTag = pending ? "p" : failed ? "f" : "";
    var key = unitIdx + ":" + (trans || "") + ":" + stTag;
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    setRendererText(unit.originalText, trans, pending, failed);
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
        state.clipInflight = {};
        // model/语言变了，旧译文已不适用 → 丢内存缓存重翻（持久缓存按新 key 自然不命中）
        if (config.apiModel !== prevModel || config.targetLang !== prevTarget) {
          state.clipUnits = {};
          state.renderUnits = [];
          state.clipState = {};
        } else {
          // 仅 base/key 变：把 error/failed 态清掉以便重试，已成功的保留
          for (var ci in state.clipState) {
            if (state.clipState[ci] === "error" || state.clipState[ci] === "failed") state.clipState[ci] = undefined;
          }
        }
      }
      if (!config.enabled) {
        // 禁用：彻底停掉所有循环 + 解绑监听 + 移除渲染器（空闲零开销）
        teardownRuntime(true);
      } else {
        ensureRenderer();
        // 源语言变了 → 重新选轨并重载
        if (config.sourceLang !== prevSource || !prevEnabled) {
          var track = pickTrack(state.tracks, config.sourceLang);
          if (track) {
            state.activeTrack = track;
            state.clipUnits = {};
            state.renderUnits = [];
            state.clipState = {};
            state.clipBackoff = {};
            state.clipInflight = {};
            loadTrack(track); // 内部会 bindVideo + 起循环 + 预取
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

    if (msg.type === "export-srt") {
      // popup 请求导出当前视频双语 SRT：返回已翻译的渲染单元（clip 渲染单元优先、原文兜底）+ 元信息。
      // 时间轴重建一次确保最新；renderUnits 内部用 start/end，转成 startMs/endMs 供 Core.buildSrt。
      rebuildRenderTimeline();
      var hasTrans = state.renderUnits.some(function (u) {
        return u.translation != null && String(u.translation).trim() !== "";
      });
      sendResponse({
        ok: state.renderUnits.length > 0 && hasTrans,
        videoId: state.videoId,
        targetLang: config.targetLang,
        units: state.renderUnits.map(function (u) {
          return {
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
      var lines = await Core.translateClipLines({
        cues: [{ content: "hello world" }],
        apiBaseUrl: cfg.apiBaseUrl,
        apiKey: cfg.apiKey,
        apiModel: cfg.apiModel,
        targetLang: cfg.targetLang || "zh-Hans",
        systemPrompt: cfg.systemPrompt,
        reasoningEffort: cfg.reasoningEffort,
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

