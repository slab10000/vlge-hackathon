# create_environment — video → walkable 3D world (repo-local skill)

Turn a phone video of a real place into a textured 3D mesh and load it into the
walkable browser world in [`world/`](world/). Everything runs locally on this Mac
(no accounts, no cloud): ffmpeg → Apple PhotogrammetrySession → Blender → GLB →
Three.js world with BVH collision.

**Audience:** an AI assistant (Claude) working in this repo. Follow it top to bottom.

---

## ⚠️ Step 0 — ALWAYS ask the user first (do not skip)

Before running anything, ask the user these questions (use the interactive
question tool if available; otherwise ask in chat and wait). Do **not** start
the pipeline with defaults unless the user explicitly says "use defaults".

### Q1 — Quality (detail preset)

Present these options — they map 1:1 to `tools/photogram.swift`'s `<detail>` argument.
Timings/sizes measured on this machine (M-series, ~200 4K frames):

| Preset | Time | Output size (USDZ→GLB) | When to use |
|---|---|---|---|
| `preview` | ~1–3 min | ~2–5 MB | Sanity check that reconstruction works at all |
| `reduced` | ~8 min | ~11 → 10 MB | Fast iteration; fine geometry test |
| `medium` | ~10 min | ~32 → 29 MB | **Recommended default** — good quality, still loads fast in the browser |
| `full` | ~25–60+ min | ~80–200 MB (estimate) | Maximum built-in quality; heavy for web — warn the user about load time |
| `raw` | longest | largest | Every detail, no compression; offline/archival use, not for the browser |

Note for the user: capture quality matters more than the preset — a slow 2–3 min
orbit at three heights with nothing moving in frame beats any preset bump.
(Advanced: PhotogrammetrySession also has a `.custom` detail with explicit
polygon/texture budgets; not wired into the CLI — extend `tools/photogram.swift`
if ever needed.)

### Q2 — Frame sampling (every how many frames)

Ask: "extract every Nth frame?" Show the math for their video first
(get it from ffprobe, Step 2): `frames_extracted ≈ total_frames / N`.

Guidance to present:
- Target **150–400 images**; PhotogrammetrySession accepts up to ~1000, and more views = better reconstruction but slower.
- For a 30 fps video: `N=4` ≈ 7–8 images/sec of video — the tested default.
- `N=2` doubles views (better coverage, ~2× slower). `N=8+` only for very long or slow-moving captures.

### Q3 — Video path (only if not already provided)

If the user didn't point to a video, ask for the path. Also confirm which output
slot to fill (default: replace `world/assets/desk.glb`; keep the old one as a
`*_backup.glb` if the user wants it).

---

## Step 1 — Preflight

```bash
which ffmpeg && which swift && ls /Applications/Blender.app && sw_vers
```

All must exist (ffmpeg via Homebrew, Blender.app installed, macOS with Swift).
Build the reconstruction CLI if the binary is missing or the source changed:

```bash
cd tools && swiftc -O photogram.swift -o photogram && cd ..
```

(The `photogram` binary is not committed — always safe to rebuild.)

## Step 2 — Inspect the video

```bash
ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames -of default=noprint_wrappers=1 "<VIDEO_PATH>"
```

Use `nb_frames` + the user's chosen `N` to tell them how many images will be
extracted, then confirm.

## Step 3 — Extract frames

Work in a scratch directory (`$SCRATCH` = session scratchpad or `/tmp` folder):

```bash
mkdir -p "$SCRATCH/frames"
ffmpeg -y -v error -i "<VIDEO_PATH>" \
  -vf "select='not(mod(n,<N>))',scale=3840:-2" -vsync vfr -q:v 2 \
  "$SCRATCH/frames/f_%04d.jpg"
ls "$SCRATCH/frames" | wc -l
```

Notes: `scale=3840:-2` downsamples 8K sources to 4K (good balance). For maximum
texture detail from an 8K source at `full`/`raw` presets, drop the `scale` filter.
Visually check 2–3 frames (Read tool) — confirm the scene is what the user expects
and warn them if people/hands are moving in shot (causes ghosting).

## Step 4 — Reconstruct (run in background; takes minutes)

```bash
mkdir -p "$SCRATCH/model"
tools/photogram "$SCRATCH/frames" "$SCRATCH/model/scene.usdz" <preset>
```

- Progress prints as `PROGRESS n%` plus stage info (pointCloudGeneration → meshGeneration → textureMapping → optimization).
- **Output must be `.usdz`** — `.obj` export is not supported by this macOS build (fails with `invalidOutput`).
- The CLI sets `sampleOrdering=.sequential` (video frames) and `isObjectMaskingEnabled=false` (whole scene, not one object) — that's intentional; don't change for scene scans.

## Step 5 — Convert USDZ → GLB (Blender headless)

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python tools/usdz2glb.py -- "$SCRATCH/model/scene.usdz" "world/assets/desk.glb"
```

If replacing an existing asset the user wants kept, `mv` the old one to
`world/assets/<name>_backup.glb` first.

## Step 6 — Load in the world + cache-bust

The viewer loads `world/assets/desk.glb` (see `MODEL_URL` in `world/main.js`).
**Bump the version query** on the script tag in `world/index.html`
(`main.js?v=N` → `v=N+1`) — browsers cache modules aggressively and the user
will otherwise see the old build.

Serve and open:

```bash
python3 -m http.server 8123 --directory world   # run in background
open "http://localhost:8123"
```

## Step 7 — Verify before telling the user it's done

The world self-normalizes on load — these are automatic, just confirm them:
- **Auto-level:** console logs `auto-level: tilt was X deg` (photogrammetry scans
  are always a degree or two off; the world measures the dominant floor/desk
  normals and rotates level — this is what prevents "drifting" on slopes).
- **Scale:** largest dimension normalized to `WORLD_SIZE` (16 m default = desk
  becomes walkable terrain; ~7 m ≈ human scale — ask the user if they mention scale).
- **Spawn:** raycast from above drops the player onto the topmost surface.

Then verify with browser tools (headless-safe: use `window.__step(dt)` to drive
physics even when the tab is hidden — rAF pauses in hidden tabs):
1. Model loads (no 404 in console; overlay shows no error text).
2. `window.__player.position` is on the mesh and `onGround` becomes true.
3. Idle drift is 0.000 over a few simulated seconds.
4. W/A/S/D and arrows each move the player (low distance = blocked by real
   geometry — verify from open space before calling it a bug).

## Troubleshooting (learned the hard way)

- **Keys "not working" / phantom drift in the wild:** vim-style browser
  extensions (Vimium!) steal single letters — tell the user to exclude
  `http://localhost*` in the extension or use arrow keys. Inside embedded app
  panes, single letters may be app shortcuts; use a real browser for demos.
- **Frozen world:** hidden tab ⇒ `requestAnimationFrame` paused. Normal; resumes when visible.
- **Player launched/ejected at spawn:** spawn is raycast-based now; if it recurs the mesh has a spike at center — raise the `+1.6` clearance in `main.js`.
- **Reconstruction fails / holes:** too few views, motion in scene, or reflective
  surfaces. Re-capture: slow overlapping loops, three heights, lock exposure,
  nothing moving. More frames (`N=2`) also helps.
- **The mesh is one fused blob by design.** Separating draggable objects is a
  different pipeline (per-object capture or image-to-3D generation + a physics
  engine) — see `real2sim-plan.md`.
