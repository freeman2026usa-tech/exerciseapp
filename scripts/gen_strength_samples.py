#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
力量音色试听 —— 用几条代表性力量台词（LEAD 长句 + 短提示 + 安全句 + 口令）在候选音色上各烧一条，
存到 app/audio/samples/（gitignore），供挑「中性偏亮、吐字清楚、有精神不亢奋」的力量音色。
选定后 set STRENGTH_VOICE=那个 再跑 gen_audio_strength.py 全烧。
用法(cmd):  set DASHSCOPE_API_KEY=sk-...   python scripts/gen_strength_samples.py
"""
import os
import sys
import time
import urllib.request

import dashscope
from dashscope.audio.qwen_tts import SpeechSynthesizer

def _read_key():
    k = (os.environ.get("DASHSCOPE_API_KEY") or "").strip().strip('"').strip("'")
    if k:
        return k
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".dashscope_key")  # gitignore
    if os.path.exists(p):
        return open(p, encoding="utf-8").read().strip().strip('"').strip("'")
    return ""


KEY = _read_key()
if not KEY:
    print("ERR: 未提供 key（设环境变量 DASHSCOPE_API_KEY，或写入 scripts/.dashscope_key）")
    sys.exit(1)
dashscope.api_key = KEY
dashscope.base_http_api_url = "https://dashscope.aliyuncs.com/api/v1"
MODEL = "qwen3-tts-flash"

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "audio", "samples")
os.makedirs(OUT, exist_ok=True)

# 一条代表性串：口令 + 短要领 + 安全句（力量音色最该听清「有精神、清晰、不亢奋」）
SAMPLE = "预备，开始。中立握，肘四十五度，护左肘。左肘要是咔响，或者有刺痛，就停。这组完成，歇九十秒，手臂甩松。"

# 8 个母语普通话女声候选（气质拉开，避开外语腔/纯奶音）
VOICES = [
    ("cherry",  "Cherry",  "芊悦·阳光清亮亲切"),
    ("maia",    "Maia",    "四月·知性干练"),
    ("bellona", "Bellona", "燕铮莺·洪亮清晰有力"),
    ("chelsie", "Chelsie", "千雪·年轻清亮"),
    ("vivian",  "Vivian",  "十三·飒·有精神"),
    ("serena",  "Serena",  "苏瑶·温和（偏柔备选）"),
    ("stella",  "Stella",  "少女阿月·甜亮少女"),
    ("momo",    "Momo",    "茉兔·活力"),
]


def audio_url(resp):
    a = getattr(getattr(resp, "output", None), "audio", None)
    if a is None:
        return None
    return a.get("url") if hasattr(a, "get") else getattr(a, "url", None)


ok, fail = [], []
for label, voice, desc in VOICES:
    t0 = time.time()
    try:
        resp = SpeechSynthesizer.call(model=MODEL, text=SAMPLE, voice=voice)
        if getattr(resp, "status_code", None) != 200:
            raise RuntimeError("status=%s msg=%s" % (getattr(resp, "status_code", "?"), getattr(resp, "message", "?")))
        url = audio_url(resp)
        if not url:
            raise RuntimeError("无音频URL")
        data = urllib.request.urlopen(url, timeout=30).read()
        path = os.path.join(OUT, "strength_%s.wav" % label)
        with open(path, "wb") as f:
            f.write(data)
        ok.append(label)
        print("OK   %-10s %d bytes (%.1fs)  <- %s（%s）" % (label, len(data), time.time() - t0, voice, desc))
    except Exception as e:
        fail.append(label)
        print("FAIL %-10s %s: %s" % (label, type(e).__name__, str(e)[:140]))

print("\n=== 成功 %d：%s ｜ 失败 %d：%s ===" % (len(ok), ",".join(ok), len(fail), ",".join(fail)))
print("试听 app/audio/samples/strength_*.wav，选定后 set STRENGTH_VOICE=<名> 跑 gen_audio_strength.py 全烧。")
