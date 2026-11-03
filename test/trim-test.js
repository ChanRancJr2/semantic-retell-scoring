/* 验证房主音频截断：生成 70 秒音频，按配置截断为 60 秒 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpeg = require("ffmpeg-static");
const { processAudio } = require("../server/audioStore");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "trim-result.log"), out.join("\n"), "utf8");
};

(async () => {
  const src = path.join(__dirname, "src70.mp3");
  await new Promise((res, rej) => {
    const p = spawn(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "70", src]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("gen fail"))));
  });
  const config = require("../config");
  rec("源音频时长: 70 秒, 截断阈值: " + config.timing.hostAudioTrimSeconds + " 秒");
  const r = await processAudio({
    inputPath: src,
    prefix: "trimcheck",
    trimSeconds: config.timing.hostAudioTrimSeconds,
  });
  rec("处理后实际时长: " + r.durationSec.toFixed(2) + " 秒");
  const ok = r.durationSec <= 61 && r.durationSec >= 59;
  rec(ok ? "PASS：已正确截断到约60秒" : "FAIL：截断异常");
})().catch((e) => rec("FAIL: " + e.message));
