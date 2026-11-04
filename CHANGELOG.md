# 维护日志（CHANGELOG）

本项目所有版本变更、问题根因与修复记录均在此登记，日期按实际变更填写。

## [1.3.0] - 2026-11-04：评分后房间保持、全员退出/离线才关闭；调整阶段时长

### 规则变更
1. **AI 评分后房间不再主动关闭**：移除原“评分后 10 秒自动回到等待”的定时器，房间停留在结果态（RESULT），成员可自行查看结果。
2. **关闭条件统一为“房间已无人”**：
   - 主动退出：成员离开后仅当房间成员数为 0（全员都退出）才关闭；单人退出不影响其余成员。
   - 全员离线：任意成员断线后，若房间已无任何在线成员，启动重连宽限（默认 30 秒）；宽限内有人重连则保留，宽限后仍无人在线才关闭，避免网络抖动误杀。
3. **阶段时长调整**：房主阶段墙钟 120 → **180 秒**；访客阶段墙钟 180 → **300 秒**。房主音频截断仍为前 60 秒，未在本次变更内。

### 实现要点
- 原仅针对房主的 `hostGrace` 宽限升级为房间级 `roomGrace`：触发条件由“房主断线”改为“全员离线”，任意成员重连/加入即清除。
- RoomManager 新增 `hasOnlineMembers`、`destroyIfNoOnline`；`leave` 统一为“成员数为 0 才销毁”，不再区分房主/访客。
- 删除已无调用者的 `_backToWaiting`；宽限秒数支持环境变量 `HOST_RECONNECT_GRACE_SECONDS` 覆盖（默认仍 30），便于测试。
- 前端倒计时本就由服务端 `phase.deadline` 驱动，无写死时长，改配置即自动生效。

### 变更文件
- config.js、server/roomManager.js、server/socket.js
- test/room-lifecycle-test.js（新增）、test/client-test.js（修复连接事件竞态）

### 验证
- 新增房间生命周期测试：评分后保持、单人退出不关闭、全员退出关闭、全员离线宽限内保留/宽限后关闭、宽限内重连不关闭，全部通过。
- 规则、重连、端到端、客户端回归测试全部通过。

## [1.2.0] - 2026-11-04：修复真实评分失败（音频 404 / 火山 45000006）

### 问题现象
- 1 房主 + 1 访客走到最后一步，前端直接显示“评分失败”。
- 服务端日志：火山 ASR 返回 `45000006 The audio could not be downloaded`，提交的 URL 为 `/audio/play/:id`。
- 外部访问该 URL 稳定返回 404，但磁盘音频文件真实存在、数据库记录与路径一致。

### 根因分析
1. **better-sqlite3 调用方法误用（核心根因）**：`/audio/play/:id` 对 SELECT 预处理语句使用了 `.run()`。`.run()` 仅用于写操作，返回 `{ changes, lastInsertRowid }`，并不返回查询行；因此拿到的对象没有 `processed_path`，路由判定为找不到文件而返回 404。火山服务回拉该 404 URL 失败，于是报 `45000006`。
2. 同类方法误用：`saveTranscript` 中的 `listRoundAudios.run(...)` 应为 `.all(...)`，否则 `.find` 会失败。
3. **预处理语句参数顺序系统性写反**：多个 UPDATE 语句（`setReady`、`setRoomStatus`、`setConnected`、`setRoundStatus`、`setAudioTranscript`）的 SQL 占位顺序是“先字段值、后 id”，调用却按“先 id、后值”传参，导致数据库中的准备/连接/房间状态/转写文本均未真正更新。运行时因以内存状态为准而未暴露，但持久化实际失效。

### 修复内容
- SELECT 语句改用正确方法：`getAudioById.get(...)`、`listRoundAudios.all(...)`。
- 按各 SQL 占位顺序修正全部写操作参数：`setReady`、`setRoomStatus`（6 处）、`setConnected`（2 处）、`setRoundStatus`、`setAudioTranscript`。
- 评分失败在服务端 `console.error` 留痕，便于后续定位。

### 变更文件
- server/index.js、server/roomManager.js、server/ai/index.js

### 验证
- 三个修改文件 `node --check` 通过。
- 本地启动服务，数据库现有全部音频 id 的 `/audio/play/:id` 均返回 200 且可正常下载。
- 规则测试、重连回归测试、端到端测试全部通过；新增持久化专项校验（准备/连接/状态/转写均正确落库）通过。

### 结论
- 本次失败与 Key 额度、充值无关：方舟 LLM 与外部公网 ASR 均真实调用成功；问题完全在服务端数据库调用。
- 服务由 systemd 常驻，无需每次使用后手动挂起；更新代码后重启服务即可加载新版本。

## [1.1.0] - 2026-11-03：修复访客阶段闪退、录音互斥、重连健壮性

### 问题现象
- 1 房主 + 1 访客场景，访客在访客阶段播放房主录音时被“秒退”出房间（音频仍在播放）。

### 根因分析
1. 游戏进行中（非 WAITING）旧的 `room:join` 逻辑一律拒绝，导致手机网络抖动触发 Socket.IO 重连时，成员无法恢复。
2. 房主一旦断线即启动 30 秒解散定时器；重连因走 `room:join` 失败而无法清除该定时器，超时后房间被解散，在线访客收到 `roomClosed` 被连带退出。
3. 前端重连失败时直接清除房间记录，缺少“确已关闭才退”的判断。
4. 返回大厅时未停止 `<audio>`，故界面已退出而录音仍在播放。

### 修复内容
- 新增服务端 `reconnectRoom` 与 `room:reconnect` 事件：仅允许原成员在任意阶段重连，恢复 socketId/在线状态，不重置准备与录音；非成员重连被拒绝。
- 房主重连宽限时间纳入配置 `timing.hostReconnectGraceSeconds`（默认 30 秒），重连成功即清除解散定时器。
- 前端重连改用 `room:reconnect`，只有房间确已关闭/成员被移除时才退回大厅。
- 访客“播放房主录音”与“自己录音”严格互斥：播放中禁用录音、录音中禁用播放，开始录音自动暂停播放；移除 audio 原生控件，统一由按钮控制。
- 访客阶段全员主动上传不再误发强制提交；仅墙钟超时才催交并给 3 秒宽限。
- 倒计时仅当前阶段参与者可见（房主阶段仅房主、访客阶段仅访客），非自己阶段不计时。
- `backToLobby` 停止正在播放的音频。
- Caddy 显式配置 WebSocket 长连接 1 小时读写超时，降低代理层空闲断开概率。

### 变更文件
- server/roomManager.js、server/socket.js、config.js
- public/js/app.js、public/index.html、public/css/style.css
- deploy/Caddyfile
- test/reconnect-test.js（新增重连回归测试）

### 验证
- 端到端流程测试通过；新增重连回归测试（游戏中拒绝 join、断线重连恢复、非成员拒绝）通过。

### 已知限制
- 单 Node 进程 + 内存状态 + SQLite，适合 demo 规模（≤10 房 / ≤50 人）；高并发演进见 `docs/scale.md`。
- 上传端点基于业务层校验角色，未做独立会话鉴权，公网正式环境需补鉴权与限流。

## [1.0.0] - 2026-11-03：首个可运行版本
- 大厅/房间状态机、准备/踢人规则、房主与访客录音、超时自动上传、60 秒截断。
- 火山引擎标准版 ASR（submit/query）+ 方舟大模型两项评分（复述匹配分、语言能力分），含等级与评语。
- 阿里云香港 ECS + sslip.io + Caddy 自动 HTTPS 部署，支持 mock 与 real 双模式。
