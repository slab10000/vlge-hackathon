# vlge-hackathon

## Mirror the real SO-101 in the world editor

The physical arm lives on the robot laptop, running
[actuacore-feetech](https://github.com/actuacure/fleetech)'s
`scripts/zmq_so_arm_handler.py`. Its joint stream drives every SO-101 you drop
into the world, live.

**1. Robot laptop** (the one with the arm plugged in) — publish over TCP instead
of the default machine-local ipc:

```bash
ACTUACORE_ZMQ_TRANSPORT=tcp \
  uv run scripts/zmq_so_arm_handler.py --port /dev/cu.usbmodemXXXX --channel so101_r
```

**2. This laptop** — bridge that ZMQ stream to a WebSocket the browser can read:

```bash
pip3 install pyzmq msgpack websockets   # once
python3 tools/so101_ws_bridge.py --host pc-chilly-chicken
```

(`--host` takes the robot laptop's Tailscale name, MagicDNS FQDN or LAN IP —
see `HACKATHON.md` in actuacore-feetech. If the handler runs on *this* machine,
omit `--host` and the bridge reads the local ipc socket.)

**3. Browser** — serve and open the world, then in the **Live robot** panel
(under Assets) hit **Connect** on `ws://localhost:8765`:

```bash
python3 -m http.server 8125 --directory world
```

Drop an SO-101: it follows the physical arm. Uncheck **live** in the inspector
to hand-pose one instance while the others keep mirroring. `joint_pos` order and
names come straight from the handler
(`shoulder_pan shoulder_lift elbow_flex wrist_flex wrist_roll gripper`, radians,
`null` for a failed servo read — nulls keep the last pose).

The Piper X arm (`world/assets/piper/`, from actuacore-feetech's
`models/piper_x_arm_description`) is on the shelf too — 7 controllable joints,
the right finger mimics the left.

### Drive the Pipers from the same arm

`tools/so101_piper_ws_bridge.py` replaces the plain bridge: it additionally
retargets the SO-101's TCP onto the Piper (scale ×1.7 + axis permutation, the
same projection as actuacore-feetech's `project_so101_tcp_piper_viser.py`),
solves Piper IK, and appends `joint1..joint6, gripper_left_joint` to the same
WebSocket payload — so one connection drives every SO-101 *and* every Piper in
the scene. It needs actuacore's kinematics source + pinocchio; from this repo's
root (stop `so101_ws_bridge.py` first, both use port 8765):

```bash
PYTHONPATH="tools/stubs:$HOME/Documents/TODO/Coding/actuacore-feetech/src" \
uv run --no-project --python 3.12 \
  --with pin --with numpy --with pyyaml --with motorbridge --with python-can \
  --with msgpack --with pyzmq --with websockets \
  python tools/so101_piper_ws_bridge.py --host pc-chilly-chicken
```

(`tools/stubs/` fakes `ruckig`, whose sdist doesn't build on modern
scikit-build-core; the bridge never uses it. `--scale` tunes the workspace
mapping, default 1.7.)
