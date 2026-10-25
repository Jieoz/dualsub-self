/*
 * main.js — 运行在 world: "MAIN"
 * =============================================================
 * 职责：抓取 YouTube 播放器的字幕轨道。
 * MAIN world 能访问页面里的 YouTube 播放器私有对象 #movie_player，
 * 但不能用 chrome.* API。所以抓到轨道后通过自建 RPC 通道把数据
 * 推给运行在 ISOLATED world 的 isolated.js。
 *
 * 与 isolated.js 的通信靠一条固定随机字符串常量的 CustomEvent 通道。
 */
(function () {
  "use strict";

  // RPC 通道名：固定随机串常量（main.js 与 isolated.js 必须一致）
  var CHANNEL = "__dualsub_rpc_8f3ad7c1b2e94__";
  var SENDER = "main";
  var RECEIVER = "isolated";

  // Firefox 兼容：跨 world 传对象需要 cloneInto
  var cloneInto = globalThis.cloneInto;

  /** 通过 RPC 通道发送消息给 isolated.js */
  function send(subject, content) {
    var detail = { sender: SENDER, receiver: RECEIVER, subject: subject, content: content };
    if (cloneInto) {
      detail = cloneInto(detail, window);
    }
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: detail }));
  }

  // isolated.js → main.js 的回执通道（命名与 isolated.js 的 CHANNEL_OUT 一致）
  var CHANNEL_IN = "__dualsub_main_to_iso_9f47c2ae51d8__";
  window.addEventListener(CHANNEL_IN, function (ev) {
    try {
      var d = ev && ev.detail;
      if (!d || d.sender !== "isolated" || d.subject !== "manifest-ack") return;
      lastAckedSignature = lastSignature; // 当前签名已被确认，停止重发
    } catch (e) {}
  });

  /* ---------------- 轨道抓取 ---------------- */

  var lastSignature = ""; // 上次推送的轨道签名，避免重复推送
  var lastAckedSignature = ""; // isolated.js 已确认收到的签名（manifest-ack 回执）
  var lastSentAt = 0; // 上次推送时刻（未 ack 时限流 2s 重发）

  // 当前是否移动端 m.youtube.com（影响 c 参数）
  function isMobile() {
    return location.hostname === "m.youtube.com";
  }

  /**
   * 给字幕轨道 URL 补上易解析参数：
   *  - fmt=json3（最易解析）
   *  - c=WEB（移动端用 MWEB）
   * 保留原有的 pot 等签名参数。
   */
  function normalizeUrl(rawUrl) {
    var u;
    try {
      u = new URL(rawUrl, location.origin);
    } catch (e) {
      return null;
    }
    u.searchParams.set("fmt", "json3");
    u.searchParams.set("c", isMobile() ? "MWEB" : "WEB");
    return u.toString();
  }

  /**
   * 关键：YouTube 字幕轨道 URL 必须带上 pot（签名）参数后才有效，
   * 否则字幕请求会 403。没有 pot 就当作"还没准备好"。
   */
  function hasPot(rawUrl) {
    try {
      var u = new URL(rawUrl, location.origin);
      var pot = u.searchParams.get("pot");
      return !!(pot && pot.length > 0);
    } catch (e) {
      return false;
    }
  }

  /** 从轨道的 name 字段（simpleText 或 runs）提取可读名称 */
  function trackName(track) {
    var name = track.name;
    if (!name) return track.languageName || track.languageCode || "unknown";
    if (typeof name.simpleText === "string") return name.simpleText;
    if (Array.isArray(name.runs)) {
      return name.runs
        .map(function (r) {
          return r && r.text ? r.text : "";
        })
        .join("");
    }
    return track.languageName || track.languageCode || "unknown";
  }

  /** 轮询主体：读 #movie_player，抓有效字幕轨道 */
  function poll() {
    try {
      var player = document.querySelector("#movie_player");
      if (!player || typeof player.getVideoData !== "function") return;

      var vd = player.getVideoData();
      var videoId = vd && vd.video_id ? vd.video_id : null;
      if (!videoId) return;

      // 未开始播放的状态跳过（轨道可能还没挂上）
      if (typeof player.getPlayerStateObject === "function") {
        var st = player.getPlayerStateObject();
        if (st && st.isUnstarted) return;
      }

      if (typeof player.getAudioTrack !== "function") return;
      var audioTrack = player.getAudioTrack();
      var captionTracks =
        audioTrack && audioTrack.captionTracks ? audioTrack.captionTracks : null;
      if (!captionTracks || !captionTracks.length) return;

      var files = [];
      var allHavePot = true;
      for (var i = 0; i < captionTracks.length; i++) {
        var t = captionTracks[i];
        var rawUrl = t.baseUrl || t.url;
        if (!rawUrl) continue;

        // 没有 pot 签名 → 还没准备好，本轮整体跳过等下次轮询
        if (!hasPot(rawUrl)) {
          allHavePot = false;
          break;
        }

        var url = normalizeUrl(rawUrl);
        if (!url) continue;

        var vss = t.vss_id || t.vssId || "";
        var lang = t.languageCode || vss.replace(/^[.a]*[.]/, "") || "und";
        // kind=asr 是自动生成字幕，code 标记 -asr 以便区分
        var isAsr = t.kind === "asr" || /(^|\.)asr/.test(vss);
        var code = isAsr ? lang + "-asr" : lang;

        // 不在这里判「是否原语言」：单条轨的元数据不足以回答这个问题。
        //
        // 实测 3teflb1QNN4（音轨英语，另有西语人工翻译轨）的三条轨：
        //   vssId ".en"      languageCode en      isTranslatable true
        //   vssId "a.en"     languageCode en      kind "asr"
        //   vssId ".es-419"  languageCode es-419  isTranslatable true
        // 可见 vss_id 以 "." 开头只代表「人工上传」，西语翻译轨同样是 ".es-419"；
        // isTranslatable 三条全为 true（能被 YouTube 机翻的都算）。两者都无法区分
        // 原语言轨和人工翻译轨。
        //
        // 唯一可靠的信号是 ASR 轨的语言：YouTube 只会对音轨的实际语言做语音识别，
        // 所以 "a.<lang>" 里的 lang 就是音轨语言。这需要看整个轨道列表才能得出，
        // 因此判定放在选轨点（pickTrack），这里只忠实传递 kind 和 languageCode。

        files.push({
          name: trackName(t),
          code: code,
          languageCode: lang,
          kind: t.kind || (isAsr ? "asr" : ""),
          url: url,
        });
      }

      if (!allHavePot || !files.length) return;

      // 签名去重：videoId + 所有 url 拼起来
      var signature =
        videoId +
        "|" +
        files
          .map(function (f) {
            return f.code + "=" + f.url;
          })
          .join("|");
      if (signature === lastSignature && signature === lastAckedSignature) return;
      // 未 ack 的签名每 2s 重发一次：isolated.js 与本文件同为 document_start，
      // 但 isolated 的 RPC 监听器注册有先后竞态——首发若落在监听器就绪前会被
      // 静默丢弃，而签名去重会阻止重发，页面就永远死了（实测偶发整页无字幕）。
      if (signature === lastSignature && Date.now() - lastSentAt < 2000) return;
      lastSignature = signature;
      lastSentAt = Date.now();

      // site 必须显式声明：isolated.js 靠它选站点适配器做 URL 校验，
      // 不靠猜。缺省回落到 youtube 只是为了兼容旧包，新代码一律显式发。
      send("update-manifest", { site: "youtube", videoId: videoId, files: files });
    } catch (e) {
      // 播放器内部对象偶发抛错，吞掉继续下轮
    }
  }

  // SPA 路由变化检测：轮询 location.search 的 v 参数，变了就清签名强制重抓
  var lastV = null;
  function checkRoute() {
    try {
      var v = new URLSearchParams(location.search).get("v");
      if (v !== lastV) {
        lastV = v;
        lastSignature = ""; // 视频切换，强制下一轮重新推送
      }
    } catch (e) {}
  }

  // 1.5 秒轮询。manifest 就绪时刻直接决定首字幕时刻：轮询 3s 时实测
  // 播放器就绪慢的页面要 20-30s 才拿到轨道（用户面前干瞪眼）；
  // 1.5s 把平均落地提前 ~0.75s、最坏提前 ~1.5s，轮询本身只是读播放器
  // 状态，开销可忽略。
  setInterval(function () {
    checkRoute();
    poll();
  }, 1500);

  // 启动时也立即跑一次
  checkRoute();
  poll();
})();
