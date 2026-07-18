// smoke_strength.js —— 力量语音引擎离线冒烟：模拟全菜单每动作每组每 segment 的 id 请求，
// 断言每个必念 id ∈ STRENGTH_VOICE 且文本非空；A1 轮换/去重；夜间池与力量池文本不撞车。
// 用法:  node scripts/smoke_strength.js
"use strict";
const path = require("path");
const APP = path.join(__dirname, "..", "app");
global.window = {};
require(path.join(APP, "program.js"));
require(path.join(APP, "audio", "strength_voice.js"));
let nightTexts = new Set();
try {
  require(path.join(APP, "audio", "manifest.js"));
  const byV = global.window.AUDIO_MANIFEST_BY_VOICE || {};
  const def = global.window.AUDIO_MANIFEST_DEFAULT;
  Object.keys((byV[def] || {})).forEach((t) => nightTexts.add(t));
} catch (e) { console.warn("WARN: 夜间 manifest 未加载:", e.message); }

const P = global.window.PROGRAM;
const V = global.window.STRENGTH_VOICE || {};
const SLOTS = global.window.STRENGTH_VOICE_SLOTS || { menuNames: {}, restBuckets: [45, 60, 75, 90, 120] };

let fails = 0;
const missing = new Set();
function need(id, ctx) {
  if (!id) return;
  if (!V[id] || !V[id].text) { missing.add(id + "   « " + ctx); fails++; }
}

// —— 与 app.js 同构的纯助手 ——
function voiceSubsFor(ex) {
  if (ex.voiceSubs && ex.voiceSubs.length) return ex.voiceSubs;
  return [{ id: ex.id, side: ex.perSide ? "single" : "double" }];
}
function segmentsFor(ex) {
  const subs = voiceSubsFor(ex), segs = [];
  subs.forEach((sub, j) => {
    const t = j > 0 ? ex.id + ".super.in." + j : null;
    if (sub.side === "single") {
      segs.push({ sub: sub.id, subOrder: j, enter: [t, sub.id + ".side.start.S"].filter(Boolean), sideOff: 0 });
      segs.push({ sub: sub.id, subOrder: j, enter: [sub.id + ".side.switch.S"], sideOff: 1 });
    } else segs.push({ sub: sub.id, subOrder: j, enter: [t].filter(Boolean), sideOff: 0 });
  });
  return segs;
}
function collectItems(sub, types, variant) {
  const order = { feel: 0, setup: 1, avoid: 2, watch: 3, breath: 4, regress: 5, progress: 6 };
  const seen = new Set(), items = [];
  for (const id in V) {
    const m = id.match(/^(.+)\.([a-z]+)\.(\d+)\.(S|L)$/);
    if (!m || m[1] !== sub || m[4] !== variant || types.indexOf(m[2]) < 0) continue;
    const item = m[1] + "." + m[2] + "." + m[3];
    if (seen.has(item)) continue;
    seen.add(item); items.push({ item, type: m[2], nn: +m[3] });
  }
  items.sort((a, b) => (order[a.type] - order[b.type]) || (a.nn - b.nn));
  return items.map((x) => x.item);
}
function pickCue(sub, o) {
  const pool = collectItems(sub, o.types, o.variant).filter((it) => !(o.exclude && o.exclude.has(it)));
  if (!pool.length) return null;
  return pool[((o.rotate % pool.length) + pool.length) % pool.length];
}
function restBucket(sec) {
  const b = SLOTS.restBuckets;
  return b.indexOf(sec) >= 0 ? sec : b.reduce((x, y) => (Math.abs(y - sec) < Math.abs(x - sec) ? y : x), b[0]);
}
function warmLead(step, menuId, w6) {
  if (step.byMenu) return step.byMenu[menuId] + "_LEAD";
  if (step.pick) return w6 + "_LEAD";
  return step.id + "_LEAD";
}
function warmPrefix(step, w6) {
  if (step.byMenu) return "W7";
  if (step.pick) return w6;
  return step.id;
}

