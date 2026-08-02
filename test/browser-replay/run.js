#!/usr/bin/env node
"use strict";
const assert=require("assert"),http=require("http"),fs=require("fs"),path=require("path"),os=require("os");
const ROOT=path.resolve(__dirname,"../..");
const FIX=__dirname;
const endpoint=process.env.DUALSUB_CDP_URL||"http://172.19.0.33:9222";
const publicHost=process.env.DUALSUB_REPLAY_HOST||Object.values(os.networkInterfaces()).flat().find(x=>x&&x.family==="IPv4"&&!x.internal&&/^172\./.test(x.address))?.address||"127.0.0.1";
const scenarios=(process.env.DUALSUB_REPLAY_SCENARIOS||"happy,empty-track-retry,empty-track-exhaust,block-long-fallback,block-failure,seek-race,block-cache,config-race,disable-inflight,track-switch-race,full-srt,full-srt-cancel,priority-overtake,spa-switch-stale,source-lang-chinese,netflix-happy").split(",");
for(const name of ["index.html","track.json","semantic.json"])assert.ok(fs.existsSync(path.join(FIX,name)),`missing fixture: ${name}`);
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.onEvent=null;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result)}else if(m.method&&this.onEvent){this.onEvent(m)}}}send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.id;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}}
/* 生产 isolated.js 按 location.hostname 选站点适配器，未支持的站点直接退出。
 * 所以回放必须跑在**真实站点 origin** 上，不能用 IP —— 否则测的就不是
 * 真实注入条件了。这里用 CDP 请求拦截把 https://www.youtube.com/* 的响应
 * 换成本地 fixture，页面看到的 origin 与真机一致，且不产生任何外网请求。
 * 不为测试在生产代码里留 host 白名单后门。 */
/* 场景名决定站点 origin：netflix-* 跑 Netflix，其余跑 YouTube。
 * 不用环境变量，否则跑全量时只能测到一个站点。 */
