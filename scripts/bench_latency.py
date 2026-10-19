"""Per-stage latency of Pipeline.process on CPU (core) and cost of the 1:N search by gallery size.

The frames are 1280×720 and are built from the synthetic faces in assets/faces, with a slight scale and
translation jitter so that they are not identical. The gallery has 50 identities: Marta (5 shots) and 49 LFW
templates. The first frames are discarded (warm-up of onnxruntime and of the anchor caches).

    .venv/bin/python scripts/bench_latency.py [--frames 300] [--out docs/eval/latencia_core.json]
"""
import argparse
import json
import os
import platform
import random
import subprocess
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from mnemo.align import align
from mnemo.config import Config
from mnemo.embedder import EMBEDDING_DIM, l2_normalize, template_from_shots
from mnemo.gallery import Consent, FileKeyProvider, Gallery
from mnemo.pipeline import Pipeline
from mnemo.preprocess import enhance
from mnemo.quality import assess

ROOT = Path(__file__).resolve().parents[1]
FACES = ROOT / "assets" / "faces"
MARTA_SHOTS = ["marta_frontal", "marta_sonrisa", "marta_giro_izq", "marta_giro_der", "marta_luz_baja"]
SCENES = MARTA_SHOTS + ["marta_barbijo", "tomas_frontal", "desconocido_frontal"]
FACE_CENTER = (625.0, 400.0)       # approximate center of the face in the 1200×896 images
W, H = 1280, 720
STAGES = ["preproceso", "deteccion+alineacion", "embedding", "busqueda", "decision"]


def stats(xs) -> dict:
    a = np.asarray(xs, dtype=np.float64)
    return {"n": int(a.size), "p50": float(np.percentile(a, 50)), "p95": float(np.percentile(a, 95)),
            "media": float(a.mean()), "min": float(a.min()), "max": float(a.max())}


def make_frame(scene: np.ndarray, rng: random.Random) -> np.ndarray:
    """1280×720 frame with the face centered ±60 px and scale 1.07–1.25 (always covers the whole frame)."""
    s = (W / scene.shape[1]) * (1 + rng.uniform(0.0, 0.17))
    tx = np.clip(W / 2 - FACE_CENTER[0] * s + rng.uniform(-60, 60), W - scene.shape[1] * s, 0)
    ty = np.clip(H / 2 - FACE_CENTER[1] * s + rng.uniform(-60, 60), H - scene.shape[0] * s, 0)
    m = np.array([[s, 0, tx], [0, s, ty]], dtype=np.float32)
    return cv2.warpAffine(scene, m, (W, H), flags=cv2.INTER_LINEAR)


def embed_image(pipe: Pipeline, path: Path) -> np.ndarray | None:
    img = cv2.imread(str(path))
    if img is None:
        return None
    face, crop = pipe.best_face(enhance(img))
    return None if face is None else pipe.embedder.embed(crop)[0]


def build_gallery(pipe: Pipeline, lfw: Path, tmp: Path, n_lfw: int, rng: random.Random) -> Gallery:
    gal = Gallery(tmp / "bench.db", FileKeyProvider(tmp / "key"), max_size=n_lfw + 1)
    marta = [embed_image(pipe, FACES / f"{s}.png") for s in MARTA_SHOTS]
    gal.enroll("Marta", "tu hija", template_from_shots(np.stack(marta)), Consent(), valid_shots=len(marta))
    people = sorted(p for p in lfw.iterdir() if p.is_dir())
    rng.shuffle(people)
    added = 0
    for person in people:
        vecs = [v for f in sorted(person.glob("*.jpg"))[:5] if (v := embed_image(pipe, f)) is not None]
        if len(vecs) < 3:
            continue
        gal.enroll(person.name, "vecino", template_from_shots(np.stack(vecs)), Consent(), valid_shots=len(vecs))
        added += 1
        if added == n_lfw:
            break
    assert len(gal.active()) == n_lfw + 1, f"the gallery ended up with {len(gal.active())} identities"
    return gal


def bench_process(pipe: Pipeline, n_frames: int, warmup: int, rng: random.Random) -> dict:
    scenes = [cv2.imread(str(FACES / f"{n}.png")) for n in SCENES]
    per_stage: dict[str, list[float]] = {k: [] for k in STAGES}
    totals, reached, seen = [], 0, {n: [] for n in SCENES}
    for i in range(n_frames + warmup):
        frame = make_frame(scenes[i % len(scenes)], rng)
        t0 = time.perf_counter()
        res = pipe.process(frame, t_ms=i * 100.0)
        total = (time.perf_counter() - t0) * 1000
        if i < warmup:
            continue
        for k, v in res.timings_ms.items():
            per_stage[k].append(v)
        totals.append(total)
        reached += "embedding" in res.timings_ms
        if "embedding" in res.timings_ms:
            seen[SCENES[i % len(SCENES)]].append((res.s_max, res.candidate.name if res.candidate else None))
    # Control: Marta's frames must give a high s_max with Marta as the candidate; the others, a low one.
    control = {n: {"cuadros": len(v), "s_max_media": float(np.mean([s for s, _ in v])) if v else None,
                   "candidata_marta": float(np.mean([c == "Marta" for _, c in v])) if v else None}
               for n, v in seen.items()}
    return {
        "cuadros_medidos": n_frames, "cuadros_descartados_warmup": warmup, "cuadros_con_embedding": reached,
        "etapas_ms": {k: stats(v) for k, v in per_stage.items() if v}, "total_ms": stats(totals),
        "control_por_escena": control,
    }


