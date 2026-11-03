/**
 * WebSocket 事件注册
 * 处理身份初始化、房间创建/加入/离开、准备、开始游戏、断线重连
 */
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
      // 若断开的是房主，给 30 秒宽限，未重连则解散房间
      for (const room of roomManager.rooms.values()) {
        if (room.hostId === user.userId) {
          const timer = setTimeout(() => {
            if (roomManager.rooms.has(room.code)) {
              roomManager.leave(room.code, user.userId);
              io.emit("lobby:update", roomManager.listRooms());
            }
          }, 30000);
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
