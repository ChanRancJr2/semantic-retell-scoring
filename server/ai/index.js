/**
 * AI 评分编排：根据 AI_MODE 选择真实火山服务或本地模拟
 * 统一输出包含转写文本、两项分数、等级、评语的结果对象
 */
const config = require("../../config");
const { stmts } = require("../db");
const { transcribe } = require("./asr");
const { scoreByLLM } = require("./llm");
const { mockScore, gradeOf } = require("./mock");

function clamp(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(config.scoring.min, Math.min(config.scoring.max, Math.round(n)));
}

function audioUrl(audioDbId) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("real 模式需先在 .env 配置 PUBLIC_BASE_URL");
  return `${base.replace(/\/$/, "")}/audio/play/${audioDbId}`;
}

async function realScore(room) {
  const host = room.members.get(room.hostId);
  const guests = [...room.members.values()].filter((m) => m.role === "guest");

  // 1) 房主转写（提交公网 URL，服务端轮询）
  const hostAudio = room.round.hostAudio;
  const hostUrl = hostAudio ? audioUrl(hostAudio.audioDbId) : "";
  console.log("[ASR] 房主音频 URL:", hostUrl);
  const hostText = hostAudio ? await transcribe(hostUrl, "mp3") : "";
  console.log("[ASR] 房主转写结果:", JSON.stringify(hostText));
  this._saveTranscript(room, room.hostId, hostText);

  // 2) 访客转写（并行）
  const guestData = await Promise.all(
    guests.map(async (g) => {
      const audio = room.round.guestAudios.get(g.userId);
      const gUrl = audio ? audioUrl(audio.audioDbId) : "";
      console.log("[ASR] 访客", g.nickname, "音频 URL:", gUrl);
      const text = audio ? await transcribe(gUrl, "mp3") : "";
      console.log("[ASR] 访客", g.nickname, "转写:", JSON.stringify(text));
      this._saveTranscript(room, g.userId, text);
      return { userId: g.userId, nickname: g.nickname, text };
    })
  );

  // 3) 大模型打分
  console.log("[LLM] 开始调用大模型评分");
  const raw = await scoreByLLM(hostText, guestData, room.hostId);
  console.log("[LLM] 评分返回条数:", raw.length);
  const byUser = new Map(raw.map((s) => [s.userId, s]));

  // 4) 合并成员信息、clamp 分数、计算等级（模型漏人时补默认，保证全员有条目）
  const scores = [];
  const pushOne = (member, role) => {
    const r = byUser.get(member.userId) || {};
    const isHost = role === "host";
    const languageScore = clamp(r.languageScore);
    const matchScore = isHost ? null : clamp(r.matchScore);
    scores.push({
      userId: member.userId,
      role,
      nickname: member.nickname,
      matchScore,
      matchGrade: isHost ? null : gradeOf(matchScore),
      languageScore,
      languageGrade: gradeOf(languageScore),
      comment: r.comment || (isHost ? "整体表达良好。" : "复述与表达整体可接受。"),
    });
  };
  pushOne(host, "host");
  guests.forEach((g) => pushOne(g, "guest"));

  return {
    roundNo: room.round.roundNo,
    mode: "real",
    hostText: hostText || "（无有效语音）",
    guests: guestData,
    scores,
  };
}

function saveTranscript(room, userId, text) {
  const audio = stmts
    .listRoundAudios.run(room.round.dbId)
    .find((a) => a.user_id === userId);
  if (audio) stmts.setAudioTranscript.run(audio.id, text);
}

module.exports = {
  scoreRound: async (room) => {
    const mode = (process.env.AI_MODE || "mock").toLowerCase();
    if (mode === "real") {
      const real = realScore.bind({ _saveTranscript: saveTranscript });
      return real(room);
    }
    return mockScore(room);
  },
};
