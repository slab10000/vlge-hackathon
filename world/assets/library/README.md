# Asset library — drop files here

Copy any `.glb`, `.gltf` or `.ply` file into this folder and it appears in the
editor's **Assets** shelf. No code change, no registration step. Subfolders work
(3 levels deep) if you want to organize.

    world/assets/library/mug.glb
    world/assets/library/scans/lamp.ply

Then reload the page, or hit **Rescan** in the shelf.

You can also drag a file straight from Finder onto the 3D view — it is added for
that session only. Copy it in here to keep it.

## Scale

Files are assumed to be in **metres** (that is what `tools/make_object.py` emits).
Anything whose longest side is under 2 cm or over 3 m is clearly not metric, so it
gets auto-scaled to ~25 cm and the shelf card says `auto-scaled`. Fix it properly
in `manifest.json` (below), or just select it in the scene and scale with `S`.

## manifest.json (optional)

Discovery works by reading the dev server's directory index, which
`python3 -m http.server` provides. Add a `manifest.json` when you want to override
labels/scale, or when serving from something that hides directory listings:

```json
[
  "mug.glb",
  { "file": "scans/lamp.ply", "label": "Desk Lamp", "icon": "💡", "size": 0.32 },
  { "file": "bolt.glb", "scale": 0.001 }
]
```

- `label`, `icon` — how it shows up in the shelf
- `size` — normalize the longest side to this many metres
- `scale` — multiply source units by this to get metres (`0.001` for millimetres)

Regenerate the file list without hand-editing (keeps existing overrides):

```bash
python3 tools/scan_assets.py
```

## Notes

- `.ply` with faces loads as a mesh; without faces it loads as a point cloud
  (vertex colours honoured either way). Point clouds render and place, but physics
  needs a solid — they are skipped by the convex-hull step when you hit Simulate.
- Big textured scans are the slow part. `tools/optimize_glb.py` shrinks them.
