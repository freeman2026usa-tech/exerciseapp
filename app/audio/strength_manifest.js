/*
 * app/audio/strength_manifest.js —— 力量预渲染 clip 清单 { 文本: 路径 }（力量与夜间共用 say() 文本键出声缝的力量池）。
 * 自动生成，勿手改；跑 scripts/gen_audio_strength.py 烧录后覆盖。
 * Phase 0 占位：空 map → 力量全部走 say()/sayThen() 的 TTS 兜底。
 */
window.AUDIO_MANIFEST_STRENGTH = {};
