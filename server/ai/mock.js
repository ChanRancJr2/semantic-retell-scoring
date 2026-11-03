/**
 * 模拟评分（mock 模式）
 * 不调用任何网络服务，生成确定性的伪随机分数，保证无 Key/离线时全流程可演示
 */
const config = require("../../config");

// 基于字符串的稳定伪随机（同一用户每次结果一致）
function seeded(str, salt = 0) {
  let h = salt;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000; // 0-1
}

function mockScore(room) {
  const host = room.members.get(room.hostId);
  const guests = [...room.members.values()].filter((m) => m.role === "guest");

  const scores = [];
  // 房主：仅语言能力分
  const hostLang = Math.round(72 + seeded(host.userId, 1) * 23);
  scores.push({
    userId: host.userId,
    role: "host",
    nickname: host.nickname,
    matchScore: null,
    matchGrade: null,
    languageScore: hostLang,
    languageGrade: gradeOf(hostLang),
    comment: "表达较为清晰流畅，信息组织基本完整（模拟评分）。",
  });

  for (const g of guests) {
    const uploaded = room.round.guestAudios.has(g.userId);
    if (!uploaded) {
      scores.push({
        userId: g.userId,
        role: "guest",
        nickname: g.nickname,
        matchScore: 0,
        matchGrade: gradeOf(0),
        languageScore: 0,
        languageGrade: gradeOf(0),
        comment: "未在规定时间内提交录音，按缺考处理。",
      });
      continue;
    }
    const match = Math.round(60 + seeded(g.userId, 7) * 35);
    const lang = Math.round(62 + seeded(g.userId, 13) * 30);
    scores.push({
      userId: g.userId,
      role: "guest",
      nickname: g.nickname,
      matchScore: match,
      matchGrade: gradeOf(match),
      languageScore: lang,
      languageGrade: gradeOf(lang),
      comment: "复述覆盖了主要信息，表达可进一步精炼（模拟评分）。",
    });
  }

  return {
    roundNo: room.round.roundNo,
    mode: "mock",
    hostText: "（模拟模式：未调用真实语音识别）",
    guests: guests.map((g) => ({
      userId: g.userId,
      nickname: g.nickname,
      text: "（模拟转写文本）",
    })),
    scores,
  };
}

function gradeOf(score) {
  for (const g of config.scoring.grades) if (score >= g.min) return g.label;
  return config.scoring.grades[config.scoring.grades.length - 1].label;
}

module.exports = { mockScore, gradeOf };
