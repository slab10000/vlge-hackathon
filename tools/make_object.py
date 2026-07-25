"""Turn a captured object mesh into a simulation-ready asset.

    python3 tools/make_object.py <in.glb|in.usdz|in.obj> <name> --height 0.22 [options]

Takes the raw mesh from an object capture (Apple Object Capture / photogrammetry /
image-to-3D) and emits everything a simulator needs:

    world/assets/objects/<name>.glb          visual mesh, metric, Y-up  (browser world)
    sim/objects/<name>/visual.obj            visual mesh, metric, Z-up  (MuJoCo)
    sim/objects/<name>/collision_XX.obj      convex hulls from CoACD    (MuJoCo)
    sim/objects/<name>/<name>.xml            MJCF include with body/geoms
    sim/objects/<name>/<name>.json           manifest (dims, mass, hull count)

Why measure instead of predict: single-image generators (and RoboSnap's SAM 3D
Objects stage) output arbitrary scale, and RoboSnap never corrects it — scale is
inherited from the predictor. One ruler measurement makes the twin metrically
correct, which is what decides whether a policy trained in sim transfers.

Options:
  --height / --width / --depth  M   real-world size along one axis (pick the one
                                    you can measure most accurately). Required.
  --mass KG                         measured mass; else derived from --density
  --density KG_M3                   default 400 (light plastic); water bottle ~1000
  --hulls N                         max convex hulls (default 24)
  --friction F                      sliding friction (default 0.8)
  --no-collision                    skip CoACD (visual only)
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import trimesh

REPO = Path(__file__).resolve().parent.parent


def load_mesh(src: Path) -> trimesh.Trimesh:
    if src.suffix.lower() == ".usdz":
        # trimesh can't read USDZ; bounce through Blender to GLB first
        tmp = src.with_suffix(".fromusdz.glb")
        script = REPO / "tools" / "usdz2glb.py"
        subprocess.run(
            ["/Applications/Blender.app/Contents/MacOS/Blender", "--background",
             "--python", str(script), "--", str(src), str(tmp)],
            check=True, capture_output=True,
        )
        src = tmp
    scene_or_mesh = trimesh.load(src, force="scene")
    mesh = scene_or_mesh.to_mesh() if hasattr(scene_or_mesh, "to_mesh") else scene_or_mesh
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate([g for g in mesh.geometry.values()])
    return mesh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("name")
    ap.add_argument("--height", type=float, help="real size along the tallest axis, meters")
    ap.add_argument("--width", type=float, help="real size along X, meters")
    ap.add_argument("--depth", type=float, help="real size along Z, meters")
    ap.add_argument("--mass", type=float, help="measured mass in kg")
    ap.add_argument("--density", type=float, default=400.0, help="kg/m^3 if mass unknown")
    ap.add_argument("--hulls", type=int, default=24)
    ap.add_argument("--friction", type=float, default=0.8)
    ap.add_argument("--no-collision", action="store_true")
    args = ap.parse_args()

    if not (args.height or args.width or args.depth):
        sys.exit("error: give at least one real-world dimension (--height/--width/--depth)")

    src = Path(args.input).expanduser().resolve()
    mesh = load_mesh(src)
    mesh.remove_unreferenced_vertices()
    mesh.merge_vertices()
    print(f"loaded {src.name}: {len(mesh.faces)} faces, raw extents {mesh.extents}")

    # ---- metric scale from one measured dimension -------------------------
    extents = mesh.extents  # X, Y, Z of the axis-aligned bounding box
    if args.height:
        axis, target = int(np.argmax(extents)), args.height
        label = "tallest axis"
    elif args.width:
        axis, target, label = 0, args.width, "X"
    else:
        axis, target, label = 2, args.depth, "Z"
    scale = target / extents[axis]
    mesh.apply_scale(scale)
    print(f"scaled by {scale:.4f} so {label} = {target} m -> extents {np.round(mesh.extents, 4)}")

    # ---- origin: centered in XZ, base at Y=0 (Y-up, as captured) ----------
    bounds = mesh.bounds
    mesh.apply_translation([
        -(bounds[0][0] + bounds[1][0]) / 2,
        -bounds[0][1],
        -(bounds[0][2] + bounds[1][2]) / 2,
    ])

    mass = args.mass if args.mass else max(mesh.volume, 1e-6) * args.density
    print(f"volume {mesh.volume * 1000:.2f} L -> mass {mass:.3f} kg"
          f"{' (measured)' if args.mass else f' (density {args.density})'}")

    # ---- visual asset for the browser world (Y-up GLB) --------------------
    web_dir = REPO / "world" / "assets" / "objects"
    web_dir.mkdir(parents=True, exist_ok=True)
    web_path = web_dir / f"{args.name}.glb"
    mesh.export(web_path)
    print(f"wrote {web_path.relative_to(REPO)} ({web_path.stat().st_size / 1e6:.2f} MB)")

    # ---- MuJoCo assets (Z-up) ---------------------------------------------
    sim_dir = REPO / "sim" / "objects" / args.name
    if sim_dir.exists():
        shutil.rmtree(sim_dir)
    sim_dir.mkdir(parents=True, exist_ok=True)

    zup = mesh.copy()
    zup.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    zup.export(sim_dir / "visual.obj")

    hull_files = []
    if not args.no_collision:
        import coacd
        coacd.set_log_level("error")
        parts = coacd.run_coacd(
            coacd.Mesh(zup.vertices, zup.faces),
            max_convex_hull=args.hulls,
            preprocess_mode="auto",
        )
        for i, (verts, faces) in enumerate(parts):
            hull = trimesh.Trimesh(vertices=verts, faces=faces)
            name = f"collision_{i:02d}.obj"
            hull.export(sim_dir / name)
            hull_files.append(name)
        print(f"CoACD: {len(hull_files)} convex hulls")

    # ---- MJCF include ------------------------------------------------------
    asset_lines = [f'    <mesh name="{args.name}_visual" file="visual.obj"/>']
    geom_lines = [
        f'      <geom type="mesh" mesh="{args.name}_visual" class="visual"/>'
    ]
    for i, hf in enumerate(hull_files):
        asset_lines.append(f'    <mesh name="{args.name}_c{i}" file="{hf}"/>')
        geom_lines.append(
            f'      <geom type="mesh" mesh="{args.name}_c{i}" class="collision" '
            f'friction="{args.friction} 0.01 0.001"/>'
        )
    if not hull_files:
        geom_lines.append('      <geom type="box" size="0.03 0.03 0.03" class="collision"/>')

    mjcf = f"""<mujoco model="{args.name}">
  <!-- generated by tools/make_object.py from {src.name} -->
  <default>
    <default class="visual">
      <geom group="2" contype="0" conaffinity="0" density="0"/>
    </default>
    <default class="collision">
      <geom group="3" condim="4" solref="0.004 1"/>
    </default>
  </default>

  <asset>
{chr(10).join(asset_lines)}
  </asset>

  <worldbody>
    <body name="{args.name}" pos="0 0 0.1">
      <freejoint/>
      <inertial pos="0 0 {zup.center_mass[2]:.4f}" mass="{mass:.4f}"
                diaginertia="{' '.join(f'{v * mass / max(zup.volume, 1e-9):.6f}' for v in zup.moment_inertia.diagonal())}"/>
{chr(10).join(geom_lines)}
    </body>
  </worldbody>
</mujoco>
"""
    (sim_dir / f"{args.name}.xml").write_text(mjcf)

    inertia = [float(v * mass / max(zup.volume, 1e-9)) for v in zup.moment_inertia.diagonal()]
    manifest = {
        "name": args.name,
        "source": str(src),
        "scale_applied": float(scale),
        "extents_m": [float(v) for v in mesh.extents],
        "mass_kg": float(mass),
        "com_z_m": float(zup.center_mass[2]),
        "diaginertia": inertia,
        "mass_source": "measured" if args.mass else f"density {args.density}",
        "volume_l": float(mesh.volume * 1000),
        "convex_hulls": len(hull_files),
        "friction": args.friction,
        "web_asset": str(web_path.relative_to(REPO)),
        "mjcf": str((sim_dir / f"{args.name}.xml").relative_to(REPO)),
    }
    (sim_dir / f"{args.name}.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {(sim_dir / f'{args.name}.xml').relative_to(REPO)} + manifest")
    print("\nnext: add the name to PROP_DEFS in world/main.js to see it in the browser world")


if __name__ == "__main__":
    main()
