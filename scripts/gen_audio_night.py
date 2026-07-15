#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
夜间放松台词 —— 把定稿音色 Seren 烧一整套 clip，写成 manifest.js（VOICES 可扩展多把）。
台词来自 scripts/night_strings.json（由 scripts/night_strings.js 从 program.js 精确提取，勿手改）。
每把音色一个子目录 app/audio/clips/<key>/；已存在的 clip 按文本 md5 跳过（断点续烧，可反复跑补齐）。
两套引擎：
  - Seren / 卡捷琳娜 走 qwen3-tts-flash（SDK）；
  - 定制音色走声音设计合成 qwen3-tts-vd-2026-01-26（HTTP，voice id 取自 scripts/custom_voice_id_<key>.txt）。
用法(cmd):  set DASHSCOPE_API_KEY=sk-...   然后  python scripts/gen_audio_night.py
key 仅经环境变量传入，绝不写进任何文件、绝不提交。
"""
import os
import sys
import json
import time
import hashlib
import urllib.request

import dashscope
from dashscope.audio.qwen_tts import SpeechSynthesizer
import requests

KEY = (os.environ.get("DASHSCOPE_API_KEY") or "").strip().strip('"').strip("'")
if not KEY:
    print("ERR: 未设置环境变量 DASHSCOPE_API_KEY")
    sys.exit(1)
dashscope.api_key = KEY
BASE = "https://dashscope.aliyuncs.com/api/v1"  # 国内·北京
dashscope.base_http_api_url = BASE
VD_SYNTH_URL = BASE + "/services/aigc/multimodal-generation/generation"
VD_MODEL = "qwen3-tts-vd-2026-01-26"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CLIPS = os.path.join(ROOT, "app", "audio", "clips")
MANIFEST = os.path.join(ROOT, "app", "audio", "manifest.js")
STRINGS = os.path.join(HERE, "night_strings.json")

DEFAULT_VOICE = "seren"
BURN = {"seren"}  # 本轮只合成这些音色；其余音色沿用现有 manifest 里的旧映射（切过去改动句回退 TTS）
# key, 显示名, engine(qwen|vd), qwen 用的 voice 名（vd 忽略，改读 custom_voice_id_<key>.txt）
VOICES = [
    ("seren",    "Seren",    "qwen", "Seren"),
    ("katerina", "卡捷琳娜", "qwen", "Katerina"),
    ("jingshu",  "静姝",     "vd",   None),
    ("ruanmian", "软眠",     "vd",   None),
    ("nuanyi",   "暖依",     "vd",   None),
    ("hexu",     "和煦",     "vd",   None),
    ("qingyu",   "轻语",     "vd",   None),
]

if not os.path.exists(STRINGS):
    print("ERR: 缺 night_strings.json，先跑 node scripts/night_strings.js")
    sys.exit(1)
with open(STRINGS, encoding="utf-8") as f:
    TEXTS = json.load(f)


def ext_of(data):
    if data[:4] == b"RIFF":
        return "wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    return "wav"


def vd_voice_id(key):
    p = os.path.join(HERE, "custom_voice_id_%s.txt" % key)
    if not os.path.exists(p):
        raise RuntimeError("缺 custom_voice_id_%s.txt（先跑 gen_voice_design.py 造该音色）" % key)
    with open(p, encoding="utf-8") as f:
        return f.read().strip()


def synth_qwen(text, voice):
    resp = SpeechSynthesizer.call(model="qwen3-tts-flash", text=text, voice=voice)
    if getattr(resp, "status_code", None) != 200:
        raise RuntimeError("qwen status=%s msg=%s" % (
            getattr(resp, "status_code", "?"), getattr(resp, "message", "?")))
    out = getattr(resp, "output", None)
    a = getattr(out, "audio", None) if out is not None else None
    url = (a.get("url") if hasattr(a, "get") else getattr(a, "url", None)) if a is not None else None
    if not url:
        raise RuntimeError("qwen 无音频URL")
    return url


def synth_vd(text, voice_id):
    payload = {"model": VD_MODEL, "input": {"text": text, "voice": voice_id},
               "parameters": {"response_format": "wav"}}
    r = requests.post(VD_SYNTH_URL, json=payload,
                      headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
                      timeout=90)
    if r.status_code != 200:
        raise RuntimeError("vd status=%s %s" % (r.status_code, r.text[:120]))
    a = (r.json().get("output") or {}).get("audio") or {}
    url = a.get("url") if isinstance(a, dict) else None
    if not url:
        raise RuntimeError("vd 无音频URL")
    return url


def burn_voice(key, name, engine, qvoice):
    outdir = os.path.join(CLIPS, key)
    os.makedirs(outdir, exist_ok=True)
    vid = vd_voice_id(key) if engine == "vd" else None
    m = {}
    made = skipped = 0
    fails = []
    for i, text in enumerate(TEXTS, 1):
        h = hashlib.md5(text.encode("utf-8")).hexdigest()[:12]
        existing = [fn for fn in os.listdir(outdir) if fn.startswith(h + ".")]
        if existing:
            m[text] = "audio/clips/%s/%s" % (key, existing[0])
            skipped += 1
            continue
        ok = False
        for attempt in range(1, 4):
            try:
                url = synth_qwen(text, qvoice) if engine == "qwen" else synth_vd(text, vid)
                data = urllib.request.urlopen(url, timeout=60).read()
                if not data:
                    raise RuntimeError("空音频")
                fn = "%s.%s" % (h, ext_of(data))
                with open(os.path.join(outdir, fn), "wb") as wf:
                    wf.write(data)
                m[text] = "audio/clips/%s/%s" % (key, fn)
                made += 1
                ok = True
                break
            except Exception as e:
                print("   ... [%s] %2d/%d 第%d次失败 %s: %s" % (
                    key, i, len(TEXTS), attempt, text[:10], str(e)[:60]))
                time.sleep(1.2)
        if not ok:
            fails.append(text)
        time.sleep(0.15)
    print(">> %-9s(%s) 新烧 %d | 跳过 %d | 失败 %d | 映射 %d/%d" % (
        name, key, made, skipped, len(fails), len(m), len(TEXTS)))
    return m, fails


def load_base_by_voice():
    # 读现有 manifest.js 里的 AUDIO_MANIFEST_BY_VOICE（保留本轮不烧的音色映射）
    if not os.path.exists(MANIFEST):
        return {}
    txt = open(MANIFEST, encoding="utf-8").read()
    marker = "window.AUDIO_MANIFEST_BY_VOICE = "
    if marker not in txt:
        return {}
    start = txt.index(marker) + len(marker)
    try:
        end = txt.index(";\nwindow.AUDIO_MANIFEST_VOICES", start)
        return json.loads(txt[start:end])
    except Exception:
        return {}


def main():
    os.makedirs(CLIPS, exist_ok=True)
    base = load_base_by_voice()
    print("待烧 %d 条 · 本轮合成音色: %s（其余沿用现有映射）" % (len(TEXTS), ", ".join(sorted(BURN))))
    by_voice = {}
    voices_meta = []
    for key, name, engine, qvoice in VOICES:
        if key in BURN:
            m, fails = burn_voice(key, name, engine, qvoice)
            if fails:
                print("!! %s(%s) 有 %d 条失败，未写 manifest（修好再跑）" % (name, key, len(fails)))
                return 2
        else:
            m = base.get(key, {})
            print(">> %-9s(%s) 沿用现有映射 %d 条（未重烧）" % (name, key, len(m)))
        by_voice[key] = m
        if m:
            voices_meta.append({"key": key, "name": name})

    if DEFAULT_VOICE not in [v["key"] for v in voices_meta]:
        print("!! 默认音色 %s 无映射，停止" % DEFAULT_VOICE)
        return 2

    good = {v["key"]: by_voice[v["key"]] for v in voices_meta}
    header = (
        "/*\n"
        " * app/audio/manifest.js —— 预渲染音频清单（渲染层接口缝 say() 的第 1 优先级）。\n"
        " * 自动生成，勿手改；改台词/换音色请重跑 scripts/gen_audio_night.py。\n"
        " * 多音色可切换：App 设置里「🌙 夜间语音」选谁，say() 就用谁的 clip。\n"
        " * 仅夜间放松；力量训练仍走浏览器 TTS。\n"
        " */\n"
    )
    body = (
        "window.AUDIO_MANIFEST_BY_VOICE = %s;\n"
        "window.AUDIO_MANIFEST_VOICES = %s;\n"
        "window.AUDIO_MANIFEST_DEFAULT = %s;\n"
        "window.AUDIO_MANIFEST = window.AUDIO_MANIFEST_BY_VOICE[window.AUDIO_MANIFEST_DEFAULT];\n"
    ) % (
        json.dumps(good, ensure_ascii=False, indent=2),
        json.dumps(voices_meta, ensure_ascii=False),
        json.dumps(DEFAULT_VOICE, ensure_ascii=False),
    )
    with open(MANIFEST, "w", encoding="utf-8") as mf:
        mf.write(header + body)
    print("=== manifest.js 写好：%d 把可选音色（默认 %s）===" % (len(voices_meta), DEFAULT_VOICE))
    return 0


sys.exit(main())
