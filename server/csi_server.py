#!/usr/bin/env python3
"""
InSite — CSI Server

Listens for CSI packets from ESP32-C6 sniffer nodes over UDP, runs
per-node presence/motion and breathing-rate estimation, and broadcasts
the fused state as JSON over a WebSocket for the 3D frontend to consume.

Usage:
    python3 csi_server.py --positions ../config/node_positions.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import struct
import time
from dataclasses import dataclass, field

import numpy as np
import websockets

from processing import PresenceDetector, BreathingEstimator

# Must match csi_packet_header_t in firmware/csi_sniffer_node/csi_sniffer_node.ino
HEADER_FORMAT = "<16sIIbBBBH"  # node_id[16], seq, timestamp_ms, rssi(i8),
                                # rate(u8), channel(u8), first_word_invalid(u8),
                                # csi_len(u16)
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)

UDP_LISTEN_PORT = 9494
WS_PORT = 8765
ASSUMED_CSI_SAMPLE_RATE_HZ = 20.0  # rough estimate; tune per your packet rate


@dataclass
class NodeState:
    node_id: str
    position: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    presence_detector: PresenceDetector = field(default_factory=PresenceDetector)
    breathing_estimator: BreathingEstimator = field(
        default_factory=lambda: BreathingEstimator(ASSUMED_CSI_SAMPLE_RATE_HZ)
    )
    last_seen: float = 0.0
    last_result: dict = field(default_factory=dict)


class CSIServer:
    def __init__(self, node_positions: dict[str, list[float]]):
        self.nodes: dict[str, NodeState] = {}
        for node_id, pos in node_positions.items():
            self.nodes[node_id] = NodeState(node_id=node_id, position=pos)
        self.connected_ws = set()
        self.state_lock = asyncio.Lock()

    def get_or_create_node(self, node_id: str) -> NodeState:
        if node_id not in self.nodes:
            print(f"[warn] unknown node_id '{node_id}' seen on the wire — "
                  f"add it to node_positions.json for a real position. "
                  f"Using origin (0,0,0) for now.")
            self.nodes[node_id] = NodeState(node_id=node_id)
        return self.nodes[node_id]

    def handle_packet(self, data: bytes):
        if len(data) < HEADER_SIZE:
            return

        node_id_raw, seq, ts_ms, rssi, rate, channel, first_word_invalid, csi_len = (
            struct.unpack_from(HEADER_FORMAT, data, 0)
        )
        node_id = node_id_raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")

        csi_bytes = data[HEADER_SIZE:HEADER_SIZE + csi_len]
        if len(csi_bytes) < csi_len:
            return  # truncated packet, drop it

        # CSI raw data is signed 8-bit int/real pairs per the ESP-IDF format.
        csi_raw = np.frombuffer(csi_bytes, dtype=np.int8).astype(np.float32)
        if len(csi_raw) < 2:
            return

        # Pair up as (imaginary, real) per ESP-IDF's documented ordering and
        # compute amplitude per subcarrier. TODO: confirm ordering against
        # your ESP-IDF version's wifi.h CSI docs — this has changed across
        # releases (see the L-LTF ordering note in ESP-IDF's CSI guide).
        imag = csi_raw[0::2]
        real = csi_raw[1::2]
        amplitude = np.sqrt(imag ** 2 + real ** 2)

        node = self.get_or_create_node(node_id)
        node.last_seen = time.time()

        presence_result = node.presence_detector.update(amplitude)
        breathing_result = {"breath_rate_bpm": None, "confidence": 0.0}
        # Only bother estimating breathing when the node looks relatively
        # still — trying to extract it during active motion is noise.
        if presence_result["motion_level"] < 1.0:
            breathing_result = node.breathing_estimator.update(amplitude)

        node.last_result = {
            "position": node.position,
            "presence": presence_result["presence"],
            "motion_level": presence_result["motion_level"],
            "breath_rate_bpm": breathing_result["breath_rate_bpm"],
            "confidence": max(presence_result["confidence"], breathing_result["confidence"]),
            "rssi": rssi,
            "channel": channel,
        }

    def estimate_person_positions(self) -> list[dict]:
        """
        TODO: this is the big open problem flagged in the README.
        v1 heuristic: treat every node currently showing presence as
        "a person is near this node" and place a marker at that node's
        fixed position. This is NOT real triangulation — it just proves
        the pipeline end to end. Replace with proper multi-node fusion
        (e.g. weighted centroid across nodes with correlated motion
        timing, or a trained model) once you have multiple nodes per
        room and calibration data.
        """
        people = []
        for i, (node_id, node) in enumerate(self.nodes.items()):
            if node.last_result.get("presence"):
                people.append({
                    "id": f"person-near-{node_id}",
                    "position": node.last_result["position"],
                    "breath_rate_bpm": node.last_result.get("breath_rate_bpm"),
                    "confidence": node.last_result.get("confidence", 0.0),
                })
        return people

    def build_state_message(self) -> dict:
        nodes_out = {}
        now = time.time()
        for node_id, node in self.nodes.items():
            stale = (now - node.last_seen) > 5.0 if node.last_seen else True
            entry = dict(node.last_result) if node.last_result else {
                "position": node.position,
                "presence": False,
                "motion_level": 0.0,
                "breath_rate_bpm": None,
                "confidence": 0.0,
            }
            entry["stale"] = stale
            nodes_out[node_id] = entry

        return {
            "timestamp": now,
            "nodes": nodes_out,
            "people": self.estimate_person_positions(),
        }


class UDPProtocol(asyncio.DatagramProtocol):
    def __init__(self, server: CSIServer):
        self.server = server

    def datagram_received(self, data: bytes, addr):
        try:
            self.server.handle_packet(data)
        except Exception as e:
            print(f"[error] failed to parse packet from {addr}: {e}")


async def ws_handler(websocket, server: CSIServer):
    server.connected_ws.add(websocket)
    print(f"[ws] client connected ({len(server.connected_ws)} total)")
    try:
        async for _ in websocket:
            pass  # this server doesn't expect incoming messages, ignore
    finally:
        server.connected_ws.discard(websocket)
        print(f"[ws] client disconnected ({len(server.connected_ws)} total)")


async def broadcast_loop(server: CSIServer, interval_s: float = 0.2):
    while True:
        if server.connected_ws:
            msg = json.dumps(server.build_state_message())
            stale_clients = set()
            for ws in server.connected_ws:
                try:
                    await ws.send(msg)
                except Exception:
                    stale_clients.add(ws)
            server.connected_ws -= stale_clients
        await asyncio.sleep(interval_s)


async def verbose_log_loop(server: CSIServer, interval_s: float = 0.5):
    """
    --verbose console output: one line per node, printed on a fixed
    interval regardless of packet rate, so it's readable while you're
    watching numbers change in real time (e.g. tuning the presence
    threshold in processing/presence.py) rather than scrolling past a
    line per CSI packet.
    """
    while True:
        now = time.time()
        for node_id, node in server.nodes.items():
            if not node.last_result:
                continue
            stale = (now - node.last_seen) > 5.0 if node.last_seen else True
            r = node.last_result
            flag = "!" if stale else (" " if not r.get("presence") else "*")
            breath = f"{r['breath_rate_bpm']:.1f}bpm" if r.get("breath_rate_bpm") is not None else "  -- "
            print(
                f"[{flag}] {node_id:12s} motion={r.get('motion_level', 0.0):6.3f}  "
                f"presence={str(r.get('presence', False)):5s}  "
                f"breath={breath}  conf={r.get('confidence', 0.0):.2f}  "
                f"rssi={r.get('rssi', 0)}dBm"
            )
        if server.nodes:
            print()  # blank line between ticks, easier to read
        await asyncio.sleep(interval_s)


def load_node_positions(path: str) -> dict[str, list[float]]:
    with open(path) as f:
        return json.load(f)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--positions", required=True,
        help="Path to node_positions.json (see config/node_positions.example.json)"
    )
    parser.add_argument("--udp-port", type=int, default=UDP_LISTEN_PORT)
    parser.add_argument("--ws-port", type=int, default=WS_PORT)
    parser.add_argument(
        "--verbose", action="store_true",
        help="Print motion_level/presence/breath_rate/confidence per node "
             "to the console twice a second — useful for tuning the "
             "presence threshold in processing/presence.py while testing."
    )
    args = parser.parse_args()

    node_positions = load_node_positions(args.positions)
    server = CSIServer(node_positions)

    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: UDPProtocol(server),
        local_addr=("0.0.0.0", args.udp_port),
    )
    print(f"[udp] listening for CSI packets on 0.0.0.0:{args.udp_port}")

    if args.verbose:
        asyncio.ensure_future(verbose_log_loop(server))

    async with websockets.serve(
        lambda ws: ws_handler(ws, server), "0.0.0.0", args.ws_port
    ):
        print(f"[ws] serving state on ws://0.0.0.0:{args.ws_port}")
        await broadcast_loop(server)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nshutting down")
