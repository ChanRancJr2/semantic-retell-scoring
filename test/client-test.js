/* 连接已运行的服务，走完整流程，结果写入文件，避免控制台捕获问题 */
const path = require("path");
const ffmpeg = require("ffmpeg-static");
const fs = require("fs");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (s) => {
  log.push(s);
  fs.writeFileSync(path.join(__dirname, "client-result.log"), log.join("\n"), "utf8");
};

function genSilence(out, sec) {
  return new Promise((res, rej) => {
    const p = spawn(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(sec), out]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("gen fail"))));
  });
}
async function upload(code, userId, role, file) {
  const fd = new FormData();
  fd.append("audio", new Blob([fs.readFileSync(file)]), "t.mp3");
  fd.append("code", code);
  fd.append("userId", userId);
  fd.append("role", role);
  fd.append("auto", "0");
  const r = await fetch(BASE + "/api/upload/audio", { method: "POST", body: fd });
  return r.json();
}

(async () => {
  const host = io(BASE);
  const guest = io(BASE);
  let result = null;
  guest.on("result", (r) => (result = r));
  try {
    await new Promise((r) => host.on("connect", r));
    await new Promise((r) => guest.on("connect", r));
    const ack = (sock, ev, pl) =>
      new Promise((res, rej) =>
        sock.emit(ev, pl || {}, (x) => (x.ok ? res(x.data) : rej(new Error(x.error))))
      );
    await ack(host, "user:init", { userId: "hostA", nickname: "房主A" });
    await ack(guest, "user:init", { userId: "guestB", nickname: "访客B" });
    const room = await ack(host, "room:create");
    rec("创建房间 code=" + room.code + " status=" + room.status);
    const joined = await ack(guest, "room:join", { code: room.code });
    rec("访客加入 成员数=" + joined.members.length);
    await ack(host, "member:ready", { code: room.code, ready: true });
    await ack(guest, "member:ready", { code: room.code, ready: true });
    await ack(host, "game:start", { code: room.code });
    rec("全员准备并开始游戏");

    const hf = path.join(__dirname, "h.mp3");
    const gf = path.join(__dirname, "g.mp3");
    await genSilence(hf, 5);
    const hr = await upload(room.code, "hostA", "host", hf);
    rec("房主上传 ok=" + hr.ok + (hr.error ? " err=" + hr.error : ""));
    await genSilence(gf, 5);
    await sleep(300);
    const grr = await upload(room.code, "guestB", "guest", gf);
    rec("访客上传 ok=" + grr.ok + (grr.error ? " err=" + grr.error : ""));

    for (let i = 0; i < 40 && !result; i++) await sleep(500);
    if (!result) throw new Error("未收到结果");
    rec("评分结果:\n" + JSON.stringify(result.scores, null, 2));
    rec("PASS");
  } catch (e) {
    rec("FAIL: " + e.message);
  } finally {
    host.close();
    guest.close();
  }
})();
