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
