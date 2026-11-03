#!/usr/bin/env bash
# 语音复述评分 —— 一键部署脚本（Ubuntu 22.04，香港 ECS，免备案）
# 用法（在 ECS Web Shell 以 root 执行）：
#   REPO_URL=https://github.com/<用户>/<仓库>.git bash setup.sh
# 幂等：可重复执行，会更新代码并重启服务
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/semantic-retell
REPO_URL="${REPO_URL:?请通过 REPO_URL 环境变量传入 GitHub 仓库地址}"

# 自动探测公网 IP（可用 SERVER_IP 覆盖）
SERVER_IP="${SERVER_IP:-$(curl -s --max-time 10 https://api.ipify.org || true)}"
if [ -z "$SERVER_IP" ]; then
  echo "无法自动获取公网 IP，请用 SERVER_IP=x.x.x.x 重新执行"; exit 1
fi
DOMAIN="${SERVER_IP}.sslip.io"
echo ">>> 部署域名: $DOMAIN"

echo ">>> [1/7] 安装基础工具"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

echo ">>> [2/7] 安装 Node.js 22"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q v22; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo ">>> [3/7] 安装 Caddy（自动 HTTPS）"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sed 's|https://dl.cloudsmith.io|https://dl.cloudsmith.io|g' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo ">>> [4/7] 拉取/更新代码"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

echo ">>> [5/7] 安装依赖（better-sqlite3 / ffmpeg 等）"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo ">>> [6/7] 配置并启动 Node 服务（systemd）"
cp deploy/semantic-retell.service /etc/systemd/system/semantic-retell.service
systemctl daemon-reload
systemctl enable semantic-retell
systemctl restart semantic-retell

echo ">>> [7/7] 配置 Caddy 反向代理与 HTTPS"
sed "s/__DOMAIN__/${DOMAIN}/g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo ""
echo "============================================================"
echo "部署完成！请确认 .env 已正确配置（AI_MODE=real、PUBLIC_BASE_URL 等）"
echo "手机浏览器访问: https://${DOMAIN}"
echo "查看服务状态: systemctl status semantic-retell"
echo "查看日志: journalctl -u semantic-retell -f"
echo "============================================================"
