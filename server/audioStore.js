/**
 * 音频处理：统一转码为 mp3、房主音频截断、时长探测
 * 直接用子进程调用 ffmpeg-static 自带二进制，无需系统安装 ffmpeg
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const config = require("../config");
const { AUDIO_DIR } = require("./db");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** 解析音频时长（秒），读取 ffmpeg 输出里的 Duration 字段 */
async function probeDuration(filePath) {
  const stderr = await runFfmpeg(["-i", filePath, "-f", "null", "-"]);
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 处理上传音频：转 mp3，可选截断前 N 秒
 * @returns { processedPath, durationSec }
 */
async function processAudio({ inputPath, prefix, trimSeconds = null }) {
  const fileName = `${prefix}_${Date.now()}.${config.audio.targetFormat}`;
  const outPath = path.join(AUDIO_DIR, fileName);
  const args = ["-y", "-i", inputPath];
  if (trimSeconds && trimSeconds > 0) args.push("-t", String(trimSeconds));
  args.push(
    "-acodec",
    "libmp3lame",
    "-ab",
    config.audio.bitrate,
    "-ac",
    "1",
    outPath
  );
  await runFfmpeg(args);
  const durationSec = await probeDuration(outPath);
  return { processedPath: outPath, durationSec };
}

/** 生成不冲突的房间码（6 位大写字母数字，去除易混字符） */
function genRoomCode(exists) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (exists(code));
  return code;
}

/** 安全清理临时文件（忽略错误） */
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* 忽略 */
  }
}

module.exports = { processAudio, probeDuration, genRoomCode, safeUnlink, AUDIO_DIR };
