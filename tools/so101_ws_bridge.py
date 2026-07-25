#!/usr/bin/env python3
"""Bridge the SO-101 arm's ZMQ state stream to a WebSocket the world editor can read.

actuacore-feetech's ``scripts/zmq_so_arm_handler.py`` publishes joint state as
msgpack on a ZMQ PUB socket. Browsers cannot speak ZMQ, so this bridge runs on
the SAME machine as the browser, subscribes to the arm stream, and rebroadcasts
every tick as JSON on ``ws://localhost:8765`` for the world's Live panel:

    robot laptop:  ACTUACORE_ZMQ_TRANSPORT=tcp  zmq_so_arm_handler.py --channel so101_r
                        │ tcp://<robot-laptop>:5860 (msgpack)
    this laptop:   so101_ws_bridge.py --host <robot-laptop>
                        │ ws://localhost:8765 (same dict, as JSON)
    browser:       world editor → Live panel → Connect

Usage::

    python3 tools/so101_ws_bridge.py --host pc-chilly-chicken            # robot on another machine
    python3 tools/so101_ws_bridge.py                                     # handler on THIS machine (ipc)
    python3 tools/so101_ws_bridge.py --connect tcp://192.168.2.58:5860   # explicit endpoint

Needs ``pyzmq``, ``msgpack`` and ``websockets``::

    pip3 install pyzmq msgpack websockets
    # or, dependency-free via uv:
    uv run --with pyzmq --with msgpack --with websockets python3 tools/so101_ws_bridge.py --host ...

The forwarded payload is the handler's state dict unchanged — the world reads
``joint_names``/``joint_pos``; everything else (EEF poses, 6D rotations, ticks)
rides along for anything downstream. See actuacore-feetech's HACKATHON.md for
the field reference and frame conventions.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import tempfile

import msgpack
import websockets
import zmq
import zmq.asyncio

# ---------------------------------------------------------------------- addresses
# Mirrors actuacore.runtime_paths exactly: four consecutive ports per channel in
# role order (state, action, action_tap, control), slot chosen by a stable
# blake2b hash of the channel name so both machines agree without a config file.
# so101_r -> state port 5860 (checked against the table in HACKATHON.md).
_ROLES = ("state", "action", "action_tap", "control")
_CHANNEL_SLOTS = 100
_DEFAULT_PORT_BASE = 5600


def _safe_name(name: str) -> str:
    return name.replace("/", "_").lstrip("_") or "default"


def state_port(channel: str, port_base: int) -> int:
    digest = hashlib.blake2b(_safe_name(channel).encode(), digest_size=2).digest()
    slot = int.from_bytes(digest, "big") % _CHANNEL_SLOTS
    return port_base + slot * len(_ROLES) + _ROLES.index("state")


def state_address(args: argparse.Namespace) -> str:
    if args.connect:
        return args.connect
    if args.host:
        return f"tcp://{args.host}:{state_port(args.channel, args.port_base)}"
    # no host: the handler runs on this machine over its default ipc transport
    return f"ipc://{tempfile.gettempdir()}/state_{_safe_name(args.channel)}"


# ---------------------------------------------------------------------- bridge
async def run(args: argparse.Namespace) -> None:
    addr = state_address(args)

    ctx = zmq.asyncio.Context.instance()
    sub = ctx.socket(zmq.SUB)
    sub.setsockopt(zmq.SUBSCRIBE, b"")
    sub.setsockopt(zmq.CONFLATE, 1)  # a mirror only ever wants the newest tick
    sub.connect(addr)

    clients: set = set()
    last: str | None = None

    async def handler(ws, path=None):  # `path` arg kept for older websockets versions
        clients.add(ws)
        peer = getattr(ws, "remote_address", "?")
        print(f"world connected: {peer} ({len(clients)} client{'s' if len(clients) != 1 else ''})")
        try:
            if last is not None:
                await ws.send(last)  # a late joiner starts from the current pose
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            print(f"world left: {peer} ({len(clients)} left)")

    async def pump() -> None:
        nonlocal last
        got_first = False
        while True:
            raw = await sub.recv()
            try:
                state = msgpack.unpackb(raw, raw=False)
            except Exception as exc:  # one bad tick is not fatal
                print(f"skipping undecodable message: {exc}")
                continue
            if not got_first:
                got_first = True
                names = state.get("joint_names") if isinstance(state, dict) else None
                print(f"receiving arm state ✓  joints: {names}")
            last = json.dumps(state)
            for ws in list(clients):
                try:
                    await ws.send(last)
                except websockets.ConnectionClosed:
                    clients.discard(ws)

    async with websockets.serve(handler, args.ws_host, args.ws_port):
        print(f"ZMQ SUB   ← {addr}")
        print(f"WebSocket → ws://{args.ws_host}:{args.ws_port}")
        print("point the world's Live panel at that URL and press Connect")
        if addr.startswith("tcp://"):
            host = addr.removeprefix("tcp://").rsplit(":", 1)
            print(f"(no data? check the link first:  nc -vz {host[0]} {host[1]})")
        await pump()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ZMQ→WebSocket bridge for mirroring the SO-101 in the world editor."
    )
    parser.add_argument("--host", default=None,
                        help="machine running zmq_so_arm_handler.py with ACTUACORE_ZMQ_TRANSPORT=tcp "
                             "(hostname or IP; omit if the handler runs on this machine over ipc)")
    parser.add_argument("--channel", default="so101_r", help="handler's --channel name (default: so101_r)")
    parser.add_argument("--port-base", type=int, default=_DEFAULT_PORT_BASE,
                        help="ACTUACORE_ZMQ_PORT_BASE if the robot laptop overrides it")
    parser.add_argument("--connect", default=None,
                        help="explicit ZMQ endpoint, e.g. tcp://192.168.2.58:5860 (overrides --host/--channel)")
    parser.add_argument("--ws-host", default="localhost", help="WebSocket bind host (default: localhost)")
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket bind port (default: 8765)")
    args = parser.parse_args()

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
