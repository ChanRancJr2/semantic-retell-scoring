/* 端到端流程测试：模拟房主+访客两个客户端走完整轮（mock 评分） */
const { spawn } = require("child_process");
const path = require("path");
const ffmpeg = require("ffmpeg-static");
const fs = require("fs");
const { io } = require("socket.io-client");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = __dirname;

function genSilence(out, sec) {
  return new Promise((res, rej) => {
    const p = spawn(ffmpeg, [
      "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(sec), out,
    ]);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error("生成音频失败"))));
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
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.join(here, ".."),
  });
  const host = io(BASE);
  const guest = io(BASE);
  let result = null;
  guest.on("result", (r) => (result = r));
  try {
    await sleep(2500);
    await new Promise((r) => host.on("connect", r));
    await new Promise((r) => guest.on("connect", r));
    const ack = (sock, ev, pl) =>
      new Promise((res, rej) =>
        sock.emit(ev, pl || {}, (x) => (x.ok ? res(x.data) : rej(new Error(x.error))))
      );

    await ack(host, "user:init", { userId: "host1", nickname: "房主甲" });
    await ack(guest, "user:init", { userId: "guest1", nickname: "访客乙" });

    const room = await ack(host, "room:create");
    console.log("✓ 创建房间，码:", room.code, "状态:", room.status);

    const joined = await ack(guest, "room:join", { code: room.code });
    if (joined.members.length !== 2) throw new Error("成员数应为2");
    console.log("✓ 访客加入，成员数:", joined.members.length);

    await ack(host, "member:ready", { code: room.code, ready: true });
    await ack(guest, "member:ready", { code: room.code, ready: true });
    await ack(host, "game:start", { code: room.code });
    console.log("✓ 全员准备，游戏开始");

    const hFile = path.join(here, "h.mp3");
    const gFile = path.join(here, "g.mp3");
    await genSilence(hFile, 5);
    await sleep(400);
    const hr = await upload(room.code, "host1", "host", hFile);
    if (!hr.ok) throw new Error("房主上传失败 " + hr.error);
    console.log("✓ 房主音频上传，进入访客阶段");

    await genSilence(gFile, 5);
    await sleep(400);
    const gr = await upload(room.code, "guest1", "guest", gFile);
    if (!gr.ok) throw new Error("访客上传失败 " + gr.error);
    console.log("✓ 访客音频上传，触发评分");

    for (let i = 0; i < 40 && !result; i++) await sleep(500);
    if (!result) throw new Error("未收到评分结果");
    console.log("✓ 收到评分结果：");
    console.log(JSON.stringify(result.scores, null, 2));
    console.log("\n端到端测试通过 ✔");
  } catch (e) {
    console.error("✘ 测试失败:", e.message);
    process.exitCode = 1;
  } finally {
    host.close();
    guest.close();
    server.kill();
  }
})();
