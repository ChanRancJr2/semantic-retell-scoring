/* ===== 前端主逻辑 ===== */
const $ = (id) => document.getElementById(id);
const socket = io();

const state = {
  userId: localStorage.getItem("userId"),
  nickname: localStorage.getItem("nickname") || "",
  room: null,
  phase: null,
  deadline: null,
  uiTimer: null,
  hostRec: new Recorder(),
  guestRec: new Recorder(),
};

if (!state.userId) {
  state.userId = "u_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  localStorage.setItem("userId", state.userId);
}

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
}
function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload || {}, (res) =>
      res.ok ? resolve(res.data) : reject(new Error(res.error))
    );
  });
}

/* ===== Socket 连接与重连 ===== */
socket.on("connect", async () => {
  if (state.nickname) {
    try {
      await emitAck("user:init", { userId: state.userId, nickname: state.nickname });
      const lastCode = localStorage.getItem("lastRoomCode");
      if (lastCode) {
        try {
          const snap = await emitAck("room:join", { code: lastCode });
          enterRoom(snap);
        } catch {
          localStorage.removeItem("lastRoomCode");
        }
      }
    } catch (e) {
      toast(e.message);
    }
  }
});
socket.on("lobby:update", () => refreshLobby());
socket.on("roomState", (snap) => {
  state.room = snap;
  renderRoom();
});
socket.on("phase", (p) => {
  state.phase = p;
  state.deadline = p.deadline || null;
  handlePhase(p);
});
socket.on("forceSubmit", (p) => autoSubmit(p.role));
socket.on("result", (result) => renderResult(result));
socket.on("error", (p) => toast(p.message, 3500));
socket.on("kicked", (p) => {
  if (p.userId === state.userId) backToLobby("你已被房主移出房间");
});
socket.on("roomClosed", () => backToLobby("房间已关闭"));

/* ===== 身份 ===== */
$("btn-enter").addEventListener("click", async () => {
  const name = $("nickname-input").value.trim();
  if (!name) return toast("请输入昵称");
  state.nickname = name;
  localStorage.setItem("nickname", name);
  await emitAck("user:init", { userId: state.userId, nickname: name });
  showView("lobby");
  $("me-badge").textContent = name;
  refreshLobby();
});
$("nickname-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-enter").click();
});

/* ===== 大厅 ===== */
async function refreshLobby() {
  const rooms = await emitAck("room:list");
  const box = $("room-list");
  if (!rooms.length) {
    box.innerHTML = '<div class="empty">暂无房间，创建一个吧</div>';
    return;
  }
  box.innerHTML = "";
  rooms.forEach((r) => {
    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `<div class="info"><div class="name">${r.name}</div>
      <div class="meta">房间码 ${r.code} · ${r.memberCount}/${r.maxMembers} 人</div></div>`;
    const b = document.createElement("button");
    b.className = "btn btn-small btn-primary";
    b.textContent = "加入";
    b.onclick = () => joinRoom(r.code);
    card.appendChild(b);
    box.appendChild(card);
  });
}
$("btn-create").addEventListener("click", async () => {
  try {
    const snap = await emitAck("room:create");
    enterRoom(snap);
  } catch (e) {
    toast(e.message);
  }
});
$("btn-join").addEventListener("click", () => {
  const code = $("join-code").value.trim().toUpperCase();
  if (code) joinRoom(code);
});
async function joinRoom(code) {
  try {
    const snap = await emitAck("room:join", { code });
    enterRoom(snap);
  } catch (e) {
    toast(e.message);
  }
}

/* ===== 进入/离开房间 ===== */
function enterRoom(snap) {
  state.room = snap;
  localStorage.setItem("lastRoomCode", snap.code);
  showView("room");
  renderRoom();
}
function backToLobby(msg) {
  localStorage.removeItem("lastRoomCode");
  state.room = null;
  state.phase = null;
  state.deadline = null;
  state.hostRec.releaseMic();
  state.guestRec.releaseMic();
  showView("lobby");
  refreshLobby();
  if (msg) toast(msg);
}
$("btn-leave").addEventListener("click", async () => {
  if (!state.room) return;
  await emitAck("room:leave", { code: state.room.code });
  backToLobby();
});

