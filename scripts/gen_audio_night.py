#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
夜间放松台词 —— 整套烧录为本地音频 clip + 生成 app/audio/manifest.js。
台词来自 scripts/night_strings.json（由 scripts/night_strings.js 从 program.js 精确提取，勿手改）。
音色固定为终选 (MODEL, VOICE)；换音色只改下面两行再重跑即可。
已存在的 clip 自动跳过（按文本哈希断点续烧）。
用法(cmd):  set DASHSCOPE_API_KEY=sk-...   然后  python scripts/gen_audio_night.py
key 只经环境变量传入，绝不写进任何文件、绝不提交。
"""
import os
import sys
import json
import time
import hashlib
import urllib.request

import dashscope
from dashscope.audio.qwen_tts import SpeechSynthesizer

KEY = (os.environ.get("DASHSCOPE_API_KEY") or "").strip().strip('"').strip("'")
if not KEY:
    print("ERR: 未设置环境变量 DASHSCOPE_API_KEY")
    sys.exit(1)
dashscope.api_key = KEY
dashscope.base_http_api_url = "https://dashscope.aliyuncs.com/api/v1"  # 国内·北京

# ===== 终选音色（换音色改这两行再重跑）=====
MODEL = "qwen3-tts-flash"
VOICE = "Seren"   # 你的终选：Seren（听下来最棒、原速保留）

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CLIPS = os.path.join(ROOT, "app", "audio", "clips")
MANIFEST = os.path.join(ROOT, "app", "audio", "manifest.js")
STRINGS = os.path.join(HERE, "night_strings.json")
os.makedirs(CLIPS, exist_ok=True)

if not os.path.exists(STRINGS):
    print("ERR: 缺 night_strings.json，先跑 node scripts/night_strings.js")
    sys.exit(1)
with open(STRINGS, encoding="utf-8") as f:
    texts = json.load(f)
print("待烧 %d 条  音色=%s (%s)" % (len(texts), VOICE, MODEL))


def ext_of(data):
    if data[:4] == b"RIFF":
        return "wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    return "wav"


def audio_url(resp):
    out = getattr(resp, "output", None)
    if out is None:
        return None
    a = getattr(out, "audio", None)
    if a is None:
        return None
    return a.get("url") if hasattr(a, "get") else getattr(a, "url", None)


manifest = {}
ok, fail = [], []
for i, text in enumerate(texts, 1):
    h = hashlib.md5(text.encode("utf-8")).hexdigest()[:12]
    existing = [fn for fn in os.listdir(CLIPS) if fn.startswith(h + ".")]
    if existing:
        manifest[text] = "audio/clips/" + existing[0]
        print("SKIP %2d/%d  %s" % (i, len(texts), text[:16]))
        continue
    done = False
    for attempt in range(1, 4):
        try:
            resp = SpeechSynthesizer.call(model=MODEL, text=text, voice=VOICE)
            if getattr(resp, "status_code", None) != 200:
                raise RuntimeError("status=%s msg=%s" % (
                    getattr(resp, "status_code", "?"), getattr(resp, "message", "?")))
            url = audio_url(resp)
            if not url:
                raise RuntimeError("响应无音频URL")
            data = urllib.request.urlopen(url, timeout=60).read()
            if not data:
                raise RuntimeError("空音频")
            fn = "%s.%s" % (h, ext_of(data))
            with open(os.path.join(CLIPS, fn), "wb") as wf:
                wf.write(data)
            manifest[text] = "audio/clips/" + fn
            ok.append(text)
            print("OK   %2d/%d  %-18s %d bytes" % (i, len(texts), text[:16], len(data)))
            done = True
            break
        except Exception as e:
            print("...  %2d/%d  第%d次失败 %s: %s" % (i, len(texts), attempt, text[:12], str(e)[:70]))
            time.sleep(1.0)
    if not done:
        fail.append(text)

# —— 写 manifest.js ——（未全部成功则不覆盖，避免半套清单）
if fail:
    print("\n=== 失败 %d 条，未写 manifest（先修好再重跑）===" % len(fail))
    print("失败：" + " / ".join(t[:12] for t in fail))
    sys.exit(2)

header = (
    "/*\n"
    " * app/audio/manifest.js —— 预渲染音频清单（渲染层接口缝 say() 的第 1 优先级）。\n"
    " * 自动生成，勿手改；改台词/换音色请重跑 scripts/gen_audio_night.py。\n"
    " * 音色：%s（%s）· 仅夜间放松；力量训练仍走浏览器 TTS。\n"
    " */\n"
) % (VOICE, MODEL)
with open(MANIFEST, "w", encoding="utf-8") as mf:
    mf.write(header + "window.AUDIO_MANIFEST = "
             + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n")

print("\n=== 成功 %d | manifest 条目 %d → app/audio/manifest.js ===" % (len(ok), len(manifest)))
print("下一步：node --check，再验证 clip 齐全，然后提交。")
