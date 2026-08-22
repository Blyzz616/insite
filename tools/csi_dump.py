#!/usr/bin/env python3
"""
InSite — CSI packet dump / bench test tool

Run this BEFORE csi_server.py when bringing up a new node. It just
listens on the UDP port, unpacks the header, and prints a one-line
summary per packet so you can confirm:
  - packets are arriving at all
  - csi_len looks sane (should be a few dozen to ~128 bytes for HT20,
    not truncated to something tiny)
  - first_word_invalid isn't flagged constantly (if it is, see the
    known ESP32-C6 issue linked in the README)
  - rssi/channel look plausible

Usage:
    python3 tools/csi_dump.py
    python3 tools/csi_dump.py --port 9494 --node node-01   # filter to one node
"""

import argparse
import socket
import struct
import time

HEADER_FORMAT = "<16sIIbBBBH"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9494)
    parser.add_argument("--node", default=None, help="Only show packets from this node_id")
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", args.port))
    print(f"listening on UDP :{args.port} — waiting for CSI packets...\n")

    count = 0
    last_print = time.time()

    while True:
        data, addr = sock.recvfrom(2048)
        if len(data) < HEADER_SIZE:
            print(f"[warn] short packet from {addr} ({len(data)} bytes, expected >= {HEADER_SIZE})")
            continue

        node_id_raw, seq, ts_ms, rssi, rate, channel, first_word_invalid, csi_len = (
            struct.unpack_from(HEADER_FORMAT, data, 0)
        )
        node_id = node_id_raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")

        if args.node and node_id != args.node:
            continue

        actual_csi_bytes = len(data) - HEADER_SIZE
        truncated = actual_csi_bytes < csi_len

        count += 1
        flag = " TRUNCATED" if truncated else ""
        invalid_flag = " first_word_invalid" if first_word_invalid else ""
        print(
            f"[{count:5d}] {node_id:12s} seq={seq:6d} rssi={rssi:4d}dBm "
            f"ch={channel:2d} csi_len={csi_len:4d} (got {actual_csi_bytes}){flag}{invalid_flag}"
        )

        # Every ~5 seconds, print a rate summary — useful for estimating
        # your real CSI sample rate to plug into BreathingEstimator.
        now = time.time()
        if now - last_print > 5.0:
            print(f"        --- {count} packets total so far ---\n")
            last_print = now


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
