/**
 * 服务入口：HTTP（静态页 + 音频上传/访问）与 WebSocket（实时状态）
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");

const config = require("../config");
const { DATA_DIR, stmts } = require("./db");
const { safeUnlink } = require("./audioStore");
const { RoomManager } = require("./roomManager");
const scoring = require("./ai");
const registerSocket = require("./socket");

const TMP_DIR = path.join(DATA_DIR, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const broadcast = (code, event, payload) => io.to(code).emit(event, payload);
const roomManager = new RoomManager({ broadcast, scoring });

app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: config.audio.uploadMaxMB * 1024 * 1024 },
});

// 音频上传（录音提交，手动或自动）
app.post("/api/upload/audio", upload.single("audio"), async (req, res) => {
  const { code, userId, role, auto } = req.body || {};
  if (!req.file) return res.status(400).json({ ok: false, error: "缺少音频文件" });
  try {
    if (role === "host") {
      await roomManager.hostUpload(code, userId, req.file, auto === "1");
    } else {
      await roomManager.guestUpload(code, { userId }, req.file, auto === "1");
    }
    res.json({ ok: true });
  } catch (e) {
    safeUnlink(req.file.path);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 房主音频访问（访客播放）
app.get("/audio/host/:code", (req, res) => {
  const room = roomManager.rooms.get(req.params.code);
  if (!room || !room.round || !room.round.hostAudio) return res.status(404).end();
  res.sendFile(room.round.hostAudio.path);
});

// 通用音频访问：按音频 ID 取文件（火山识别回调与客户端播放共用）
app.get("/audio/play/:id", (req, res) => {
  const audio = stmts.getAudioById && stmts.getAudioById.run(Number(req.params.id));
  if (!audio || !audio.processed_path || !fs.existsSync(audio.processed_path)) {
    return res.status(404).end();
  }
  res.sendFile(audio.processed_path);
});

registerSocket({ io, roomManager });

server.listen(config.server.port, () => {
  console.log(`语音复述评分服务已启动，监听端口 ${config.server.port}`);
  console.log(`本地访问 http://localhost:${config.server.port}`);
});
