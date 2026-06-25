#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Podcast Studio — Deployment Script
#  Target: Ubuntu VPS (22.04 or 24.04)
#  Domain: studio.example.com
#  Stack: Node.js 20 + PM2 + Caddy
# ═══════════════════════════════════════════════════════════
#
#  BEFORE RUNNING THIS SCRIPT:
#
#  1. Point studio.example.com DNS to your server IP
#     - Add an A record: studio.example.com → <your-server-ip>
#     - Wait for DNS propagation (check with: dig studio.example.com)
#
#  2. SSH into your server:
#     ssh root@<your-server-ip>
#
#  3. Upload this script and run it:
#     chmod +x deploy.sh
#     ./deploy.sh
#
#  The script is idempotent — safe to run multiple times.
# ═══════════════════════════════════════════════════════════

set -euo pipefail

DOMAIN="studio.example.com"
REPO="git@github.com:oooShiny/podcast-studio.git"
APP_DIR="/opt/podcast-studio"
APP_USER="podstudio"
NODE_VERSION="20"
APP_PORT="3000"

# Generate a random webhook secret if one isn't already set in the environment
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 32)}"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Podcast Studio — Deployment"
echo "  Domain: ${DOMAIN}"
echo "═══════════════════════════════════════════════"
echo ""

# ── Step 1: System updates ──
echo "→ Updating system packages…"
apt-get update -qq
apt-get upgrade -y -qq

# ── Step 2: Create app user ──
if ! id "${APP_USER}" &>/dev/null; then
  echo "→ Creating application user: ${APP_USER}"
  useradd --system --create-home --shell /bin/bash "${APP_USER}"
else
  echo "→ User ${APP_USER} already exists"
fi

# ── Step 3: Install Node.js 20 ──
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
  echo "→ Installing Node.js ${NODE_VERSION}…"
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
else
  echo "→ Node.js $(node -v) already installed"
fi

# ── Step 4: Install PM2 ──
if ! command -v pm2 &>/dev/null; then
  echo "→ Installing PM2…"
  npm install -g pm2
  # Set up PM2 to start on boot
  pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" --silent
else
  echo "→ PM2 already installed"
fi

# ── Step 5: Install Caddy ──
if ! command -v caddy &>/dev/null; then
  echo "→ Installing Caddy…"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
else
  echo "→ Caddy already installed"
fi

# ── Step 6: Set up application directory ──
echo "→ Setting up application directory…"
mkdir -p "${APP_DIR}/public"
mkdir -p "${APP_DIR}/recordings"

# ── Step 7: Clone or update repo ──
if [[ -d "${APP_DIR}/.git" ]]; then
  echo "→ Updating existing repo…"
  su - "${APP_USER}" -c "git -C ${APP_DIR} pull --ff-only"
else
  echo "→ Cloning repo into ${APP_DIR}…"
  rm -rf "${APP_DIR}"
  git clone "${REPO}" "${APP_DIR}"
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
fi

# ── Step 8: Install Node dependencies ──
echo "→ Installing Node.js dependencies…"
cd "${APP_DIR}"
npm install --production --quiet

# ── Step 9: Set ownership ──
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ── Step 10: Configure Caddy ──
echo "→ Configuring Caddy reverse proxy…"
cat > /etc/caddy/Caddyfile << EOF
${DOMAIN} {
    # Reverse proxy to Node.js app
    reverse_proxy localhost:${APP_PORT}

    # Enable WebSocket proxying
    @websockets {
        header Connection *Upgrade*
        header Upgrade    websocket
    }
    reverse_proxy @websockets localhost:${APP_PORT}

    # Increase upload size limit for audio chunks (10 MB)
    request_body {
        max_size 10MB
    }

    # Logging
    log {
        output file /var/log/caddy/podcast-studio.log
        format json
    }
}
EOF

mkdir -p /var/log/caddy