def bench_micro(pipe: Pipeline, reps: int = 300) -> dict:
    """Costs that Pipeline.process does not report separately: the alignment warpAffine and the quality assessment."""
    img = enhance(cv2.imread(str(FACES / "marta_frontal.png")))
    face, crop = pipe.best_face(img)
    out = {}
    for name, fn in {"alineacion_warpAffine": lambda: align(img, face.kps),
                     "calidad_assess": lambda: assess(face, crop, pipe.cfg.quality),
                     "embedding_un_recorte": lambda: pipe.embedder.embed(crop)}.items():
        for _ in range(20):
            fn()
        xs = []
        for _ in range(reps):
            t0 = time.perf_counter()
            fn()
            xs.append((time.perf_counter() - t0) * 1000)
        out[name] = stats(xs)
    return out


def bench_search(sizes: list[int], rng: np.random.Generator) -> dict:
    """Exhaustive search vs N with random normalized templates.

    - ``gallery_search``: Gallery.search as is (rebuilds the template matrix on every query).
    - ``matriz_prearmada``: matrix product + argsort over an already-built matrix (what it would cost with a cache).
    - ``solo_matmul``: just ``mat @ q``.
    """
    out = {}
    with tempfile.TemporaryDirectory() as d:
        for n in sizes:
            mat = l2_normalize(rng.standard_normal((n, EMBEDDING_DIM)).astype(np.float32))
            gal = Gallery(":memory:", FileKeyProvider(Path(d) / "key"), max_size=n)
            for k in range(n):
                gal.enroll(f"id{k}", "vecino", mat[k], Consent(), valid_shots=5)
            q = l2_normalize(rng.standard_normal(EMBEDDING_DIM).astype(np.float32))
            reps = 2000 if n <= 500 else 300
            fns = {"gallery_search": lambda: gal.search(q),
                   "matriz_prearmada": lambda: np.argsort(mat @ q)[::-1][:2],
                   "solo_matmul": lambda: mat @ q}
            row = {}
            for name, fn in fns.items():
                for _ in range(20):
                    fn()
                xs = []
                for _ in range(reps):
                    t0 = time.perf_counter()
                    fn()
                    xs.append((time.perf_counter() - t0) * 1000)
                row[name] = stats(xs)
            out[str(n)] = row
    return out


def sysctl(key: str) -> str:
    try:
        return subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description="Latency of the reference pipeline (CPU)")
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--lfw", type=Path, default=ROOT / "data" / "lfw")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "eval" / "latencia_core.json")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    cfg = Config()
    env = {"cpu": sysctl("machdep.cpu.brand_string"), "nucleos_logicos": os.cpu_count(), "sistema": platform.platform(),
           "python": platform.python_version(), "onnxruntime": ort.__version__, "opencv": cv2.__version__,
           "numpy": np.__version__, "proveedor": "CPUExecutionProvider", "carga_inicial": os.getloadavg()}
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        pipe = Pipeline(cfg, Gallery(tmp / "vacia.db", FileKeyProvider(tmp / "k0")))
        gal = build_gallery(pipe, args.lfw, tmp, n_lfw=49, rng=rng)
        pipe.gallery = gal
        env["galeria"] = len(gal.active())
        print(f"{env['cpu']} · onnxruntime {env['onnxruntime']} · gallery of {env['galeria']}")
        proc = bench_process(pipe, args.frames, args.warmup, rng)
        micro = bench_micro(pipe)
        env["carga_final"] = os.getloadavg()
        gal.db.close()
    search = bench_search([10, 25, 50, 500, 5000], np.random.default_rng(args.seed))

    rep = {"entorno": env, "cuadro": f"{W}×{H}", "pipeline": proc, "micro": micro, "busqueda_vs_N": search}
    args.out.write_text(json.dumps(rep, indent=2, ensure_ascii=False))

    print(f"\nPipeline.process · {proc['cuadros_medidos']} frames {W}×{H} (ms)")
    print(f"{'stage':<24}{'p50':>9}{'p95':>9}{'media':>9}")
    for k, v in {**proc["etapas_ms"], "TOTAL": proc["total_ms"]}.items():
        print(f"{k:<24}{v['p50']:>9.3f}{v['p95']:>9.3f}{v['media']:>9.3f}")
    print("\nMicro (ms):", {k: round(v["p50"], 4) for k, v in micro.items()})
    print("\nSearch vs N, p50 / p95 (ms)")
    print(f"{'N':>6}" + "".join(f"{k:>30}" for k in ("gallery_search", "matriz_prearmada", "solo_matmul")))
    for n, row in search.items():
        print(f"{n:>6}" + "".join(f"{row[k]['p50']:>16.4f} /{row[k]['p95']:>9.4f}" for k in row))
    print(f"\nReport in {args.out}")


if __name__ == "__main__":
    main()
