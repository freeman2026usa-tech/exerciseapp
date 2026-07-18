// strength_voice.js —— 从「语音稿.md」力量段精确提取全部录音行，生成力量语音的两份产物：
//   ① app/audio/strength_voice.js  = window.STRENGTH_VOICE {id:{text,rate}} + window.STRENGTH_VOICE_SLOTS
//      （运行时引擎按 id 取文本；力量与夜间共用 say()/sayThen() 文本键出声缝，这里只提供“id→文本”内容表）
//   ② scripts/strength_texts.json  = 按文本去重后的 [{text,rate,phase}]（烧录输入；gen_audio_strength.py 用）
//
// 槽位 {{菜单名}}/{{歇}} 在生成期展开成具体 id/文本（G_OPEN_01__拉、G_REST__90），配置驱动、不硬编码进烧录脚本。
// 力量段只认反引号包裹 ID 且末列为语速档 {0.9,0.95,1.0,1.05} 的表行；§三内容模型表/间隔表因末列非语速档天然排除。
//
// 用法:  node scripts/strength_voice.js  [语音稿.md 的路径]
"use strict";
const fs = require("fs");
const path = require("path");

// ---- 配置（槽位取值；菜单短名 ≠ program.js 的 title；休息秒集合见 program.js 各 restSec）----
const SLOTS = {
  menuNames: { A: "推", B: "拉", C: "肩与体态", D: "腿与核心" },
  restBuckets: [45, 60, 75, 90, 120],
};
const RATES = new Set([0.9, 0.95, 1.0, 1.05]);

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const MD_PATH = process.argv[2] ||
  "C:\\Users\\Administrator\\Claude\\Projects\\健身\\语音稿.md";
const OUT_JS = path.join(ROOT, "app", "audio", "strength_voice.js");
const OUT_JSON = path.join(HERE, "strength_texts.json");

// ---- 汉字数字（休息秒转中文，让 TTS 读对：90→九十）----
function cn(n) {
  n = Math.round(+n || 0);
  const d = "零一二三四五六七八九";
  if (n < 10) return d[n];
  if (n < 20) return "十" + (n % 10 ? d[n % 10] : "");
  if (n < 100) return d[Math.floor(n / 10)] + "十" + (n % 10 ? d[n % 10] : "");
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return d[h] + "百" + (r ? (r < 10 ? "零" + cn(r) : cn(r)) : ""); }
  return String(n);
}

function fail(msg) { console.error("ERR: " + msg); process.exit(1); }