function originFor(name){return /^netflix-/.test(name)?"https://www.netflix.com":"https://www.youtube.com"}
async function installOriginShim(cdp,sessionId,origin){
  await cdp.send("Fetch.enable",{patterns:[{urlPattern:origin+"/*"}]},sessionId);
}
function fulfillFromDisk(cdp,sessionId,ev){
  const {requestId,request}=ev.params;
  const p=new URL(request.url).pathname;
  // /api/timedtext 由页面内的 fetch 桩接管，这里放行让它自己失败/被桩拦下
  const f=fileFor(p==="/watch"||p==="/"?"/":p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){
    return cdp.send("Fetch.fulfillRequest",{requestId,responseCode:404,body:Buffer.from("not found").toString("base64")},sessionId).catch(()=>{});
  }
  const body=fs.readFileSync(f);
  return cdp.send("Fetch.fulfillRequest",{requestId,responseCode:200,
    responseHeaders:[{name:"content-type",value:mime[path.extname(f)]||"application/octet-stream"}],
    body:body.toString("base64")},sessionId).catch(()=>{});
}
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8"};
function fileFor(url){const p=new URL(url,"http://x").pathname;if(p==="/core.js"||p==="/isolated.js")return path.join(ROOT,p.slice(1));return path.join(FIX,p==="/"?"index.html":p.slice(1))}
function serve(){return new Promise(resolve=>{const s=http.createServer((req,res)=>{const f=fileFor(req.url);if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end("not found")}res.setHeader("content-type",mime[path.extname(f)]||"application/octet-stream");fs.createReadStream(f).pipe(res)});s.listen(0,"0.0.0",()=>resolve(s))})}
async function connect(){const version=await fetch(endpoint+"/json/version").then(r=>r.json());const ws=new WebSocket(version.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/,endpoint.replace(/^http/,"ws")));await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});return new CDP(ws)}
function check(name,r){assert.equal(r.finished,true,`${name}: replay did not finish`);assert.deepEqual(r.errors,[],`${name}: browser errors: ${r.errors}`);const expectedWarnings={"block-failure":[/clip 0 翻译失败/],"empty-track-retry":[/字幕轨加载失败\(轨道为空\),第 1 次重试/,/字幕轨加载失败\(轨道为空\),第 2 次重试/],"empty-track-exhaust":[/字幕轨加载失败\(轨道为空\),第 1 次重试/,/字幕轨加载失败\(轨道为空\),第 2 次重试/,/字幕轨加载失败\(轨道为空\),第 3 次重试/,/重试已用尽/]}[name]||[];assert.equal((r.warnings||[]).length,expectedWarnings.length,`${name}: unexpected browser warnings: ${r.warnings}`);expectedWarnings.forEach((pattern,i)=>assert.match(r.warnings[i],pattern,`${name}: warning ${i} drift`));/* spa-switch-stale 与 empty-track-exhaust 一样，正确结局是「没有可导出快照」：
   换片后状态被清空，导出为空是期望行为而非缺陷。所以走同一个早返回位置，
   在这里做完自己的断言 —— 不给共享 check() 加 scenario 例外分支。 */
if(name==="spa-switch-stale"){
  const sw=r.events.find(e=>e.type==="spa-url-switch");
  assert.ok(sw,"spa-switch-stale: URL 切换未发生，场景没跑起来");
  // 用例自检：切换前必须真有双语上过屏，否则"切换后没有"是废话式通过
  assert.ok(r.beforeSwitchPainted>0,
    "用例失效：切换前没有双语上屏，本条无法证明清理行为("+r.beforeSwitchPainted+")");
  // 承重断言：换片后不得再有上一部片的译文留在屏上
  const stale=r.paints.filter(p=>p.t>sw.t+600&&p.trans&&p.trans!=="翻译中…");
  assert.equal(stale.length,0,
    "换片后上一部片的译文仍挂在新片画面上("+stale.length+" 帧): "+
    JSON.stringify(stale.slice(0,2).map(p=>({at:p.at,orig:p.orig,trans:p.trans}))));
  // 原文也不能留：清理必须是整屏清空，不是只清译文那一行
  const staleOrig=r.paints.filter(p=>p.t>sw.t+600&&p.orig);
  assert.equal(staleOrig.length,0,
    "换片后上一部片的原文仍在屏上("+staleOrig.length+" 帧): "+
    JSON.stringify(staleOrig.slice(0,2).map(p=>p.orig)));
  return;
}
// 中文源轨不介入：切到 zh-Hans 后 pickTrack 返回 null,此时必须走和「无可用轨」
// 同一条清理路径。曾经只调 bindVideo() —— 不清 renderUnits、不摘 hide-native,
// 于是上一条轨的字幕永久挂在画面上,同时原生字幕仍被隐藏,两头都没有正确字幕。
if(name==="source-lang-chinese"){const switchAt=(r.events.find(x=>x.type==="config-switch")||{}).t;assert.ok(switchAt!=null,"未发生 sourceLang 切换,场景没跑起来");
// 前置条件:切换前必须真的在渲染双语字幕、且真的隐藏了原生字幕。
// 少了这两条,「切换后无残留」会因为「压根没渲染过」而假绿 —— 空的观察窗
// 天然满足「无残留」。实测切换前 20 帧里 16 帧双语、16 帧 nativeHidden。
const before=(r.paints||[]).filter(x=>x.t<=switchAt);const beforeBi=before.filter(x=>String(x.orig||"").trim()&&String(x.trans||"").trim());
assert.ok(beforeBi.length>=3,"切换前双语帧仅 "+beforeBi.length+" 帧 —— 渲染没真正跑起来,「无残留」是空窗假绿而非清理生效");
assert.ok(before.some(x=>x.nativeHidden),"切换前从未隐藏原生字幕 —— 无法证明切换后的恢复是真的");
const after=(r.paints||[]).filter(x=>x.t>switchAt+600);assert.ok(after.length>=3,"切换后采样帧不足("+after.length+"),观察窗太短证明不了清理");const stale=after.filter(x=>String(x.orig||"").trim()||String(x.trans||"").trim());assert.equal(stale.length,0,"切到中文源后仍残留上一条轨的字幕 "+stale.length+" 帧,例:"+JSON.stringify((stale[0]||{}).orig||"")+" / "+JSON.stringify((stale[0]||{}).trans||""));const stillHidden=after.filter(x=>x.nativeHidden);assert.equal(stillHidden.length,0,"本扩展已不介入,却仍隐藏着 YouTube 原生字幕 "+stillHidden.length+" 帧 —— 用户两头都没有字幕");assert.ok(r.nativeRestored,"收尾时原生字幕未恢复显示");return}
const noTrackScenario=name==="empty-track-exhaust";if(noTrackScenario){assert.equal(r.emptyTrackFetches,4,"重试次数不对(应为 1 次首发 + 3 次重试),实际 "+r.emptyTrackFetches);assert.ok((r.warnings||[]).some(w=>/重试已用尽/.test(String(w))),"重试用尽后未向用户报告失败原因,只是静默放弃");assert.ok(!(r.paints||[]).some(x=>x.orig),"轨道始终为空却painted了字幕内容");return}const fallback=r.paints.find(x=>x.orig&&(!x.trans||x.trans==="翻译中…"));assert.ok(fallback,`${name}: fallback original with blank Chinese never painted`);const starts=r.events.filter(x=>x.type==="translation-start");const ready=r.events.filter(x=>x.type==="translation-ready");const expectedResponses=ready.length;assert.equal(r.apiUsage&&r.apiUsage.requests,expectedResponses,`${name}: runtime usage missed a completed translation response`);assert.equal(r.apiUsage&&r.apiUsage.totalTokens,expectedResponses*14,`${name}: runtime usage total drift`);const exported=r.exportSrt;assert.ok(exported&&exported.sourceFingerprint,`${name}: SRT export did not expose snapshot fingerprint`);const exportedIds=new Set((exported.units||[]).map(x=>x.unitId));const provenancePaint=[...r.paints].reverse().find(x=>x.orig&&x.unitId&&x.sourceFingerprint&&exportedIds.has(x.unitId));assert.ok(provenancePaint,`${name}: no rendered frame belonged to exported snapshot`);assert.equal(provenancePaint.sourceFingerprint,exported.sourceFingerprint,`${name}: renderer/SRT snapshot fingerprint drift`);const exportedUnit=(exported.units||[]).find(x=>x.unitId===provenancePaint.unitId);assert.ok(exportedUnit,`${name}: rendered unit missing from exported snapshot`);assert.deepEqual([exportedUnit.tokenStart,exportedUnit.tokenEnd],[provenancePaint.tokenStart,provenancePaint.tokenEnd],`${name}: renderer/SRT token span drift`);const bilingualPaints=r.paints.filter(x=>x.orig&&x.trans&&x.trans!=="翻译中…"&&x.trans!=="翻译失败"&&x.sampleType==="periodic");const bilingual=bilingualPaints.at(-1);for(const paint of bilingualPaints){assert.match(paint.trans,/[\u3400-\u9fff]/,`${name}: bilingual paint did not contain real CJK translation`);assert.notEqual(paint.trans,"翻译中…",`${name}: loading placeholder counted as translation`);assert.notEqual(paint.trans,"翻译失败",`${name}: failure placeholder counted as translation`);assert.ok(!paint.trans.includes("。"),`${name}: rendered Chinese subtitle contains forbidden full stop`);const wordLimit=r.segmentationMode==="fallback-translation"?14:12;assert.ok(paint.orig.trim().split(/\s+/).length<=wordLimit,`${name}: rendered English screen exceeds ${wordLimit} words`);assert.ok(paint.origFontPx>=paint.baseFontPx*0.85&&paint.transFontPx>=paint.baseFontPx*0.85,`${name}: renderer hid bad segmentation with tiny text`);assert.ok(paint.playerRight>paint.playerLeft&&paint.origLeft>=paint.playerLeft-1&&paint.origRight<=paint.playerRight+1&&paint.transLeft>=paint.playerLeft-1&&paint.transRight<=paint.playerRight+1&&paint.origTop>=paint.playerTop-1&&paint.origBottom<=paint.playerBottom+1&&paint.transTop>=paint.playerTop-1&&paint.transBottom<=paint.playerBottom+1,`${name}: bilingual row escaped player viewport`)}
 if(name==="happy"){assert.equal(r.segmentationMode,"block","happy path did not install block mode");assert.ok(starts.length>0,"happy: block translation never started");assert.ok(bilingual,"happy: bilingual block unit never painted");assert.equal(r.pauseCalls,r.playCalls,"首块等待后必须成对恢复播放")}
 if(name==="block-long-fallback"){assert.equal(r.segmentationMode,"block","slow block request must keep block mode");assert.equal(starts.length,1,"slow block request should be in flight");assert.equal(r.apiUsage&&r.apiUsage.requests,0,"pending block request polluted usage");assert.equal(!!bilingual,false,"pending block request painted Chinese early");assert.ok(r.paints.some(x=>x.orig&&(!x.trans||x.trans==="翻译中…")),"source fallback was not visible while block translation was pending")}
 if(name==="empty-track-retry"){assert.ok(r.emptyTrackFetches>=3,"空轨未触发重试,只请求了 "+r.emptyTrackFetches+" 次(旧代码 1 次就永久放弃)");assert.ok(r.exportSrt&&r.exportSrt.ok&&(r.exportSrt.units||[]).length>0,"重试拿到真轨后仍未建立可用时间轴 —— 用户日志里的『解析后无有效字幕』未修复");assert.ok((r.paints||[]).length>0,"重试成功后没有任何字幕被绘制");assert.ok(r.events.some(x=>x.type==="good-track-served"),"未走到真轨")}
 if(name==="block-failure"){assert.equal(r.segmentationMode,"block","block failure must keep source timeline active");assert.ok(starts.length>0,"block failure did not exercise translation");assert.equal(!!bilingual,false,"failed block painted unverified Chinese")}
 if(name==="seek-race"){assert.ok(starts.length>=1,"seek race did not start block translation");assert.ok(bilingual&&bilingual.at>=7.4,"seek race rendered a stale-time block unit")}
 if(name==="block-cache"){assert.equal(r.segmentationMode,"block","block cache path did not remain active");assert.equal(starts.length,2,"returning to the same video should reuse the first block cache instead of issuing a third request")}
 if(name==="config-race"){assert.ok(r.events.some(x=>x.type==="translation-aborted"),"old model request was not actively aborted");assert.ok(starts.length>=2,"config switch did not start a new generation request");assert.ok(!r.paints.some(x=>String(x.trans||"").includes("旧模型")),"stale old-model result reached the renderer");assert.ok(r.paints.some(x=>String(x.trans||"").includes("新模型")),"new-model result was not rendered")}
 if(name==="disable-inflight"){const disabled=r.events.find(x=>x.type==="disable-send");assert.ok(disabled,"disable was not exercised");assert.ok(r.events.some(x=>x.type==="translation-aborted"),"disable did not actively abort translation");assert.equal(r.apiUsage&&r.apiUsage.requests,0,"aborted response polluted usage");assert.ok(!r.events.some(x=>x.type==="cache-write-after-disable"),"aborted response wrote cache after disable");assert.ok(!r.paints.some(x=>x.t>disabled.t&&x.trans&&x.trans!=="翻译中…"),"late translation painted after disable");assert.ok(r.nativeRestored,"disable did not restore native captions")}
 if(name==="full-srt"){assert.equal(r.fullSrtStatus&&r.fullSrtStatus.status,"completed","full SRT did not complete");assert.ok(r.exportSrt&&r.exportSrt.ok,"full SRT export is incomplete");const counts=r.events.filter(e=>e.type==="translation-start").map(e=>e.count);assert.ok(r.events.some(e=>e.type==="translation-start"&&/unit0[\s\S]*unit1[\s\S]*unit2/.test(e.first||"")),"full SRT did not send a context-rich source block");assert.ok(counts.every(n=>n<=20),"full SRT emitted a request above the block cue cap")}
if(name==="full-srt-cancel"){assert.equal(r.fullSrtStatus&&r.fullSrtStatus.status,"cancelled","full SRT cancellation did not settle");assert.ok(r.fullSrtStatus.completedUnits<r.fullSrtStatus.totalUnits,"cancelled full SRT unexpectedly completed");assert.equal(r.exportSrt&&r.exportSrt.ok,false,"cancelled incomplete SRT was exportable");const cancelled=r.events.find(e=>e.type==="full-srt-cancelled");assert.ok(cancelled,"cancel event missing");const startsBySource=new Map();for(const e of r.events.filter(e=>e.type==="translation-start")){const k=e.first||"";startsBySource.set(k,(startsBySource.get(k)||0)+1)}assert.ok([...startsBySource.values()].every(n=>n===1),"full-SRT and foreground issued duplicate requests for the same block");assert.ok(!r.events.some(e=>e.type==="translation-aborted"&&e.t>=cancelled.t),"cancelling full-SRT aborted a request potentially shared with foreground")}
if(name==="netflix-happy"){
  // Netflix 是句级人工成品字幕轨（TTML/IMSC1，无词级时间），与 YouTube ASR 的
  // 形态完全不同，下面每条都断言真实行为，不是"没报错就算过"。
  const fetched=r.events.filter(e=>e.type==="ttml-fetch").length;
  assert.equal(fetched,1,"Netflix 轨没被下载或被重复下载: "+fetched);
  // ① 注入活性：原生字幕真的被隐藏过（不是只加了 class 不生效）
  assert.ok(r.paints.some(p=>p.nativeHidden&&p.nativeDisplay==="none"),"Netflix 原生字幕容器没被真正隐藏");
  // ② 渲染活性：原文与译文都真上过屏
  const painted=r.paints.filter(p=>p.orig&&p.trans&&p.trans!=="翻译中…");
  assert.ok(painted.length,"Netflix 双语没上屏");
  // ③ 标点必须保留。句级人工字幕自带标点，而句号是最强分屏信号；
  //    canonical token 流曾用剥标点的 restoredWords 切词，导致整轨标点全灭。
  assert.ok(painted.some(p=>/[.!?]/.test(p.orig)),"Netflix 原文标点被吃掉了: "+JSON.stringify(painted[0].orig));
  // ④ 合法重复台词一个都不能少。注意：渲染与导出的文本来自 canonical token 流，
  //    它本身不做重发去重，所以这条断言不能用来验 rollingSource 开关（实测把
  //    rollingSource 强设成 true，这里仍然全绿）。rollingSource 的承重门禁在
  //    test/run-tests.js 的 resegmentCues 用例里，带负向验证。这里守的是
  //    「整条链路端到端没吞词」。
  const srt=(r.exportSrt&&r.exportSrt.units||[]).map(u=>u.originalText).join(" ");
  assert.ok(/It works\. It works like crazy!/.test(srt),"合法重复台词被当滚动重发删了: "+srt);
  assert.equal((srt.match(/Tobes/g)||[]).length,3,"Tobes 重复次数不对: "+srt);
  assert.ok(/He almost\.\.\. Almost what\?/.test(srt),"83ms 间隙的相邻台词被误删: "+srt);
  // ⑤ 双说话人分隔符 "-" 必须还在（剥音效不能顺手吃掉它）
  assert.ok(/- Tobes!/.test(srt),"说话人分隔符丢了: "+srt);
  // ⑥ startMs 红线：导出单元的起点必须来自源轨，一个都不许改
  const first=(r.exportSrt&&r.exportSrt.units||[])[0];
  assert.equal(first&&first.startMs,300,"首单元起点偏离源轨 300ms");
}
if(name==="priority-overtake"){assert.equal(r.fullSrtStatus&&r.fullSrtStatus.status,"completed","priority fixture did not finish full SRT");const seek=r.events.find(e=>e.type==="priority-seek");assert.ok(seek,"priority seek missing");const startsForTarget=r.events.filter(e=>e.type==="translation-start"&&/^unit1[2-9]\b|^unit2[0-3]\b/.test(e.first||""));assert.equal(startsForTarget.length,1,"seek duplicated a block already being translated by full-SRT");const abortAfterSeek=r.events.filter(e=>e.type==="translation-aborted"&&e.t>=seek.t);assert.equal(abortAfterSeek.length,0,"seek aborted shared in-flight block");assert.ok(r.events.some(e=>e.type==="translation-ready"&&e.t>seek.t),"shared block never completed after seek") }if(name==="track-switch-race"){assert.ok(r.events.some(x=>x.type==="track-fetch-aborted"&&x.track==="slowA"),"old source-track fetch was not actively aborted");assert.ok(!r.paints.some(x=>String(x.orig||"").includes("stale first track")),"stale source track reached DOM");assert.ok(r.paints.some(x=>String(x.orig||"").includes("fresh second track wins")),"new source track never painted");assert.ok((r.exportSrt.units||[]).some(x=>String(x.originalText||"").includes("fresh second track wins")),"SRT snapshot did not belong to new source track")}}
(async()=>{const server=await serve(),port=server.address().port,cdp=await connect();try{for(const name of scenarios){const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"});const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true});await cdp.send("Runtime.enable",{},sessionId);cdp.onEvent=m=>{if(m.method==="Fetch.requestPaused"&&m.sessionId===sessionId)fulfillFromDisk(cdp,sessionId,m)};const origin=originFor(name);await installOriginShim(cdp,sessionId,origin);await cdp.send("Page.navigate",{url:`${origin}/watch?scenario=${name}`},sessionId);const deadline=Date.now()+(name==="empty-track-exhaust"?14000:6000);let report;while(Date.now()<deadline){await new Promise(r=>setTimeout(r,100));const out=await cdp.send("Runtime.evaluate",{expression:"window.__report||null",returnByValue:true},sessionId);report=out.result.value;if(report&&report.finished)break}if(process.env.DUALSUB_REPLAY_DEBUG)console.log(JSON.stringify(report));check(name,report||{});await cdp.send("Target.closeTarget",{targetId});console.log(`PASS ${name}`)}console.log(`browser replay: ${scenarios.length}/${scenarios.length} scenarios passed`)}finally{server.close();if(typeof server.closeAllConnections==="function")server.closeAllConnections();cdp.ws.close()}})().catch(e=>{console.error(e.stack||e);process.exit(1)});