/* ===== 房间渲染 ===== */
function renderRoom() {
  const r = state.room;
  if (!r) return;
  $("room-title").textContent = r.name;
  $("room-code-badge").textContent = "房码 " + r.code;
  $("member-count").textContent = `${r.members.length}/${r.maxMembers}`;

  const me = r.members.find((m) => m.userId === state.userId);
  const isHost = me && me.role === "host";

  // 成员列表
  const mb = $("member-list");
  mb.innerHTML = "";
  r.members.forEach((m) => {
    const card = document.createElement("div");
    card.className = "member-card" + (m.connected ? "" : " offline");
    const canKick = isHost && r.status === "WAITING" && m.userId !== state.userId;
    card.innerHTML = `<div class="who">
        <span class="role-tag ${m.role === "host" ? "role-host" : "role-guest"}">${m.role === "host" ? "房主" : "访客"}</span>
        <span>${m.nickname}${m.connected ? "" : "（离线）"}</span>
      </div>
      <span class="ready-dot ${m.ready ? "ready-yes" : "ready-no"}">${m.ready ? "已准备" : "未准备"}</span>
      ${canKick ? '<button class="btn btn-small btn-danger kick">踢出</button>' : ""}`;
    if (canKick) {
      card.querySelector(".kick").onclick = () =>
        emitAck("room:kick", { code: r.code, targetUserId: m.userId }).catch((e) => toast(e.message));
    }
    mb.appendChild(card);
  });

  // 面板显隐
  $("waiting-actions").classList.toggle("hidden", r.status !== "WAITING");
  $("host-recorder").classList.toggle("hidden", !(r.status === "HOST_RECORDING" && isHost));
  $("guest-recorder").classList.toggle("hidden", !(r.status === "GUEST_RECORDING" && !isHost));
  $("scoring-tip").classList.toggle("hidden", r.status !== "SCORING");
  $("result-panel").classList.toggle("hidden", r.status !== "RESULT");

  if (r.status === "WAITING") {
    $("phase-banner").textContent = "等待成员准备";
    $("btn-ready").textContent = me && me.ready ? "取消准备" : "准备";
    $("btn-start").classList.toggle("hidden", !(isHost && r.members.every((x) => x.ready)));
  } else if (r.status === "HOST_RECORDING") {
    $("phase-banner").textContent = isHost ? "房主发言阶段：请录制并上传" : "房主正在发言…";
  } else if (r.status === "GUEST_RECORDING") {
    $("phase-banner").textContent = isHost ? "访客正在复述…" : "访客复述阶段：先听录音再复述";
  } else if (r.status === "SCORING") {
    $("phase-banner").textContent = "AI 评分中";
  }
}

/* ===== 阶段切换 ===== */
function handlePhase(p) {
  if (p.status === "GUEST_RECORDING" && p.hostAudioUrl) {
    $("host-audio-player").src = p.hostAudioUrl + "?t=" + Date.now();
  }
  startUiTick();
}

/* ===== 准备 / 开始 ===== */
$("btn-ready").addEventListener("click", async () => {
  const me = state.room.members.find((m) => m.userId === state.userId);
  await emitAck("member:ready", { code: state.room.code, ready: !(me && me.ready) }).catch((e) =>
    toast(e.message)
  );
});
$("btn-start").addEventListener("click", () =>
  emitAck("game:start", { code: state.room.code }).catch((e) => toast(e.message))
);

/* ===== 录音控件：房主 ===== */
$("host-btn-rec").addEventListener("click", async () => {
  try {
    if (state.hostRec.state === "idle") {
      await state.hostRec.start();
      $("host-btn-rec").textContent = "暂停录制";
    } else {
      state.hostRec.toggle();
      $("host-btn-rec").textContent = state.hostRec.state === "recording" ? "暂停录制" : "继续录制";
    }
  } catch (e) {
    toast(e.message);
  }
});
$("host-btn-delete").addEventListener("click", () => {
  state.hostRec.delete();
  $("host-btn-rec").textContent = "开始录制";
  $("host-rec-time").textContent = "00:00";
});
$("host-btn-upload").addEventListener("click", () => submitHost(false));

