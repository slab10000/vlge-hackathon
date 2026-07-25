"""Make a heavy photogrammetry bake web-viable.

blender --background --python tools/optimize_glb.py -- <in.glb> <out.glb> [max_texture] [target_tris]

With Apple's PhotogrammetrySession the file size is dominated by TEXTURES, not
geometry (a `full` bake is ~100k tris but ships 8192x8192 colour + normal +
roughness maps = ~120 MB). Halving texture edge length quarters that cost, so
`max_texture` is the lever that matters; `target_tris` is a safety net.
"""
import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
max_texture = int(argv[2]) if len(argv) > 2 else 4096
target_tris = int(argv[3]) if len(argv) > 3 else 0  # 0 = keep geometry as-is
# Draco saves ~2 MB on a 100k-tri bake but requires a DRACOLoader + WASM decoder
# in the viewer; three.js GLTFLoader alone silently fails on it. Opt in only.
use_draco = "--draco" in argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

total = 0
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    total += tris
    if target_tris and tris > target_tris:
        mod = obj.modifiers.new(name="decimate", type="DECIMATE")
        mod.ratio = target_tris / tris
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        print(f"decimated {obj.name}: {tris} -> ~{target_tris} tris")
print(f"triangles: {total}")

for img in bpy.data.images:
    w, h = img.size
    if w > max_texture or h > max_texture:
        scale = max_texture / max(w, h)
        img.scale(int(w * scale), int(h * scale))
        print(f"resized {img.name}: {w}x{h} -> {img.size[0]}x{img.size[1]}")

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format="GLB",
    export_apply=True,
    export_image_format="JPEG",          # photogrammetry textures are photos; JPEG >> PNG here
    export_jpeg_quality=85,
    export_draco_mesh_compression_enable=use_draco,
    export_draco_mesh_compression_level=6,
)
print("exported", dst)
