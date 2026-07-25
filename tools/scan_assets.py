"""Regenerate world/assets/library/manifest.json from whatever is in the folder.

    python3 tools/scan_assets.py [--dir world/assets/library] [--print]

The editor discovers library assets by reading the dev server's directory index,
so this script is OPTIONAL — you only need it when serving from something that
hides directory listings (nginx, GitHub Pages, `file://`, a bundler's dev server).

Existing entries are preserved verbatim, so hand-written overrides (label, icon,
size, scale) survive a rescan; files that disappeared are dropped.
"""
import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SUFFIXES = {".glb", ".gltf", ".ply"}


def label_for(rel: str) -> str:
    stem = Path(rel).stem.replace("_", " ").replace("-", " ").strip()
    return stem[:1].upper() + stem[1:] if stem else rel


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default="world/assets/library", help="library folder (default: %(default)s)")
    ap.add_argument("--print", action="store_true", dest="dry", help="print the manifest instead of writing it")
    args = ap.parse_args()

    root = (REPO / args.dir) if not Path(args.dir).is_absolute() else Path(args.dir)
    if not root.is_dir():
        print(f"no such folder: {root}", file=sys.stderr)
        return 1

    manifest = root / "manifest.json"
    previous = {}
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text())
            for raw in (data if isinstance(data, list) else data.get("assets", [])):
                entry = {"file": raw} if isinstance(raw, str) else raw
                if isinstance(entry, dict) and isinstance(entry.get("file"), str):
                    previous[entry["file"]] = entry
        except (json.JSONDecodeError, OSError) as err:
            print(f"ignoring unreadable manifest ({err})", file=sys.stderr)

    entries = []
    for path in sorted(p for p in root.rglob("*") if p.suffix.lower() in SUFFIXES):
        rel = path.relative_to(root).as_posix()
        entry = previous.get(rel, {"file": rel, "label": label_for(rel)})
        entry["file"] = rel
        entries.append(entry)

    text = json.dumps(entries, indent=2, ensure_ascii=False) + "\n"  # keep emoji readable
    if args.dry:
        print(text, end="")
    else:
        manifest.write_text(text)
        kept = sum(1 for e in entries if e["file"] in previous)
        print(f"{manifest.relative_to(REPO)}: {len(entries)} asset(s), {len(entries) - kept} new")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
