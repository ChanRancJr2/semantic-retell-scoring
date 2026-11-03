# 语音复述评分（Semantic Retell Scoring）

手机浏览器 H5 多人语音复述 + AI 评分的实验性 demo。房主在房间内录音，访客收听后复述，服务端调用火山引擎（豆包）语音识别与大模型，输出两项分数。

## 功能与规则

- 大厅可创建多个房间；任何人可创建房间成为房主；访客凭房间码加入。
- 每人有准备按钮，**全员准备且至少 1 名访客**（禁止单人开局）后房主才能开始。
- 房主阶段：开始/暂停录制、删除、上传；墙钟 120 秒到点自动上传；服务端将音频**截断为前 60 秒**。
- 访客阶段：播放房主录音、开始/暂停复述、上传；墙钟 180 秒到点自动上传；访客音频不截断，以语义为准。
- 评分输出两项（0–100，附评语与等级）：
  - **复述匹配分**（仅访客）：复述与房主原文的语义一致性。
  - **语言能力分**（房主+访客）：完整度与流畅度合并评分。
- 仅等待阶段房主可踢人，**游戏进行中不可踢人**。

## 技术架构

```
手机浏览器 ──HTTPS──> Caddy(443, 自动证书) ──反代──> Node.js(127.0.0.1:3000)
                                                        ├─ Express + Socket.IO
                                                        ├─ better-sqlite3 持久化
                                                        ├─ ffmpeg 转码/截断
                                                        └─ 火山 ASR + 方舟 LLM
```

- 前端：原生 HTML/CSS/JS，MediaRecorder 录音，无构建步骤。
- 后端：Node.js + Express + Socket.IO；SQLite 落库；ffmpeg-static 自带二进制。
- 部署：阿里云香港 ECS（免备案）+ sslip.io 免费域名 + Caddy 自动 HTTPS。

## 配置说明

所有数量参数集中在 `config.js`，改数字即可，无需动业务代码：

| 配置 | 含义 | 默认 |
|---|---|---|
| room.maxRooms | 大厅最多房间数 | 10 |
| room.maxMembersPerRoom | 每房最多人数（含房主） | 5 |
| room.requireGuestToStart | 是否需访客才能开局 | true |
| timing.hostPhaseSeconds | 房主墙钟（秒） | 120 |
| timing.hostAudioTrimSeconds | 房主音频截断（秒） | 60 |
| timing.guestPhaseSeconds | 访客墙钟（秒） | 180 |
| scoring.grades | 等级阈值 | 90优/80良/60中/0差 |
| audio.uploadMaxMB | 上传大小上限 | 20 |

密钥与环境变量放在 `.env`（不进 git），字段见 `.env.example`。

## 本地运行

```bash
npm install
npm start          # http://localhost:3000
```

默认 `AI_MODE=mock`，无需 Key 即可走完整流程（模拟分数）。切真实评分需配置 `.env` 并设 `AI_MODE=real`。

## 部署到阿里云香港 ECS（手机 Web Shell 可完成）

1. 控制台确认安全组放行 **80、443** 端口。
2. 将本项目推送到 GitHub（公开仓库，`.env` 已被忽略）。
3. 阿里云控制台「远程连接」打开 Web Shell，先创建 `.env`（见下方），再执行：

```bash
REPO_URL=https://github.com/<用户>/<仓库>.git bash /opt 路径下的 deploy/setup.sh
```

首次无本地代码时，可直接用远程脚本（仓库推送后）：

```bash
curl -fsSL https://raw.githubusercontent.com/<用户>/<仓库>/main/deploy/setup.sh \
  | REPO_URL=https://github.com/<用户>/<仓库>.git bash
```

4. 部署完成后，两部手机用**系统自带浏览器**（非微信）访问 `https://<公网IP>.sslip.io`。

### 在 ECS 创建 .env（Web Shell 粘贴）

```bash
mkdir -p /opt/semantic-retell
cat > /opt/semantic-retell/.env <<'EOF'
ARK_API_KEY=你的方舟KEY
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL_ID=doubao-seed-2-1-lite-260915
SPEECH_API_KEY=你的语音KEY
SPEECH_RESOURCE_ID=volc.seedasr.auc
PUBLIC_BASE_URL=https://<公网IP>.sslip.io
AI_MODE=real
PORT=3000
EOF
```

> 注意：setup.sh 会 clone 代码到 /opt/semantic-retell；请先确认 clone 不会覆盖已写好的 `.env`（git 不会跟踪/覆盖被忽略的 .env）。

## 故障排查

- 服务异常：`systemctl status semantic-retell`；日志 `journalctl -u semantic-retell -f`。
- HTTPS 证书失败：确认 80/443 已放行、域名 `<IP>.sslip.io` 解析正常，`systemctl restart caddy`。
- ASR 报 resource not granted：确认语音控制台已开通录音文件识别（资源 ID 与 `.env` 一致）。
- 录音无权限：必须 HTTPS 或 localhost 访问；使用系统自带最新浏览器。
