/*
 * app/audio/manifest.js —— 预渲染音频清单（渲染层接口缝的第 1 优先级）
 *
 * 现在是空的：say() 查不到 clip，就退回运行时大模型适配器 window.AI_TTS（默认无），
 * 再退回浏览器实时 TTS。功能完全正常。
 *
 * 「换大模型渲染音频」= Phase 2：跑生成脚本（edge-tts / OpenAI / ElevenLabs 任选），
 * 把固定台词逐句渲染成 mp3，并在这里填成：
 *   window.AUDIO_MANIFEST = { "腹式呼吸": "audio/clips/xxxx.mp3", "呼比吸长": "audio/clips/yyyy.mp3", ... };
 * App 代码一个字都不用改，say() 命中即用预渲染音频。
 */
// window.AUDIO_MANIFEST = {};