// ---- 读 md，截出「## 力量语音」到「## 夜间语音」之间 ----
if (!fs.existsSync(MD_PATH)) fail("找不到语音稿: " + MD_PATH);
const all = fs.readFileSync(MD_PATH, "utf8").split(/\r?\n/);
let inSec = false;
const secLines = [];
for (const ln of all) {
  if (/^## 力量语音/.test(ln)) { inSec = true; continue; }
  if (/^## 夜间语音/.test(ln)) { inSec = false; continue; }
  if (inSec) secLines.push(ln);
}
if (!secLines.length) fail("未截到力量语音段");

// ---- 抽录音行： | `ID` | 文本 | 语速 | ----
const ROW = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*(0\.9|0\.95|1\.0|1\.05)\s*\|\s*$/;
const raw = []; // {id,text,rate}
const seenId = new Set();
for (const ln of secLines) {
  const m = ROW.exec(ln);
  if (!m) continue;
  const id = m[1].trim(), text = m[2].trim(), rate = parseFloat(m[3]);
  if (!RATES.has(rate)) fail("非法语速 " + rate + " @ " + id);
  if (seenId.has(id)) fail("重复 ID: " + id);
  seenId.add(id);
  raw.push({ id, text, rate });
}
console.log("原始录音行:", raw.length);

// ---- 校验：原始计数（防解析漂移）----
const rawTiers = {};
raw.forEach((r) => (rawTiers[r.rate] = (rawTiers[r.rate] || 0) + 1));
const rawTexts = new Set(raw.map((r) => r.text));
console.log("原始唯一文本:", rawTexts.size, "| 语速档:", JSON.stringify(rawTiers));

// ---- 槽位展开 ----
// id 的相位键（分期烧录用）：DV 先于 D 判定
function phaseOf(id) {
  if (id.startsWith("G_")) return "G";
  if (/^W/.test(id)) return "W";
  if (id.startsWith("DV")) return "DV";
  if (/^A/.test(id)) return "A";
  if (/^B/.test(id)) return "B";
  if (/^C/.test(id)) return "C";
  if (/^D/.test(id)) return "D";
  return "?";
}

const VOICE = {}; // id -> {text,rate}
function put(id, text, rate) {
  if (VOICE[id]) fail("展开后 id 冲突: " + id);
  VOICE[id] = { text, rate };
}

for (const r of raw) {
  const hasMenu = r.text.includes("{{菜单名}}");
  const hasRest = r.text.includes("{{歇}}");
  if (hasMenu && hasRest) fail("同一行含两种槽位，未支持: " + r.id);
  if (hasMenu) {
    for (const [mk, mn] of Object.entries(SLOTS.menuNames)) {
      put(r.id + "__" + mn, r.text.replace(/\{\{菜单名\}\}/g, mn), r.rate);
    }
  } else if (hasRest) {
    for (const sec of SLOTS.restBuckets) {
      put("G_REST__" + sec, r.text.replace(/\{\{歇\}\}/g, cn(sec) + "秒").replace(/秒秒/g, "秒"), r.rate);
    }
  } else {
    put(r.id, r.text, r.rate);
  }
}

// ---- 校验：无残留槽位 ----
for (const [id, v] of Object.entries(VOICE)) {
  if (v.text.includes("{{")) fail("残留未展开槽位 @ " + id + ": " + v.text);
}

// ---- 校验：菜单覆盖（A–D 各 6 个 G_OPEN 变体齐）----
for (const mn of Object.values(SLOTS.menuNames)) {
  for (let n = 1; n <= 6; n++) {
    const id = "G_OPEN_0" + n + "__" + mn;
    if (!VOICE[id]) fail("缺 G_OPEN 变体: " + id);
  }
}
// ---- 校验：restBuckets 每值都被 program.js 某动作 restSec 用到 ----
try {
  const prog = fs.readFileSync(path.join(ROOT, "app", "program.js"), "utf8");
  const usedRest = new Set((prog.match(/restSec:\s*(\d+)/g) || []).map((s) => parseInt(s.replace(/\D/g, ""), 10)));
  for (const sec of SLOTS.restBuckets) {
    if (!usedRest.has(sec)) console.warn("WARN: restBucket " + sec + " 未被任何 restSec 使用（仍会烧）");
  }
  for (const sec of usedRest) {
    if (!SLOTS.restBuckets.includes(sec)) fail("program.js 有 restSec=" + sec + " 但 restBuckets 里没有，G_REST 会漏音频");
  }
} catch (e) { console.warn("WARN: 无法核对 program.js restSec:", e.message); }

// ---- 去重文本（烧录输入）；同文多档挑 1.0（否则挑最小档）----
const byText = new Map(); // text -> {text,rate,phases:Set}
for (const [id, v] of Object.entries(VOICE)) {
  const ph = phaseOf(id);
  const cur = byText.get(v.text);
  if (!cur) { byText.set(v.text, { text: v.text, rate: v.rate, phases: new Set([ph]) }); }
  else {
    cur.phases.add(ph);
    if (cur.rate !== v.rate) cur.rate = 1.0; // 冲突：统一 1.0（全 1.0 烧时本就无差别）
  }
}
const texts = [...byText.values()].map((e) => ({ text: e.text, rate: e.rate, phase: [...e.phases].sort().join(",") }));

// ---- 写产物 ----
const header =
  "/*\n" +
  " * app/audio/strength_voice.js —— 力量语音内容表（id→文本），由 scripts/strength_voice.js 从 语音稿.md 生成。\n" +
  " * 自动生成，勿手改；改台词请改 语音稿.md 后重跑。运行时引擎按 id 取文本，交给共用 say()/sayThen() 文本键出声。\n" +
  " * 仅力量；夜间用 audio/manifest.js。\n" +
  " */\n";
const body =
  "window.STRENGTH_VOICE = " + JSON.stringify(VOICE, null, 0).replace(/\},"/g, "},\n\"").replace(/^\{/, "{\n").replace(/\}$/, "\n}") + ";\n" +
  "window.STRENGTH_VOICE_SLOTS = " + JSON.stringify(SLOTS) + ";\n";
fs.writeFileSync(OUT_JS, header + body, "utf8");
fs.writeFileSync(OUT_JSON, JSON.stringify(texts, null, 2), "utf8");

console.log("展开后 STRENGTH_VOICE id 数:", Object.keys(VOICE).length);
console.log("去重后烧录文本数:", texts.length);
console.log("写出:", path.relative(ROOT, OUT_JS), "+", path.relative(ROOT, OUT_JSON));
