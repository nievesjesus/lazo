"""Descarga LFW (Labeled Faces in the Wild) y lo deja como data/lfw/<persona>/*.jpg para mnemo-eval.

Conjunto público de referencia de la sección 7.5 (calibración y comparación). NO reemplaza al conjunto
propio consentido: sirve para verificar que la implementación reproduce el comportamiento esperado.

Se conservan las personas con al menos --min-images fotos (5 para enrolar + sondas) y, para acotar
el tiempo de cómputo, hasta --max-images por persona.

    .venv/bin/python scripts/prepare_lfw.py
"""
import argparse
import shutil
import tarfile
import urllib.request
from pathlib import Path

URL = "https://ndownloader.figshare.com/files/5976018"  # lfw.tgz (espejo que usa scikit-learn)

ap = argparse.ArgumentParser()
ap.add_argument("--out", type=Path, default=Path("data/lfw"))
ap.add_argument("--min-images", type=int, default=6)
ap.add_argument("--max-images", type=int, default=10)
args = ap.parse_args()

cache = Path("data/.cache")
cache.mkdir(parents=True, exist_ok=True)
tgz = cache / "lfw.tgz"
if not tgz.exists():
    print("Descargando LFW (~180 MB)…")
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
print(f"{kept} identidades en {args.out}")