/* ===== 录音控件：访客 ===== */
$("guest-btn-play").addEventListener("click", () => {
  const audio = $("host-audio-player");
  audio.play().catch((e) => toast("播放失败：" + e.message));
});
$("guest-btn-rec").addEventListener("click", async () => {
  try {
    if (state.guestRec.state === "idle") {
      await state.guestRec.start();
      $("guest-btn-rec").textContent = "暂停复述";
    } else {
      state.guestRec.toggle();
      $("guest-btn-rec").textContent = state.guestRec.state === "recording" ? "暂停复述" : "继续复述";
    }
  } catch (e) {
    toast(e.message);
  }
});
$("guest-btn-upload").addEventListener("click", () => submitGuest(false));

/* ===== 上传 ===== */
async function postAudio(blob, role, auto) {
  const ext = (blob.type.includes("mp4") || blob.type.includes("m4a")) ? "m4a" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, "recording." + ext);
  fd.append("code", state.room.code);
  fd.append("userId", state.userId);
  fd.append("role", role);
  fd.append("auto", auto ? "1" : "0");
  const resp = await fetch("/api/upload/audio", { method: "POST", body: fd });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error);
}
async function submitHost(auto) {
  if (!state.hostRec.hasContent()) return toast("还没有录制内容");
  const blob = await state.hostRec.stopBlob();
  await postAudio(blob, "host", auto);
  state.hostRec.releaseMic();
  if (!auto) toast("录音已上传");
}
async function submitGuest(auto) {
  if (!state.guestRec.hasContent()) return toast("还没有录制内容");
  const blob = await state.guestRec.stopBlob();
  await postAudio(blob, "guest", auto);
  state.guestRec.releaseMic();
  if (!auto) toast("录音已上传");
}
async function autoSubmit(role) {
  try {
    if (role === "host" && state.hostRec.hasContent()) await submitHost(true);
    if (role === "guest" && state.guestRec.hasContent()) await submitGuest(true);
  } catch (e) {
    toast(e.message);
  }
}

/* ===== 每秒刷新：倒计时 + 录音时长 ===== */
function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function startUiTick() {
  if (state.uiTimer) clearInterval(state.uiTimer);
  state.uiTimer = setInterval(() => {
    // 阶段倒计时
    if (state.deadline) {
      const cd = $("countdown");
      cd.classList.remove("hidden");
      cd.textContent = fmt(state.deadline - Date.now());
    }
    // 录音时长
    if (state.hostRec.state !== "idle") $("host-rec-time").textContent = fmt(state.hostRec.durationMs());
    if (state.guestRec.state !== "idle") $("guest-rec-time").textContent = fmt(state.guestRec.durationMs());
  }, 250);
}

/* ===== 结果渲染 ===== */
function renderResult(result) {
  // 转写
  let tb = `<div><b>房主原文：</b>${result.hostText}</div>`;
  result.guests.forEach((g) => {
    tb += `<div style="margin-top:6px"><b>${g.nickname}的复述：</b>${g.text || "（无有效语音）"}</div>`;
  });
  $("transcript-box").innerHTML = tb;

  const list = $("score-list");
  list.innerHTML = "";
  result.scores.forEach((s) => {
    const card = document.createElement("div");
    card.className = "score-card";
    const matchBlock =
      s.matchScore === null
        ? ""
        : `<div class="score-row"><span class="label">复述匹配分</span>
             <span><span class="score-val">${s.matchScore}</span><span class="grade">${s.matchGrade}</span></span></div>`;
    card.innerHTML = `<div class="head"><span class="role-tag ${s.role === "host" ? "role-host" : "role-guest"}">${s.role === "host" ? "房主" : "访客"}</span>
        <span class="n">${s.nickname}</span></div>
      ${matchBlock}
      <div class="score-row"><span class="label">语言能力分（完整度+流畅度）</span>
        <span><span class="score-val">${s.languageScore}</span><span class="grade">${s.languageGrade}</span></span></div>
      <div class="score-comment">${s.comment}</div>`;
    list.appendChild(card);
  });
}

/* ===== 初始化 ===== */
if (state.nickname) {
  $("nickname-input").value = state.nickname;
  $("me-badge").textContent = state.nickname;
}
showView("identity");