// —— 通用词固定检查 ——
["G_GO", "G_FOCUS"].forEach((id) => need(id, "通用"));
[["G_SETEND", 5], ["G_LAST", 4], ["G_TIMER", 4], ["G_MAIN", 4], ["G_FIN", 5]].forEach(([p, n]) => {
  for (let i = 1; i <= n; i++) need(p + "_0" + i, "通用序列");
});

// —— 模拟每菜单 ——
for (const mid of Object.keys(P.menus)) {
  const menu = P.menus[mid];
  const short = SLOTS.menuNames[mid];
  for (let i = 1; i <= 6; i++) need("G_OPEN_0" + i + "__" + short, "开场 " + mid);
  // 热身：W6 两个变体都验；W7 验本菜单变体
  P.warmup.steps.forEach((step) => {
    const w6s = step.pick ? step.pick : [null];
    w6s.forEach((w6) => {
      need(warmLead(step, mid, w6), "热身LEAD " + step.id);
      if (step.side === "single") {
        const pre = warmPrefix(step, w6);
        need(pre + ".side.start.S", "热身起边 " + pre);
        need(pre + ".side.switch.S", "热身换边 " + pre);
      }
    });
  });
  // 正课
  menu.exercises.forEach((ex) => {
    need(ex.id + "_LEAD", "动作LEAD " + ex.id);
    need(ex.id + "_END", "动作记录句 " + ex.id);
    const segs = segmentsFor(ex);
    for (let s = 0; s < ex.sets; s++) {
      const used = new Set();
      segs.forEach((seg) => {
        seg.enter.forEach((id) => need(id, "segment enter " + ex.id + " set" + s));
        const item = pickCue(seg.sub, { types: ["feel", "setup", "avoid"], variant: "S", rotate: s + seg.sideOff, exclude: used });
        if (item) { need(item + ".S", "组中S " + ex.id); used.add(item); }
        need(seg.sub + ".watch.01.L", "安全句 " + seg.sub);
      });
      if (s < ex.sets - 1) {
        need("G_REST__" + restBucket(ex.restSec), "休息 " + ex.id);
        const restSub = ex.type === "superset" ? segs[0].sub : ex.id;
        const it = pickCue(restSub, { types: ["setup", "avoid", "watch", "breath", "regress"], variant: "L", rotate: s, exclude: used });
        if (it) need(it + ".L", "休息L " + restSub);
      }
    }
  });
}

// —— A1 轮换/去重 ——
(function () {
  const a1 = P.menus.A.exercises.find((e) => e.id === "A1");
  const picks = [];
  for (let s = 0; s < a1.sets; s++) {
    const used = new Set();
    const it = pickCue("A1", { types: ["feel", "setup", "avoid"], variant: "S", rotate: s, exclude: used });
    picks.push(it);
  }
  if (new Set(picks).size < 2) { console.error("A1 组中S 未跨组轮换:", picks); fails++; }
  else console.log("A1 组中S 轮换:", picks.join(" / "));
  // 组内去重：模拟一组里 S 选后 L 排除
  const used = new Set();
  const sItem = pickCue("A1", { types: ["feel", "setup", "avoid"], variant: "S", rotate: 0, exclude: used });
  used.add(sItem);
  const lItem = pickCue("A1", { types: ["setup", "avoid", "watch", "breath", "regress"], variant: "L", rotate: 0, exclude: used });
  if (sItem && lItem && sItem === lItem) { console.error("A1 组内 S/L 撞同一内容项:", sItem); fails++; }
})();

// —— 夜间池 vs 力量池：文本不撞车 ——
(function () {
  let hit = 0;
  for (const id in V) if (nightTexts.has(V[id].text)) { if (hit < 5) console.error("撞车文本:", V[id].text); hit++; }
  if (hit) { console.error("夜间/力量文本撞车 " + hit + " 条"); fails++; }
  else console.log("夜间池(" + nightTexts.size + ") 与力量池文本无交集 ✓");
})();

console.log("\nSTRENGTH_VOICE id 数:", Object.keys(V).length);
if (missing.size) { console.error("\n缺失/空文本 id (" + missing.size + "):"); [...missing].slice(0, 40).forEach((m) => console.error("  " + m)); }
console.log(fails ? "\n✗ 冒烟失败，问题数: " + fails : "\n✓ 冒烟全过");
process.exit(fails ? 1 : 0);
