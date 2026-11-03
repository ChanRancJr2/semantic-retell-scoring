/* ASR 公网链路验证：用可公网访问的 mp3 URL 验证 Key、资源授权与 submit/query 流程 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const { transcribe } = require("../server/ai/asr");

const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "asr-public-result.log"), out.join("\n"), "utf8");
};

// 可换成 ECS 上的真实音频 URL
const TEST_URL = process.argv[2] || "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

(async () => {
  rec("资源ID: " + process.env.SPEECH_RESOURCE_ID);
  rec("测试URL: " + TEST_URL);
  try {
    const text = await transcribe(TEST_URL, "mp3");
    rec("submit/query 流程成功（Key 与资源授权正常）");
    rec("返回文本='" + text + "'（音乐可能为空或静音码，属正常）");
    rec("PASS");
  } catch (e) {
    rec("ASR 失败: " + e.message);
    rec("FAIL");
  }
})();
