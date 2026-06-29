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

  // 跨 clip 的全局 in-flight 翻译请求上限（每个内容脚本实例一个信号量）。
  // 滑动窗口预取(planPrefetch depth=2)会让当前/下一个/下下个 clip 几乎同时发起翻译，
  // 每个 clip 内部又有 concurrency=3 的批内并发。若不封顶，瞬时并发可达 ~9 → 网关 429
  // → 退避 → 反而更卡。这里把所有 clip 的所有批请求收敛到一个全局上限下排队，
  // 在 cap 内仍尽量保持最大领先，但绝不冲垮网关。可被 config.globalConcurrency 覆盖。
  var GLOBAL_INFLIGHT_DEFAULT = 4;
  var globalGate = Core.makeSemaphore(GLOBAL_INFLIGHT_DEFAULT);

  /** 按配置（重）建全局信号量；并发数变了才换，避免丢弃在途令牌 */
  function ensureGate() {
    var want = parseInt(config.globalConcurrency, 10);
    if (!Number.isFinite(want) || want < 1) want = GLOBAL_INFLIGHT_DEFAULT;
    if (!globalGate || globalGate.max !== want) {
      globalGate = Core.makeSemaphore(want);
    }
    return globalGate;
  }

  var config = Object.assign({}, DEFAULT_CONFIG);

  // ---- 运行状态 ----
  var state = {
    videoId: null,
    tracks: [], // main.js 推来的轨道清单
    activeTrack: null, // 当前选中的轨道
    cues: [], // 清洗 + 启发式重组后的原文 cue（全局，按 start 升序）—— 句级重断失败时的兜底分段器产物
    clips: [], // 按 cue 边界切的 clip
    cueMap: [], // 全局 cue 下标 -> {clipIdx,cueIdx}（cueClipIndexMap 建表）
    clipCache: {}, // clipIndex -> translated string[]（逐行兜底路径：与该 clip cues 等长，可含空洞）
    clipSentences: {}, // clipIndex -> 句级重断结果 [{startMs,endMs,originalText,translation}]（主路径，成功才有）
    renderUnits: [], // 全局渲染时间轴（句级优先、逐行兜底），按 start 升序。findCueIndexAt 在此上查当前句
    clipState: {}, // clipIndex -> 'pending'|'done'|'error'
    clipBackoff: {}, // clipIndex -> backoff 控制器（失败退避）
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
  };

  // 渲染/预取节拍（ms）。渲染 250ms 人眼无感；预取 1s 一次（比渲染低频，但比旧 1.5s 更跟手），与渲染解耦。
  var RENDER_INTERVAL_MS = 250;
  var PREFETCH_INTERVAL_MS = 1000;
  var SEEK_SETTLE_MS = 350; // seek 停稳多少 ms 后才翻目标 clip

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

  /** 把某 clip 的整段译文写进持久缓存（仅在全部翻完时调用）。
   *  payload 为 { sent: [...] }（句级）或 { lines: [...] }（逐行兜底）。 */
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
    state.cueMap = [];
    state.clipCache = {};
    state.clipSentences = {};
    state.renderUnits = [];
    state.clipState = {};
    state.lastHitCueIdx = -1;
    state.lastPrefetchMs = -1e9;
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
      // 建全局 cue→clip 映射表，渲染时 O(1) 反查所属 clip
      state.cueMap = Core.cueClipIndexMap(state.clips);
      state.clipCache = {};
      state.clipSentences = {};
      state.renderUnits = [];
      state.clipState = {};
      state.clipBackoff = {};
      state.lastHitCueIdx = -1;
      // 先用 resegment 分段铺一条「原文时间轴」(译文留空)，译文未到也能立刻显原文；
      // 句级重断成功后由 rebuildRenderTimeline 用合并句替换对应 clip 的单元。
      rebuildRenderTimeline();
      ensureRenderer();
      bindVideo();
      // 立即预取当前播放位置所在的 clip
      prefetchAround(currentTimeMs(), true);
      requestRender();
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
   * 预取策略（带节流）：进入某 clip 立即翻当前 clip + 滑动窗口预取后续若干 clip。
   * force=true 时跳过节流（拖动进度条 / 刚加载）。
   * 用 Core.planPrefetch 算出 [idx, idx+1, idx+2]（depth=2，已裁越界）；每个下标各自
   * 独立发起 translateClip——"下下个"不被"下一个还 pending"阻塞。更深的窗口由全局信号量
   * (ensureGate)封顶，避免多 clip × 批内并发叠加冲垮网关。
   * 已翻 / 正在翻 / 退避中的 clip 由 translateClip 内部跳过。
   */
  function prefetchAround(ms, force) {
    if (!config.enabled || !state.clips.length) return;
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

    // 滑动窗口下标列表（含当前段）。当前段用首句优先起点，后续段从头翻。
    var plan = Core.planPrefetch(idx, state.clips.length, undefined, {
      remainMsInCurrent: remainMsInCurrent,
    });
    for (var i = 0; i < plan.length; i++) {
      var ci = plan[i];
      translateClip(ci, ci === idx ? priorityCueIndex(idx, ms) : 0);
    }
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

    // 先查持久缓存：命中直接用，零 API 调用。
    // 缓存可能是句级（sent）或逐行兜底（lines）两种形态，按存的形态恢复。
    var key = clipCacheKey(clip);
    var cached = await readCache();
    if (cached[key]) {
      if (Array.isArray(cached[key].sent)) {
        state.clipSentences[idx] = cached[key].sent.slice();
        state.clipState[idx] = "done";
        rebuildRenderTimeline();
        requestRender();
        return;
      }
      if (Array.isArray(cached[key].lines)) {
        state.clipCache[idx] = cached[key].lines.slice();
        state.clipState[idx] = "done";
        rebuildRenderTimeline();
        requestRender(); // 命中缓存：强制刷新把译文显示上去
        return;
      }
    }

    state.clipState[idx] = "pending";

    // ① 主路径：句级语义重断（一次调用同时重组断句 + 翻译），覆盖性校验通过即用。
    try {
      var res = await ensureGate().run(function () {
        return Core.translateSentences({
          cues: clip.cues,
          apiBaseUrl: config.apiBaseUrl,
          apiKey: config.apiKey,
          apiModel: config.apiModel,
          targetLang: config.targetLang,
          systemPrompt: config.sentencePrompt || "", // 句级 prompt 自定义（空=核心默认）
          splitFill: true, // A1：模型把多源行合并成一条译文时，本地拆分回填到每行，时间轴更细
          timeoutMs: 20000,
          fetchImpl: function (u, o) {
            return fetch(u, o);
          },
        });
      });
      if (res && res.ok && res.sentences.length) {
        state.clipSentences[idx] = res.sentences;
        delete state.clipCache[idx]; // 句级成功：清掉可能存在的逐行残留
        state.clipState[idx] = "done";
        backoff.reset();
        rebuildRenderTimeline();
        requestRender();
        writeCache(key, { sent: res.sentences });
        return;
      }
      // 覆盖性校验未过 → 落到逐行兜底，留诊断日志
      console.warn(
        "[dualsub] clip", idx, "句级重断覆盖性校验未过(",
        (res && res.reason) || "unknown", ") → 退回逐行对齐 fallback"
      );
    } catch (e) {
      // 句级调用本身失败（网络/超时/HTTP）→ 同样退回逐行兜底
      console.warn("[dualsub] clip", idx, "句级重断调用失败：", e && e.message, "→ 退回逐行 fallback");
    }

    // ② 兜底路径：保留原有逐行翻译（resegment 分段 + alignTranslations），不丢字幕。
    await translateClipPerLine(idx, clip, key, priorityIndex);
  }

  /**
   * 逐行翻译兜底（fallback）：句级语义重断失败/覆盖性不过时走这里。
   * 沿用前置任务的 translateCues（批内并发 + 上下文窗口 + 首句优先），
   * 译文按行号对齐回 clip.cues，渲染时退化为「一条 resegment 段 = 一条译文」。
   */
  async function translateClipPerLine(idx, clip, key, priorityIndex) {
    var backoff = getBackoff(idx);
    // 边翻边填：clipCache[idx] 先建空数组，每批回调即时写入并触发重渲染
    if (!state.clipCache[idx]) state.clipCache[idx] = new Array(clip.cues.length);
    delete state.clipSentences[idx]; // 走逐行：清掉句级残留
    var hadError = false;
    try {
      var lines = await Core.translateCues({
        cues: clip.cues,
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        targetLang: config.targetLang,
        systemPrompt: config.systemPrompt,
        batchSize: config.batchLines > 0 ? config.batchLines : 14,
        contextLines: config.contextLines != null ? config.contextLines : 3,
        priorityIndex: priorityIndex != null ? priorityIndex : 0,
        concurrency: 3,
        gate: ensureGate(), // 全局并发上限：所有 clip 共享，避免滑动窗口预取冲垮网关
        timeoutMs: 20000,
        fetchImpl: function (u, o) {
          return fetch(u, o);
        },
        onProgress: function (updates) {
          var arr = state.clipCache[idx];
          for (var i = 0; i < updates.length; i++) arr[updates[i].index] = updates[i].text;
          rebuildRenderTimeline();
          requestRender(); // 新译文到 → 立即把当前 cue 刷新（暂停/隐藏时也补一帧）
        },
        onError: function () {
          hadError = true;
        },
      });
      state.clipCache[idx] = lines;
      rebuildRenderTimeline();
      if (hadError) {
        // 部分批失败：标记 error 让退避接管，但已成功的行仍显示
        state.clipState[idx] = "error";
        backoff.fail();
      } else {
        state.clipState[idx] = "done";
        backoff.reset();
        writeCache(key, { lines: lines }); // 整段成功才写持久缓存（逐行形态）
      }
    } catch (e) {
      console.warn("[dualsub] clip", idx, "逐行兜底也失败：", e.message);
      state.clipState[idx] = "error"; // 兜底：渲染时只显示原文
      backoff.fail();
    }
  }

  /**
   * 重建全局渲染时间轴 state.renderUnits（句级优先、逐行兜底）。
   * 按 clip 顺序遍历，每个 clip：
   *  - 有句级重断结果(clipSentences[idx]) → 直接用其句单元（含合并后时间区间 + 完整原文 + 译文）；
   *  - 否则退回逐行：每条 cue 一个单元，译文取 clipCache（可能为空=未翻/翻译中）。
   * 产出按 start 升序的单元数组，渲染 tick 用 findCueIndexAt 在其上二分查当前句。
   * 每个单元：{ start, end, originalText, translation }（与 cue 同构 start/end，便于复用查找）。
   */
  function rebuildRenderTimeline() {
    var units = [];
    for (var ci = 0; ci < state.clips.length; ci++) {
      var sents = state.clipSentences[ci];
      if (sents && sents.length) {
        for (var s = 0; s < sents.length; s++) {
          units.push({
            start: sents[s].startMs,
            end: sents[s].endMs,
            originalText: sents[s].originalText,
            translation: sents[s].translation != null ? sents[s].translation : null,
            clipIdx: ci,
          });
        }
        continue;
      }
      // 逐行兜底：clip 的每条 cue 一个单元，原文用 cue.content，译文取 clipCache
      var clip = state.clips[ci];
      var arr = state.clipCache[ci];
      for (var k = 0; k < clip.cues.length; k++) {
        var cue = clip.cues[k];
        units.push({
          start: cue.start,
          end: cue.end,
          originalText: cue.content,
          translation: arr && arr[k] != null ? arr[k] : null,
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
      "  width:100%; padding:0 4%; box-sizing:border-box;",
      "}",
      ".dualsub-subtitle{",
      "  display:inline-block; max-width:96%; line-height:1.25;",
      "  font-size:var(--ds-fontsize,22px);",
      "  font-family:var(--ds-fontfamily,'YouTube Noto',Roboto,Arial,sans-serif);",
      "  font-weight:var(--ds-fontweight,500);",
      "  white-space:pre-wrap; word-break:break-word;",
      "}",
      ".dualsub-orig{ color:var(--ds-orig-color,#fff); }",
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
  function applyFontSize() {
    var r = state.renderer;
    if (!r) return;
    var player = playerEl();
    var h = player ? player.clientHeight : 0;
    var px = Core.computeFontPx(h, config.fontSize);
    r.style.setProperty("--ds-fontsize", px + "px");
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

    // 二分 + 上次命中提示：在「句级合并后时间轴」(renderUnits)上查当前句，大多数相邻 tick O(1)
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
    // 未翻好且该 clip 不是 error 态 → pending（显示「翻译中…」）；error 态不显示，只留原文
    var pending = trans == null && state.clipState[unit.clipIdx] !== "error";

    // 命中键：单元下标 + 译文 + 是否 pending。键未变 → 不动 DOM（idle 零开销）
    var key = unitIdx + ":" + (trans || "") + ":" + (pending ? "p" : "");
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    setRendererText(unit.originalText, trans, pending);
  }

  /**
   * 写字幕文本。
   *  - orig/trans 为当前 cue 的原文/译文。
   *  - pending=true 且无译文时，按配置显示轻量"翻译中…"指示（不闪烁）。
   */
  function setRendererText(orig, trans, pending) {
    var r = state.renderer;
    if (!r) return;
    // 原文行
    r._orig.textContent = config.showOriginal ? orig || "" : "";
    r._orig.classList.toggle("dualsub-hidden", !config.showOriginal || !orig);
    // 译文行：有译文显译文；没翻好时按 showLoading 显"翻译中…"，否则留空
    if (trans) {
      r._trans.textContent = trans;
      r._trans.classList.remove("dualsub-hidden", "dualsub-pending");
    } else if (pending && config.showLoading && orig) {
      r._trans.textContent = "翻译中…";
      r._trans.classList.remove("dualsub-hidden");
      r._trans.classList.add("dualsub-pending");
    } else {
      r._trans.textContent = "";
      r._trans.classList.add("dualsub-hidden");
      r._trans.classList.remove("dualsub-pending");
    }
  }

  /**
   * 彻底清理运行时（定时器 + 监听器 + seek 防抖）。
   * full=true 时连 renderer 也移除（禁用扩展）；false 仅清循环/监听（换 video）。
   */
  function teardownRuntime(full) {
    stopRenderLoop();
    stopPrefetchLoop();
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
        // model/语言变了，旧译文已不适用 → 丢内存缓存重翻（持久缓存按新 key 自然不命中）
        if (config.apiModel !== prevModel || config.targetLang !== prevTarget) {
          state.clipCache = {};
          state.clipSentences = {};
          state.renderUnits = [];
          state.clipState = {};
        } else {
          // 仅 base/key 变：把 error 态清掉以便重试，已成功的保留
          for (var ci in state.clipState) {
            if (state.clipState[ci] === "error") state.clipState[ci] = undefined;
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
            state.clipCache = {};
            state.clipSentences = {};
            state.renderUnits = [];
            state.clipState = {};
            state.clipBackoff = {};
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
      // popup 请求导出当前视频双语 SRT：返回已翻译的渲染单元（句级优先、逐行兜底）+ 元信息。
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

