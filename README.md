# InSite — Proxmox deployment

Bootstraps a dedicated LXC to run the InSite server + frontend, in the
style of the Proxmox community-scripts helpers: one command, no
interactive menus, sensible defaults, everything overridable via env
vars.

## Quick start

On your Proxmox host, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Blyzz616/insite/main/deploy/proxmox/create-insite-ct.sh)"
```

You'll get three whiptail prompts — **CTID**, **root password** (leave
blank to auto-generate one, printed at the end), and **timezone**.
Everything else is a fixed default (see below) — no CPU/RAM/disk
questions, no menu maze. Takes a couple minutes after the prompts.

### Fixed defaults (edit the script directly to change permanently)

| Setting | Default |
|---|---|
| Hostname | `insite` |
| Cores / RAM / Disk | 2 / 1024MB / 8GB |
| Network | DHCP on `vmbr0` |
| Storage | `local-lvm` |
| Locale | `en_US.UTF-8` |

### Common overrides

Any of the prompted values can also be pre-filled via env var — the
whiptail box still opens, but shows your value instead of the built-in
default, so hitting Enter accepts it:

```bash
# Pre-fill CTID and timezone, still confirm via dialog
CTID=205 TIMEZONE="America/Toronto" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/Blyzz616/insite/main/deploy/proxmox/create-insite-ct.sh)"

# Static IP instead of DHCP
CTID=204 IP_CONFIG="192.168.0.204/24,gw=192.168.0.1" \
  bash -c "$(curl -fsSL .../create-insite-ct.sh)"

# SSH key for key-based login (separate from the password prompt)
SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" \
  bash -c "$(curl -fsSL .../create-insite-ct.sh)"

# Different hostname / storage
CT_HOSTNAME=insite-test ROOTFS_STORAGE=Kara \
  bash -c "$(curl -fsSL .../create-insite-ct.sh)"
```

Full list of overridable vars is at the top of
`proxmox/create-insite-ct.sh`.

### SSH access

- **Password**: set via the whiptail prompt during install. Leave it
  blank there and a random password is generated and printed at the end
  of the run — save it, it's not stored anywhere else.
- **Key-based**: independent of the password prompt — set `SSH_PUBKEY`
  (literal key text or a path to a `.pub` file) beforehand if you want
  key login too.

Either works standalone; set `SSH_PUBKEY` and answer the password
prompt if you want both. `sshd` is installed and enabled either way.

## What it sets up

| Component | How |
|---|---|
| CSI server (`csi_server.py`) | systemd service `insite-server`, auto-restart on failure |
| Frontend | nginx serving the repo root on port 80, visit `/frontend/` |
| Python deps | venv at `/opt/insite/server/venv` |

## After install

1. **Point your ESP32-C6 nodes at this CT's IP.** The script prints the
   CT's IP and the UDP port (9494) at the end — set `SERVER_IP` in
   `firmware/csi_sniffer_node/csi_sniffer_node.ino` to that IP and
   reflash.
2. **Edit real node positions.** The installer copies
   `config/node_positions.example.json` to `config/node_positions.json`
   as a placeholder.
   ```bash
   pct exec 204 -- nano /opt/insite/config/node_positions.json
   pct exec 204 -- systemctl restart insite-server
   ```
3. **Open the frontend**: `http://<CT_IP>/frontend/` — or over your
   Tailscale tailnet from anywhere, since CT 203 already advertises the
   `192.168.0.0/24` route, no Tailscale install needed on this CT.

## Manual / re-run install

If you already have a CT and just want to (re)install InSite on it
(e.g. after `git pull`ing new server code):

```bash
pct exec <CTID> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/Blyzz616/insite/main/deploy/proxmox/install-insite.sh)"
```

## Notes

- No auth/TLS is set up — this is meant for LAN + Tailscale access only,
  not public internet exposure. If you ever want it reachable outside
  your tailnet, put it behind a reverse proxy with auth first.
- `deploy/nginx-insite.conf` explicitly blocks serving
  `config/node_positions.json` over HTTP (the frontend doesn't need it,
  only the backend does) — worth keeping in mind since that file
  contains your real in-house sensor coordinates.
- The template lookup (`pveam available`) grabs the newest
  `debian-12-standard` image available to your Proxmox host at run
  time — if Proxmox ships Debian 13 as default in the future, update
  the `debian-12-standard` match in `create-insite-ct.sh` accordingly.
