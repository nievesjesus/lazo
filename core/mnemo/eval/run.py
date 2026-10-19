"""Evaluation protocol over a dataset laid out in folders.

Expected layout:
    data/<identity>/<shot>.jpg      (one folder per person; free file names)

Split BY IDENTITY into validation and test. In each split, N identities are enrolled
(with ``--enroll-shots`` shots each) and the rest act as impostors. The threshold is
derived on validation for the target FPIR and frozen before evaluating on test.
N = 10, 25, 50 are swept (bounded by the number of available identities).
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np

from ..align import CROP_SIZE, align
from ..config import Config
from ..detector import FaceDetector
from ..embedder import FaceEmbedder, template_from_shots
from ..preprocess import enhance
from . import metrics

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def box_crop(img: np.ndarray, bbox: np.ndarray) -> np.ndarray:
    """Ablation baseline (``--no-align``): square crop of the detected box, at 112×112.

    It is a similarity without rotation (scale + translation) using the same ``warpAffine``
    as ``align``, so the only change is that the five landmarks are no longer used.
    """
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    side = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    s = CROP_SIZE / side
    m = np.array([[s, 0, -(cx - side / 2) * s], [0, s, -(cy - side / 2) * s]], dtype=np.float32)
    return cv2.warpAffine(img, m, (CROP_SIZE, CROP_SIZE), borderValue=0.0)


def embed_dataset(
    root: Path, cfg: Config, use_align: bool = True, use_enhance: bool = True, stats: dict | None = None
) -> dict[str, list[np.ndarray]]:
    det = FaceDetector(cfg.det_model, cfg.det_size)
    emb = FaceEmbedder(cfg.rec_model)
    out: dict[str, list[np.ndarray]] = {}
    n_img = n_sin_rostro = n_descartadas = 0
    for person in sorted(p for p in root.iterdir() if p.is_dir()):
        vecs = []
        for f in sorted(person.iterdir()):
            if f.suffix.lower() not in IMG_EXT:
                continue
            img = cv2.imread(str(f))
            if img is None:
                continue
            n_img += 1
            if use_enhance:
                img = enhance(img)
            faces = det.detect(img, max_faces=1)
            if faces:
                crop = align(img, faces[0].kps) if use_align else box_crop(img, faces[0].bbox)
                vecs.append(emb.embed(crop)[0])
            else:
                n_sin_rostro += 1
        if len(vecs) >= 2:
            out[person.name] = vecs
        else:
            n_descartadas += 1
    if stats is not None:
        stats.update(imagenes=n_img, sin_rostro=n_sin_rostro, personas_descartadas=n_descartadas)
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
    ap = argparse.ArgumentParser(description="MNEMO FPIR/FNIR evaluation")
    ap.add_argument("data", type=Path)
    ap.add_argument("--target-fpir", type=float, default=0.01)
    ap.add_argument("--band", type=float, default=0.08, help="width of the abstention band (τ_high − τ_low)")
    ap.add_argument("--enroll-shots", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, default=Path("eval_report.json"))
    ap.add_argument("--no-align", action="store_true",
                    help="ablation: square crop of the detected box instead of the 5-point similarity")
    ap.add_argument("--no-enhance", action="store_true", help="ablation: skip gamma/CLAHE/bilateral before detecting")
    ap.add_argument("--dump-scores", action="store_true",
                    help="store the test s_max values in the report (impostors, correct genuines and identity errors)")
    args = ap.parse_args(argv)

    cfg = Config()
    rng = random.Random(args.seed)
    stats: dict = {}
    embs = embed_dataset(args.data, cfg, use_align=not args.no_align, use_enhance=not args.no_enhance, stats=stats)
    ids = sorted(embs)
    rng.shuffle(ids)
    half = len(ids) // 2
    val_ids, test_ids = ids[:half], ids[half:]
    # scripts/ablacion.py reads the first three integers of these two lines by position: keep their order.
    print(f"{len(ids)} usable identities → validation {len(val_ids)}, test {len(test_ids)}")
    print(f"{stats['sin_rostro']} of {stats['imagenes']} images with no face detected; "
          f"{stats['personas_descartadas']} people with fewer than 2 usable")

    results = {}
    for n in (10, 25, 50):
        n_val = min(n, len(val_ids) - 1)
        n_test = min(n, len(test_ids) - 1)
        if n_val < 1 or n_test < 1:
            continue
        val = build_searches(embs, val_ids, n_val, args.enroll_shots, rng)
        tau_high = metrics.threshold_at_fpir(val, args.target_fpir)   # frozen here
        tau_low = tau_high - args.band
        test = build_searches(embs, test_ids, n_test, args.enroll_shots, rng)
        rep = metrics.report(test, tau_low, tau_high)
        rep.update({"N_val": n_val, "N_test": n_test, "tau_high": tau_high, "tau_low": tau_low})
        taus, fp, fn = metrics.det_curve(test)
        rep["det"] = {"tau": taus.tolist(), "fpir": fp.tolist(), "fnir": fn.tolist()}
        if args.dump_scores:
            gen_ok = test.genuine & (test.top_id == test.true_id)
            gen_err = test.genuine & ~gen_ok
            rep["scores"] = {
                "impostoras": np.round(test.s_max[~test.genuine], 5).tolist(),
                "genuinas_rango1": np.round(test.s_max[gen_ok], 5).tolist(),
                "errores_identidad": np.round(test.s_max[gen_err], 5).tolist(),
            }
        results[f"N={n}"] = rep
        print(f"N={n:>2}  τ=({tau_low:.3f}, {tau_high:.3f})  " + "  ".join(
            f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}" for k, v in rep.items() if k not in ("det", "scores")))

    args.out.write_text(json.dumps(results, indent=2))
    print(f"Report written to {args.out}")


if __name__ == "__main__":
    main()
