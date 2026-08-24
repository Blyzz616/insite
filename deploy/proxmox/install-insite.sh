#!/usr/bin/env bash
#
# InSite — in-container install script
# Runs INSIDE the LXC (called automatically by create-insite-ct.sh, or
# run manually inside an already-existing Debian 12 container as root).
#
# Env overrides:
#   REPO_URL      (default: https://github.com/Blyzz616/insite.git)
#   INSTALL_DIR   (default: /opt/insite)
#   LOCALE        (default: en_US.UTF-8)
#   TIMEZONE      (default: UTC)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Blyzz616/insite.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/insite}"
LOCALE="${LOCALE:-en_US.UTF-8}"
TIMEZONE="${TIMEZONE:-UTC}"

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages..."
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  git python3 python3-venv python3-pip nginx ca-certificates \
  openssh-server locales tzdata >/dev/null

echo "==> Setting timezone ($TIMEZONE)..."
if [[ -f "/usr/share/zoneinfo/$TIMEZONE" ]]; then
  ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime
  echo "$TIMEZONE" > /etc/timezone
  dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1
else
  echo "    '$TIMEZONE' not found under /usr/share/zoneinfo — leaving default (UTC)."
fi

echo "==> Configuring locale ($LOCALE)..."
if ! grep -q "^${LOCALE} UTF-8" /etc/locale.gen 2>/dev/null; then
  if grep -q "^# ${LOCALE} UTF-8" /etc/locale.gen 2>/dev/null; then
    sed -i "s/^# ${LOCALE} UTF-8/${LOCALE} UTF-8/" /etc/locale.gen
  else
    echo "${LOCALE} UTF-8" >> /etc/locale.gen
  fi
fi
locale-gen >/dev/null
update-locale LANG="$LOCALE" >/dev/null

echo "==> Enabling SSH..."
# Allow root login (both key- and password-based). This CT is meant for
# LAN + Tailscale access only, not public internet exposure — see
# deploy/README.md's Notes section.
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
systemctl enable ssh >/dev/null
systemctl restart ssh

echo "==> Fetching InSite ($REPO_URL)..."
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Setting up Python venv..."
cd "$INSTALL_DIR/server"
python3 -m venv venv
venv/bin/pip install --upgrade pip -q
venv/bin/pip install -r requirements.txt -q

echo "==> Node positions config..."
if [ ! -f "$INSTALL_DIR/config/node_positions.json" ]; then
  cp "$INSTALL_DIR/config/node_positions.example.json" "$INSTALL_DIR/config/node_positions.json"
  echo "    created config/node_positions.json from the example — edit this with"
  echo "    your real sensor coordinates once nodes are mounted."
fi

echo "==> Installing systemd service..."
cp "$INSTALL_DIR/deploy/insite-server.service" /etc/systemd/system/insite-server.service
systemctl daemon-reload
systemctl enable --now insite-server

echo "==> Configuring nginx..."
cp "$INSTALL_DIR/deploy/nginx-insite.conf" /etc/nginx/sites-available/insite
ln -sf /etc/nginx/sites-available/insite /etc/nginx/sites-enabled/insite
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> Done."
systemctl --no-pager status insite-server || true
