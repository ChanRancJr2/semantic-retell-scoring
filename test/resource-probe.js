/* 探测账号对各录音文件识别资源的授权状态 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "probe-result.log"), out.join("\n"), "utf8");
};

async function probe(resourceId) {
  const resp = await fetch(
    "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.SPEECH_API_KEY,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": crypto.randomUUID(),
        "X-Api-Sequence": "-1",
      },
      body: JSON.stringify({
        user: { uid: process.env.SPEECH_API_KEY },
        audio: { data: "//uQx" }, // 极小无效数据，仅用于探测授权
        request: { model_name: "bigmodel" },
      }),
    }
  );
  return {
    code: resp.headers.get("X-Api-Status-Code"),
    msg: resp.headers.get("X-Api-Message"),
  };
}

(async () => {
  const ids = ["volc.seedasr.auc", "volc.bigasr.auc_turbo", "volc.bigasr.auc_idle", "volc.bigasr.auc"];
  for (const id of ids) {
    try {
      const r = await probe(id);
      const granted = r.msg !== "requested resource not granted" && !String(r.code).startsWith("45000030");
      rec(`${id}: code=${r.code} msg=${r.msg} -> ${granted ? "已授权" : "未授权"}`);
    } catch (e) {
      rec(`${id}: 探测异常 ${e.message}`);
    }
  }
})();
