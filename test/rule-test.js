/* 验证业务规则拦截，连接已运行的服务 */
const path = require("path");
const fs = require("fs");
const { io } = require("socket.io-client");

const BASE = "http://localhost:3000";
const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "rule-result.log"), out.join("\n"), "utf8");
};
const ack = (sock, ev, pl) =>
  new Promise((res) =>
    sock.emit(ev, pl || {}, (x) => res(x))
  );

(async () => {
  const host = io(BASE);
  const guest = io(BASE);
  await new Promise((r) => host.on("connect", r));
  await new Promise((r) => guest.on("connect", r));
  await ack(host, "user:init", { userId: "h_rule", nickname: "规则房主" });
  await ack(guest, "user:init", { userId: "g_rule", nickname: "规则访客" });

  const room = (await ack(host, "room:create")).data;
  await ack(guest, "room:join", { code: room.code });

  // 1) 单人开局（访客存在但先测试无访客语义：这里访客已在，先测未全员准备）
  await ack(host, "member:ready", { code: room.code, ready: true });
  const r1 = await ack(host, "game:start", { code: room.code });
  rec("1) 访客未准备时房主开始 -> ok=" + r1.ok + " 错误='" + r1.error + "'");

  // 2) 访客准备后开始成功，进入 HOST_RECORDING
  await ack(guest, "member:ready", { code: room.code, ready: true });
  const r2 = await ack(host, "game:start", { code: room.code });
  rec("2) 全员准备后开始 -> ok=" + r2.ok);

  // 3) 游戏进行中房主踢人 -> 应失败
  const r3 = await ack(host, "room:kick", { code: room.code, targetUserId: "g_rule" });
  rec("3) 游戏中踢人 -> ok=" + r3.ok + " 错误='" + r3.error + "'");

  // 4) 访客尝试开始游戏 -> 应失败（仅房主）
  const r4 = await ack(guest, "game:start", { code: room.code });
  rec("4) 访客尝试开始 -> ok=" + r4.ok + " 错误='" + r4.error + "'");

  // 5) 访客尝试踢人 -> 应失败
  const r5 = await ack(guest, "room:kick", { code: room.code, targetUserId: "h_rule" });
  rec("5) 访客尝试踢人 -> ok=" + r5.ok + " 错误='" + r5.error + "'");

  const pass =
    !r1.ok && r2.ok && !r3.ok && !r4.ok && !r5.ok;
  rec(pass ? "PASS：所有规则拦截符合预期" : "FAIL：规则拦截不符合预期");
  host.close();
  guest.close();
})().catch((e) => rec("FAIL: " + e.message));
