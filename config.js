/**
 * 全局配置中心 —— 所有数量、时长、分值、等级参数集中在此
 * 业务代码只读取本文件，调整规则时只需修改这里的数字，无需改动其他代码
 */
module.exports = {
  // 房间与人数
  room: {
    maxRooms: 10, // 大厅最多同时存在的房间数
    maxMembersPerRoom: 5, // 每个房间最多人数（含房主）
    requireGuestToStart: true, // true=至少 1 名访客才能开局（无访客不可单人开局）
  },

  // 计时（单位：秒）
  timing: {
    hostPhaseSeconds: 120, // 房主阶段墙钟上限，到点自动上传已录内容
    hostAudioTrimSeconds: 60, // 房主音频实际有效时长，超过则截取前 N 秒
    guestPhaseSeconds: 180, // 访客阶段墙钟上限，到点自动上传
  },

  // 评分
  scoring: {
    min: 0,
    max: 100,
    // 等级阈值：自上而下匹配，分数 >= min 即取该等级
    grades: [
      { min: 90, label: "优" },
      { min: 80, label: "良" },
      { min: 60, label: "中" },
      { min: 0, label: "差" },
    ],
  },

  // 音频处理
  audio: {
    targetFormat: "mp3", // 服务端统一转码格式（火山 ASR 支持 MP3/WAV/OGG）
    bitrate: "64k",
    uploadMaxMB: 20, // 单次上传大小上限
  },

  // 服务
  server: {
    port: Number(process.env.PORT) || 3000,
  },
};