# ── Step 11: Configure firewall ──
echo "→ Configuring firewall…"
if command -v ufw &>/dev/null; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  # Don't enable ufw automatically — just make sure the rules exist
  echo "  Firewall rules added (ports 22, 80, 443)"
fi

# ── Step 12: Create PM2 ecosystem file ──
echo "→ Creating PM2 configuration…"
cat > "${APP_DIR}/ecosystem.config.js" << EOF
module.exports = {
  apps: [{
    name: "podcast-studio",
    script: "server.js",
    cwd: "/opt/podcast-studio",
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      WEBHOOK_SECRET: "${WEBHOOK_SECRET}",
      // Deploying a public demo instead of a private one? Set DEMO_MODE: "1" here
      // (plus dedicated demo passwords below) to turn on the demo guardrails —
      // local-only recording, scheduled data wipes, rate limiting, etc.
      // See "Public Demo Deployments" in README.md. Other knobs:
      // DEMO_WIPE_INTERVAL_MINUTES, DEMO_WIPE_MAX_DEFER_CYCLES,
      // DEMO_STORAGE_CAP_MB, DEMO_ALLOWED_ORIGIN.
      // HOST_PASSWORD: "...", MEMBER_PASSWORD: "...", GUEST_PASSWORD: "...",
    },
    // Restart if memory exceeds 500MB (shouldn't happen, safety net)
    max_memory_restart: "500M",
    // Auto-restart on crash
    autorestart: true,
    // Wait 1s between restarts
    restart_delay: 1000,
    // Log configuration
    error_file: "/opt/podcast-studio/logs/error.log",
    out_file: "/opt/podcast-studio/logs/output.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }]
};
EOF

mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ── Step 13: Start/restart the application ──
echo "→ Starting application with PM2…"
# Stop existing instance if running
su - "${APP_USER}" -c "pm2 delete podcast-studio 2>/dev/null || true"
su - "${APP_USER}" -c "cd ${APP_DIR} && pm2 start ecosystem.config.js"
su - "${APP_USER}" -c "pm2 save"

# ── Step 14: Restart Caddy ──
echo "→ Starting Caddy…"
systemctl restart caddy
systemctl enable caddy

# ── Step 15: Verify ──
echo ""
echo "→ Verifying services…"
sleep 2

# Check Node app
if su - "${APP_USER}" -c "pm2 show podcast-studio" &>/dev/null; then
  echo "  ✓ Podcast Studio app is running"
else
  echo "  ✗ Podcast Studio app failed to start — check logs:"
  echo "    su - ${APP_USER} -c 'pm2 logs podcast-studio'"
fi

# Check Caddy
if systemctl is-active --quiet caddy; then
  echo "  ✓ Caddy is running"
else
  echo "  ✗ Caddy failed to start — check logs:"
  echo "    journalctl -u caddy --no-pager -n 20"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  Deployment complete!"
echo ""
echo "  Your studio will be available at:"
echo "    https://${DOMAIN}"
echo ""
echo "  Caddy will automatically obtain an HTTPS"
echo "  certificate from Let's Encrypt. This may"
echo "  take a minute on first request."
echo ""
echo "  Useful commands:"
echo "    pm2 logs podcast-studio    — view app logs"
echo "    pm2 restart podcast-studio — restart app"
echo "    pm2 monit                  — live monitoring"
echo "    caddy validate             — check Caddy config"
echo "    journalctl -u caddy        — Caddy logs"
echo ""
echo "  Recordings are saved to:"
echo "    ${APP_DIR}/recordings/"
echo ""
echo "  Auto-deploy via GitHub webhook:"
echo "    URL:         https://${DOMAIN}/webhook"
echo "    Content type: application/json"
echo "    Secret:      ${WEBHOOK_SECRET}"
echo ""
echo "    Add this at: https://github.com/oooShiny/podcast-studio/settings/hooks"
echo "    Select event: 'Just the push event'"
echo "    Pushes to main will git pull and restart automatically."
echo "═══════════════════════════════════════════════"
