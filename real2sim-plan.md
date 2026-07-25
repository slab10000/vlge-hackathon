# Real2Sim2Real with the SO-101 — verified plan (2026-07-25)

Goal: phone-record a desk → photoreal interactive 3D twin → SO-101 model inside → train policies in sim → drive the physical arm with them.

**Verdict: the idea is exactly on-thesis for this event (VLGE = behavioral data for physical AI, judges from NVIDIA/DeepMind/NASA), and a scoped version is achievable today.** The full "ultra-realistic twin + policy training + real deployment" is normally a multi-week research project — but purpose-built tooling for the SO-101 exists that compresses it to hours *if* you use the proven paths below and have an NVIDIA GPU (cloud or a teammate's gaming laptop — **ManiSkill/Isaac do not run on Macs**).

---

## The key finding: `squint`

**https://github.com/aalmuzairee/squint** (UC San Diego, 2026 — built on lerobot-sim2real/ManiSkill3)

- **Supports the SO-101 out of the box** (with wrist camera), 8 tasks: Reach / Lift / Place / Stack × cube/can
- Visual SAC that converges in **2–9 min per task (~15 min wall-clock)** on an RTX 3080+ (≥10 GB VRAM)
- Workflow: `tune_camera.py` (align real camera to sim) → `train_squint.py` → `deploy.py` (zero-shot on the real arm)
- Uses background-overlay matching — a photo of **your real desk** is composited behind the simulated arm during training, so the policy trains "in" your scene. This *is* your digital twin, in the form that actually transfers.
- This is the path the lerobot-sim2real author himself now recommends in his README (updated June 2026).

⚠️ The better-known **lerobot-sim2real** (StoneT2000) is **SO-100 only** — the author explicitly notes SO-101 doesn't work. Don't burn time on it; use squint.

## Three pipeline options

### Option A — Recommended: squint + splat twin for the story
Highest odds of a **live robot demo by 18:00**.

1. Photograph/scan the desk now (details below) — splat for visuals, one clean photo for squint's overlay.
2. Set up squint on a cloud GPU (RunPod/Lambda, any RTX 3090/4090 instance) or a teammate's NVIDIA laptop.
3. Calibrate the SO-101 carefully (`lerobot-calibrate`, mid-range zeros; watch wrist_roll — known issue huggingface/lerobot#3193).
4. `tune_camera.py` → capture desk overlay → `train_squint.py` (Lift or Reach first — smallest task) → `deploy.py` on the physical arm.
5. In parallel: splat the desk (Scaniverse → PLY) → Teleport upload (free for .ply) → Share ID → **VLGE World 50 world** = the judge-accessible browser link the submission form requires. Demo = explorable twin in VLGE + video/live of the real arm executing the sim-trained policy.

### Option B — The full NVIDIA digital-twin (only if pre-installed / big GPU)
Officially documented end-to-end, but heavy:

- **Scene:** phone photos (60% overlap) → COLMAP → **3dgrut** (github.com/nv-tlabs/3dgrut) → NuRec USDZ → **Isaac Sim 5.1** (min RTX 4080 16 GB; A100/H100 can't render — no RT cores). Splat is visual-only: colliders are hand-placed proxies (ground plane + boxes).
- **Robot:** **LeIsaac** (github.com/LightwheelAI/leisaac) — SO-101 leader-arm teleop inside Isaac Lab, dataset conversion to LeRobot format.
- **Policy:** **GR00T N1.7** (GA July 7, 2026, `nvidia/GR00T-N1.7-3B`) finetune via LeRobot's native `groot` policy type on your teleop episodes (~25 GB+ VRAM → rent an L40S/A100 for training only).
- NVIDIA's official course: "Train an SO-101 Robot From Sim-to-Real With NVIDIA Isaac" — docs.nvidia.com/learning/physical-ai/sim-to-real-so-101/latest/
- Realistic only with everything pre-downloaded (installs are tens of GB). Safest combo: Isaac Sim 5.1 + Isaac Lab 2.3 + LeIsaac (not the new 6.0).

### Option C — Fallback: imitation learning, no sim
Reliable, works today, no GPU drama until training:

- `lerobot-record` ~50 teleop episodes on the real desk (needs leader arm) → `lerobot-train --policy.type=act` (hours on consumer GPU / HF Jobs a10g) or finetune **SmolVLA** (`lerobot/smolvla_base`, Colab available) → `lerobot-rollout --robot.type=so101_follower`.
- No digital twin, but pairs perfectly with the splat-in-VLGE demo for the "future data plan" story.

## SO-101 sim assets (verified today)

| Asset | Where | Notes |
|---|---|---|
| **SO-101 URDF + MJCF** | github.com/TheRobotStudio/SO-ARM100 → `Simulation/SO101/` | Use **`so101_new_calib.xml`** — joint zeros at mid-range, matches current LeRobot calibration. `so101_old_calib.xml` = pre-2025 horizontal-extended convention. |
| SO-ARM100 MJCF | MuJoCo Menagerie `trs_so_arm100` | Best-tuned physics (collision geoms, elliptic cone) but SO-100 geometry, not 101. |
| SO-101 Gym envs | github.com/johnsutor/so101-nexus (`pip install so101-nexus`) | Beta; 6 MuJoCo tasks, PPO + BC, LeRobot dataset integration. |
| ManiSkill3 | `so100` agent + `SO100GraspCube-v1` | No `so101` in core — squint adds it. |
| MuJoCo Playground / gym-hil | — | **No SO-arm environments** (gym-hil is Franka-only). Don't look there. |

**Known sim gotchas:** LeRobot's gripper convention (0=closed…100=open) is *not* mapped in the URDF/MJCF — write the shim yourself. Gripper is asymmetric (one fixed jaw). Mesh-mesh fingertip contact is unstable in MuJoCo — add ~2.5 mm box collision pads (community fix from ggando.com/blog/so101-rl-lift). Motor params are borrowed from Open Duck Mini, not system-ID'd on the SO-101.

## Tools: video/photos → 3D

**Scene (splat):**
- **Scaniverse** (iOS/Android) — free, trains on-device in ~90 s, exports **PLY** splat + OBJ/GLB mesh. Fastest option today.
- **Teleport (Varjo)** — already in the event pipeline; PLY uploads free → Share ID → VLGE. Video/ZIP processing 30 min–24 h, so start early if capturing fresh.
- Desktop: **Postshot** (Windows, free tier), **Brush** (open-source, runs on Mac!), Nerfstudio `splatfacto` (`ns-export gaussian-splat`).
- Cleanup: **SuperSplat** (superspl.at/editor, free browser editor — crop floaters).

**Individual objects (the interactive part):**
- **TRELLIS.2** (Microsoft, MIT) — single photo → watertight PBR GLB; free HF Space `microsoft/TRELLIS.2-4B` (local needs 24 GB VRAM). Best quality/effort ratio.
- Tripo (300 free credits/mo) or Meshy — GLB out, assets go public CC-BY on free tiers.
- SPAR3D (Stability, open) — ~0.7 s/object locally on a GPU.
- Photogrammetry when accuracy matters: RealityScan 2.x (free), Meshroom.

**Physics/collision prep:**
- **CoACD** (`pip install coacd`) + **obj2mjcf** (`pip install obj2mjcf --decompose`) → convex hulls + ready MJCF.
- **Scale is not free:** image-to-3D outputs have arbitrary scale — measure one real object with a ruler and rescale everything to meters.
- Model the desk itself as a measured **box primitive**, not an extracted mesh. Splat→mesh research pipelines (SuGaR / 2DGS / GOF) are CUDA rabbit holes — skip today unless pre-installed.

**Research systems to cite or crib (all verified public code):**
- **RoboSnap** (arXiv:2607.06699, July 2026) — ONE photo → physics-ready layered scene in ~20 min; Docker images; needs ~48 GB VRAM + Gemini key. The 2026 state of the art for exactly this idea.
- **SplatSim** (ICRA 2025) — splat rendering over PyBullet for RGB sim2real; the canonical citation for your approach.
- **GSWorld** (ICRA 2026) — splat + ManiSkill closed-loop manipulation suite with prebuilt assets.
- **RialTo** (MIT, RSS 2024) — real2sim RL robustification (cite; too version-pinned to run today).
- **Articulate-Anything** (ICLR 2025) — VLM articulates objects from image/video (~30 min setup, Gradio app; good wow-factor).
- RoboGSim / Robo-GS / GASE — papers only, no runnable code.

## Suggested schedule for today (submission 18:00–18:30)

| When | What |
|---|---|
| Now | Two people: (1) scan desk with Scaniverse + shoot the squint overlay photo + measure desk/objects; (2) rent cloud RTX 4090, clone squint, start installs |
| +1 h | Calibrate SO-101 (careful wrist_roll); mount camera rigidly; `tune_camera.py` alignment |
| +2 h | `train_squint.py` on Reach or Lift (15 min/run — iterate); meanwhile upload splat PLY to Teleport → VLGE World 50 world |
| +4 h | `deploy.py` on the real arm; film everything immediately when it works |
| +5 h | Polish VLGE world (add object GLBs from TRELLIS, portal/UI explaining pipeline); optional: overlay telemetry story |
| 17:00 | Mentor check-in with working core loop; freeze features |
| 17:30–18:00 | Backup video, screenshots, submit form |

**Scope discipline:** one task (lift the cube) transferred to the real arm is a winning demo. Stack/place are stretch goals. If sim2real transfer fails by ~15:30, fall back to Option C (teleop imitation) or demo the sim-side policy + twin only.

## Pitch framing (for these judges)

"We turn any phone video of a workspace into a policy-training environment for a real robot" — then connect it to VLGE: the same splat lives in a VLGE world where *human* players could demonstrate tasks, generating the consented behavioral data VLGE sells. Real2sim (your pipeline) + human-data flywheel (their thesis) = Track 2 or Free Track. Cite SplatSim/RoboSnap as the research lineage, show the sim/real side-by-side video, and export one trajectory as JSON to wave at "traceable provenance."

## Compute checklist

- ❗ ManiSkill/squint & Isaac: **NVIDIA GPU + Vulkan, Linux preferred — no Mac.** Rent RunPod/Lambda RTX 4090 (~$0.4–0.8/h) for training; the physical-arm deploy machine just needs the policy + USB + camera (verify CPU inference works early — unconfirmed).
- squint: ≥10 GB VRAM · GR00T finetune: ≥25 GB (L40S/A100) · Isaac Sim: RTX 4080+ w/ RT cores
- Pre-download weights/checkpoints on venue Wi-Fi *now*, not at 16:00.
