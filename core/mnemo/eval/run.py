"""Protocolo de evaluación (sección 7.5) sobre un conjunto en carpetas.

Estructura esperada:
    data/<identidad>/<toma>.jpg      (una carpeta por persona; nombres libres)

Partición POR IDENTIDAD en validación y prueba. En cada partición, N identidades se enrolan
(con ``--enroll-shots`` tomas cada una) y el resto actúan como impostores. El umbral se
deriva sobre validación para el FPIR objetivo y se congela antes de evaluar prueba.
Se barre N = 10, 25, 50 (acotado por la cantidad de identidades disponibles).
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np

from ..align import align
from ..config import Config
from ..detector import FaceDetector
from ..embedder import FaceEmbedder, template_from_shots
from ..preprocess import enhance
from . import metrics

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def embed_dataset(root: Path, cfg: Config) -> dict[str, list[np.ndarray]]:
    det = FaceDetector(cfg.det_model, cfg.det_size)
    emb = FaceEmbedder(cfg.rec_model)
    out: dict[str, list[np.ndarray]] = {}
    for person in sorted(p for p in root.iterdir() if p.is_dir()):
        vecs = []
        for f in sorted(person.iterdir()):
            if f.suffix.lower() not in IMG_EXT:
                continue
            img = cv2.imread(str(f))
            if img is None:
                continue
            img = enhance(img)
            faces = det.detect(img, max_faces=1)
            if faces:
                vecs.append(emb.embed(align(img, faces[0].kps))[0])
        if len(vecs) >= 2:
            out[person.name] = vecs
    return out


def build_searches(embs: dict[str, list[np.ndarray]], ids: list[str], n_enrolled: int, shots: int, rng: random.Random):
    enrolled = ids[:n_enrolled]
    impostors = ids[n_enrolled:]
    gal, gal_ids, probes, probe_ids = [], [], [], []
    for i in enrolled:
        vecs = embs[i][:]
        rng.shuffle(vecs)
        k = min(shots, len(vecs) - 1)
        gal.append(template_from_shots(np.stack(vecs[:k])))
        gal_ids.append(i)
        probes += vecs[k:]
        probe_ids += [i] * (len(vecs) - k)
    for i in impostors:
        probes += embs[i]
        probe_ids += [None] * len(embs[i])
    return metrics.search_all(np.stack(probes), probe_ids, np.stack(gal), gal_ids)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Evaluación FPIR/FNIR de MNEMO")
    ap.add_argument("data", type=Path)
    ap.add_argument("--target-fpir", type=float, default=0.01)
    ap.add_argument("--band", type=float, default=0.08, help="ancho de la banda de abstención (τ_alta − τ_baja)")
    ap.add_argument("--enroll-shots", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, default=Path("eval_report.json"))
    args = ap.parse_args(argv)

    cfg = Config()
    rng = random.Random(args.seed)
    embs = embed_dataset(args.data, cfg)
    ids = sorted(embs)
    rng.shuffle(ids)
    half = len(ids) // 2
    val_ids, test_ids = ids[:half], ids[half:]
    print(f"{len(ids)} identidades útiles → validación {len(val_ids)}, prueba {len(test_ids)}")

    results = {}
    for n in (10, 25, 50):
        n_val = min(n, len(val_ids) - 1)
        n_test = min(n, len(test_ids) - 1)
        if n_val < 1 or n_test < 1:
            continue
        val = build_searches(embs, val_ids, n_val, args.enroll_shots, rng)
        tau_high = metrics.threshold_at_fpir(val, args.target_fpir)   # congelado aquí
        tau_low = tau_high - args.band
        test = build_searches(embs, test_ids, n_test, args.enroll_shots, rng)
        rep = metrics.report(test, tau_low, tau_high)
        rep.update({"N_val": n_val, "N_test": n_test, "tau_high": tau_high, "tau_low": tau_low})
        taus, fp, fn = metrics.det_curve(test)
        rep["det"] = {"tau": taus.tolist(), "fpir": fp.tolist(), "fnir": fn.tolist()}
        results[f"N={n}"] = rep
        print(f"N={n:>2}  τ=({tau_low:.3f}, {tau_high:.3f})  " + "  ".join(
            f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}" for k, v in rep.items() if k != "det"))

    args.out.write_text(json.dumps(results, indent=2))
    print(f"Reporte en {args.out}")


if __name__ == "__main__":
    main()
