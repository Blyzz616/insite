# InSite

<img width="1536" height="1024" alt="6640a17f-5528-4b3c-8d54-b868f9d43b9b" src="https://github.com/user-attachments/assets/4a98d799-a5b7-4646-96b8-7a4c349b71e7" />

A homelab project to render a live, transparent 3D map of the house showing
where people are, with status data (breathing rate, motion, etc.) floating
above each detected person — built on WiFi Channel State Information (CSI)
from ESP32-C6 nodes, no cameras or wearables involved.

```
 ESP32-C6 sniffer nodes  --CSI (UDP)-->  Python server  --WebSocket-->  3D web frontend
 (fixed known positions)                 (signal proc,                 (Three.js house
                                          presence/breathing            model + live
                                          estimation)                   markers)
```

## Status

Early scaffold. This repo gets you from "boards on a desk" to a working
pipeline you can iterate on. It does **not** yet do accurate 3D
localization — see [Limitations](#limitations-read-this-first) before you
get too excited.

## Hardware

- 3+ Seeed Studio XIAO ESP32C6 boards, placed at **known, fixed positions**
  around the house (ceiling corners of rooms work well). More nodes = better
  spatial coverage.
- One of these can act as the CSI transmitter/beacon (or you can just use
  your existing home WiFi AP as the transmit source — simpler, see
  `firmware/reference_beacon_node/`).
- Each node needs power (USB) at its mounting location.
- A machine to run the server (your Proxmox homelab is perfect for this —
  a small LXC container with a WiFi-adjacent network path works fine since
  data arrives over your LAN via UDP, not over the air).

## Repo layout

```
firmware/
  csi_sniffer_node/        Arduino sketch: captures CSI, streams to server over UDP
  reference_beacon_node/   Arduino sketch: optional dedicated beacon (fixed-rate probe packets)
server/
  csi_server.py            UDP listener -> signal processing -> WebSocket broadcast
  processing/
    presence.py            Variance/energy-based presence & motion detection
    breathing.py           Bandpass filter + peak counting for breath-rate estimate
  requirements.txt
frontend/
  index.html / app.js      Three.js scene: transparent house shell, live person markers
config/
  node_positions.example.json   Fixed (x,y,z) coordinates of each sniffer node
  floorplan.json                Room geometry rendered by the frontend
tools/
  csi_dump.py               Standalone bench-test script — verify raw CSI
                             packets before running the full server
deploy/
  proxmox/                  One-command Proxmox LXC bootstrap (see deploy/README.md)
  insite-server.service     systemd unit for the CSI server
  nginx-insite.conf         nginx config serving the frontend
```

## Hosting

For always-on operation (rather than running `csi_server.py` on a
laptop), see `deploy/README.md` for a one-command Proxmox LXC bootstrap
that sets up the server + frontend as systemd/nginx services.

## Setup

## Floorplan

`config/floorplan.json` defines the actual house geometry the frontend
renders — a list of rooms per floor, each with a footprint (`x`, `z`,
`w`, `d` in meters) and a level (`main`/`lower`, each with its own
`y_base`/`ceiling_height`). The included one is derived from the
3356 270A Street, Langley BC listing floorplan and is a **best-effort
approximation** — room adjacency and relative sizing match the listing,
but exact wall-corner coordinates weren't available (only labeled room
dimensions + the flyer's overall layout), and the listing itself notes
its own measurements are approximate within ±2%.

If precision matters for your triangulation work later, treat this as a
starting sketch: measure your actual rooms with a tape measure and
adjust the `x`/`z`/`w`/`d` values directly in the JSON. The frontend
re-reads this file on every page load, so changes show up immediately —
no rebuild step.

### 1. Flash the nodes

Each XIAO ESP32C6 needs a unique `NODE_ID` and your WiFi credentials. Open
`firmware/csi_sniffer_node/csi_sniffer_node.ino` in the Arduino IDE
(board package: **esp32 by Espressif Systems**, board: **XIAO_ESP32C6**),
set the config block at the top, and flash.

If you want a dedicated beacon instead of relying on ambient AP traffic,
flash one board with `firmware/reference_beacon_node/reference_beacon_node.ino`
instead — it just blasts fixed-interval probe-request-like packets so your
sniffer nodes have a consistent, known transmit source to compute CSI
against.

### 1.5 Bench test before mounting anything

Before you climb a ladder to mount nodes, plug one into USB power
somewhere convenient, flash it, and run:

```bash
python3 tools/csi_dump.py
```

This just prints a line per CSI packet as it arrives — confirms the
node is actually sending, and flags truncated packets or the
`first_word_invalid` quirk immediately so you're not debugging a
mounted node in a wall cavity.

### 2. Record node positions

Measure each node's real-world position in your house (pick an origin —
e.g. one corner of the ground floor at floor level — and measure in
meters). Fill in `config/node_positions.example.json` and rename it to
`node_positions.json`.

