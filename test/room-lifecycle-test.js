/* 房间生命周期测试：
   1) AI 评分后房间保持 RESULT，不自动回等待/关闭
   2) 单个成员主动退出不关闭，全员主动退出才关闭
   3) 全员离线：宽限内重连不关闭；宽限后仍无人在线才关闭
   4) 计时配置：房主 180 秒、访客 300 秒 */
const { spawn } = require("child_process");
const path = require("path");
const ffmpeg = require("ffmpeg-static");
const fs = require("fs");
const { io } = require("socket.io-client");
const config = require("../config");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = __dirname;

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
  // 短宽限服务，便于快速验证离线关闭
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: path.join(here, ".."),
    env: { ...process.env, AI_MODE: "mock", HOST_RECONNECT_GRACE_SECONDS: "2" },
  });
  let failed = false;
  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };
  try {
    // ---- 配置校验 ----
    if (config.timing.hostPhaseSeconds !== 180) throw new Error("房主阶段应为180秒");
    if (config.timing.guestPhaseSeconds !== 300) throw new Error("访客阶段应为300秒");
    console.log("步骤0: 计时配置正确（房主180s / 访客300s）");

    await sleep(2500);
    const ack = (sock, ev, pl) =>
      new Promise((res, rej) =>
        sock.emit(ev, pl || {}, (x) => (x.ok ? res(x.data) : rej(new Error(x.error))))
      );

    // ---- 场景1：完整一轮，评分后保持 ----
    const host = track(io(BASE));
    const guest = track(io(BASE));
    await waitConnect(host);
    await waitConnect(guest);
    await ack(host, "user:init", { userId: "h1", nickname: "房主" });
    await ack(guest, "user:init", { userId: "g1", nickname: "访客" });
    const room = await ack(host, "room:create");
    await ack(guest, "room:join", { code: room.code });
    await ack(host, "member:ready", { code: room.code, ready: true });
    await ack(guest, "member:ready", { code: room.code, ready: true });
    await ack(host, "game:start", { code: room.code });

    const hf = path.join(here, "lc-h.mp3");
    const gf = path.join(here, "lc-g.mp3");
    await genSilence(hf, 3);
    await upload(room.code, "h1", "host", hf);
    await sleep(500);
    await genSilence(gf, 3);
    await upload(room.code, "g1", "guest", gf);
    console.log("步骤1: 已走完一轮，等待评分结果");

    // 用房间列表轮询状态
    const getStatus = async () => {
      const rooms = await new Promise((res) => {
        const probe = io(BASE);
        probe.on("connect", () =>
          probe.emit("room:list", {}, (x) => { res(x.data); probe.close(); })
        );
      });
      const found = rooms.find((r) => r.code === room.code);
      return found ? found.status : null;
    };

    for (let i = 0; i < 20; i++) {
      const st = await getStatus();
      if (st === "RESULT") break;
      await sleep(500);
    }
    // 等待超过旧的 10 秒自动回等待阈值，确认房间仍保持 RESULT
    await sleep(12000);
    const after12 = await getStatus();
    if (after12 !== "RESULT") throw new Error("评分后房间应保持 RESULT，实际=" + after12);
    console.log("步骤2: 评分后超过12秒，房间仍保持 RESULT（未自动关闭）");

    // ---- 场景2：单人退出不关闭 ----
    await ack(guest, "room:leave", { code: room.code });
    guest.close();
    await sleep(800);
    const afterGuestLeave = await getStatus();
    if (afterGuestLeave !== "RESULT") throw new Error("访客退出后房间应仍在，实际=" + afterGuestLeave);
    console.log("步骤3: 访客退出后房间仍在（房主未退出）");

    // 房主退出，全员已离开 -> 关闭
    await ack(host, "room:leave", { code: room.code });
    host.close();
    await sleep(1000);
    const afterHostLeave = await getStatus();
    if (afterHostLeave !== null) throw new Error("全员退出后房间应关闭");
    console.log("步骤4: 房主退出（全员已离开），房间关闭");

    // ---- 场景3：全员离线，宽限后关闭 ----
    const h2 = track(io(BASE));
    const g2 = track(io(BASE));
    await waitConnect(h2);
    await waitConnect(g2);
    await ack(h2, "user:init", { userId: "h2", nickname: "房主2" });
    await ack(g2, "user:init", { userId: "g2", nickname: "访客2" });
    const room2 = await ack(h2, "room:create");
    await ack(g2, "room:join", { code: room2.code });
    const getStatus2 = async () => {
      const rooms = await new Promise((res) => {
        const probe = io(BASE);
        probe.on("connect", () =>
          probe.emit("room:list", {}, (x) => { res(x.data); probe.close(); })
        );
      });
      const found = rooms.find((r) => r.code === room2.code);
      return found ? found.status : null;
    };
    h2.disconnect();
    g2.disconnect();
    await sleep(700); // 宽限（2s）内
    const withinGrace = await getStatus2();
    if (withinGrace == null) throw new Error("宽限内房间不应被关闭");
    await sleep(2200); // 超过宽限
    const afterGrace = await getStatus2();
    if (afterGrace !== null) throw new Error("全员离线宽限后房间应关闭，实际=" + afterGrace);
    console.log("步骤5: 全员离线，宽限内保留、宽限后关闭");

    // ---- 场景4：离线宽限内重连，不关闭 ----
    const h3 = track(io(BASE));
    const g3 = track(io(BASE));
    await waitConnect(h3);
    await waitConnect(g3);
    await ack(h3, "user:init", { userId: "h3", nickname: "房主3" });
    await ack(g3, "user:init", { userId: "g3", nickname: "访客3" });
    const room3 = await ack(h3, "room:create");
    await ack(g3, "room:join", { code: room3.code });
    const getStatus3 = async () => {
      const rooms = await new Promise((res) => {
        const probe = io(BASE);
        probe.on("connect", () =>
          probe.emit("room:list", {}, (x) => { res(x.data); probe.close(); })
        );
      });
      const found = rooms.find((r) => r.code === room3.code);
      return found ? found.status : null;
    };
    h3.disconnect();
    g3.disconnect();
    await sleep(800);
    // 房主在宽限内重连
    const h3back = track(io(BASE));
    await waitConnect(h3back);
    await ack(h3back, "user:init", { userId: "h3", nickname: "房主3" });
    const recSnap = await ack(h3back, "room:reconnect", { code: room3.code });
    if (recSnap.status !== "WAITING") throw new Error("重连后应恢复 WAITING");
    await sleep(2500); // 超过原宽限
    const afterReconnect = await getStatus3();
    if (afterReconnect == null) throw new Error("宽限内重连后房间不应关闭");
    console.log("步骤6: 全员离线但宽限内重连，房间保持不关闭");
    h3back.close();

    console.log("\n房间生命周期测试通过 ✔");
  } catch (e) {
    failed = true;
    console.error("✘ 测试失败:", e.message);
  } finally {
    for (const s of sockets) try { s.close(); } catch {}
    server.kill();
    for (const f of ["lc-h.mp3", "lc-g.mp3"]) {
      const p = path.join(here, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    process.exitCode = failed ? 1 : 0;
  }
})();
