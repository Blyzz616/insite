#!/usr/bin/env bash
#
# InSite — Proxmox CT bootstrap
# Run this ON THE PROXMOX HOST (not inside a container).
#
# Creates an unprivileged Debian 12 LXC, installs InSite's server deps,
# clones the repo, and wires up systemd + nginx.
#
# Interactive (via whiptail): CTID, root password, timezone.
# Everything else is either a fixed default or an env var override —
# see below. CPU/RAM/disk are intentionally NOT prompted for or exposed
# as env vars to think about each run — fixed sensible defaults for
# this workload (CORES/MEMORY_MB/DISK_SIZE_GB). Edit those directly in
# this file if you want to change them permanently.
#
# Non-interactive env overrides (skip the matching prompt if set):
#   CTID=205 IP_CONFIG="192.168.0.205/24,gw=192.168.0.1" \
#     bash create-insite-ct.sh
#
# SSH key access (separate from the password prompt, optional):
#   SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" ...
#
# Locale (default en_US.UTF-8, not currently prompted):
#   LOCALE="en_GB.UTF-8" ...
#
# Or run directly from GitHub (once pushed):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Blyzz616/insite/main/deploy/proxmox/create-insite-ct.sh)"

set -euo pipefail

# ---------------------------------------------------------------------
# CONFIG — hardcoded or override via env vars before running
# ---------------------------------------------------------------------
CTID="${CTID:-204}"                     # prompted via whiptail below unless set
CT_HOSTNAME="${CT_HOSTNAME:-insite}"
DISK_SIZE_GB="${DISK_SIZE_GB:-8}"       # hardcoded, not prompted
CORES="${CORES:-2}"                     # hardcoded, not prompted
MEMORY_MB="${MEMORY_MB:-1024}"          # hardcoded, not prompted
SWAP_MB="${SWAP_MB:-512}"
BRIDGE="${BRIDGE:-vmbr0}"
IP_CONFIG="${IP_CONFIG:-dhcp}"          # e.g. "192.168.0.204/24,gw=192.168.0.1" for static
ROOTFS_STORAGE="${ROOTFS_STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
REPO_URL="${REPO_URL:-https://github.com/Blyzz616/insite.git}"
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/Blyzz616/insite/main/deploy/proxmox/install-insite.sh}"
LOCALE="${LOCALE:-en_US.UTF-8}"
TIMEZONE="${TIMEZONE:-America/Vancouver}"   # prompted via whiptail below unless set

# SSH access — key-based login only, separate from the password prompt below
SSH_PUBKEY="${SSH_PUBKEY:-}"
ROOT_PASSWORD="${ROOT_PASSWORD:-}"      # prompted via whiptail below unless set

# ---------------------------------------------------------------------
# Colors (community-scripts style output, purely cosmetic)
# ---------------------------------------------------------------------
GN='\033[1;92m'; YW='\033[33m'; RD='\033[01;31m'; CL='\033[m'
msg_info() { echo -e " ${YW}➜${CL} $1"; }
msg_ok()   { echo -e " ${GN}✓${CL} $1"; }
msg_err()  { echo -e " ${RD}✗${CL} $1"; }

if [[ $EUID -ne 0 ]]; then
  msg_err "Must be run as root on the Proxmox host."
  exit 1
fi
if ! command -v pct &>/dev/null; then
  msg_err "pct not found — this script must run on a Proxmox VE host, not inside a container."
  exit 1
fi

# ---------------------------------------------------------------------
# whiptail dialogs — CTID, root password, timezone
# ---------------------------------------------------------------------
if ! command -v whiptail &>/dev/null; then
  msg_info "Installing whiptail..."
  apt-get update -qq && apt-get install -y -qq whiptail >/dev/null
fi

WT_BACKTITLE="InSite Proxmox Setup"

# CTID — loop until an unused ID is entered (env var CTID still seeds
# the default shown in the box, so scripted runs can pre-fill it)
while true; do
  CTID_INPUT=$(whiptail --backtitle "$WT_BACKTITLE" --title "Container ID" \
    --inputbox "CTID for the new container:" 9 58 "$CTID" 3>&1 1>&2 2>&3) \
    || { msg_err "Cancelled."; exit 1; }
  if pct status "$CTID_INPUT" &>/dev/null; then
    whiptail --backtitle "$WT_BACKTITLE" --msgbox "CT $CTID_INPUT already exists — pick a different ID." 8 58
    continue
  fi
  CTID="$CTID_INPUT"
  break
done

# Root password — blank is allowed (auto-generates one later), confirm
# match if something was typed
while true; do
  PW1=$(whiptail --backtitle "$WT_BACKTITLE" --title "Root Password" \
    --passwordbox "Root password for the CT\n(leave blank to auto-generate one):" 10 58 3>&1 1>&2 2>&3) \
    || { msg_err "Cancelled."; exit 1; }
  if [[ -z "$PW1" ]]; then
    ROOT_PASSWORD=""
    break
  fi
  PW2=$(whiptail --backtitle "$WT_BACKTITLE" --title "Root Password" \
    --passwordbox "Confirm password:" 9 58 3>&1 1>&2 2>&3) \
    || { msg_err "Cancelled."; exit 1; }
  if [[ "$PW1" == "$PW2" ]]; then
    ROOT_PASSWORD="$PW1"
    break
  fi
  whiptail --backtitle "$WT_BACKTITLE" --msgbox "Passwords didn't match — try again." 8 58
