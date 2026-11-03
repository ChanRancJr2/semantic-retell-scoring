/**
 * 火山豆包语音 - 录音文件识别模型 2.0 标准版
 * 流程：submit（提交音频公网 URL）→ query（轮询结果）
 * 资源 ID：volc.seedasr.auc
 */
const crypto = require("crypto");

const SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseHeaders(requestId) {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": process.env.SPEECH_API_KEY,
    "X-Api-Resource-Id": process.env.SPEECH_RESOURCE_ID || "volc.seedasr.auc",
    "X-Api-Request-Id": requestId,
  };
}

/**
 * @param {string} audioUrl 火山服务可公网访问的音频 URL
 * @param {string} format 音频格式 mp3/wav/ogg
 * @returns {Promise<string>} 识别文本；静音返回空字符串
 */
async function transcribe(audioUrl, format = "mp3") {
  if (!process.env.SPEECH_API_KEY) throw new Error("缺少 SPEECH_API_KEY");
  const requestId = crypto.randomUUID();
  const headers = baseHeaders(requestId);

  // 1) 提交任务
  const submitResp = await fetch(SUBMIT_URL, {
    method: "POST",
    headers: { ...headers, "X-Api-Sequence": "-1" },
    body: JSON.stringify({
      user: { uid: process.env.SPEECH_API_KEY },
      audio: { format, url: audioUrl },
      request: { model_name: "bigmodel" },
    }),
  });
  const submitCode = submitResp.headers.get("X-Api-Status-Code");
  if (submitCode !== "20000000") {
    throw new Error(
      `识别提交失败 code=${submitCode} msg=${submitResp.headers.get("X-Api-Message")}`
    );
  }

  // 2) 轮询结果
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const qr = await fetch(QUERY_URL, {
      method: "POST",
      headers,
      body: "{}",
    });
    const code = qr.headers.get("X-Api-Status-Code");
    if (code === "20000000") {
      const j = await qr.json();
      return (j.result && j.result.text) || "";
    }
    if (code === "20000003") return ""; // 静音
    if (code === "20000001" || code === "20000002") continue; // 处理中/排队
    throw new Error(`识别查询失败 code=${code} msg=${qr.headers.get("X-Api-Message")}`);
  }
  throw new Error("语音识别超时（超过 60 秒未返回）");
}

module.exports = { transcribe };
