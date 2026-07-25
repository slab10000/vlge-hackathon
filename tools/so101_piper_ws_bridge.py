#!/usr/bin/env python3
"""Like tools/so101_ws_bridge.py, but also drives Piper arms: retargets the
SO-101's live TCP onto a Piper-X (actuacore-feetech's cross-embodiment map) and
appends the solved Piper joints to the forwarded state, so one WebSocket drives
every arm type in the world at once.

Same projection as actuacore-feetech's scripts/project_so101_tcp_piper_viser.py:

    position     p_piper = scale * p_so101        (each in its own base frame)
    orientation  R_piper = R_so101 @ ALIGN        (exact axis permutation)
    gripper      SO-101 jaw angle normalised onto 0..0.05 m per finger

then Piper IK (~0.2 ms). The forwarded payload is the handler's state dict with
joint_names/joint_pos EXTENDED by [joint1..joint6, gripper_left_joint] — the
world routes by joint name, so SO-101 instances take the first six and Piper
instances the rest (the right finger mimics the left in the URDF). A "piper"
field carries scale + IK residuals for debugging.

Needs actuacore's kinematics stack (pinocchio) plus its source tree on
PYTHONPATH. The actuacore project env itself may not build (ruckig's sdist is
broken against scikit-build-core >= 0.10), so run wheels-only with the ruckig
import stub from tools/stubs/ — from this repo's root:

    PYTHONPATH="tools/stubs:$HOME/Documents/TODO/Coding/actuacore-feetech/src" \
    uv run --no-project --python 3.12 \
        --with pin --with numpy --with pyyaml --with motorbridge --with python-can \
        --with msgpack --with pyzmq --with websockets \
        python tools/so101_piper_ws_bridge.py --host pc-chilly-chicken

(If `uv sync --extra so101` works in the actuacore checkout on your machine,
`uv run --extra so101 python .../so101_piper_ws_bridge.py` works too.)

Then connect the world's Live panel to ws://localhost:8765 as usual. Stop the
plain so101_ws_bridge.py first — both default to port 8765.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import tempfile
from pathlib import Path

import msgpack
import numpy as np
import pinocchio as pin
import websockets
import zmq
import zmq.asyncio

from actuacore.actuator import EEF_FRAME, SoArmKinematics
from actuacore.kinematics import solve_ik_with_retry

# The vendored copy of actuacore-feetech's models/piper_x_arm_description —
# kinematics only, so pin never needs the meshes.
PIPER_URDF = Path(__file__).resolve().parents[1] / "world" / "assets" / "piper" / "piper_x_arm.urdf"
PIPER_TCP_FRAME = "gripper_center"
PIPER_ARM_JOINTS = ("joint1", "joint2", "joint3", "joint4", "joint5", "joint6")
PIPER_FINGER_JOINTS = ("gripper_left_joint", "gripper_right_joint")
PIPER_FINGER_TRAVEL = 0.05  # metres per finger
DEFAULT_SCALE = 1.7         # ~ the arms' reach ratio (0.925 m / 0.543 m)

# SO-101 EEF axes -> Piper TCP axes (project_so101_tcp_piper_viser.py's _ALIGN):
# approach +z -> Piper +x, hinge -> grasp normal, plus the 180° about x that
# lands the gripper upright.
ALIGN = np.array([
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 0.0],
])

# ---------------------------------------------------------------------- addresses
# Mirrors actuacore.runtime_paths (see tools/so101_ws_bridge.py for the details).
_ROLES = ("state", "action", "action_tap", "control")


def _safe_name(name: str) -> str:
    return name.replace("/", "_").lstrip("_") or "default"


def state_address(args: argparse.Namespace) -> str:
    if args.connect:
        return args.connect
    if args.host:
        digest = hashlib.blake2b(_safe_name(args.channel).encode(), digest_size=2).digest()
        port = args.port_base + (int.from_bytes(digest, "big") % 100) * len(_ROLES)
        return f"tcp://{args.host}:{port}"
    return f"ipc://{tempfile.gettempdir()}/state_{_safe_name(args.channel)}"


# ---------------------------------------------------------------------- retarget
class PiperProjector:
    """SO-101 joint state -> Piper joint state, per the viser projector."""

    def __init__(self, scale: float) -> None:
        self.scale = scale
        self.so101 = SoArmKinematics()
        self.model = pin.buildModelFromUrdf(str(PIPER_URDF))
        self.data = self.model.createData()
        self.tcp_id = self.model.getFrameId(PIPER_TCP_FRAME)
        self.idx_q = {
            name: self.model.joints[self.model.getJointId(name)].idx_q
            for name in self.model.names[1:]
        }
        self.q = pin.neutral(self.model)

    def project(self, joint_pos: dict[str, float]) -> dict | None:
        pos, rot = self.so101.frame_pose_world(joint_pos, EEF_FRAME)
        target = pin.SE3(rot @ ALIGN, pos * self.scale)
        try:
            self.q = solve_ik_with_retry(self.model, self.data, self.tcp_id, target, self.q).q
        except Exception:
            return None  # keep the world's last pose rather than glitching

        # pinocchio ignores <mimic>: drive both fingers from the SO-101 jaw angle
        lower, upper = self.so101.joint_limits["gripper"]
        opening = float(np.clip((joint_pos.get("gripper", 0.0) - lower) / (upper - lower), 0.0, 1.0))
        for finger in PIPER_FINGER_JOINTS:
            self.q[self.idx_q[finger]] = opening * PIPER_FINGER_TRAVEL

        pin.forwardKinematics(self.model, self.data, self.q)
        pin.updateFramePlacements(self.model, self.data)
        reached = self.data.oMf[self.tcp_id]
        return {
            "names": [*PIPER_ARM_JOINTS, "gripper_left_joint"],
            "pos": [float(self.q[self.idx_q[n]]) for n in (*PIPER_ARM_JOINTS, "gripper_left_joint")],
            "scale": self.scale,
            "pos_err_mm": float(np.linalg.norm(reached.translation - target.translation) * 1000),
            "rot_err_deg": float(np.degrees(np.linalg.norm(pin.log3(reached.rotation.T @ target.rotation)))),
        }


# ---------------------------------------------------------------------- bridge
async def run(args: argparse.Namespace) -> None:
    addr = state_address(args)
    projector = PiperProjector(args.scale)

    ctx = zmq.asyncio.Context.instance()
    sub = ctx.socket(zmq.SUB)
    sub.setsockopt(zmq.SUBSCRIBE, b"")
    sub.setsockopt(zmq.CONFLATE, 1)
    sub.connect(addr)

    clients: set = set()
    last: str | None = None

    async def handler(ws, path=None):
        clients.add(ws)
        print(f"world connected ({len(clients)} client{'s' if len(clients) != 1 else ''})", flush=True)
        try:
            if last is not None:
                await ws.send(last)
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    async def pump() -> None:
        nonlocal last
        got_first = False
        while True:
            raw = await sub.recv()
            try:
                state = msgpack.unpackb(raw, raw=False)
            except Exception as exc:
                print(f"skipping undecodable message: {exc}", flush=True)
                continue

            joint_pos = {
                name: pos
                for name, pos in zip(state.get("joint_names", []), state.get("joint_pos", []))
                if pos is not None
            }
            piper = projector.project(joint_pos) if joint_pos else None
            if piper:
                state["joint_names"] = list(state["joint_names"]) + piper["names"]
                state["joint_pos"] = list(state["joint_pos"]) + piper["pos"]
                state["piper"] = {k: piper[k] for k in ("scale", "pos_err_mm", "rot_err_deg")}

            if not got_first:
                got_first = True
                print(f"receiving arm state ✓  forwarding joints: {state.get('joint_names')}", flush=True)

            last = json.dumps(state)
            for ws in list(clients):
                try:
                    await ws.send(last)
                except websockets.ConnectionClosed:
                    clients.discard(ws)

    async with websockets.serve(handler, args.ws_host, args.ws_port):
        print(f"ZMQ SUB   ← {addr}", flush=True)
        print(f"WebSocket → ws://{args.ws_host}:{args.ws_port}  (SO-101 + retargeted Piper)", flush=True)
        await pump()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ZMQ→WebSocket bridge forwarding SO-101 state plus the retargeted Piper joints."
    )
    parser.add_argument("--host", default=None, help="machine running zmq_so_arm_handler.py over tcp")
    parser.add_argument("--channel", default="so101_r", help="handler's --channel name (default: so101_r)")
    parser.add_argument("--port-base", type=int, default=5600, help="ACTUACORE_ZMQ_PORT_BASE override")
    parser.add_argument("--connect", default=None, help="explicit ZMQ endpoint (overrides --host/--channel)")
    parser.add_argument("--scale", type=float, default=DEFAULT_SCALE, help="position scale SO-101→Piper")
    parser.add_argument("--ws-host", default="localhost", help="WebSocket bind host")
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket bind port")
    args = parser.parse_args()

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
