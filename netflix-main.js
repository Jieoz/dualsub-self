/*
 * netflix-main.js — 运行在 world: "MAIN"（仅 netflix.com）
 * =============================================================
 * 职责：拿到 Netflix 的字幕轨。与 main.js（YouTube）同一份契约：
 * 通过 CustomEvent 把 { site, videoId, files[] } 推给 isolated.js。
 * 解析、时间轴、语义分屏、翻译全在下游，与站点无关。
 *
 * 为什么不能照抄 main.js 的做法（读播放器给的 URL 就完事）：
 *
 *   Netflix 的字幕不是 API 端点，是**签名 CDN 直链**
 *   （*.oca.nflxvideo.net/range/... 带 t=<签名>）。而且缓存命中时播放器
 *   **根本不发网络请求** —— 实测默认即英文轨时，旁听式挂钩一条都抓不到。
 *
 *   所以取轨走**主动**路径：从播放器内存读 getTextTrackList() 拿轨清单与
 *   下载 URL，不依赖「页面恰好发过请求」。缓存命中不发请求对我们无影响。
 *
 *   刻意不做旁听式抓正文：那会造成「拿 cue 文本」有两条路径（旁听的正文 vs
 *   下载的正文），两条都要维护、还可能给出不一致的结果。取轨只有一条路：
 *   URL → 下载 → Core.parseSubtitleText。
 *
 * 明确不做的事：不读 cookie / localStorage / 任何账号信息或 token。
 */
(function () {
  "use strict";

  // RPC 通道名：必须与 isolated.js / main.js 完全一致
  var CHANNEL = "__dualsub_rpc_8f3ad7c1b2e94__";
  var SENDER = "main";
  var RECEIVER = "isolated";
  var SITE = "netflix";

  var cloneInto = globalThis.cloneInto;

  function send(subject, content) {
    var detail = { sender: SENDER, receiver: RECEIVER, subject: subject, content: content };
    if (cloneInto) detail = cloneInto(detail, window);
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: detail }));
  }

  /* ---------------- 视频 id ---------------- */

  /** Netflix 观看页 URL 形如 /watch/80075919（可带 ?trackId=...） */
  function currentVideoId() {
    var m = String(location.pathname || "").match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  /* ---------------- 主动路径：读播放器内存 ---------------- */

  /**
   * 取 Netflix 播放器实例。这是页面内部对象，只有 MAIN world 能碰。
   * 结构随 Netflix 前端改版会变 —— 全程 try/catch，拿不到就返回 null，
   * 让轮询安静重试，绝不抛错影响页面。
   */
  function netflixPlayer() {
    try {
      var ctx = window.netflix && window.netflix.appContext && window.netflix.appContext.state;
      var api = ctx && ctx.playerApp && ctx.playerApp.getAPI && ctx.playerApp.getAPI();
      var vp = api && api.videoPlayer;
      if (!vp || typeof vp.getAllPlayerSessionIds !== "function") return null;
      var ids = vp.getAllPlayerSessionIds() || [];
      for (var i = 0; i < ids.length; i++) {
        // 只要 watch session，跳过预览/预告片播放器
        if (!/watch/.test(String(ids[i]))) continue;
        var p = vp.getVideoPlayerBySessionId(ids[i]);
        if (p && typeof p.getTextTrackList === "function") return p;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 从轨道对象里挖出可下载的字幕 URL。
   *
   * Netflix 的 track 对象没有稳定的公开字段名（实测 downloadables 是嵌套
   * 结构，键名是 profile 名如 "imsc1" / "dfxp-ls-sdh"，还随改版变化）。
   * 与其硬钉某个路径，不如在序列化后的对象里找符合 CDN 形态的 URL ——
   * 这样 Netflix 换字段名不会直接把功能打死。
   * 安全性不依赖这里：URL 最终要过 isolated.js 的 validateTrackManifest。
   */
  function trackUrls(track) {
    var urls = [];
    try {
      var raw = JSON.stringify(track);
      var found = raw.match(/https:\\?\/\\?\/[^"'\\]+/g) || [];
      for (var i = 0; i < found.length; i++) {
        var u = found[i].replace(/\\\//g, "/");
        if (/nflxvideo\.net/.test(u)) urls.push(u);
      }
    } catch (e) {}
    return urls;
  }

  /** 轨道语言码：优先 BCP47，回落 language 字段 */
  function trackLang(track) {
    var raw = track && (track.bcp47 || track.language || track.languageCode);
    if (!raw) return null;
    // 规范成 validateTrackManifest 接受的形状（字母数字 . - _）
    var code = String(raw).replace(/[^A-Za-z0-9_.-]/g, "");
    return code || null;
  }

  /**
   * 判断这条轨是否「强制字幕」（forced narrative）——只翻译片中外语对话
   * 的几句，不是完整字幕轨。当完整轨可用时不该选它。
   */
  function isForced(track) {
    try {
      return /forced/i.test(JSON.stringify(track));
    } catch (e) {
      return false;
    }
  }

  function readTrackList() {
    var player = netflixPlayer();
    if (!player) return null;
    var list;
    try {
      list = player.getTextTrackList() || [];
    } catch (e) {
      return null;
    }
    var files = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var lang = trackLang(t);
      if (!lang) continue; // 「关闭字幕」那条伪轨没有语言
      if (isForced(t)) continue;
      var urls = trackUrls(t);
      if (!urls.length) continue;
      files.push({
        name: lang,          // 不用 displayName：那是本地化字符串，与语言码不稳定对应
        code: lang,
        languageCode: lang,
        kind: "",            // Netflix 只有人工轨，没有 ASR
        url: urls[0],
      });
    }
    return files.length ? files : null;
  }

  /* ---------------- 汇总推送 ---------------- */

  var lastSignature = "";

  function poll() {
    try {
      var videoId = currentVideoId();
      if (!videoId) return;
      // 播放器 API 不可达（改版 / 还没就绪）→ 本轮什么也不推，等下一轮。
      // 不做「猜一个 URL」之类的兜底：拿不到就是拿不到，让它安静重试，
      // 而不是推一份可能是错的清单进下游。
      var files = readTrackList();
      if (!files) return;

      var signature = videoId + "|" + files.map(function (f) {
        return f.code + "=" + f.url;
      }).join("|");
      if (signature === lastSignature) return;
      lastSignature = signature;

      send("update-manifest", { site: SITE, videoId: videoId, files: files });
    } catch (e) {
      // 页面内部对象偶发抛错，吞掉继续下轮
    }
  }

  // SPA 路由变化：换剧集要强制重抓
  var lastPath = null;
  function checkRoute() {
    try {
      var id = currentVideoId();
      if (id !== lastPath) {
        lastPath = id;
        lastSignature = "";
      }
    } catch (e) {}
  }

  setInterval(function () {
    checkRoute();
    poll();
  }, 3000);

  checkRoute();
  poll();
})();
