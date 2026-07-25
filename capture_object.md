# capture_object — real object → simulation-ready asset (repo-local skill)

Turn a real object you can hold (water bottle, cube, tool) into a metric, physics-ready
asset that drops into **both** the browser world and a **MuJoCo scene with the SO-101**,
so a policy can be trained on it in sim and then run on the physical arm.

Companion to [`create_environment.md`](create_environment.md), which builds the *scene*.
This skill builds the *objects in it*.

---

## What this is: RoboSnap, adapted to run on a Mac

[RoboSnap](https://github.com/robosnap/robosnap) (RA-L, July 2026) is the current state of
the art for one-shot real-to-sim. Its pipeline is 9 stages across 4 CUDA conda environments.
Verified stage-by-stage against their released code:

| RoboSnap stage | Tool it uses | Runs on Apple Silicon? | What we do instead |
|---|---|---|---|
| 1. Find objects in photo | Gemini VLM + **SAM3** | ✗ CUDA | Not needed — you capture one object at a time, physically isolated |
| 2. Mask → 3D asset | **SAM 3D Objects** (32 GB VRAM, gated) | ✗ | **Apple PhotogrammetrySession in object mode** — reconstructs the *real* object |
| 3. Camera + depth | VGGT | ✗ | Not needed (per-object capture) |
| 4. Pose registration | Open3D ICP | ✓ portable | Not needed; objects are placed by the scene builder |
| 5–6. Background | **NVIDIA Lyra-2** (91 GB weights) + 3DGS | ✗ | Our photogrammetry scene mesh — and unlike their splat, **ours has collision** |
| 7. Gravity alignment | area-weighted face normals | ✓ portable | Already implemented (auto-level in `world/main.js`) |
| 8. Physics settling | **SAPIEN** | ✗ no macOS | **MuJoCo** (native, and what the SO-101 model targets anyway) |
| 9. Layered render | CUDA `gsplat` | ✗ | Three.js browser world |
| Convex decomposition | **CoACD** | ✓ pure CPU | Same — CoACD, identical to theirs |
| Simulator export | *doesn't exist* — outputs only GLB + PLY | — | **We emit MJCF**, ready for the SO-101 |

**Two places this beats RoboSnap for our use case:**

1. **Scale.** RoboSnap's metric scale comes entirely from SAM 3D Objects' predicted `scale`
   field and is *never corrected* (their ICP runs with `with_scaling=False`). Scale error is
   the difference between a policy that transfers and one that misses the grasp by 2 cm.
   We measure the object with a ruler and scale to it — one number, exact.
2. **Real geometry.** They *generate* the object from one photo, so the unseen back side is
   hallucinated. We photograph the whole object, so the mesh is the real thing all the way
   around — the part the gripper closes on is real, not invented.

What we give up: their fully automatic multi-object scene parsing from a single snapshot.
We trade ~4 minutes of capture per object for accuracy where it matters.

---

## ⚠️ Step 0 — ALWAYS ask the user first

Before running anything, ask:

### Q1 — Which object, and its measured size
The object must be **measured** — this is what makes the twin metrically correct.
Ask for one dimension (height is usually easiest) in **centimeters or meters**, and
ideally the **mass in grams** (a kitchen scale beats a density guess).

### Q2 — Quality preset
Same presets as `create_environment.md`. For a single small object, reconstruction is much
faster than a whole scene, so prefer higher quality:

| Preset | Typical time (single object) | Use |
|---|---|---|
| `preview` | <1 min | sanity check |
| `reduced` | 1–3 min | quick iteration |
| `medium` | 3–6 min | good default |
| `full` | 8–20 min | **recommended for objects** — the gripper contact surface benefits |

### Q3 — Frame sampling
Show the math (`total_frames / N`) for their clip. For a single object, target **80–200
images**; a 60 s orbit at 30 fps with `N=10` gives ~180.

---

## Step 1 — Capture the object (the part that decides quality)

Tell the user:

- Put the object **alone** on a plain, non-reflective surface with even light. A contrasting
  matte surface helps object masking separate it.
- Walk a **slow, complete circle** around it — 3 orbits at three heights: near table level,
  45°, and looking down from above. ~45–90 s total.
- **Every side must be seen**, including the top. Whatever the camera never sees becomes a hole.
- Keep the object **still** — move the camera, not the object. Lock exposure/focus (tap-hold on iPhone).
- Avoid transparent/mirror objects — clear plastic bottles reconstruct poorly. **A bottle with a
  label or an opaque one works far better than a clear empty one.** If it's clear, put something
  in it or wrap tape around it.
- Measure it with a ruler right after, and weigh it if possible.

## Step 2 — Frames + reconstruction (object mode)

```bash
SCRATCH=/tmp/objcap && mkdir -p $SCRATCH/frames
ffmpeg -y -v error -i <VIDEO> -vf "select='not(mod(n,<N>))',scale=3840:-2" \
  -vsync vfr -q:v 2 "$SCRATCH/frames/f_%04d.jpg"
ls $SCRATCH/frames | wc -l

tools/photogram "$SCRATCH/frames" "$SCRATCH/object.usdz" <preset> --object
```

The **`--object` flag is the important part**: it turns on `isObjectMaskingEnabled` (isolating
the subject from its background) and raises feature sensitivity. Omit it and you reconstruct
the table too. Build the CLI first if needed: `cd tools && swiftc -O photogram.swift -o photogram`

## Step 3 — Make it simulation-ready

```bash
python3 tools/make_object.py "$SCRATCH/object.usdz" water_bottle \
  --height 0.22 --mass 0.5
```

Deps (one-time): `python3 -m pip install coacd trimesh mujoco`

What it does, and why each part matters:
- **Scales** the mesh so the measured axis equals the real measurement — the metric anchor.
- **Re-origins** it: centered in XZ, base at Y=0, so "place at desk height" just works.
- **Convex-decomposes** with CoACD (same tool RoboSnap uses) — MuJoCo can't do stable contact
  against a raw concave mesh, so collision must be a union of convex hulls.
- **Computes inertia** from the real mesh volume and your measured mass.
- Emits: `world/assets/objects/<name>.glb` (browser, Y-up) and `sim/objects/<name>/`
  (`visual.obj`, `collision_XX.obj`, `<name>.xml` MJCF, `<name>.json` manifest — Z-up).

Useful flags: `--density KG_M3` if you can't weigh it (water bottle ≈ 1000, empty plastic ≈ 400),
`--hulls N` for decomposition detail, `--friction F`, `--no-collision` for visual-only props.

## Step 4 — Build the SO-101 scene

```bash
python3 tools/build_sim_scene.py water_bottle          # add more names for more objects
```

Writes `sim/so101/desk_scene.xml`: the SO-101 arm (from `sim/so101/`, TheRobotStudio's official
MJCF, `so101_new_calib` — the calibration that matches current LeRobot) + a desk plane + your
objects laid out in front of the gripper.

⚠️ Mesh paths resolve against the arm's `compiler meshdir="assets"`, which is why object meshes
are referenced as `../../objects/<name>/...`. Don't "simplify" those paths.

Verify it actually simulates:

```bash
python3 -c "
import mujoco, numpy as np
m = mujoco.MjModel.from_xml_path('sim/so101/desk_scene.xml'); d = mujoco.MjData(m)
mujoco.mj_forward(m, d)                      # REQUIRED before reading xpos
b = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, 'water_bottle')
s = d.xpos[b].copy()
for _ in range(1500): mujoco.mj_step(m, d)
print('settle drift %.4f m, upright %.3f' % (np.linalg.norm(d.xpos[b]-s), d.xmat[b].reshape(3,3)[2,2]))"
```

Healthy: drift **< 0.01 m** and upright **≈ 1.0**. Large drift means the object is
penetrating something at t=0 or the hulls are wrong.

Render a look at it:
```bash
python3 -c "
import mujoco, imageio.v3 as iio
m = mujoco.MjModel.from_xml_path('sim/so101/desk_scene.xml'); d = mujoco.MjData(m)
mujoco.mj_forward(m,d)
for _ in range(600): mujoco.mj_step(m,d)
r = mujoco.Renderer(m, 720, 1280)
cam = mujoco.MjvCamera(); cam.lookat[:]=[0.16,0,0.08]; cam.distance=0.8; cam.azimuth=135; cam.elevation=-20
r.update_scene(d, cam); iio.imwrite('/tmp/scene.png', r.render())"
```

## Step 5 — Show it in the browser world

Add the object to `OBJECT_PROPS` in `world/main.js`:

```js
const OBJECT_PROPS = [
  { name: 'water_bottle', url: './assets/objects/water_bottle.glb' },
];
```

Then bump `main.js?v=N` in `world/index.html` (cache-busting is mandatory) and reload.
The object spawns as a grabbable Rapier body with a convex-hull collider — walk into it, `E`
to pick up and throw.

**Scale note:** the browser world deliberately blows the desk up to `WORLD_SIZE` (16 m) so you
can walk on it. Metric objects are converted with `METERS_TO_WORLD = WORLD_SIZE /
REAL_SCENE_SIZE_M`. If your objects look wrong-sized, measure the real scene's longest
dimension and set `REAL_SCENE_SIZE_M` in `world/main.js` (default 1.6 m).
Metric truth lives in the MuJoCo scene; the browser world is a scaled view of it.

---

## Step 6 — Train a policy on it, then run it on the real arm

The sim is now the input to the policy work described in
[`real2sim-plan.md`](real2sim-plan.md). Short version:

- **[squint](https://github.com/aalmuzairee/squint)** is the path — SO-101 supported out of
  the box, visual RL, ~15 min per task on an RTX 3080+. Needs an **NVIDIA GPU (cloud is fine;
  this Mac cannot train)**.
- Its camera-alignment step composites a photo of your **real desk** behind the simulated arm,
  which is what makes the policy transfer zero-shot.
- Do NOT use `lerobot-sim2real` — it is SO-100 only; its own author points SO-101 users to squint.
- Calibrate the real arm carefully first (`lerobot-calibrate`, mid-range zeros, watch
  `wrist_roll` — known issue huggingface/lerobot#3193). Sim/real joint mismatch is the top
  silent failure.

---

## Troubleshooting

- **Object has holes / mush** — the camera never saw that side, or the object moved during
  capture. Re-shoot with full 360° coverage at three heights.
- **Clear/shiny object reconstructs badly** — expected; photogrammetry needs texture. Add a
  label, tape, or fill it.
- **`--object` still includes the table** — masking needs contrast; use a plainer, contrasting
  background and re-shoot.
- **CoACD produces too many/few hulls** — tune `--hulls` (default 24). More hulls = more
  accurate contact, slower sim.
- **Object jitters or explodes in MuJoCo** — usually initial penetration. Objects are placed
  with their base 2 mm above the surface; if you moved them, keep base ≥ surface height.
- **Measured `xpos` looks wildly wrong** — call `mujoco.mj_forward(m, d)` before reading it;
  `xpos` is zero-filled until kinematics run. (This one cost us a debugging cycle.)
- **Object invisible in the browser** — check the browser console for the `prop "<name>" loaded`
  line, confirm `assets/objects/<name>.glb` returns 200, and confirm you bumped `?v=`.