### 3. Run the server

```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 csi_server.py --positions ../config/node_positions.json
```

This listens for UDP CSI packets from all nodes, runs presence/breathing
estimation per node, and serves a WebSocket on `ws://<host>:8765` with the
live state as JSON.

### 4. Open the frontend

Serve from the **repo root** (not the `frontend/` folder) so the browser
can fetch `config/floorplan.json` via its relative path:

```bash
cd insite       # repo root
python3 -m http.server 8080
```

Visit `http://localhost:8080/frontend/`, it loads the floorplan, connects
to the WebSocket server, and renders your house.

## Data model (what flows over the WebSocket)

```json
{
  "timestamp": 1755800000.123,
  "nodes": {
    "node-01": {
      "position": [1.2, 0.4, 2.6],
      "presence": true,
      "motion_level": 0.42,
      "breath_rate_bpm": 15.2,
      "confidence": 0.61
    }
  },
  "people": [
    {
      "id": "person-1",
      "position": [2.1, 1.0, 3.0],
      "breath_rate_bpm": 15.2,
      "confidence": 0.4
    }
  ]
}
```

The `nodes` block is raw per-sensor output — always available and honest
about confidence. The `people` block is the fused/estimated result once
you've built out multi-node triangulation (stubbed as TODO in
`server/csi_server.py` — see below).

## Limitations (read this first)

Be realistic about what this hardware tier can and can't do:

- **Single antenna per node.** The XIAO ESP32C6 switches between its
  onboard ceramic antenna and an external U.FL port — it doesn't use both
  simultaneously. That means no per-node spatial diversity (no MIMO/AoA),
  which is what a lot of academic through-wall imaging work leans on.
- **No true 3D localization yet.** With single-antenna nodes, precise
  (x,y,z) tracking from CSI alone is a genuinely hard research problem.
  This scaffold gives you per-node presence and motion confidence; fusing
  that into an actual triangulated position across rooms is left as a
  clearly-marked TODO (`estimate_person_positions()` in `csi_server.py`) —
  a reasonable v1 is nearest-node "this person is near node X" rather than
  a continuous coordinate.
- **Breathing rate needs a mostly-still subject.** Bandpass-filtering CSI
  amplitude for the ~0.15–0.4 Hz breathing band works best when the person
  isn't also walking around — expect noisy or absent readings while
  someone is active, better readings while seated/sleeping.
- **A known ESP32-C6 firmware quirk**: some C6 boards under-report CSI
  bytes (missing L-LTF data) compared to ESP32/S3 in certain ESP-IDF
  versions. If your CSI packets look truncated, check
  [espressif/esp-idf#14271](https://github.com/espressif/esp-idf/issues/14271)
  for current status before assuming your code is wrong.
- **Multi-person disambiguation is unsolved here.** Distinguishing two
  people in the same room from raw variance/energy features alone is
  unreliable — the `people` array will likely undercount when occupants
  are close together until a proper ML model replaces the heuristic
  detector.

None of this means the goal isn't achievable — it means the honest v1 is
"a live house map showing which rooms have movement/breathing signal,"
with continuous 3D dot-tracking as a stretch goal once you've tuned
per-room calibration and possibly added more nodes per room for better
spatial resolution.

## Roadmap

- [ ] Get raw CSI streaming reliably from one node to the server
- [ ] Per-node presence/motion detection tuned to your rooms
- [ ] Per-node breathing rate estimation validated against a known-still test
- [ ] Fixed node position config + basic nearest-node "person is in room X"
- [ ] Replace heuristic detector with a small trained classifier per node
- [ ] Multi-node fusion toward real (x,y,z) estimates
- [x] Real floorplan geometry in the frontend
- [ ] Historical logging / timeline view

## License

MIT — see `LICENSE`.
