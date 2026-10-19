"""Downloads LFW (Labeled Faces in the Wild) and leaves it as data/lfw/<person>/*.jpg for mnemo-eval.

Public reference dataset from section 7.5 of the report (calibration and comparison). It does NOT replace the
project's own consented dataset: it is used to check that the implementation reproduces the expected behaviour.

People with at least --min-images photos are kept (5 to enroll + probes) and, to bound the compute
time, up to --max-images per person.

    .venv/bin/python scripts/prepare_lfw.py
"""
import argparse
import shutil
import tarfile
import urllib.request
from pathlib import Path

URL = "https://ndownloader.figshare.com/files/5976018"  # lfw.tgz (the mirror scikit-learn uses)

ap = argparse.ArgumentParser()
ap.add_argument("--out", type=Path, default=Path("data/lfw"))
ap.add_argument("--min-images", type=int, default=6)
ap.add_argument("--max-images", type=int, default=10)
args = ap.parse_args()

cache = Path("data/.cache")
cache.mkdir(parents=True, exist_ok=True)
tgz = cache / "lfw.tgz"
if not tgz.exists():
    print("Downloading LFW (~180 MB)…")
    urllib.request.urlretrieve(URL, tgz)
raw = cache / "lfw"
if not raw.exists():
    with tarfile.open(tgz) as t:
        t.extractall(cache)

args.out.mkdir(parents=True, exist_ok=True)
kept = 0
for person in sorted(p for p in raw.iterdir() if p.is_dir()):
    imgs = sorted(person.glob("*.jpg"))
    if len(imgs) < args.min_images:
        continue
    dst = args.out / person.name
    dst.mkdir(exist_ok=True)
    for f in imgs[: args.max_images]:
        shutil.copy2(f, dst / f.name)
    kept += 1
print(f"{kept} identities in {args.out}")
