/**
 * 房间管理器：房间状态机与实时权威状态
 * 所有阶段流转、倒计时截止、自动上传均由服务端驱动，客户端只做展示与操作
 */
const config = require("../config");
const { stmts } = require("./db");
const { genRoomCode } = require("./audioStore");

// 房间状态枚举
const STATUS = {
  WAITING: "WAITING",
  HOST_RECORDING: "HOST_RECORDING",
  GUEST_RECORDING: "GUEST_RECORDING",
  SCORING: "SCORING",
  RESULT: "RESULT",
};

class RoomManager {
  constructor({ broadcast, scoring }) {
    this.rooms = new Map(); // code -> runtime room
    this.broadcast = broadcast; // (code, event, payload)
    this.scoring = scoring; // 评分服务
  }

  // ---------- 大厅 ----------
  listRooms() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      name: r.name,
      status: r.status,
      hostId: r.hostId,
      memberCount: r.members.size,
      maxMembers: config.room.maxMembersPerRoom,
    }));
  }

  createRoom(user) {
    if (this.rooms.size >= config.room.maxRooms) {
      throw new Error("房间数量已达上限，暂无可创建房间");
    }
    // 同一用户已有房间则直接返回其房间
    for (const r of this.rooms.values()) {
      if (r.hostId === user.userId) return r;
    }
    const code = genRoomCode((c) => this.rooms.has(c));
    const now = Date.now();
    const info = stmts.createRoom.run(code, `${user.nickname}的房间`, user.userId, now);
    const room = {
      id: info.lastInsertRowid,
      code,
      name: `${user.nickname}的房间`,
      hostId: user.userId,
      status: STATUS.WAITING,
      members: new Map(),
      round: null,
      timers: [],
    };
    this.rooms.set(code, room);
    this._addMember(room, user, "host");
    return room;
  }

  joinRoom(code, user) {
    const room = this.rooms.get(code);
    if (!room) throw new Error("房间不存在或已关闭");
    if (room.status !== STATUS.WAITING) throw new Error("游戏已开始，无法中途加入");
    if (!room.members.has(user.userId) && room.members.size >= config.room.maxMembersPerRoom) {
      throw new Error("房间人数已满");
    }
    const isHost = user.userId === room.hostId;
    this._addMember(room, user, isHost ? "host" : "guest");
    return room;
  }

  _addMember(room, user, role) {
    const existing = room.members.get(user.userId);
    const member = existing || {
      userId: user.userId,
      nickname: user.nickname,
      role,
      ready: false,
      socketId: user.socketId,
      connected: true,
    };
    member.socketId = user.socketId;
    member.connected = true;
    member.nickname = user.nickname;
    room.members.set(user.userId, member);
    stmts.addMember.run(
      room.id,
      user.userId,
      user.nickname,
      role,
      member.ready ? 1 : 0,
      Date.now()
    );
    this._sync(room);
  }

  // ---------- 成员/权限 ----------
  kick(code, hostId, targetUserId) {
    const room = this._requireRoom(code);
    this._assertHost(room, hostId);
    if (room.status !== STATUS.WAITING) throw new Error("游戏进行中不允许踢人");
    if (targetUserId === room.hostId) throw new Error("不能移除房主");
    if (!room.members.delete(targetUserId)) throw new Error("该成员不在房间内");
    stmts.removeMember.run(room.id, targetUserId);
    this.broadcast(code, "kicked", { userId: targetUserId });
    this._sync(room);
  }

  setReady(code, user, ready) {
    const room = this._requireRoom(code);
    const member = room.members.get(user.userId);
    if (!member) throw new Error("你不在该房间内");
    member.ready = ready;
    stmts.setReady.run(room.id, user.userId, ready ? 1 : 0);
    this._sync(room);
  }

  canStart(room) {
    const members = [...room.members.values()];
    if (!members.every((m) => m.ready)) return false;
    if (config.room.requireGuestToStart && !members.some((m) => m.role === "guest")) {
      return false;
    }
    return true;
  }

  // ---------- 游戏流程 ----------
  startGame(code, hostId) {
    const room = this._requireRoom(code);
    this._assertHost(room, hostId);
    if (room.status !== STATUS.WAITING) throw new Error("当前阶段无法开始游戏");
    if (!this.canStart(room)) {
      throw new Error("需全员准备，且至少有一名访客才能开始");
    }
    const prevMax = stmts.latestRound.get(room.id);
    const roundNo = prevMax ? this._roundNo(prevMax) + 1 : 1;
    const roundInfo = stmts.createRound.run(room.id, roundNo, Date.now());
    room.round = {
      dbId: roundInfo.lastInsertRowid,
      roundNo,
      hostAudio: null,
      guestAudios: new Map(),
    };
    stmts.setRoomStatus.run(room.id, STATUS.HOST_RECORDING);
    room.status = STATUS.HOST_RECORDING;
    stmts.resetReady.run(room.id);

    const hostDeadline = Date.now() + config.timing.hostPhaseSeconds * 1000;
    this._schedule(room, config.timing.hostPhaseSeconds * 1000, () =>
      this._autoHostUpload(room)
    );
    this.broadcast(code, "phase", {
      status: room.status,
      role: "host",
      deadline: hostDeadline,
      phaseSeconds: config.timing.hostPhaseSeconds,
    });
    this._sync(room);
  }

  /** 房主上传音频（手动或自动），处理后进入访客阶段 */
  async hostUpload(code, hostId, file, auto = false) {
    const room = this._requireRoom(code);
    this._assertHost(room, hostId);
    if (room.status !== STATUS.HOST_RECORDING) throw new Error("当前不是房主录音阶段");
    if (room.round.hostAudio) throw new Error("房主音频已上传");
    this._clearTimers(room);

    const { processAudio } = require("./audioStore");
    const { safeUnlink } = require("./audioStore");
    const { processedPath, durationSec } = await processAudio({
      inputPath: file.path,
      prefix: `round${room.round.roundNo}_host`,
      trimSeconds: config.timing.hostAudioTrimSeconds,
    });
    safeUnlink(file.path);
    const hostAudioRow = stmts.addAudio.run(
      room.round.dbId,
      room.hostId,
      "host",
      processedPath,
      null,
      auto ? 1 : 0,
      durationSec,
      Date.now()
    );
    room.round.hostAudio = {
      path: processedPath,
      durationSec,
      autoUploaded: auto,
      audioDbId: hostAudioRow.lastInsertRowid,
    };

    stmts.setRoomStatus.run(room.id, STATUS.GUEST_RECORDING);
    room.status = STATUS.GUEST_RECORDING;
    const guestDeadline = Date.now() + config.timing.guestPhaseSeconds * 1000;
    this._schedule(room, config.timing.guestPhaseSeconds * 1000, () =>
      this._guestPhaseTimeout(room)
    );
    this.broadcast(code, "phase", {
      status: room.status,
      role: "guest",
      deadline: guestDeadline,
      phaseSeconds: config.timing.guestPhaseSeconds,
      hostAudioUrl: `/audio/host/${room.code}`,
    });
    this._sync(room);
  }

  async _autoHostUpload(room) {
    if (room.status !== STATUS.HOST_RECORDING || room.round.hostAudio) return;
    // 通知客户端立即提交已有录音；若客户端无响应，服务端按缺录音处理
    this.broadcast(room.code, "forceSubmit", { role: "host" });
    // 给予 3 秒宽限提交，仍无上传则按无房主音频结束（异常情况）
    this._schedule(room, 3000, async () => {
      if (room.round.hostAudio) return;
      // 极端情况：房主完全无录音，直接结束并提示
      this._abort(room, "房主未上传任何录音，本轮结束");
    });
  }

  async guestUpload(code, user, file, auto = false) {
    const room = this._requireRoom(code);
    if (room.status !== STATUS.GUEST_RECORDING) throw new Error("当前不是访客录音阶段");
    const member = room.members.get(user.userId);
    if (!member || member.role !== "guest") throw new Error("只有访客可提交复述录音");
    if (room.round.guestAudios.has(user.userId)) throw new Error("你已上传录音");

    const { processAudio, safeUnlink } = require("./audioStore");
    const { processedPath, durationSec } = await processAudio({
      inputPath: file.path,
      prefix: `round${room.round.roundNo}_guest_${user.userId.slice(-4)}`,
      trimSeconds: null, // 访客不做时长截断，以语义为准
    });
    safeUnlink(file.path);
    const guestAudioRow = stmts.addAudio.run(
      room.round.dbId,
      user.userId,
      "guest",
      processedPath,
      null,
      auto ? 1 : 0,
      durationSec,
      Date.now()
    );
    room.round.guestAudios.set(user.userId, {
      path: processedPath,
      durationSec,
      autoUploaded: auto,
      audioDbId: guestAudioRow.lastInsertRowid,
    });
    this._sync(room);
    this._maybeFinishGuest(room);
  }

  _maybeFinishGuest(room) {
    const guests = [...room.members.values()].filter((m) => m.role === "guest");
    if (guests.every((g) => room.round.guestAudios.has(g.userId))) {
      // 全员主动上传：直接进入评分，无需再催交
      this._enterScoring(room);
    }
  }

  /** 访客阶段墙钟超时：催交未上传者，给 3 秒宽限后进入评分 */
  _guestPhaseTimeout(room) {
    if (room.status !== STATUS.GUEST_RECORDING) return;
    this.broadcast(room.code, "forceSubmit", { role: "guest" });
    this._schedule(room, 3000, () => this._enterScoring(room));
  }

  _enterScoring(room) {
    if (room.status !== STATUS.GUEST_RECORDING) return;
    this._clearTimers(room);
    this._runScoring(room);
  }

  async _runScoring(room) {
    if (room.status !== STATUS.GUEST_RECORDING) return;
    this._clearTimers(room);
    room.status = STATUS.SCORING;
    stmts.setRoomStatus.run(room.id, STATUS.SCORING);
    this.broadcast(room.code, "phase", { status: STATUS.SCORING });
    this._sync(room);
    try {
      const result = await this.scoring.scoreRound(room);
      this._presentResult(room, result);
    } catch (err) {
      this._abort(room, `评分失败：${err.message}`);
    }
  }

  _presentResult(room, result) {
    for (const item of result.scores) {
      stmts.addScore.run(
        room.round.dbId,
        item.userId,
        item.matchScore,
        item.languageScore,
        item.matchGrade,
        item.languageGrade,
        item.comment,
        Date.now()
      );
    }
    room.status = STATUS.RESULT;
    stmts.setRoomStatus.run(room.id, STATUS.RESULT);
    stmts.setRoundStatus.run(room.round.dbId, "DONE");
    this.broadcast(room.code, "result", result);
    this._sync(room);
    // 10 秒后回到等待大厅
    this._schedule(room, 10000, () => this._backToWaiting(room));
  }

  _backToWaiting(room) {
    this._clearTimers(room);
    room.status = STATUS.WAITING;
    room.round = null;
    stmts.setRoomStatus.run(room.id, STATUS.WAITING);
    for (const m of room.members.values()) m.ready = false;
    stmts.resetReady.run(room.id);
    this.broadcast(room.code, "phase", { status: STATUS.WAITING });
    this._sync(room);
  }

  _abort(room, message) {
    this._clearTimers(room);
    room.status = STATUS.WAITING;
    room.round = null;
    stmts.setRoomStatus.run(room.id, STATUS.WAITING);
    this.broadcast(room.code, "error", { message });
    this.broadcast(room.code, "phase", { status: STATUS.WAITING });
    this._sync(room);
  }

  // ---------- 断线/离开 ----------
  disconnect(socketId) {
    for (const room of this.rooms.values()) {
      for (const [userId, m] of room.members) {
        if (m.socketId === socketId) {
          m.connected = false;
          stmts.setConnected.run(room.id, userId, 0);
          if (userId === room.hostId) {
            // 房主断开：先标记，等待重连；若 socket 关闭事件判定为离开则解散
          }
          this._sync(room);
        }
      }
    }
  }

  leave(code, userId) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (userId === room.hostId) {
      this._destroyRoom(room);
      return;
    }
    room.members.delete(userId);
    stmts.removeMember.run(room.id, userId);
    this._sync(room);
  }

  _destroyRoom(room) {
    this._clearTimers(room);
    stmts.deleteRoom.run(room.id);
    this.broadcast(room.code, "roomClosed", {});
    this.rooms.delete(room.code);
  }

  /**
   * 重连恢复：仅允许“原本就在房间内”的成员在任意阶段重连
   * 只恢复连接与 socketId，不重置其准备/录音等既有状态
   */
  reconnectRoom(code, user) {
    const room = this.rooms.get(code);
    if (!room) throw new Error("房间不存在或已关闭");
    const member = room.members.get(user.userId);
    if (!member) throw new Error("你不是该房间成员，无法重连");
    member.socketId = user.socketId;
    member.connected = true;
    member.nickname = user.nickname || member.nickname;
    stmts.setConnected.run(room.id, user.userId, 1);
    this._sync(room);
    return room;
  }

  // ---------- 工具 ----------
  _requireRoom(code) {
    const room = this.rooms.get(code);
    if (!room) throw new Error("房间不存在或已关闭");
    return room;
  }
  _assertHost(room, userId) {
    if (room.hostId !== userId) throw new Error("仅房主可执行该操作");
  }
  _schedule(room, ms, fn) {
    const t = setTimeout(() => {
      room.timers = room.timers.filter((x) => x !== t);
      fn();
    }, ms);
    room.timers.push(t);
  }
  _clearTimers(room) {
    room.timers.forEach(clearTimeout);
    room.timers = [];
  }
  _roundNo(prev) {
    return prev.round_no;
  }

  /** 房间公开快照（发给客户端） */
  snapshot(room) {
    return {
      code: room.code,
      name: room.name,
      hostId: room.hostId,
      status: room.status,
      members: [...room.members.values()].map((m) => ({
        userId: m.userId,
        nickname: m.nickname,
        role: m.role,
        ready: m.ready,
        connected: m.connected,
      })),
      maxMembers: config.room.maxMembersPerRoom,
      round: room.round
        ? {
            roundNo: room.round.roundNo,
            hostAudio: room.round.hostAudio
              ? { durationSec: room.round.hostAudio.durationSec }
              : null,
            guestsSubmitted: [...room.round.guestAudios.keys()],
          }
        : null,
    };
  }

  _sync(room) {
    this.broadcast(room.code, "roomState", this.snapshot(room));
  }
}

module.exports = { RoomManager, STATUS };
