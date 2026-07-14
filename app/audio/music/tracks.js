/*
 * app/audio/music/tracks.js —— 背景音乐曲目清单（可替换，不写死）
 *
 * 「轻音·合成钟琴」是 App 现场合成的柔和氛围（五声音阶钟琴 + 暖底垫，无需文件、免版权、离线）。
 *
 * 想用你自己的音乐（推荐真实好听的曲子）：
 *   1) 把 mp3 放进本目录 app/audio/music/（如 waves.mp3）；
 *   2) 在下面数组里加一行： { name: "海浪", type: "file", file: "audio/music/waves.mp3" },
 *   3) 保存刷新，主页设置的「音乐」下拉里就会出现它，可选、可关。
 */
window.MUSIC_TRACKS = [
  { name: "轻音·合成钟琴", type: "synth" },
  // { name: "海浪", type: "file", file: "audio/music/waves.mp3" },
];