done

# Timezone — free-text IANA zone name, prefilled with a sensible default
TIMEZONE_INPUT=$(whiptail --backtitle "$WT_BACKTITLE" --title "Timezone" \
  --inputbox "Timezone (IANA name, e.g. America/Vancouver):" 9 58 "$TIMEZONE" 3>&1 1>&2 2>&3) \
  || { msg_err "Cancelled."; exit 1; }
TIMEZONE="$TIMEZONE_INPUT"

# ---------------------------------------------------------------------
# Find / download a Debian 12 template
# ---------------------------------------------------------------------
msg_info "Locating Debian 12 template..."
TEMPLATE=$(pveam available -section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
if [[ -z "$TEMPLATE" ]]; then
  pveam update >/dev/null
  TEMPLATE=$(pveam available -section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
fi
if [[ -z "$TEMPLATE" ]]; then
  msg_err "Could not find a debian-12-standard template in 'pveam available'."
  exit 1
fi
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_info "Downloading $TEMPLATE to $TEMPLATE_STORAGE..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
msg_ok "Using template $TEMPLATE"

# ---------------------------------------------------------------------
# Create the container
# ---------------------------------------------------------------------
SSH_KEY_FILE=""
if [[ -n "$SSH_PUBKEY" ]]; then
  if [[ -f "$SSH_PUBKEY" ]]; then
    SSH_KEY_FILE="$SSH_PUBKEY"
  else
    SSH_KEY_FILE=$(mktemp)
    echo "$SSH_PUBKEY" > "$SSH_KEY_FILE"
  fi
fi

msg_info "Creating CT $CTID ($CT_HOSTNAME)..."
CREATE_ARGS=(
  "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  --hostname "$CT_HOSTNAME"
  --cores "$CORES"
  --memory "$MEMORY_MB"
  --swap "$SWAP_MB"
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP_CONFIG}"
  --rootfs "${ROOTFS_STORAGE}:${DISK_SIZE_GB}"
  --unprivileged "$UNPRIVILEGED"
  --features "nesting=1"
  --onboot 1
  --startup order=3
)
if [[ -n "$SSH_KEY_FILE" ]]; then
  CREATE_ARGS+=(--ssh-public-keys "$SSH_KEY_FILE")
fi
pct create "${CREATE_ARGS[@]}" >/dev/null
msg_ok "CT $CTID created"

msg_info "Starting CT $CTID..."
pct start "$CTID"

msg_info "Waiting for network..."
for i in $(seq 1 30); do
  if pct exec "$CTID" -- ping -c1 -W1 1.1.1.1 &>/dev/null; then
    break
  fi
  sleep 2
  if [[ "$i" -eq 30 ]]; then
    msg_err "CT never got network access — check bridge/IP config and finish setup manually."
    exit 1
  fi
done
msg_ok "Network is up"

# ---------------------------------------------------------------------
# Root password (SSH key access above is separate/optional; this covers
# console + password-based SSH login)
# ---------------------------------------------------------------------
if [[ -n "$ROOT_PASSWORD" ]]; then
  FINAL_ROOT_PW="$ROOT_PASSWORD"
else
  FINAL_ROOT_PW=$(openssl rand -base64 12)
fi
pct exec "$CTID" -- bash -c "echo 'root:${FINAL_ROOT_PW}' | chpasswd"

# ---------------------------------------------------------------------
# Install InSite inside the container
# ---------------------------------------------------------------------
msg_info "Installing dependencies + InSite (this takes a couple minutes)..."
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl >/dev/null"
pct exec "$CTID" -- bash -c "curl -fsSL '$INSTALL_SCRIPT_URL' -o /root/install-insite.sh"
pct exec "$CTID" -- bash -c "REPO_URL='$REPO_URL' LOCALE='$LOCALE' TIMEZONE='$TIMEZONE' bash /root/install-insite.sh"
msg_ok "InSite installed"

CT_IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo
msg_ok "Done. CT $CTID ($CT_HOSTNAME) is up."
echo -e "   Frontend:  ${GN}http://${CT_IP}/frontend/${CL}"
echo -e "   WebSocket: ws://${CT_IP}:8765"
echo -e "   CSI UDP:   ${CT_IP}:9494  <- point your ESP32-C6 nodes' SERVER_IP here"
echo -e "   SSH:       ssh root@${CT_IP}"
if [[ -z "$ROOT_PASSWORD" ]]; then
  echo -e "   Root password (auto-generated, save this): ${YW}${FINAL_ROOT_PW}${CL}"
else
  echo "   Root password: as set via ROOT_PASSWORD"
fi
if [[ -n "$SSH_KEY_FILE" ]]; then
  echo "   SSH key also installed for key-based login"
fi
echo
echo "Next: edit /opt/insite/config/node_positions.json inside the CT with your"
echo "real sensor positions, then: pct exec $CTID -- systemctl restart insite-server"
