/**
 * WebSocket 事件注册
 * 处理身份初始化、房间创建/加入/离开、准备、开始游戏、断线重连
 */
const config = require("../config");

module.exports = function registerSocket({ io, roomManager }) {
  const hostGrace = new Map(); // socket 所属房主房间的宽限定时器

  io.on("connection", (socket) => {
    socket.data.user = null;

    socket.on("user:init", (user, ack) => {
      if (!user || !user.userId || !user.nickname) {
        return ack && ack({ ok: false, error: "身份信息不完整" });
      }
      socket.data.user = { ...user, socketId: socket.id };
      ack && ack({ ok: true });
    });

    socket.on("room:list", (_arg, ack) => {
      ack && ack({ ok: true, data: roomManager.listRooms() });
    });

    socket.on("room:create", (_arg, ack) => {
      try {
        const user = requireUser(socket, ack);
        const room = roomManager.createRoom(user);
        socket.join(room.code);
        ack && ack({ ok: true, data: roomManager.snapshot(room) });
        io.emit("lobby:update", roomManager.listRooms());
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on("room:join", (payload, ack) => {
      try {
        const user = requireUser(socket, ack);
        const code = payload && payload.code;
        const room = roomManager.joinRoom(code, user);
        socket.join(room.code);
        clearHostGrace(room.code);
        ack && ack({ ok: true, data: roomManager.snapshot(room) });
        io.emit("lobby:update", roomManager.listRooms());
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    // 已有成员在任意阶段断线重连（不要求 WAITING），恢复连接与房间状态
    socket.on("room:reconnect", (payload, ack) => {
      try {
        const user = requireUser(socket, ack);
        const code = payload && payload.code;
        const room = roomManager.reconnectRoom(code, user);
        socket.join(room.code);
        clearHostGrace(room.code);
        ack && ack({ ok: true, data: roomManager.snapshot(room) });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on("room:leave", (payload, ack) => {
      const user = socket.data.user;
      const code = payload && payload.code;
      if (!user || !code) return ack && ack({ ok: false, error: "参数缺失" });
      socket.leave(code);
      roomManager.leave(code, user.userId);
      io.emit("lobby:update", roomManager.listRooms());
      ack && ack({ ok: true });
    });

    socket.on("member:ready", (payload, ack) => {
      try {
        const user = requireUser(socket, ack);
        roomManager.setReady(payload.code, user, !!payload.ready);
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on("game:start", (payload, ack) => {
      try {
        const user = requireUser(socket, ack);
        roomManager.startGame(payload.code, user.userId);
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on("room:kick", (payload, ack) => {
      try {
        const user = requireUser(socket, ack);
        roomManager.kick(payload.code, user.userId, payload.targetUserId);
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on("disconnect", () => {
      roomManager.disconnect(socket.id);
      const user = socket.data.user;
      if (!user) return;
      // 仅当断开者是房主时，启动宽限定时器；期间游戏由服务端定时器继续推进
      // 房主在宽限内通过 room:reconnect 回来会清除该定时器，超时才解散房间
      for (const room of roomManager.rooms.values()) {
        if (room.hostId === user.userId) {
          const graceMs = config.timing.hostReconnectGraceSeconds * 1000;
          const timer = setTimeout(() => {
            if (roomManager.rooms.has(room.code)) {
              roomManager.leave(room.code, user.userId);
              io.emit("lobby:update", roomManager.listRooms());
            }
          }, graceMs);
          hostGrace.set(room.code, timer);
        }
      }
    });
  });

  function clearHostGrace(code) {
    if (hostGrace.has(code)) {
      clearTimeout(hostGrace.get(code));
      hostGrace.delete(code);
    }
  }

  function requireUser(socket, ack) {
    const user = socket.data.user;
    if (!user) {
      const err = new Error("身份未初始化，请刷新重试");
      ack && ack({ ok: false, error: err.message });
      throw err;
    }
    return user;
  }
};
