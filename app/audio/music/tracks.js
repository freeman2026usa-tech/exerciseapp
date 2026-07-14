/*
 * app/audio/music/tracks.js —— 背景音乐曲目清单（可替换，不写死）
 *
 * 默认只有一条"合成氛围"（Web Audio 现场合成，无需文件、免版权）。
 * 想用自己的音乐：把 mp3 放进本目录 app/audio/music/，然后在下面数组里加一行，例如：
 *   { name: "海浪", type: "file", file: "audio/music/waves.mp3" },
 * 保存后刷新，主页设置的"音乐"下拉里就会出现它。
 */
window.MUSIC_TRACKS = [
  { name: "合成氛围", type: "synth" },
  // { name: "自定义音乐", type: "file", file: "audio/music/your.mp3" },
];
