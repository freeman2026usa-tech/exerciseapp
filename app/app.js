/* app.js —— 健身伴侣工具 · 训练中引导播放器
 * 状态机：home → warmup → player ⇄ rest → summary
 * 依赖 program.js（window.PROGRAM）。数据存 localStorage，完全离线自包含。
 */
(function () {
  "use strict";

  const P = window.PROGRAM;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $("#app");

  /* ============================ 存储 ============================ */
  const KEY = "exerciseCompanion.v1";
  const defaultState = {
    cycleIndex: 0, // 指向 P.meta.cycle 的下一张
    progression: {}, // exerciseId -> [{reps, weight}, ...]（上次各组）
    logs: [], // 历史训练记录（最新在末尾）
    ladders: { pushup: P.ladders.pushup.current, pullup: P.ladders.pullup.current },
    overrides: {}, // exerciseId -> 用户在 App 内改的字段（覆盖 program.js 默认值）
    night: { logs: [] }, // 夜间放松打卡（独立于力量历史，无循环/进阶）
    settings: {
      voiceOn: true, rate: 1, weightStep: 1, voiceURI: null, autoAdvance: true,
      vol: { voice: 1, music: 0.5, tone: 0.7 }, // 语音 / 背景音乐 / 提示音 各自音量 0–1
      musicTrack: "off", // 背景音乐：off=关闭（默认）；synth=生成式轻音；或 tracks.js 里 mp3 的 name
    },
  };
  let S = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(defaultState);
      const parsed = JSON.parse(raw);
      const merged = Object.assign(structuredClone(defaultState), parsed, {
        settings: Object.assign({}, defaultState.settings, parsed.settings || {}),
      });
      merged.settings.vol = Object.assign({}, defaultState.settings.vol, (parsed.settings && parsed.settings.vol) || {});
      return merged;
    } catch (e) {
      console.warn("读取存档失败，用默认值", e);
      return structuredClone(defaultState);
    }
  }
  function saveState() {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
    } catch (e) {
      console.warn("保存失败", e);
    }
  }

  /* ============================ 语音 & 提示音 ============================ */
  const Voice = {
    supported: "speechSynthesis" in window,
    zh: null,
    hasZh: false,
    zhList: [],
    refresh() {
      if (!this.supported) return;
      const vs = window.speechSynthesis.getVoices() || [];
      this.zhList = vs.filter((v) => /zh|cmn|Chinese/i.test(v.lang + v.name));
      const chosen = S.settings.voiceURI && vs.find((v) => v.voiceURI === S.settings.voiceURI);
      this.zh = chosen || this.zhList[0] || null;
      this.hasZh = this.zhList.length > 0;
    },
    list() { this.refresh(); return this.zhList; },
    speak(text, { flush = false, force = false } = {}) {
      if (!S.settings.voiceOn || !this.supported || !text) return;
      if (!this.hasZh) this.refresh();
      if (!this.hasZh && !force) return; // 无中文语音引擎：跳过播报，别用英文乱读，靠提示音+大字
      const doSpeak = () => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-CN";
        u.rate = S.settings.rate || 1;
        u.volume = (S.settings.vol && S.settings.vol.voice != null) ? S.settings.vol.voice : 1;
        if (this.zh) u.voice = this.zh;
        u.onstart = () => Music.duck(true);   // 说话时压低背景音乐
        u.onend = () => Music.duck(false);
        u.onerror = () => Music.duck(false);
        window.speechSynthesis.speak(u);
      };
      if (flush) {
        window.speechSynthesis.cancel();
        setTimeout(doSpeak, 60); // 规避 Chrome：cancel 紧跟 speak 会被吞掉
      } else {
        doSpeak();
      }
    },
    test() {
      if (!this.supported) return toast("不支持语音", "这个浏览器不支持语音合成。");
      this.refresh();
      if (!this.hasZh) return toast("未检测到中文语音", "先装中文语音包，点「如何安装」。");
      const prev = S.settings.voiceOn;
      S.settings.voiceOn = true;
      this.speak("语音测试。中立握俯卧撑，第一组，共四组。", { flush: true, force: true });
      S.settings.voiceOn = prev;
    },
    stop() {
      if (this.supported) window.speechSynthesis.cancel();
    },
  };
  if (Voice.supported) {
    Voice.refresh();
    let lastHasZh = Voice.hasZh;
    window.speechSynthesis.onvoiceschanged = () => {
      Voice.refresh();
      if (Voice.hasZh !== lastHasZh) {
        lastHasZh = Voice.hasZh;
        // 中文语音可用性变化时才刷新主页（仅当停在主板块页），避免打断交互
        if (!session && !nightSession && document.getElementById("boardNight")) renderHome();
      }
    };
  }

  // 把用户在 App 内改过的字段合并到动作上（program.js 是默认值/出厂设置）
  function resolveEx(base) {
    const ov = S.overrides[base.id];
    return ov ? Object.assign({}, base, ov) : base;
  }
  function baseExercise(menuId, exId) {
    return P.menus[menuId].exercises.find((e) => e.id === exId);
  }
  // 夜间步骤也套用本地覆盖（台词界面可改要点池）
  function resolveStep(base) {
    const ov = S.overrides[base.id];
    return ov ? Object.assign({}, base, ov) : base;
  }
  function findExerciseAnywhere(id) {
    for (const m of Object.values(P.menus)) {
      const e = m.exercises.find((x) => x.id === id);
      if (e) return e;
    }
    return null;
  }

  /* ---------- 音频套件：提示音 / 呼吸音 / 背景音乐 ---------- */
  let audioCtx = null;
  function ensureCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function toneVol() { return (S.settings.vol && S.settings.vol.tone != null) ? S.settings.vol.tone : 0.7; }

  // 单音（可滑音）；peak 相对音量，最终乘以"提示音"音量设置。
  function playTone(f0, dur, when, f1, peak) {
    const ctx = ensureCtx();
    if (!ctx || toneVol() <= 0) return;
    const t = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, t + dur);
    const pk = (peak == null ? 0.4 : peak) * toneVol();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, pk), t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }
  function beep(freq = 880, dur = 0.15, when = 0) { playTone(freq, dur, when, null, 0.4); }
  // 呼吸提示音：做成"呼吸感"长滑音——吸气=整段上行+渐强（像充盈），呼气=整段下行+渐弱（像泄出）。
  // 方向明显、时长不同，闭眼也一听就懂哪个是吸、哪个是呼。
  function breathTone(dir) {
    const ctx = ensureCtx();
    if (!ctx || toneVol() <= 0) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    const pk = 0.26 * toneVol();
    if (dir === "in") {
      const dur = 1.3;
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.linearRampToValueAtTime(660, t + dur); // 明显上行
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(pk, t + dur * 0.72); // 渐强（吸气充盈）
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + dur + 0.2);
    } else {
      const dur = 1.9;
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.linearRampToValueAtTime(300, t + dur); // 明显下行
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(pk, t + 0.18); // 快起
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur); // 渐弱（呼气泄出）
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + dur + 0.2);
    }
  }

  /* ---------- 背景音乐：柔和生成式氛围（钟琴+底垫，非白噪音）/ 或自己放的 mp3；说话时 ducking ---------- */
  const Music = {
    playing: false, kind: null, nodes: null, el: null, ducked: false, bellTimer: null,
    _baseGain() { return (S.settings.vol && S.settings.vol.music != null) ? S.settings.vol.music : 0.5; },
    start(trackName) {
      this.stop();
      if (!trackName || trackName === "off" || trackName === "关闭") return;
      const track = (window.MUSIC_TRACKS || []).find((t) => t.name === trackName)
        || (trackName === "synth" ? { type: "synth" } : null);
      if (!track) return;
      const vol = this._baseGain();
      if (vol <= 0) return;
      if (track.type === "file" && track.file) {
        const el = new Audio(track.file);
        el.loop = true; el.volume = vol;
        el.play().catch(() => {});
        this.el = el; this.kind = "file"; this.playing = true;
      } else {
        this._startGenerative(vol);
      }
      this.ducked = false;
    },
    // 柔和生成式氛围：低频暖底垫 + 五声音阶钟琴（慢速随机、长衰减），比之前的低频嗡鸣好听得多
    _startGenerative(vol) {
      const ctx = ensureCtx();
      if (!ctx) return;
      const master = ctx.createGain();
      master.gain.value = vol * 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1600;
      master.connect(lp).connect(ctx.destination);
      // 暖底垫（两只很轻的低频）
      const pad = ctx.createGain(); pad.gain.value = 0.1; pad.connect(master);
      const padOscs = [110, 164.8].map((f) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = 0.5; o.connect(g).connect(pad); o.start();
        return o;
      });
      // 钟琴：C 大调五声（C D E G A），偶尔降八度
      const scale = [523.25, 587.33, 659.25, 783.99, 880];
      const self = this;
      const bell = () => {
        if (!self.playing) return;
        const base = scale[Math.floor(Math.random() * scale.length)];
        const f = Math.random() < 0.3 ? base / 2 : base;
        const t = ctx.currentTime;
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.06); // 柔和起音
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6); // 长衰减
        o.connect(g).connect(master);
        o.start(t); o.stop(t + 3.7);
      };
      this.bellTimer = setInterval(bell, 2600);
      bell();
      this.nodes = { master, padOscs }; this.kind = "synth"; this.playing = true;
    },
    stop() {
      try {
        if (this.bellTimer) { clearInterval(this.bellTimer); this.bellTimer = null; }
        if (this.el) { this.el.pause(); this.el = null; }
        if (this.nodes) {
          (this.nodes.padOscs || []).forEach((o) => { try { o.stop(); } catch (e) {} });
          this.nodes = null;
        }
      } catch (e) {}
      this.playing = false; this.kind = null; this.ducked = false;
    },
    setVolume(v) {
      if (this.kind === "file" && this.el) this.el.volume = Math.max(0, v);
      else if (this.kind === "synth" && this.nodes) this.nodes.master.gain.value = Math.max(0, v) * 0.6;
    },
    duck(on) {
      if (!this.playing || this.ducked === on) return;
      this.ducked = on;
      const base = this._baseGain();
      this.setVolume(on ? base * 0.3 : base);
    },
  };

  // 渲染层唯一出声入口（接口缝）：预渲染 clip → 运行时大模型适配器 → 浏览器 TTS 兜底。
  // 以后"换大模型渲染音频"只动这里 + 跑生成脚本；内容/编排/UI 全不改。
  function say(text, opts) {
    if (!S.settings.voiceOn || !text) return;
    const manifest = window.AUDIO_MANIFEST; // Phase 2：{ 文本: "audio/xxx.mp3" }
    if (manifest && manifest[text]) return playClip(manifest[text], opts, text);
    if (typeof window.AI_TTS === "function") return window.AI_TTS(text, opts); // 可插拔运行时（默认无）
    Voice.speak(text, opts); // 兜底
  }
  // 播放预渲染音频 clip（Phase 2 用）；说话时同样 ducking 背景音乐，出错退回 TTS
  function playClip(src, opts, text) {
    try {
      if (opts && opts.flush && window.speechSynthesis) window.speechSynthesis.cancel();
      Music.duck(true);
      const a = new Audio(src);
      a.volume = (S.settings.vol && S.settings.vol.voice != null) ? S.settings.vol.voice : 1;
      a.onended = () => Music.duck(false);
      a.onerror = () => { Music.duck(false); Voice.speak(text, opts); };
      a.play().catch(() => { Music.duck(false); });
    } catch (e) { Voice.speak(text, opts); }
  }

  /* ---------- 屏幕常亮（Wake Lock） ---------- */
  let wakeLock = null;
  function acquireWakeLock() {
    try { if ("wakeLock" in navigator && !wakeLock) navigator.wakeLock.request("screen").then((w) => { wakeLock = w; }).catch(() => {}); } catch (e) {}
  }
  function releaseWakeLock() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (session || nightSession)) acquireWakeLock();
  });

  /* ============================ 进阶引擎 ============================ */
  // 依据「训练总目录」双重渐进：先加次数，到区间上限再加难度。器械固定 10kg → 用放慢离心/停顿替代加重。
  function computeTarget(ex) {
    const last = S.progression[ex.id]; // [{reps,weight}]
    const range = ex.repRange || [8, 12];
    if (!ex.weighted) {
      // 徒手 / 带辅助：只看次数
      let repPrefill = range[1];
      let note = "首次做这个动作：以标准姿势为准，做到 " + ex.repLabel + "。";
      if (last && last.length) {
        const maxReps = Math.max(...last.map((s) => s.reps || 0));
        const allTop = last.every((s) => (s.reps || 0) >= range[1]);
        repPrefill = maxReps || range[1];
        if (ex.ladder && allTop) {
          const lad = P.ladders[ex.ladder];
          const nextStep = lad.steps[Math.min(S.ladders[ex.ladder] + 1, lad.steps.length - 1)];
          note = "上次各组都到 " + range[1] + "+，达标可升阶梯 →「" + nextStep + "」。";
        } else if (allTop) {
          note = "上次各组都到上限，这次放慢离心或顶端多停 1 秒加难度。";
        } else {
          note = "上次最多 " + maxReps + " 次，这次争取每组比上次多 1 个。";
        }
      }
      return { repPrefill, weightPrefill: null, note };
    }
    // 哑铃：双重渐进
    let weightPrefill = ex.defaultWeight || 10;
    let repPrefill = range[0];
    let note = "首次：用能标准完成 " + range[0] + " 次的重量起步（现有 10kg，偏重可单手或减幅度）。";
    if (last && last.length) {
      const w = last[last.length - 1].weight || weightPrefill;
      weightPrefill = w;
      const allTop = last.every((s) => (s.reps || 0) >= range[1]);
      repPrefill = allTop ? range[1] : range[0];
      if (allTop) {
        note = P.meta.weightAdjustable
          ? "上次 " + w + "kg 各组都到 " + range[1] + " → 这次加重量。"
          : "上次 " + w + "kg 各组都到 " + range[1] + " → 哑铃固定 10kg，这次放慢离心到 4 秒或顶端多停 1 秒。";
      } else {
        note = "维持 " + w + "kg，争取每组多做 1 次，练到 " + range[1] + "。";
      }
    }
    return { repPrefill, weightPrefill, note };
  }

  /* ============================ 会话状态 ============================ */
  let session = null; // 力量会话
  let nightSession = null; // 夜间放松会话
  let restTimer = null, nightTimer = null, transTimer = null, breathTimer = null, breathTimeout = null, introTimer = null;
  let paused = false;

  function suggestedMenuId() {
    return P.meta.cycle[S.cycleIndex % P.meta.cycle.length];
  }

  function startSession(menuId, opts) {
    opts = opts || {};
    const menu = P.menus[menuId];
    let exercises = menu.exercises.map(resolveEx);
    if (opts.trimLast) {
      // 时间紧：砍掉最后一个「可选」辅助动作
      const idx = [...exercises].reverse().findIndex((e) => e.optional);
      if (idx !== -1) exercises.splice(exercises.length - 1 - idx, 1);
    }
    session = {
      menuId,
      menu,
      exercises,
      exIndex: 0,
      setIndex: 0,
      logs: {}, // exId -> [{reps,weight,rir,pain}]
      startedAt: new Date().toISOString(),
    };
    acquireWakeLock();
    renderWarmup();
  }

  /* ============================ 视图：主页（选板块） ============================ */
  function renderHome() {
    stopRest();
    Voice.stop();
    Voice.refresh();
    Music.stop();
    releaseWakeLock();
    session = null;
    nightSession = null;
    const lastLog = S.logs[S.logs.length - 1];
    const lastNight = S.night.logs[S.night.logs.length - 1];
    app.innerHTML = `
      <section class="screen home">
        <header class="home-head">
          <h1>健身伴侣 <span class="sub">${P.meta.goal}</span></h1>
          <div class="stage">${P.meta.stage} · ${P.meta.version}</div>
        </header>

        <div class="board-cards">
          <div class="board-card strength" id="boardStrength" role="button" tabindex="0">
            <div class="board-emoji">💪</div>
            <div class="board-name">力量训练</div>
            <div class="board-desc">四菜单循环 · 倒三角</div>
            <div class="board-sub">${lastLog ? "上次 " + fmtDate(lastLog.date) + " · 菜单 " + lastLog.menuId : "还没练过"}</div>
          </div>
          <div class="board-card night" id="boardNight" role="button" tabindex="0">
            <div class="board-emoji">🌙</div>
            <div class="board-name">夜间放松</div>
            <div class="board-desc">睡前 10 分钟 · E1–E4</div>
            <div class="board-sub">${lastNight ? "上次 " + fmtDate(lastNight.date) : "还没做过"}</div>
          </div>
        </div>

        ${voiceSettingsHtml()}

        <div class="foot-links">
          <button class="link strong" id="scriptBtn">🗣 锻炼提示词</button>
          <button class="link" id="rulesBtn">护伤总则</button>
          <button class="link" id="logBtn">训练日志（${S.logs.length}）</button>
          <button class="link" id="nightLogBtn">夜间记录（${S.night.logs.length}）</button>
          <button class="link" id="exportBtn">导出备份</button>
          <button class="link" id="importBtn">导入备份</button>
          <input type="file" id="importFile" accept="application/json" hidden/>
        </div>
      </section>`;

    const goStrength = () => renderStrengthHome();
    $("#boardStrength").addEventListener("click", goStrength);
    $("#boardStrength").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") goStrength(); });
    $("#boardNight").addEventListener("click", () => startNight());
    $("#boardNight").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") startNight(); });
    wireVoiceSettings();
    $("#scriptBtn").addEventListener("click", showScript);
    $("#rulesBtn").addEventListener("click", showRules);
    $("#logBtn").addEventListener("click", showLog);
    $("#nightLogBtn").addEventListener("click", showNightLog);
    $("#exportBtn").addEventListener("click", exportBackup);
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", importBackup);
  }

  // 语音 + 设置卡（主页用）
  function voiceSettingsHtml() {
    const voices = Voice.list();
    const opts = voices
      .map((v) => `<option value="${escapeAttr(v.voiceURI)}" ${S.settings.voiceURI === v.voiceURI ? "selected" : ""}>${escapeHtml(v.name)}</option>`)
      .join("");
    return `
      <div class="settings-card">
        <div class="voice-status ${Voice.hasZh ? "ok" : "warn"}">
          <span class="vs-text">${Voice.hasZh ? "✅ 中文语音就绪" : "⚠ 未检测到中文语音（提示音和大字照常）"}</span>
          <span class="vs-btns"><button class="link" id="installVoice">${Voice.hasZh ? "想更好听？" : "如何安装"}</button></span>
        </div>
        ${Voice.hasZh ? `
        <div class="voice-pick">
          <label>声音</label>
          <select id="voiceSelect">${opts}</select>
          <button class="btn ghost sm" id="testVoice">试听</button>
        </div>` : ""}
        <div class="settings-row">
          <label class="toggle"><input type="checkbox" id="voiceToggle" ${S.settings.voiceOn ? "checked" : ""}/><span>🔊 语音</span></label>
          <label class="toggle"><input type="checkbox" id="autoToggle" ${S.settings.autoAdvance ? "checked" : ""}/><span>⚡ 自动进行</span></label>
          <label class="rate">语速 <input type="range" id="rateRange" min="0.6" max="1.4" step="0.1" value="${S.settings.rate}"/></label>
        </div>
        <div class="voice-pick">
          <label>音乐</label>
          <select id="musicSelect">${musicOptionsHtml()}</select>
        </div>
        <div class="vol-grid">
          <label>语音 <input type="range" id="volVoice" min="0" max="1" step="0.05" value="${S.settings.vol.voice}"/></label>
          <label>音乐 <input type="range" id="volMusic" min="0" max="1" step="0.05" value="${S.settings.vol.music}"/></label>
          <label>提示音 <input type="range" id="volTone" min="0" max="1" step="0.05" value="${S.settings.vol.tone}"/></label>
        </div>
      </div>`;
  }
  function musicOptionsHtml() {
    const cur = S.settings.musicTrack;
    const opts = [`<option value="off" ${cur === "off" || cur === "关闭" ? "selected" : ""}>关闭</option>`];
    (window.MUSIC_TRACKS || []).forEach((t) => {
      const val = t.type === "synth" ? "synth" : t.name;
      opts.push(`<option value="${escapeAttr(val)}" ${cur === val ? "selected" : ""}>${escapeHtml(t.name)}</option>`);
    });
    return opts.join("");
  }
  function wireVoiceSettings() {
    const sel = $("#voiceSelect");
    if (sel) sel.addEventListener("change", (e) => { S.settings.voiceURI = e.target.value; Voice.refresh(); saveState(); Voice.test(); });
    const tv = $("#testVoice");
    if (tv) tv.addEventListener("click", () => Voice.test());
    $("#installVoice").addEventListener("click", showVoiceInstall);
    $("#voiceToggle").addEventListener("change", (e) => { S.settings.voiceOn = e.target.checked; saveState(); if (S.settings.voiceOn) Voice.speak("语音已开启", { flush: true }); });
    $("#autoToggle").addEventListener("change", (e) => { S.settings.autoAdvance = e.target.checked; saveState(); });
    const rr = $("#rateRange");
    if (rr) rr.addEventListener("change", (e) => { S.settings.rate = parseFloat(e.target.value); saveState(); Voice.test(); });
    const ms = $("#musicSelect");
    if (ms) ms.addEventListener("change", (e) => {
      S.settings.musicTrack = e.target.value; saveState();
      Music.start(S.settings.musicTrack);
      if (!nightSession) setTimeout(() => { if (!nightSession) Music.stop(); }, 3000); // 主页试听 3 秒
    });
    const vv = $("#volVoice"); if (vv) vv.addEventListener("input", (e) => { S.settings.vol.voice = parseFloat(e.target.value); saveState(); });
    const vm = $("#volMusic"); if (vm) vm.addEventListener("input", (e) => { S.settings.vol.music = parseFloat(e.target.value); saveState(); Music.setVolume(Music._baseGain()); });
    const vt = $("#volTone"); if (vt) vt.addEventListener("input", (e) => { S.settings.vol.tone = parseFloat(e.target.value); saveState(); });
    const vtc = $("#volTone"); if (vtc) vtc.addEventListener("change", () => beep(660, 0.12)); // 松手试听提示音
  }

  /* ============================ 视图：力量子首页（选菜单） ============================ */
  function renderStrengthHome() {
    stopRest();
    Voice.stop();
    const sid = suggestedMenuId();
    const sm = P.menus[sid];
    const lastLog = S.logs[S.logs.length - 1];
    app.innerHTML = `
      <section class="screen home">
        <div class="crumb"><button class="link back" id="backHome">‹ 返回</button><span>💪 力量训练</span></div>
        <div class="suggest-card" id="startBtn" role="button" tabindex="0">
          <div class="suggest-label">今日建议</div>
          <div class="suggest-menu">菜单 ${sm.id} · ${sm.title}</div>
          <div class="suggest-count">${sm.exercises.length} 个动作 · 先热身 ${P.warmup.steps.length} 步</div>
          <div class="big-cta">▶ 开始今日训练</div>
        </div>
        <div class="menu-picker">
          <div class="picker-label">或手动选一张：</div>
          <div class="menu-btns">
            ${Object.values(P.menus).map((m) => `<button class="menu-btn" data-menu="${m.id}"><b>${m.id}</b>${m.title}</button>`).join("")}
          </div>
        </div>
        ${lastLog ? `<div class="last-log">上次：${fmtDate(lastLog.date)} · 菜单 ${lastLog.menuId} · ${lastLog.setCount} 组</div>` : ""}
      </section>`;
    $("#backHome").addEventListener("click", renderHome);
    $("#startBtn").addEventListener("click", () => startSession(sid));
    $("#startBtn").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") startSession(sid); });
    app.querySelectorAll(".menu-btn").forEach((b) => b.addEventListener("click", () => startSession(b.dataset.menu)));
  }

  /* ============================ 视图：热身 ============================ */
  function renderWarmup() {
    stopRest();
    Voice.speak("开始热身，" + P.warmup.steps.length + " 步，做完进入菜单 " + session.menuId, { flush: true });
    app.innerHTML = `
      <section class="screen warmup">
        <div class="crumb">菜单 ${session.menu.id} · ${session.menu.title}</div>
        <h2>热身（必做）</h2>
        <p class="hint">${P.warmup.note}</p>
        <ul class="check-list">
          ${P.warmup.steps
            .map(
              (s, i) => `
            <li class="check-item" data-i="${i}">
              <span class="ck"></span>
              <div>
                <div class="ci-name">${s.name} <em>${s.amount}</em></div>
                <div class="ci-purpose">${s.purpose}</div>
              </div>
            </li>`
            )
            .join("")}
        </ul>
        <div class="btn-row">
          <button class="btn ghost" id="skipWarm">跳过热身</button>
          <button class="btn primary" id="doneWarm">进入正式训练 ▶</button>
        </div>
      </section>`;

    app.querySelectorAll(".check-item").forEach((li) =>
      li.addEventListener("click", () => {
        li.classList.toggle("done");
        if (li.classList.contains("done")) {
          const s = P.warmup.steps[+li.dataset.i];
          Voice.speak(s.name, { flush: true });
        }
      })
    );
    $("#skipWarm").addEventListener("click", enterPlayer);
    $("#doneWarm").addEventListener("click", enterPlayer);
  }

  function enterPlayer() {
    session.exIndex = 0;
    session.setIndex = 0;
    renderPlayer();
  }

  /* ============================ 视图：训练播放器 ============================ */
  function renderPlayer() {
    stopRest();
    const ex = session.exercises[session.exIndex];
    const setNo = session.setIndex + 1;
    const isSuperset = ex.type === "superset";
    const tgt = computeTarget(ex);

    // 语音只报一句"练时该注意什么"（完整目标/要点看屏幕）
    Voice.speak(`${ex.name}，第 ${setNo} 组。${ex.voiceCue || ex.topCue}`, { flush: true });

    const targetHtml = isSuperset
      ? `<div class="target-grid">
           <div class="tg"><span>组合</span><b>${ex.supersetLabel}</b></div>
           <div class="tg"><span>节奏</span><b>慢而稳</b></div>
           <div class="tg"><span>组间歇</span><b>${ex.restSec}s</b></div>
         </div>`
      : `<div class="target-grid">
           <div class="tg"><span>目标</span><b>${ex.sets}×${ex.repLabel}</b></div>
           <div class="tg"><span>节奏</span><b>${ex.tempo || "—"}</b></div>
           ${ex.weighted ? `<div class="tg"><span>重量</span><b>${tgt.weightPrefill}kg</b></div>` : `<div class="tg"><span>RIR</span><b>${ex.rir != null ? ex.rir : "—"}</b></div>`}
           <div class="tg"><span>组间歇</span><b>${ex.restSec}s</b></div>
         </div>`;

    // 「怎么做」直接放到练的这一屏（不用点详情）
    const stepsHtml = (ex.steps || []).map((s) => `<li>${s}</li>`).join("");
    const supersetHow = ex.superset
      ? `<div class="superset-how">${ex.superset.map((s) => `<div><b>${s.name}（${s.reps}）</b>：${s.how}</div>`).join("")}</div>`
      : "";
    const howtoHtml = `
      <div class="howto">
        <div class="howto-title">怎么做</div>
        <ol class="howto-steps">${stepsHtml}</ol>
        ${supersetHow}
        <div class="feel-row">
          ${ex.feelGood ? `<div class="feel good">✅ 该有：${ex.feelGood}</div>` : ""}
          ${ex.feelBad ? `<div class="feel bad">🚫 不该有：${ex.feelBad}</div>` : ""}
        </div>
      </div>`;

    app.innerHTML = `
      <section class="screen player">
        <div class="crumb">
          <span>菜单 ${session.menu.id}</span>
          <span>动作 ${session.exIndex + 1}/${session.exercises.length}</span>
        </div>

        <div class="ex-id">${ex.id}</div>
        <h1 class="ex-name">${ex.name}</h1>
        <div class="set-counter">第 <b>${setNo}</b> / ${ex.sets} 组${ex.perSide ? " · 两侧都做" : ""}</div>

        ${targetHtml}

        <div class="cue-box">⚠ ${ex.topCue}</div>

        ${howtoHtml}

        <div class="prog-note">🎯 ${tgt.note}</div>

        <div class="done-row">
          <button class="btn primary huge" id="doneSet">✔ 完成（按计划）</button>
          <button class="btn ghost adjust" id="adjustSet">改一下</button>
        </div>

        <div class="more-row">
          <button class="btn ghost sm" id="detailBtn">📖 详情/编辑</button>
          <button class="btn ghost sm" id="easierBtn">太难→退阶</button>
          <button class="btn ghost sm" id="harderBtn">太易→进阶</button>
          <button class="btn ghost sm" id="skipEx">跳过</button>
          <button class="btn ghost sm" id="abortBtn">结束</button>
        </div>
      </section>`;

    $("#doneSet").addEventListener("click", () => quickLogSet(ex));
    $("#adjustSet").addEventListener("click", () => openRecord(ex));
    $("#detailBtn").addEventListener("click", () => showDetail(ex));
    $("#harderBtn").addEventListener("click", () => {
      Voice.speak("进阶：" + ex.progression, { flush: true });
      toast("进阶", ex.progression);
    });
    $("#easierBtn").addEventListener("click", () => {
      Voice.speak("退阶：" + ex.regression, { flush: true });
      toast("退阶", ex.regression);
    });
    $("#skipEx").addEventListener("click", () => {
      Voice.speak("跳过 " + ex.name, { flush: true });
      nextExercise();
    });
    $("#abortBtn").addEventListener("click", () => finishSession(true));
  }

  /* ---------- 记录浮层 ---------- */
  function openRecord(ex) {
    const isSuperset = ex.type === "superset";
    const tgt = computeTarget(ex);
    const last = S.progression[ex.id];
    const lastSet = last && last[session.setIndex];
    const repVal = (lastSet && lastSet.reps) || tgt.repPrefill || "";
    const wVal = (lastSet && lastSet.weight) || tgt.weightPrefill || "";

    const body = isSuperset
      ? `<p class="rec-superset">${ex.supersetLabel}</p>
         <div class="rec-field">
           <label>完成情况</label>
           <div class="pain-toggle"><button class="pt active" data-ok="1">✅ 完成</button></div>
         </div>`
      : `
        <div class="rec-field">
          <label>次数${ex.perSide ? "（每侧）" : ""}</label>
          ${stepper("recReps", repVal, 1, 0, 100)}
        </div>
        ${
          ex.weighted
            ? `<div class="rec-field"><label>重量 kg</label>${stepper("recWeight", wVal, S.settings.weightStep, 0, 60)}</div>`
            : ""
        }`;

    modal(
      `<h3>记录 · ${ex.id} 第 ${session.setIndex + 1} 组</h3>
       ${body}
       <div class="rec-field">
         <label>关节/疼痛</label>
         <div class="pain-toggle" id="painToggle">
           <button class="pt active" data-pain="0">无痛 👍</button>
           <button class="pt" data-pain="1">有点不适 ⚠</button>
         </div>
       </div>`,
      [
        { label: "保存 →", cls: "primary", onClick: () => saveSet(ex) },
      ],
      { size: "sheet" }
    );

    // 疼痛切换
    const pt = $("#painToggle");
    if (pt)
      pt.querySelectorAll(".pt").forEach((b) =>
        b.addEventListener("click", () => {
          pt.querySelectorAll(".pt").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
        })
      );
  }

  function saveSet(ex) {
    const painBtn = $("#painToggle .pt.active");
    const pain = painBtn ? painBtn.dataset.pain === "1" : false;
    const rec = { pain };
    if (ex.type !== "superset") {
      rec.reps = parseInt($("#recReps").value, 10) || 0;
      if (ex.weighted) rec.weight = parseFloat($("#recWeight").value) || 0;
    } else {
      rec.done = true;
    }
    if (!session.logs[ex.id]) session.logs[ex.id] = [];
    session.logs[ex.id][session.setIndex] = rec;
    closeModal();

    if (pain) Voice.speak("记下不适。若关节刺痛或异响伴痛，请停下换动作。", { flush: true });

    // 还有下一组？→ 休息；否则下一个动作
    if (session.setIndex < ex.sets - 1) {
      startRest(ex);
    } else {
      nextExercise();
    }
  }

  // 一键按计划完成本组：直接用进阶引擎的目标值记录，不弹浮层
  function quickLogSet(ex) {
    const tgt = computeTarget(ex);
    const rec = { pain: false };
    if (ex.type === "superset") {
      rec.done = true;
    } else {
      rec.reps = tgt.repPrefill || (ex.repRange ? ex.repRange[1] : 0);
      if (ex.weighted) rec.weight = tgt.weightPrefill || ex.defaultWeight || 0;
    }
    if (!session.logs[ex.id]) session.logs[ex.id] = [];
    session.logs[ex.id][session.setIndex] = rec;
    if (session.setIndex < ex.sets - 1) startRest(ex);
    else nextExercise();
  }

  /* ============================ 视图：组间休息 ============================ */
  function startRest(ex) {
    let remain = ex.restSec || 60;
    const total = remain;
    const nextSetNo = session.setIndex + 2; // 下一组编号
    beep(660, 0.12);
    say("休息 " + remain + " 秒", { flush: true });

    app.innerHTML = `
      <section class="screen rest">
        <div class="crumb">${ex.id} · ${ex.name}</div>
        <div class="rest-label">组间休息</div>
        <div class="ring-wrap">
          <svg viewBox="0 0 200 200" class="ring">
            <circle class="ring-bg" cx="100" cy="100" r="90"/>
            <circle class="ring-fg" cx="100" cy="100" r="90" id="ringFg"/>
          </svg>
          <div class="ring-num" id="restNum">${remain}</div>
        </div>
        <div class="next-up">下一组：${ex.name} 第 ${nextSetNo}/${ex.sets} 组</div>
        <div class="btn-row">
          <button class="btn ghost" id="restPause">⏸ 暂停</button>
          <button class="btn ghost" id="add30">+30s</button>
          <button class="btn primary" id="skipRest">跳过 · 开始下一组</button>
        </div>
      </section>`;

    const ring = $("#ringFg");
    const C = 2 * Math.PI * 90;
    ring.style.strokeDasharray = C;
    const paint = () => {
      ring.style.strokeDashoffset = C * (1 - remain / total);
      $("#restNum").textContent = remain;
    };
    paint();

    stopRest();
    restTimer = setInterval(() => {
      if (paused) return;
      remain--;
      if (remain === 10) {
        beep(620, 0.12); // 十秒警告：双低音
        beep(620, 0.12, 0.18);
        say("还有十秒", { flush: true });
      }
      if (remain <= 3 && remain > 0) beep(700, 0.08);
      if (remain <= 0) {
        stopRest();
        beep(784, 0.14); // 开始下一组：上行两音
        beep(1046, 0.22, 0.14);
        finishRest(ex);
        return;
      }
      paint();
    }, 1000);

    $("#restPause").addEventListener("click", () => togglePause("#restPause"));
    $("#add30").addEventListener("click", () => {
      remain += 30;
      paint();
    });
    $("#skipRest").addEventListener("click", () => {
      stopRest();
      finishRest(ex);
    });
  }

  function finishRest(ex) {
    session.setIndex++;
    say("开始下一组，" + ex.name + "，第 " + (session.setIndex + 1) + " 组", { flush: true });
    renderPlayer();
  }

  function stopRest() {
    [restTimer, nightTimer, transTimer, breathTimer].forEach((t) => t && clearInterval(t));
    if (breathTimeout) clearTimeout(breathTimeout);
    if (introTimer) clearTimeout(introTimer);
    restTimer = nightTimer = transTimer = breathTimer = breathTimeout = introTimer = null;
    paused = false;
  }

  // 暂停/继续：计时器空转不推进、呼吸调度跳过、暂停 CSS 动画、停住在说的话
  function togglePause(labelSel) {
    paused = !paused;
    const scr = $(".screen");
    if (scr) scr.classList.toggle("is-paused", paused);
    if (paused) { Voice.stop(); Music.duck(false); }
    const btn = labelSel && $(labelSel);
    if (btn) btn.textContent = paused ? "▶ 继续" : "⏸ 暂停";
  }

  /* ---------- 动作切换 ---------- */
  function nextExercise() {
    session.exIndex++;
    session.setIndex = 0;
    if (session.exIndex >= session.exercises.length) {
      finishSession(false);
      return;
    }
    const ex = session.exercises[session.exIndex];
    Voice.speak("下一个，" + ex.name, { flush: true });
    if (!S.settings.autoAdvance) {
      modal(
        `<h3>完成上一个动作 ✔</h3>
         <p class="next-ex">下一个：<b>${ex.id} · ${ex.name}</b></p>
         <p class="hint">${ex.sets} × ${ex.repLabel || ex.supersetLabel || ""}</p>`,
        [{ label: "开始 ▶", cls: "primary", onClick: () => { closeModal(); renderPlayer(); } }],
        { size: "sheet" }
      );
      return;
    }
    showTransition(ex);
  }

  // 自动过渡：短暂展示下一个动作，倒数后自动开始（可暂停/立即开始）
  function showTransition(ex) {
    stopRest();
    let n = 3;
    app.innerHTML = `
      <section class="screen transition">
        <div class="trans-label">下一个动作</div>
        <div class="ex-id">${ex.id}</div>
        <h1 class="ex-name">${ex.name}</h1>
        <div class="trans-target">${ex.type === "superset" ? ex.supersetLabel : ex.sets + " × " + ex.repLabel}</div>
        <div class="trans-count" id="transCount">${n}</div>
        <div class="btn-row">
          <button class="btn ghost" id="transPause">暂停</button>
          <button class="btn primary" id="transGo">立即开始 ▶</button>
        </div>
      </section>`;
    const go = () => { stopRest(); renderPlayer(); };
    transTimer = setInterval(() => {
      n--;
      const el = $("#transCount");
      if (el) el.textContent = n;
      if (n <= 0) { stopRest(); go(); }
    }, 800);
    $("#transGo").addEventListener("click", go);
    $("#transPause").addEventListener("click", () => {
      stopRest();
      const el = $("#transCount");
      if (el) el.textContent = "⏸";
      $("#transPause").style.display = "none";
    });
  }

  /* ============================ 视图：训练总结 ============================ */
  function finishSession(aborted) {
    stopRest();
    const doneExs = Object.keys(session.logs);
    let setCount = 0;
    doneExs.forEach((id) => (setCount += session.logs[id].filter(Boolean).length));
    Voice.speak(aborted ? "训练结束。" : "全部完成，做得好！", { flush: true });

    const rows = session.exercises
      .map((ex) => {
        const l = session.logs[ex.id];
        if (!l || !l.filter(Boolean).length) return "";
        const detail =
          ex.type === "superset"
            ? l.filter(Boolean).length + " 组完成"
            : l
                .filter(Boolean)
                .map((s) => (s.weight ? s.reps + "@" + s.weight : s.reps))
                .join(" / ");
        const pain = l.some((s) => s && s.pain) ? " ⚠" : "";
        return `<tr><td>${ex.id}</td><td>${ex.name}</td><td>${detail}${pain}</td></tr>`;
      })
      .join("");

    app.innerHTML = `
      <section class="screen summary">
        <h2>${aborted ? "训练结束" : "🎉 全部完成"}</h2>
        <div class="sum-stat">菜单 ${session.menu.id} · ${doneExs.length} 个动作 · ${setCount} 组</div>
        <table class="sum-table">${rows || "<tr><td>本次没有记录</td></tr>"}</table>

        <div class="sum-form">
          <div class="rec-field"><label>短板打卡 · 俯卧撑最多连续</label>${stepper("bmPushup", "", 1, 0, 60)}</div>
          <div class="rec-field"><label>短板打卡 · 引体最多连续</label>${stepper("bmPullup", "", 1, 0, 30)}</div>
          <div class="rec-field"><label>今日体重 kg（可选）</label>${stepper("bwKg", "", 0.1, 0, 200)}</div>
          <div class="rec-field">
            <label>状态</label>
            <div class="pain-toggle" id="condToggle">
              <button class="pt active" data-c="好">好</button>
              <button class="pt" data-c="一般">一般</button>
              <button class="pt" data-c="差">差</button>
            </div>
          </div>
          <div class="rec-field"><label>备注</label><input type="text" id="sumNote" class="text-in" placeholder="今天的感受、哪个动作有反应…"/></div>
        </div>

        <div class="btn-row">
          <button class="btn primary huge" id="saveSession">保存并结束</button>
        </div>
      </section>`;

    const ct = $("#condToggle");
    ct.querySelectorAll(".pt").forEach((b) =>
      b.addEventListener("click", () => {
        ct.querySelectorAll(".pt").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      })
    );
    $("#saveSession").addEventListener("click", () => commitSession(aborted));
  }

  function commitSession(aborted) {
    // 1) 写进阶状态（供下次预填）
    Object.keys(session.logs).forEach((id) => {
      const clean = session.logs[id].filter(Boolean);
      if (clean.length) S.progression[id] = clean;
    });
    // 2) 写历史日志
    let setCount = 0;
    Object.keys(session.logs).forEach((id) => (setCount += session.logs[id].filter(Boolean).length));
    const cond = $("#condToggle .pt.active");
    const rec = {
      date: session.startedAt,
      menuId: session.menuId,
      title: session.menu.title,
      setCount,
      sets: session.logs,
      aborted,
      benchmarks: {
        pushup: numOrNull($("#bmPushup").value),
        pullup: numOrNull($("#bmPullup").value),
      },
      bodyweight: numOrNull($("#bwKg").value),
      condition: cond ? cond.dataset.c : null,
      note: $("#sumNote").value || "",
    };
    S.logs.push(rec);
    // 3) 循环前进（异常中止也算走过这张，方便下次换一张；如需重练可手动选）
    S.cycleIndex = (S.cycleIndex + 1) % P.meta.cycle.length;
    saveState();
    Voice.speak("已保存。下次建议练菜单 " + suggestedMenuId() + "。", { flush: true });
    session = null;
    showRecordExport(rec); // 生成本次训练的 Markdown 记录，可复制/下载；「完成」回主页
  }

  /* ============================ 详情 / 规则 / 日志 弹层 ============================ */
  function showDetail(ex) {
    const list = (arr) => (arr || []).map((x) => `<li>${x}</li>`).join("");
    const supersetHtml = ex.superset
      ? `<h4>组合动作</h4><ul>${ex.superset.map((s) => `<li><b>${s.name}（${s.reps}）</b>：${s.how}</li>`).join("")}</ul>`
      : "";
    modal(
      `<div class="detail">
        <h3>${ex.id} · ${ex.name}</h3>
        <div class="d-meta">🎯 ${ex.target}<br/>🧰 ${ex.equipment}</div>
        <div class="d-target">${ex.type === "superset" ? ex.supersetLabel : ex.sets + " × " + ex.repLabel + " · 节奏 " + (ex.tempo || "—") + " · 歇 " + ex.restSec + "s"}</div>
        ${supersetHtml}
        <h4>起始姿势</h4><ol>${list(ex.setup)}</ol>
        <h4>动作过程</h4><ol>${list(ex.steps)}</ol>
        <h4 class="good">✅ 该有的感觉</h4><p>${ex.feelGood || ""}</p>
        <h4 class="bad">🚫 不该有的感觉</h4><p>${ex.feelBad || ""}</p>
        <h4>常见错误 → 纠正</h4><ul>${list(ex.mistakes)}</ul>
        ${ex.personalNote ? `<h4>针对你</h4><p class="mine">${ex.personalNote}</p>` : ""}
        <h4>太难 → 退阶</h4><p>${ex.regression || "—"}</p>
        <h4>太易 → 进阶</h4><p>${ex.progression || "—"}</p>
      </div>`,
      [
        { label: "✏ 编辑", cls: "ghost", onClick: () => openEdit(ex) },
        { label: "关闭", cls: "primary", onClick: closeModal },
      ],
      { size: "full" }
    );
  }

  function showRules() {
    modal(
      `<h3>护伤总则</h3><ol class="rules">${P.injuryRules.map((r) => `<li>${r}</li>`).join("")}</ol>`,
      [{ label: "知道了", cls: "primary", onClick: closeModal }],
      { size: "full" }
    );
  }

  function showLog() {
    if (!S.logs.length) {
      modal(`<h3>训练日志</h3><p class="hint">还没有记录，练一次就有了。</p>`, [
        { label: "关闭", cls: "primary", onClick: closeModal },
      ]);
      return;
    }
    const rows = S.logs
      .map((l, idx) => ({ l, idx }))
      .reverse()
      .map(({ l, idx }) => {
        const bench = [];
        if (l.benchmarks && l.benchmarks.pushup) bench.push("俯卧撑 " + l.benchmarks.pushup);
        if (l.benchmarks && l.benchmarks.pullup) bench.push("引体 " + l.benchmarks.pullup);
        return `<div class="log-row">
          <div class="log-top"><b>${fmtDate(l.date)}</b> · 菜单 ${l.menuId} · ${l.setCount} 组 ${l.condition ? "· " + l.condition : ""}</div>
          ${l.bodyweight ? `<div class="log-sub">体重 ${l.bodyweight}kg</div>` : ""}
          ${bench.length ? `<div class="log-sub">短板：${bench.join(" · ")}</div>` : ""}
          ${l.note ? `<div class="log-note">${l.note}</div>` : ""}
          <div class="log-actions">
            <button class="link" data-copymd="${idx}">复制 Markdown</button>
            <button class="link" data-dlmd="${idx}">下载 .md</button>
          </div>
        </div>`;
      })
      .join("");
    modal(`<h3>训练日志（最近在上）</h3><div class="log-list">${rows}</div>`, [
      { label: "关闭", cls: "primary", onClick: closeModal },
    ], { size: "full" });
    document.querySelectorAll("[data-copymd]").forEach((b) =>
      b.addEventListener("click", () => copyText(buildMarkdown(S.logs[+b.dataset.copymd])))
    );
    document.querySelectorAll("[data-dlmd]").forEach((b) =>
      b.addEventListener("click", () => { const r = S.logs[+b.dataset.dlmd]; downloadText(buildMarkdown(r), recFilename(r)); })
    );
  }

  /* ============================ 备份导出/导入 ============================ */
  function exportBackup() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "健身伴侣备份_" + d + ".json";
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出", "备份文件已开始下载。");
  }
  function importBackup(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        S = Object.assign(structuredClone(defaultState), data, {
          settings: Object.assign({}, defaultState.settings, data.settings || {}),
        });
        saveState();
        toast("已导入", "备份已恢复。");
        renderHome();
      } catch (err) {
        toast("导入失败", "文件格式不对。");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  /* ============================ 通用 UI 组件 ============================ */
  function stepper(id, val, step, min, max) {
    return `<div class="stepper">
      <button type="button" class="st-btn" data-step="${id}" data-dir="-1">−</button>
      <input type="number" id="${id}" value="${val}" step="${step}" min="${min}" max="${max}" inputmode="decimal"/>
      <button type="button" class="st-btn" data-step="${id}" data-dir="1">+</button>
    </div>`;
  }

  function modal(html, buttons, opts) {
    opts = opts || {};
    closeModal();
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.id = "modal";
    wrap.innerHTML = `
      <div class="modal ${opts.size || ""}">
        <div class="modal-body">${html}</div>
        <div class="modal-actions">
          ${buttons.map((b, i) => `<button class="btn ${b.cls || "ghost"}" data-mb="${i}">${b.label}</button>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(wrap);
    buttons.forEach((b, i) => wrap.querySelector(`[data-mb="${i}"]`).addEventListener("click", b.onClick));
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap && opts.size !== "sheet") closeModal();
    });
    wireSteppers(wrap);
  }
  function closeModal() {
    const m = $("#modal");
    if (m) m.remove();
  }

  function wireSteppers(root) {
    root.querySelectorAll(".st-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const input = $("#" + b.dataset.step, root) || $("#" + b.dataset.step);
        if (!input) return;
        const step = parseFloat(input.step) || 1;
        let v = parseFloat(input.value) || 0;
        v = Math.round((v + step * parseInt(b.dataset.dir, 10)) * 100) / 100;
        const min = parseFloat(input.min);
        if (!isNaN(min)) v = Math.max(min, v);
        input.value = v;
      })
    );
  }

  let toastTimer = null;
  function toast(title, msg) {
    let t = $("#toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.innerHTML = `<b>${title}</b>${msg ? "<span>" + msg + "</span>" : ""}`;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  /* ============================ 工具 ============================ */
  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    } catch (e) {
      return iso;
    }
  }
  function numOrNull(v) {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  // 全局委托 stepper（player 记录浮层等动态内容也覆盖）
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".st-btn");
    if (b && !b.closest(".modal-wrap")) {
      const input = document.getElementById(b.dataset.step);
      if (input) {
        const step = parseFloat(input.step) || 1;
        let v = parseFloat(input.value) || 0;
        v = Math.round((v + step * parseInt(b.dataset.dir, 10)) * 100) / 100;
        const min = parseFloat(input.min);
        if (!isNaN(min)) v = Math.max(min, v);
        input.value = v;
      }
    }
  });

  /* ============================ 夜间放松板块 ============================ */
  // 从台词池随机取一句（intro/outro 用）
  function pickLine(arr) { return (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : null; }

  function startNight() {
    stopRest();
    Voice.stop();
    nightSession = { stepIndex: 0, startedAt: new Date().toISOString(), skipped: {}, remain: 0 };
    acquireWakeLock();
    Music.start(S.settings.musicTrack);
    // 开场句先念完，隔一会儿再进 E1（否则会被第一步的引导语冲掉）
    const intro = S.settings.voiceOn ? pickLine(P.night.intro) : null;
    if (intro) {
      say(intro, { flush: true });
      introTimer = setTimeout(() => { introTimer = null; if (nightSession) renderNightStep(); }, 4200);
    } else {
      renderNightStep();
    }
  }

  function renderNightStep() {
    stopRest();
    const steps = P.night.steps;
    const step = resolveStep(steps[nightSession.stepIndex]);
    const idx = nightSession.stepIndex;
    const isBreath = step.type === "breath" || step.type === "release";
    const isRelease = step.type === "release";
    const li = (a) => (a || []).map((x) => `<li>${x}</li>`).join("");
    // 闭眼锻炼：屏幕极简，只留步骤名 + 倒计时给偶尔一瞥；引导全靠声音（提示音+语音）。做法收进"睁眼看"。
    app.innerHTML = `
      <section class="screen night eyes-free">
        <div class="crumb"><button class="link back" id="nightExit">‹ 退出</button><span>🌙 夜间放松 ${idx + 1}/${steps.length}</span></div>
        <h1 class="ex-name night-name">${step.name}</h1>
        <div class="ring-wrap night-ring">
          <svg viewBox="0 0 200 200" class="ring"><circle class="ring-bg" cx="100" cy="100" r="90"/><circle class="ring-fg" cx="100" cy="100" r="90" id="nightRingFg"/></svg>
          <div class="ring-num" id="nightNum">${fmtClock(step.seconds)}</div>
        </div>
        <div class="btn-row">
          <button class="btn ghost" id="nightPause">⏸ 暂停</button>
          <button class="btn ghost" id="nightAdd">+30s</button>
          <button class="btn ghost" id="nightSkip">${step.skippable ? "膝不适 · 跳过" : "跳过这步"}</button>
        </div>
        <button class="link night-how" id="nightHow">做法（睁眼看）</button>
      </section>`;
    $("#nightExit").addEventListener("click", () => { stopRest(); nightSession = null; renderHome(); });
    $("#nightPause").addEventListener("click", () => togglePause("#nightPause"));
    $("#nightAdd").addEventListener("click", () => { nightSession.remain += 30; const el = $("#nightNum"); if (el) el.textContent = fmtClock(nightSession.remain); });
    $("#nightSkip").addEventListener("click", () => { nightSession.skipped[step.id] = true; stopRest(); nextNightStep(); });
    $("#nightHow").addEventListener("click", () => {
      modal(
        `<h3>${step.id} · ${step.name}</h3>
         <div class="night-cue">💡 ${step.cue}</div>
         <ol class="howto-steps">${li(step.how)}</ol>
         <div class="feel-row">
           ${step.feelGood ? `<div class="feel good">✅ ${step.feelGood}</div>` : ""}
           ${step.pitfalls ? `<div class="feel bad">🚫 ${step.pitfalls}</div>` : ""}
         </div>`,
        [{ label: "知道了", cls: "primary", onClick: closeModal }],
        { size: "full" }
      );
    });
    startNightTimer(step);
    // 第一个呼吸步骤先引导一句"升调吸气、降调呼气"，之后只报步骤名（不重复啰嗦）
    if (isBreath && !nightSession.guided) {
      say(step.name + "。跟着提示音走，升调吸气，降调呼气。", { flush: true });
      nightSession.guided = true;
    } else {
      say(step.name, { flush: true });
    }
    if (isBreath) startBreathCoach(step);
  }

  // 夜间呼吸引导（纯听觉）：吸气上行提示音、呼气下行提示音打节拍；呼气间隙随机念一句要点（语音只念要点，不念吸呼）
  function startBreathCoach(step) {
    const b = step.breath || { inhale: 4, exhale: 6 };
    const pts = step.points || [];
    let ci = Math.floor(Math.random() * Math.max(1, pts.length)); // 起点随机
    let first = true;
    const cycleMs = (b.inhale + b.exhale) * 1000;
    const tick = () => {
      if (paused) return;
      breathTone("in");
      breathTimeout = setTimeout(() => {
        if (paused) return;
        breathTone("out");
        if (!first && pts.length) say(pts[ci++ % pts.length], { flush: true }); // 呼气间隙念要点
        first = false;
      }, b.inhale * 1000);
    };
    tick();
    breathTimer = setInterval(tick, cycleMs);
  }

  function startNightTimer(step) {
    nightSession.remain = step.seconds;
    const total = step.seconds;
    const C = 2 * Math.PI * 90;
    const ring = $("#nightRingFg");
    if (ring) ring.style.strokeDasharray = C;
    const paint = () => {
      const ratio = Math.min(1, nightSession.remain / total);
      if (ring) ring.style.strokeDashoffset = C * (1 - ratio);
      const el = $("#nightNum");
      if (el) el.textContent = fmtClock(nightSession.remain);
    };
    paint();
    nightTimer = setInterval(() => {
      if (paused) return;
      nightSession.remain--;
      if (nightSession.remain <= 0) {
        stopRest();
        nextNightStep();
        return;
      }
      paint();
    }, 1000);
  }

  function nextNightStep() {
    nightSession.stepIndex++;
    if (nightSession.stepIndex >= P.night.steps.length) { finishNight(); return; }
    renderNightStep();
  }

  function finishNight() {
    stopRest();
    say(pickLine(P.night.outro) || "放松完成，做完直接睡吧。", { flush: true });
    app.innerHTML = `
      <section class="screen summary night-summary">
        <h2>🌙 放松完成</h2>
        <p class="outro">${P.nightMeta.outro}</p>
        <div class="sum-form">
          <div class="rec-field">
            <label>今晚这套做了吗</label>
            <div class="pain-toggle" id="nkDone">
              <button class="pt active" data-v="做了">做了</button>
              <button class="pt" data-v="没做">没做</button>
            </div>
          </div>
          <div class="rec-field">
            <label>反向凯格尔找到「松」的感觉了吗</label>
            <div class="pain-toggle" id="nkFound">
              <button class="pt" data-v="是">是</button>
              <button class="pt active" data-v="部分">部分</button>
              <button class="pt" data-v="否">否</button>
            </div>
          </div>
          <div class="rec-field"><label>备注（会阴松紧、睡眠…）</label><input type="text" id="nightNote" class="text-in" placeholder="可留空"/></div>
        </div>
        <div class="btn-row"><button class="btn primary huge" id="saveNight">保存并结束</button></div>
      </section>`;
    wireToggle("#nkDone");
    wireToggle("#nkFound");
    $("#saveNight").addEventListener("click", commitNight);
  }

  function commitNight() {
    const doneEl = $("#nkDone .pt.active");
    const foundEl = $("#nkFound .pt.active");
    const rec = {
      date: nightSession ? nightSession.startedAt : new Date().toISOString(),
      done: doneEl ? doneEl.dataset.v === "做了" : true,
      reverseKegel: foundEl ? foundEl.dataset.v : "部分",
      note: $("#nightNote").value || "",
      skippedE4: !!(nightSession && nightSession.skipped.E4),
    };
    S.night.logs.push(rec);
    saveState();
    say("已记录，晚安。", { flush: true });
    nightSession = null;
    showNightExport(rec);
  }

  function buildNightMarkdown(rec) {
    return `${fmtFullDate(rec.date)}：晚间放松 ${rec.done ? "做" : "没做"} · 反向凯格尔找到感觉? ${rec.reverseKegel} · 备注(${rec.note || "—"})`;
  }

  function showNightExport(rec) {
    const md = buildNightMarkdown(rec);
    modal(
      `<h3>🌙 夜间打卡（Markdown）</h3>
       <p class="hint">复制或下载，贴进《康复日志.md》的放松打卡区。</p>
       <pre class="md-preview">${escapeHtml(md)}</pre>`,
      [
        { label: "复制", cls: "ghost", onClick: () => copyText(md) },
        { label: "下载", cls: "ghost", onClick: () => downloadText(md, "夜间打卡_" + fmtFullDate(rec.date) + ".md") },
        { label: "完成", cls: "primary", onClick: () => { closeModal(); renderHome(); } },
      ],
      { size: "full" }
    );
  }

  function showNightLog() {
    if (!S.night.logs.length) {
      modal(`<h3>夜间记录</h3><p class="hint">还没有记录，做一次就有了。</p>`, [{ label: "关闭", cls: "primary", onClick: closeModal }]);
      return;
    }
    const rows = S.night.logs
      .map((l, idx) => ({ l, idx }))
      .reverse()
      .map(({ l, idx }) => `
        <div class="log-row">
          <div class="log-top"><b>${fmtDate(l.date)}</b> · 晚间放松 ${l.done ? "做了" : "没做"} · 找到感觉：${l.reverseKegel}</div>
          ${l.note ? `<div class="log-note">${l.note}</div>` : ""}
          <div class="log-actions">
            <button class="link" data-ncopy="${idx}">复制</button>
            <button class="link" data-ndl="${idx}">下载</button>
          </div>
        </div>`)
      .join("");
    modal(`<h3>夜间记录（最近在上）</h3><div class="log-list">${rows}</div>`, [{ label: "关闭", cls: "primary", onClick: closeModal }], { size: "full" });
    document.querySelectorAll("[data-ncopy]").forEach((b) => b.addEventListener("click", () => copyText(buildNightMarkdown(S.night.logs[+b.dataset.ncopy]))));
    document.querySelectorAll("[data-ndl]").forEach((b) => b.addEventListener("click", () => { const r = S.night.logs[+b.dataset.ndl]; downloadText(buildNightMarkdown(r), "夜间打卡_" + fmtFullDate(r.date) + ".md"); }));
  }

  function wireToggle(sel) {
    const g = $(sel);
    if (!g) return;
    g.querySelectorAll(".pt").forEach((b) =>
      b.addEventListener("click", () => {
        g.querySelectorAll(".pt").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      })
    );
  }

  function fmtClock(sec) {
    sec = Math.max(0, sec | 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  /* ============================ 语音安装引导 ============================ */
  function showVoiceInstall() {
    modal(
      `<h3>安装中文语音（Windows）</h3>
       <p class="hint">你这台电脑现在只装了英文语音，所以听不到中文播报。装一个中文语音后即可全程语音引导。</p>
       <h4>方法一（推荐）：语言设置</h4>
       <ol class="rules">
         <li>Win 设置 → <b>时间和语言</b> → <b>语言和区域</b>。</li>
         <li>「添加语言」→ 选 <b>中文（简体，中国）</b> → 安装（勾上「语音」相关选项）。</li>
         <li>装完 <b>重启浏览器</b>，回来点「测试语音」。</li>
       </ol>
       <h4>方法二：讲述人语音</h4>
       <ol class="rules">
         <li>Win 设置 → <b>辅助功能</b> → <b>讲述人</b> → 「添加更多语音」。</li>
         <li>添加中文（如 Microsoft Huihui / Kangkang）。</li>
       </ol>
       <p class="mine">想更好听：用微软 <b>Edge</b> 打开本页，再在主页「声音」下拉里选带 <b>Natural / 在线</b> 字样的中文语音（如"晓晓"），接近真人、免费、无需密钥。没有语音也没关系，提示音和大字流程完全够用。</p>`,
      [
        { label: "重新检测", cls: "ghost", onClick: () => { Voice.refresh(); closeModal(); renderHome(); } },
        { label: "知道了", cls: "primary", onClick: closeModal },
      ],
      { size: "full" }
    );
  }

  /* ============================ App 内编辑动作 ============================ */
  function editField(label, id, val, step, min, max) {
    return `<div class="rec-field"><label>${label}</label>${stepper(id, val === null || val === undefined ? "" : val, step, min, max)}</div>`;
  }
  function editText(label, id, val) {
    return `<div class="rec-field"><label>${label}</label><input type="text" id="${id}" class="text-in" value="${escapeAttr(val || "")}"/></div>`;
  }

  function openEdit(ex) {
    const rr = ex.repRange || [8, 12];
    const rows = [];
    rows.push(editField("组数", "edSets", ex.sets, 1, 1, 12));
    if (ex.rirBased) {
      rows.push(editText("目标（显示文字，如 RIR2）", "edLabel", ex.repLabel));
      rows.push(editField("RIR（留几次余量）", "edRir", ex.rir, 1, 0, 5));
      rows.push(editField("达标次数（用于升阶判定）", "edRepMax", rr[1], 1, 1, 100));
    } else {
      rows.push(editField("次数下限", "edRepMin", rr[0], 1, 0, 100));
      rows.push(editField("次数上限", "edRepMax", rr[1], 1, 0, 100));
    }
    rows.push(editText("节奏（如 3-1-1）", "edTempo", ex.tempo));
    rows.push(editField("组间歇（秒）", "edRest", ex.restSec || 60, 5, 0, 600));
    if (ex.weighted) rows.push(editField("默认重量（kg）", "edW", ex.defaultWeight || 10, 1, 0, 100));
    rows.push(editText("关键提示（练时高亮那句）", "edCue", ex.topCue));

    modal(
      `<h3>✏ 编辑 · ${ex.id} ${ex.name}</h3>
       <p class="hint">改动只存在你本机、随时可「恢复默认」。大段动作说明仍在 program.js 改。</p>
       <div class="edit-form">${rows.join("")}</div>`,
      [
        { label: "恢复默认", cls: "ghost", onClick: () => { delete S.overrides[ex.id]; saveState(); afterEdit(ex.id, "已恢复默认"); } },
        { label: "保存", cls: "primary", onClick: () => saveEdit(ex) },
      ],
      { size: "full" }
    );
  }

  function saveEdit(ex) {
    const rr = ex.repRange || [8, 12];
    const ov = {
      sets: readInt("edSets", ex.sets),
      tempo: readVal("edTempo", ex.tempo),
      restSec: readInt("edRest", ex.restSec),
      topCue: readVal("edCue", ex.topCue),
    };
    if (ex.rirBased) {
      ov.repLabel = readVal("edLabel", ex.repLabel);
      const rir = readInt("edRir", ex.rir);
      ov.rir = isNaN(rir) ? null : rir;
      ov.repRange = [rr[0], readInt("edRepMax", rr[1])];
    } else {
      const mn = readInt("edRepMin", rr[0]);
      const mx = readInt("edRepMax", rr[1]);
      ov.repRange = [mn, mx];
      ov.repLabel = mn === mx ? String(mx) : mn + "–" + mx;
    }
    if (ex.weighted) ov.defaultWeight = readNum("edW", ex.defaultWeight);
    S.overrides[ex.id] = ov;
    saveState();
    afterEdit(ex.id, "已保存");
  }

  function afterEdit(exId, msg) {
    closeModal();
    toast(msg, "改动已存到本机。");
    if (session) {
      const i = session.exercises.findIndex((e) => e.id === exId);
      if (i !== -1) {
        session.exercises[i] = resolveEx(baseExercise(session.menuId, exId));
        if (i === session.exIndex) renderPlayer();
      }
    }
  }

  function readVal(id, dflt) { const el = document.getElementById(id); return el ? el.value : dflt; }
  function readInt(id, dflt) { const el = document.getElementById(id); const n = parseInt(el && el.value, 10); return isNaN(n) ? dflt : n; }
  function readNum(id, dflt) { const el = document.getElementById(id); const n = parseFloat(el && el.value); return isNaN(n) ? dflt : n; }

  /* ============================ Markdown 记录生成 ============================ */
  function buildMarkdown(rec) {
    const menu = P.menus[rec.menuId];
    const L = [];
    L.push(`### ${fmtFullDate(rec.date)} · 菜单${rec.menuId} · ${rec.title}`);
    L.push(`体重：${rec.bodyweight ? rec.bodyweight + "kg" : "—"}   状态：${rec.condition || "—"}`);
    L.push("");
    (menu ? menu.exercises : []).forEach((base) => {
      const l = rec.sets[base.id];
      if (!l) return;
      const clean = l.filter(Boolean);
      if (!clean.length) return;
      let detail;
      if (base.type === "superset") {
        detail = clean.length + " 组完成";
      } else {
        detail = clean.length + "×" + clean.map((s) => (s.weight ? s.reps + "@" + s.weight + "kg" : s.reps)).join("/");
      }
      const pain = clean.some((s) => s.pain) ? " ⚠有不适" : "";
      L.push(`- ${base.id} ${base.name} —— ${detail}${pain}`);
    });
    L.push("");
    const bm = rec.benchmarks || {};
    L.push(`短板打卡：俯卧撑最多连续 ${bm.pushup != null ? bm.pushup : "—"} / 引体最多连续 ${bm.pullup != null ? bm.pullup : "—"}`);
    const painExs = Object.keys(rec.sets).filter((id) => (rec.sets[id] || []).some((s) => s && s.pain));
    L.push(`膝盖/疼痛：${painExs.length ? painExs.join("、") + " 有不适" : "无痛"}`);
    if (rec.note) L.push(`备注：${rec.note}`);
    return L.join("\n");
  }

  function recFilename(rec) {
    return "训练记录_" + fmtFullDate(rec.date) + "_菜单" + rec.menuId + ".md";
  }

  function showRecordExport(rec) {
    const md = buildMarkdown(rec);
    modal(
      `<h3>📋 训练记录（Markdown）</h3>
       <p class="hint">复制到 Notion / Obsidian，或下载 .md 并进《训练日志.md》。</p>
       <pre class="md-preview">${escapeHtml(md)}</pre>`,
      [
        { label: "复制", cls: "ghost", onClick: () => copyText(md) },
        { label: "下载 .md", cls: "ghost", onClick: () => downloadText(md, recFilename(rec)) },
        { label: "完成", cls: "primary", onClick: () => { closeModal(); renderHome(); } },
      ],
      { size: "full" }
    );
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("已复制", "记录已到剪贴板。"), () => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制", "记录已复制。"); }
    catch (e) { toast("复制失败", "请手动选择文本复制。"); }
    ta.remove();
  }
  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function fmtFullDate(iso) {
    try {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    } catch (e) { return iso; }
  }

  /* ============================ 语音台词（检视 + 编辑） ============================ */
  function showScript() {
    const exRows = [];
    Object.values(P.menus).forEach((m) => m.exercises.forEach((base) => {
      const ex = resolveEx(base);
      exRows.push(`<div class="sc-block">
        <div class="sc-row"><label>${ex.id} ${ex.name} · 语音提醒</label><input type="text" class="text-in" data-cue="${ex.id}" value="${escapeAttr(ex.voiceCue || "")}"/></div>
        <div class="sc-row"><label class="sub">　屏幕关键提示</label><input type="text" class="text-in" data-topcue="${ex.id}" value="${escapeAttr(ex.topCue || "")}"/></div>
      </div>`);
    }));
    const nightRows = P.night.steps.map((base) => {
      const s = resolveStep(base);
      return `<div class="sc-block">
        <div class="sc-row"><label>${s.id} ${s.name} · 一句提示</label><input type="text" class="text-in" data-nightcue="${s.id}" value="${escapeAttr(s.cue || "")}"/></div>
        <div class="sc-row col"><label class="sub">要点池（每行一句，呼气间隙随机念）</label><textarea class="text-in" rows="5" data-pts="${s.id}">${escapeHtml((s.points || []).join("\n"))}</textarea></div>
      </div>`;
    }).join("");
    const sys = ["休息 N 秒 / 还有十秒 / 开始下一组", "下一个，<动作名>", "全部完成，做得好 / 训练结束", "放松完成，做完直接睡吧 / 已记录，晚安", "跟着提示音走，升调吸气，降调呼气"];
    modal(
      `<div class="script-view">
        <h3>🗣 锻炼提示词</h3>
        <p class="hint">这里是会念给你听、以及屏幕上显示的提示，都可改；改完立刻生效（无需重生成）。系统提示暂只读。</p>
        <h4>力量 · 每个动作</h4>${exRows.join("")}
        <h4>夜间 · 每步</h4>${nightRows}
        <h4>系统提示（只读）</h4><ul class="rules">${sys.map((x) => `<li>${x}</li>`).join("")}</ul>
      </div>`,
      [
        { label: "恢复默认", cls: "ghost", onClick: clearScriptOverrides },
        { label: "保存", cls: "primary", onClick: saveScript },
      ],
      { size: "full" }
    );
  }
  function ensureOverride(id) { if (!S.overrides[id]) S.overrides[id] = {}; }
  function cleanOverride(id) { if (S.overrides[id] && Object.keys(S.overrides[id]).length === 0) delete S.overrides[id]; }
  function saveScript() {
    const setText = (sel, attr, field, findBase) => {
      document.querySelectorAll("[" + attr + "]").forEach((inp) => {
        const id = inp.dataset[sel], v = inp.value.trim();
        const base = findBase(id);
        ensureOverride(id);
        if (base && v && v !== (base[field] || "")) S.overrides[id][field] = v;
        else delete S.overrides[id][field];
        cleanOverride(id);
      });
    };
    setText("cue", "data-cue", "voiceCue", findExerciseAnywhere);
    setText("topcue", "data-topcue", "topCue", findExerciseAnywhere);
    setText("nightcue", "data-nightcue", "cue", (id) => P.night.steps.find((s) => s.id === id));
    document.querySelectorAll("[data-pts]").forEach((ta) => {
      const id = ta.dataset.pts;
      const lines = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
      const base = P.night.steps.find((s) => s.id === id);
      ensureOverride(id);
      if (base && JSON.stringify(lines) !== JSON.stringify(base.points || [])) S.overrides[id].points = lines;
      else delete S.overrides[id].points;
      cleanOverride(id);
    });
    saveState();
    closeModal();
    toast("已保存", "提示词改动已生效。");
  }
  function clearScriptOverrides() {
    Object.keys(S.overrides).forEach((id) => {
      if (S.overrides[id]) {
        ["voiceCue", "topCue", "cue", "points"].forEach((k) => delete S.overrides[id][k]);
        cleanOverride(id);
      }
    });
    saveState();
    closeModal();
    toast("已恢复默认", "提示词已还原为出厂内容。");
  }

  /* ============================ 启动 ============================ */
  renderHome();
})();
