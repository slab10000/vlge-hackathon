import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=src)

print("imported objects:", [o.name for o in bpy.data.objects])

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True)
print("exported", dst)
