/* 重连回归测试：验证游戏中（非 WAITING）断线后可通过 room:reconnect 恢复，
   且不会被当成新成员拒绝、不会触发房间解散 */
const { spawn } = require("child_process");
const path = require("path");
const ffmpeg = require("ffmpeg-static");
const fs = require("fs");
const { io } = require("socket.io-client");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = __dirname;

// 健壮的连接等待：避免错过已触发的 connect 事件
function waitConnect(sock) {
  return new Promise((r) => {
    if (sock.connected) return r();
    sock.once("connect", r);
  });
}
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
  let failed = false;
  try {
    await sleep(2500);
    console.log("步骤0: 启动客户端并连接");
    const host = io(BASE);
    const guest = io(BASE);
    await waitConnect(host);
    await waitConnect(guest);
    const ack = (sock, ev, pl) =>
      new Promise((res, rej) =>
        sock.emit(ev, pl || {}, (x) => (x.ok ? res(x.data) : rej(new Error(x.error))))
      );

    await ack(host, "user:init", { userId: "host1", nickname: "房主甲" });
    await ack(guest, "user:init", { userId: "guest1", nickname: "访客乙" });
    const room = await ack(host, "room:create");
    console.log("步骤1: 创建房间", room.code);
    await ack(guest, "room:join", { code: room.code });
    await ack(host, "member:ready", { code: room.code, ready: true });
    await ack(guest, "member:ready", { code: room.code, ready: true });
    await ack(host, "game:start", { code: room.code });
    console.log("步骤2: 全员准备并开始");

    const hFile = path.join(here, "h.mp3");
    await genSilence(hFile, 3);
    await upload(room.code, "host1", "host", hFile);
    await sleep(600);
    console.log("步骤3: 房主上传，进入访客阶段");

    // 1) 游戏中用 room:join 应被拒绝（新成员路径，不能用于重连）
    let joinRejected = false;
    try {
      await ack(guest, "room:join", { code: room.code });
    } catch {
      joinRejected = true;
    }
    if (!joinRejected) throw new Error("游戏中 room:join 应拒绝新成员路径");
    console.log("步骤4: 游戏中 room:join 正确拒绝");

    // 2) 模拟访客完全断线，再以新连接 room:reconnect 恢复
    guest.disconnect();
    await sleep(800);
    const guestAgain = io(BASE);
    await waitConnect(guestAgain);
    await ack(guestAgain, "user:init", { userId: "guest1", nickname: "访客乙" });
    const snap = await ack(guestAgain, "room:reconnect", { code: room.code });
    if (snap.status !== "GUEST_RECORDING") throw new Error("重连后应处于访客阶段");
    if (snap.members.length !== 2) throw new Error("重连后成员仍应为2");
    const me = snap.members.find((m) => m.userId === "guest1");
    if (!me || !me.connected) throw new Error("访客重连后应在线");
    console.log("步骤5: 访客断线重连成功，恢复到", snap.status);

    // 3) 非成员重连应失败
    const stranger = io(BASE);
    await waitConnect(stranger);
    await ack(stranger, "user:init", { userId: "x9", nickname: "陌生人" });
    let strangerBlocked = false;
    try {
      await ack(stranger, "room:reconnect", { code: room.code });
    } catch {
      strangerBlocked = true;
    }
    if (!strangerBlocked) throw new Error("非成员不应能重连进房");
    console.log("步骤6: 非成员重连被正确拒绝");

    host.close();
    guestAgain.close();
    stranger.close();
    console.log("\n重连回归测试通过 ✔");
  } catch (e) {
    failed = true;
    console.error("✘ 重连测试失败:", e.message);
  } finally {
    server.kill();
    if (fs.existsSync(path.join(here, "h.mp3"))) fs.unlinkSync(path.join(here, "h.mp3"));
    process.exitCode = failed ? 1 : 0;
  }
})();
