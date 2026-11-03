/**
 * SQLite 持久化层
 * 房间、成员、轮次、音频、评分均落库，服务重启后历史不丢失
 */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  connected INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, user_id)
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  processed_path TEXT,
  transcript TEXT,
  auto_uploaded INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  match_score INTEGER,
  language_score INTEGER NOT NULL,
  match_grade TEXT,
  language_grade TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL
);
`);

const stmts = {
  createRoom: db.prepare(
    `INSERT INTO rooms (code, name, host_id, status, created_at) VALUES (?, ?, ?, 'WAITING', ?)`
  ),
  getRoomByCode: db.prepare(`SELECT * FROM rooms WHERE code = ?`),
  getRoomById: db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  listRooms: db.prepare(`SELECT * FROM rooms ORDER BY created_at DESC`),
  setRoomStatus: db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`),
  deleteRoom: db.prepare(`DELETE FROM rooms WHERE id = ?`),

  addMember: db.prepare(
    `INSERT INTO members (room_id, user_id, nickname, role, ready, connected, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET nickname=excluded.nickname, connected=1, role=excluded.role`
  ),
  listMembers: db.prepare(`SELECT * FROM members WHERE room_id = ? ORDER BY created_at ASC`),
  getMember: db.prepare(`SELECT * FROM members WHERE room_id = ? AND user_id = ?`),
  setReady: db.prepare(`UPDATE members SET ready = ? WHERE room_id = ? AND user_id = ?`),
  setConnected: db.prepare(`UPDATE members SET connected = ? WHERE room_id = ? AND user_id = ?`),
  removeMember: db.prepare(`DELETE FROM members WHERE room_id = ? AND user_id = ?`),
  resetReady: db.prepare(`UPDATE members SET ready = 0 WHERE room_id = ?`),

  createRound: db.prepare(
    `INSERT INTO rounds (room_id, round_no, status, created_at) VALUES (?, ?, 'OPEN', ?)`
  ),
  latestRound: db.prepare(`SELECT * FROM rounds WHERE room_id = ? ORDER BY round_no DESC LIMIT 1`),
  setRoundStatus: db.prepare(`UPDATE rounds SET status = ? WHERE id = ?`),

  addAudio: db.prepare(
    `INSERT INTO audios (round_id, user_id, role, processed_path, transcript, auto_uploaded, duration_sec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  setAudioTranscript: db.prepare(`UPDATE audios SET transcript = ? WHERE id = ?`),
  listRoundAudios: db.prepare(`SELECT * FROM audios WHERE round_id = ?`),
  getAudioById: db.prepare(`SELECT * FROM audios WHERE id = ?`),
  getRoundAudioByUser: db.prepare(`SELECT * FROM audios WHERE round_id = ? AND user_id = ?`),

  addScore: db.prepare(
    `INSERT INTO scores (round_id, user_id, match_score, language_score, match_grade, language_grade, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  listRoundScores: db.prepare(`SELECT * FROM scores WHERE round_id = ?`),
};

module.exports = { db, stmts, DATA_DIR, AUDIO_DIR };
