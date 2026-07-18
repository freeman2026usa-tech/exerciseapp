#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
力量语音烧录 —— 把 scripts/strength_texts.json（由 strength_voice.js 从 语音稿.md 生成、按文本去重）
用单一力量音色烧成本地 clip，写 app/audio/strength_manifest.js（力量与夜间共用 say() 文本键出声缝的力量池）。
命名 md5(text)[:12].wav，已存在即跳（断点续烧，可反复跑补齐）。走 qwen3-tts-flash（与夜间同一路径）。

语速：启动先探针试该模型认不认 rate；认→按每条 rate 烧，不认→全 1.0 烧（并在 manifest 头注明）。

用法(cmd):  set DASHSCOPE_API_KEY=sk-...   set STRENGTH_VOICE=Katerina   python scripts/gen_audio_strength.py
可选:  set STRENGTH_BURN=^(G_|W|A)   只烧部分（默认全烧=完全品）。  key 只经环境变量，绝不写文件/提交。
"""
import os
import re
import sys
import json
import time
import hashlib
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
dashscope.base_http_api_url = "https://dashscope.aliyuncs.com/api/v1"  # 国内·北京

MODEL = "qwen3-tts-flash"
VOICE = (os.environ.get("STRENGTH_VOICE") or "Katerina").strip()
BURN_RE = os.environ.get("STRENGTH_BURN")  # 默认全烧
BURN = re.compile(BURN_RE) if BURN_RE else None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
CLIPS = os.path.join(ROOT, "app", "audio", "strength")
MANIFEST = os.path.join(ROOT, "app", "audio", "strength_manifest.js")
TEXTS = os.path.join(HERE, "strength_texts.json")

if not os.path.exists(TEXTS):
    print("ERR: 缺 strength_texts.json，先跑 node scripts/strength_voice.js")
    sys.exit(1)
with open(TEXTS, encoding="utf-8") as f:
    ROWS = json.load(f)  # [{text, rate, phase}]


def ext_of(data):
    if data[:4] == b"RIFF":
        return "wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    return "wav"


def synth(text, rate=None):
    kw = dict(model=MODEL, text=text, voice=VOICE)
    if rate is not None:
        kw["rate"] = rate
    resp = SpeechSynthesizer.call(**kw)
    if getattr(resp, "status_code", None) != 200:
        raise RuntimeError("status=%s code=%s msg=%s" % (
            getattr(resp, "status_code", "?"), getattr(resp, "code", "?"), getattr(resp, "message", "?")))
    a = getattr(getattr(resp, "output", None), "audio", None)
    url = (a.get("url") if hasattr(a, "get") else getattr(a, "url", None)) if a is not None else None
    if not url:
        raise RuntimeError("无音频URL")
    return urllib.request.urlopen(url, timeout=60).read()


def probe_rate():
    """探针：试带 rate 的一次合成。返回 True=模型接受，False=不接受（回退全 1.0）。"""
    sample = "预备，开始。"
    try:
        synth(sample, rate=0.9)
        return True
    except TypeError as e:
        print("   探针：SDK 不认 rate 参数（%s）→ 全 1.0 烧" % str(e)[:60])
        return False
    except Exception as e:
        msg = str(e).lower()
        if "rate" in msg or "parameter" in msg or "invalid" in msg or "unsupport" in msg:
            print("   探针：模型拒绝 rate（%s）→ 全 1.0 烧" % str(e)[:60])
            return False
        # 其它错误（网络/额度）：不误判为不支持，抛出让主流程处理
        raise


def load_existing():
    if not os.path.exists(MANIFEST):
        return {}
    txt = open(MANIFEST, encoding="utf-8").read()
    marker = "window.AUDIO_MANIFEST_STRENGTH = "
    if marker not in txt:
        return {}
    start = txt.index(marker) + len(marker)
    end = txt.rindex(";")
    try:
        return json.loads(txt[start:end])
    except Exception:
        return {}


def main():
    os.makedirs(CLIPS, exist_ok=True)
    # 相位过滤：phase 字段是逗号分隔的相位键集合（如 "A" 或 "A,DV"），任一命中即烧；默认全量
    if BURN is not None:
        rows = [r for r in ROWS if any(BURN.search(p) for p in r.get("phase", "").split(","))]
    else:
        rows = list(ROWS)
    print("音色=%s  待烧文本=%d  语速=探针决定  %s" % (
        VOICE, len(rows), ("子集 " + BURN_RE) if BURN_RE else "全量（完全品）"))

    use_rate = probe_rate()
    print("=> 语速模式：%s" % ("按每条 rate 烧" if use_rate else "全部 1.0（模型不认 rate）"))

    manifest = load_existing()
    made = skipped = 0
    fails = []
    for i, r in enumerate(rows, 1):
        text, rate = r["text"], (r["rate"] if use_rate else None)
        h = hashlib.md5(text.encode("utf-8")).hexdigest()[:12]
        existing = [fn for fn in os.listdir(CLIPS) if fn.startswith(h + ".")]
        if existing:
            manifest[text] = "audio/strength/%s" % existing[0]
            skipped += 1
            continue
        ok = False
        for attempt in range(1, 4):
            try:
                data = synth(text, rate)
                if not data:
                    raise RuntimeError("空音频")
                fn = "%s.%s" % (h, ext_of(data))
                with open(os.path.join(CLIPS, fn), "wb") as wf:
                    wf.write(data)
                manifest[text] = "audio/strength/%s" % fn
                made += 1
                ok = True
                break
            except Exception as e:
                print("   ...%d/%d 第%d次失败 %s: %s" % (i, len(rows), attempt, text[:10], str(e)[:70]))
                time.sleep(1.2)
        if not ok:
            fails.append(text)
        if i % 25 == 0:
            print("   进度 %d/%d（新烧 %d，跳过 %d，失败 %d）" % (i, len(rows), made, skipped, len(fails)))
        time.sleep(0.12)

    print("\n>> 新烧 %d | 跳过 %d | 失败 %d | 映射 %d" % (made, skipped, len(fails), len(manifest)))
    if fails:
        print("!! 有 %d 条失败，未写 manifest（修好再跑，已烧的会跳过）：" % len(fails))
        for t in fails[:20]:
            print("   -", t[:30])
        return 2

    header = (
        "/*\n"
        " * app/audio/strength_manifest.js —— 力量预渲染 clip 清单 { 文本: 路径 }（力量池；与夜间共用 say() 文本键出声）。\n"
        " * 自动生成，勿手改；改台词/换音色请重跑 scripts/gen_audio_strength.py。\n"
        " * 音色=%s ｜ 语速=%s ｜ 条数=%d\n"
        " */\n"
    ) % (VOICE, ("按档" if use_rate else "全1.0"), len(manifest))
    body = "window.AUDIO_MANIFEST_STRENGTH = %s;\n" % json.dumps(manifest, ensure_ascii=False, indent=2)
    with open(MANIFEST, "w", encoding="utf-8") as mf:
        mf.write(header + body)
    print("=== strength_manifest.js 写好：%d 条（音色 %s）===" % (len(manifest), VOICE))
    return 0


sys.exit(main())
