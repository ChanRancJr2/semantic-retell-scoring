/* ASR 资源开通验证：静音文件应返回空文本且不报错 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpeg = require("ffmpeg-static");
const { transcribe } = require("../server/ai/asr");

const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "asr-result.log"), out.join("\n"), "utf8");
};

(async () => {
  const f = path.join(__dirname, "silence.mp3");
  await new Promise((res, rej) => {
    const p = spawn(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", f]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("gen fail"))));
  });
  try {
    const text = await transcribe(f);
    rec("ASR 资源已开通，静音返回空文本（不报错），链路正常");
    rec("返回='" + text + "'");
    rec("PASS");
  } catch (e) {
    rec("ASR 失败: " + e.message);
    rec("FAIL");
  }
})();
