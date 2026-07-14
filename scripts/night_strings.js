// night_strings.js —— 从 app/program.js 精确提取「夜间放松」会经 say() 出声的全部固定台词。
// 用 window 桩加载 program.js，按 app.js 的出声逻辑组装字符串集合，去重后写 night_strings.json。
// 力量训练台词（含动态数字）不在此列，保持浏览器 TTS。
// 用法:  node scripts/night_strings.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app", "program.js"), "utf8"), sandbox);

const night = sandbox.window.PROGRAM.night;
const set = new Set();

// 开场句（startNight）
(night.intro || []).forEach((s) => set.add(s));

night.steps.forEach((step, i) => {
  // 步骤名：非首个呼吸步直接念名（renderNightStep else 分支）
  set.add(step.name);
  // 首个呼吸步的引导长句（renderNightStep if 分支）——E1 实际触发；E2 防跳过一并烧
  if (i < 2) set.add(step.name + "。跟着提示音走，升调吸气，降调呼气。");
  // 呼气间隙随机念的要点池（startBreathCoach，E1–E4 全部）
  (step.points || []).forEach((p) => set.add(p));
});

// 结尾句（finishNight）+ 兜底句（与 outro[0] 相同，Set 自动去重）
(night.outro || []).forEach((s) => set.add(s));
set.add("放松完成，做完直接睡吧。");

// 记录后（commitNight）
set.add("已记录，晚安。");

const list = [...set];
fs.writeFileSync(path.join(__dirname, "night_strings.json"), JSON.stringify(list, null, 2), "utf8");
console.log("night strings:", list.length);
list.forEach((s, i) => console.log(String(i + 1).padStart(2), s));
