"""Figuras ilustrativas del informe (Módulos 2 y 4) a partir de los rostros sintéticos de docs/video/assets/faces.

    .venv/bin/python scripts/figuras_informe.py [salida=docs/informe/fig]

Genera preproceso.png (corrección de intensidad, CLAHE, bilateral y varianza del laplaciano),
alineacion.png (similitud de 5 puntos frente al recorte de la caja) y similitudes_demo.png (coseno contra la
plantilla de Marta y zonas de decisión). Los números que aparecen en las figuras quedan en figuras_informe.json.
"""
import json
import sys
import tempfile
from pathlib import Path

import cv2
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import FuncFormatter

from mnemo.align import ARCFACE_TEMPLATE, align, roll_degrees, similarity_transform
from mnemo.config import Config
from mnemo.embedder import template_from_shots
from mnemo.eval.run import box_crop
from mnemo.gallery import FileKeyProvider, Gallery
from mnemo.pipeline import Pipeline
from mnemo.preprocess import LAPLACIAN_KERNEL, enhance, gamma_correct, sharpness

ROOT = Path(__file__).resolve().parents[1]
FACES = ROOT / "docs" / "video" / "assets" / "faces"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "informe" / "fig"
CFG = Config()
TAU_LOW, TAU_HIGH = CFG.decision.tau_low, CFG.decision.tau_high
ENROLL_SHOTS = ["marta_frontal", "marta_sonrisa", "marta_giro_izq", "marta_giro_der", "marta_luz_baja"]
INK, MID, LIGHT = "#111111", "#777777", "#d9d9d9"

plt.rcParams.update({"font.size": 7.5, "axes.titlesize": 8, "axes.labelsize": 7.5, "figure.dpi": 200,
                     "savefig.dpi": 200, "axes.linewidth": 0.6})
nums: dict = {}


def load(name: str) -> np.ndarray:
    return cv2.imread(str(FACES / f"{name}.png"))


def rgb(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def es(v: float, d: int = 3) -> str:
    """Número con coma decimal, como en el texto del informe."""
    return f"{v:.{d}f}".replace(".", ",")


def comma_axis(axis) -> None:
    axis.set_major_formatter(FuncFormatter(lambda v, _: es(v, 1)))


def square_view(img: np.ndarray, bbox: np.ndarray, margin: float = 1.35, size: int = 224) -> np.ndarray:
    """Recorte cuadrado centrado en la caja (con margen), reescalado: sólo para mostrar."""
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    half = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * margin / 2
    h, w = img.shape[:2]
    x0 = int(np.clip(cx - half, 0, max(w - 2 * half, 0)))
    y0 = int(np.clip(cy - half, 0, max(h - 2 * half, 0)))
    side = int(2 * half)
    return cv2.resize(img[y0:y0 + side, x0:x0 + side], (size, size), interpolation=cv2.INTER_AREA)


def laplacian_abs(crop112: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop112, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return np.abs(cv2.filter2D(gray, -1, LAPLACIAN_KERNEL))


def strip(ax) -> None:
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)


# --------------------------------------------------------------------------- preproceso.png
def fig_preproceso(pipe: Pipeline) -> None:
    frame = load("marta_luz_baja")
    face, _ = pipe.best_face(enhance(frame))
    m = similarity_transform(face.kps)
    scale = float(np.hypot(m[0, 0], m[1, 0]))          # frame → recorte de 112×112
    sigma_crop = 3.0
    blurred = cv2.GaussianBlur(frame, (0, 0), sigma_crop / scale)  # σ = 3 px medidos en el recorte alineado
    nums["preproceso"] = {"escala_cuadro_a_recorte": scale, "sigma_desenfoque_px_recorte": sigma_crop,
                          "sigma_desenfoque_px_cuadro": sigma_crop / scale, "umbral_nitidez": CFG.quality.min_sharpness}

    names = ["Original", "Corrección gamma", "CLAHE sobre L*", "Filtro bilateral", "|∇²I| (laplaciano)"]
    fig, axes = plt.subplots(2, 5, figsize=(6.6, 3.55))
    lap_max = None
    for row, (label, img) in enumerate([("nítida", frame), (f"desenfocada\n(σ = {sigma_crop:g} px)", blurred)]):
        stages = [img, gamma_correct(img), enhance(img, bilateral=False), enhance(img)]
        f, _ = pipe.best_face(stages[-1])             # misma detección que usa el pipeline (cuadro ya mejorado)
        key = "nitida" if row == 0 else "desenfocada"
        nums["preproceso"][key] = {"var_laplaciano": {}}
        for col, st in enumerate(stages):
            crop = align(st, f.kps)
            v = sharpness(crop)
            nums["preproceso"][key]["var_laplaciano"][names[col]] = v
            ax = axes[row, col]
            ax.imshow(rgb(square_view(st, f.bbox)))
            strip(ax)
            ax.set_xlabel(f"Var(∇²I) = {es(v, 1)}", fontsize=7)
            if row == 0:
                ax.set_title(names[col])
        lap = laplacian_abs(align(stages[-1], f.kps))
        if lap_max is None:
            lap_max = float(np.percentile(lap, 99))     # misma escala de grises en las dos filas
        ax = axes[row, 4]
        ax.imshow(cv2.resize(np.clip(lap / lap_max, 0, 1), (224, 224), interpolation=cv2.INTER_NEAREST),
                  cmap="gray_r", vmin=0, vmax=1)
        strip(ax)
        v = nums["preproceso"][key]["var_laplaciano"][names[3]]
        ok = v >= CFG.quality.min_sharpness
        ax.set_xlabel(f"Var(∇²I) = {es(v, 1)}"
                      + (f" ≥ {CFG.quality.min_sharpness:g}\nse acepta" if ok
                         else f" < {CFG.quality.min_sharpness:g}\nrechazada por borrosa"), fontsize=7,
                      color=INK, fontweight="normal" if ok else "bold")
        nums["preproceso"][key]["rechazada_por_borrosa"] = (not ok)
        if row == 0:
            ax.set_title(names[4])
        axes[row, 0].set_ylabel(label, fontsize=7.5)
        axes[row, 0].yaxis.set_label_position("left")
    # las filas comparten escala de gris en la columna del laplaciano: se aclara al pie
    fig.text(0.5, 0.01, "Var(∇²I) medida sobre el recorte alineado de 112×112, como hace quality.assess.\n"
             f"Desenfoque gaussiano de σ = {sigma_crop:g} px en ese recorte (≈ {sigma_crop / scale:.0f} px en el cuadro).",
             ha="center", fontsize=6.5, color=MID)
    fig.subplots_adjust(left=0.07, right=0.995, top=0.93, bottom=0.15, wspace=0.06, hspace=0.42)
    fig.savefig(OUT / "preproceso.png")
    plt.close(fig)


# --------------------------------------------------------------------------- alineacion.png
def enrol_marta(pipe: Pipeline, shots: list[str]) -> np.ndarray:
    vecs = []
    for s in shots:
        v, q = pipe.enroll_shot(load(s), allow_profile=True)
        assert v is not None, f"toma {s} rechazada: {q.reason if q else 'sin rostro'}"
        vecs.append(v)
    return template_from_shots(np.stack(vecs))


def draw_points(ax, pts: np.ndarray, **kw) -> None:
    ax.plot(pts[:, 0], pts[:, 1], linestyle="none", **kw)


def fig_alineacion(pipe: Pipeline, tmpl: np.ndarray) -> None:
    frontal = load("marta_frontal")
    h, w = frontal.shape[:2]
    rot = cv2.getRotationMatrix2D((w / 2, h / 2), 15, 1.0)
    frame = cv2.warpAffine(frontal, rot, (w, h), borderValue=0)           # cuadro girado 15° en el plano
    img = enhance(frame)
    face, crop_al = pipe.best_face(img)
    crop_box = box_crop(img, face.bbox)
    emb = np.stack([pipe.embedder.embed(c)[0] for c in (crop_al, crop_box)])
    cos_al, cos_box = float(emb[0] @ tmpl), float(emb[1] @ tmpl)
    # Control honesto: el cuadro girado procede de una de las tomas de alta; se repite sin esa toma en la plantilla.
    tmpl_loo = enrol_marta(pipe, [s for s in ENROLL_SHOTS if s != "marta_frontal"])
    cos_al_loo, cos_box_loo = float(emb[0] @ tmpl_loo), float(emb[1] @ tmpl_loo)
    s = CFG.det_size
    nums["alineacion"] = {
        "giro_aplicado_grados": 15.0, "roll_estimado_grados": roll_degrees(face.kps), "score_deteccion": face.score,
        "coseno_alineado": cos_al, "coseno_sin_alinear": cos_box,
        "coseno_alineado_sin_toma_frontal": cos_al_loo, "coseno_sin_alinear_sin_toma_frontal": cos_box_loo,
    }

    fig, axes = plt.subplots(1, 3, figsize=(6.6, 2.55), gridspec_kw={"width_ratios": [1, 1, 1]})
    # (a) cuadro con caja y cinco puntos (vista recortada alrededor del rostro)
    side = max(face.width, face.height) * 1.9
    cx, cy = (face.bbox[0] + face.bbox[2]) / 2, (face.bbox[1] + face.bbox[3]) / 2
    x0, y0 = int(cx - side / 2), int(cy - side / 2)
    ax = axes[0]
    ax.imshow(rgb(frame))
    ax.set_xlim(x0, x0 + side)
    ax.set_ylim(y0 + side, y0)
    b = face.bbox
    ax.plot([b[0], b[2], b[2], b[0], b[0]], [b[1], b[1], b[3], b[3], b[1]], color="white", lw=2.4)
    ax.plot([b[0], b[2], b[2], b[0], b[0]], [b[1], b[1], b[3], b[3], b[1]], color=INK, lw=1.0)
    draw_points(ax, face.kps, marker="o", ms=4.2, mfc="white", mec=INK, mew=0.9)
    strip(ax)
    ax.set_title("(a) cuadro y detección")
    ax.set_xlabel(f"inclinación de los ojos: {es(abs(roll_degrees(face.kps)), 1)}°", fontsize=7)

    # (b) alineado con la plantilla canónica; (c) recorte de la caja con la misma plantilla
    m_box = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)
    side_box = max(face.width, face.height)
    sc = 112 / side_box
    m_box = np.array([[sc, 0, -(cx - side_box / 2) * sc], [0, sc, -(cy - side_box / 2) * sc]])
    m_al = similarity_transform(face.kps)
    for ax, crop, m, title, cos in [(axes[1], crop_al, m_al, "(b) alineado (similitud, 4 gdl)", cos_al),
                                    (axes[2], crop_box, m_box, "(c) sin alinear (caja cuadrada)", cos_box)]:
        ax.imshow(rgb(crop), extent=(-0.5, 111.5, 111.5, -0.5), interpolation="bicubic")
        kp = face.kps @ m[:, :2].T + m[:, 2]
        draw_points(ax, ARCFACE_TEMPLATE, marker="o", ms=6.5, mfc="none", mec="white", mew=1.8)
        draw_points(ax, ARCFACE_TEMPLATE, marker="o", ms=6.5, mfc="none", mec=INK, mew=0.7)
        draw_points(ax, kp, marker="x", ms=4.2, mec="white", mew=2.0)
        draw_points(ax, kp, marker="x", ms=4.2, mec=INK, mew=0.9)
        ax.set_xlim(-0.5, 111.5)
        ax.set_ylim(111.5, -0.5)
        strip(ax)
        ax.set_title(title)
        ax.set_xlabel(f"coseno con Marta = {es(cos)}", fontsize=7.5, fontweight="bold")
    axes[1].plot([], [], "o", mfc="none", mec=INK, ms=5, label="plantilla ArcFace")
    axes[1].plot([], [], "x", mec=INK, ms=4, label="puntos detectados")
    fig.legend(*axes[1].get_legend_handles_labels(), loc="lower center", ncol=2, fontsize=6.5, frameon=False,
               bbox_to_anchor=(0.5, -0.01))
    fig.subplots_adjust(left=0.01, right=0.99, top=0.9, bottom=0.2, wspace=0.08)
    fig.savefig(OUT / "alineacion.png")
    plt.close(fig)


# --------------------------------------------------------------------------- similitudes_demo.png
def fig_similitudes(pipe: Pipeline, tmpl: np.ndarray) -> None:
    items = [(n, True) for n in ENROLL_SHOTS] + [(n, False) for n in ("marta_barbijo", "marta_gorro_barbijo", "tomas_frontal", "desconocido_frontal")]
    label = {"marta_frontal": "Marta · frontal", "marta_sonrisa": "Marta · sonrisa", "marta_giro_izq": "Marta · giro a la izq.",
             "marta_giro_der": "Marta · giro a la der.", "marta_luz_baja": "Marta · luz baja", "marta_barbijo": "Marta · con barbijo", "marta_gorro_barbijo": "Marta · barbijo, anteojos y gorro",
             "tomas_frontal": "Tomás (otra persona)", "desconocido_frontal": "Desconocido"}
    rows = []
    for name, enrolled in items:
        face, crop = pipe.best_face(enhance(load(name)))
        rows.append((name, enrolled, float(pipe.embedder.embed(crop)[0] @ tmpl)))
    rows.sort(key=lambda r: r[2])
    nums["similitudes"] = {n: {"coseno": s, "toma_de_alta": e,
                               "zona": "afirmar" if s >= TAU_HIGH else "abstenerse" if s >= TAU_LOW else "descartar"}
                           for n, e, s in rows}

    lo = min(-0.05, min(r[2] for r in rows) - 0.05)
    fig, ax = plt.subplots(figsize=(6.0, 3.4))
    ax.axvspan(lo, TAU_LOW, color="#f0f0f0", lw=0)
    ax.axvspan(TAU_LOW, TAU_HIGH, color=LIGHT, lw=0)
    ax.axvline(TAU_LOW, color=INK, lw=0.8, ls="--")
    ax.axvline(TAU_HIGH, color=INK, lw=0.8, ls="--")
    ys = np.arange(len(rows))
    for y, (name, enrolled, s) in zip(ys, rows):
        ax.barh(y, s, height=0.62, color="#555555" if enrolled else ("#9a9a9a" if name.startswith("marta") else "#ffffff"),
                edgecolor=INK, lw=0.6, hatch="////" if enrolled else None)
        ax.text(s + 0.012, y, es(s), va="center", fontsize=7, bbox=dict(fc="white", ec="none", pad=0.6, alpha=0.85))
    ax.set_yticks(ys)
    ax.set_yticklabels([label[r[0]] for r in rows])
    ax.set_ylim(-0.7, len(rows) + 0.05)
    ax.set_xlim(lo, 1.0)
    tr = ax.get_xaxis_transform()
    for x, txt, w in [((lo + TAU_LOW) / 2, "descartar", "normal"), ((TAU_LOW + TAU_HIGH) / 2, "abstenerse", "bold"),
                      ((TAU_HIGH + 1.0) / 2, "afirmar (con confirmación 3 de 4)", "normal")]:
        ax.text(x, 1.085, txt, transform=tr, ha="center", fontsize=7.5, fontweight=w)
    ax.text(TAU_LOW - 0.006, 1.015, f"τ_baja = {es(TAU_LOW, 2)}", transform=tr, ha="right", fontsize=7)
    ax.text(TAU_HIGH + 0.006, 1.015, f"τ_alta = {es(TAU_HIGH, 2)}", transform=tr, ha="left", fontsize=7)
    comma_axis(ax.xaxis)
    ax.set_xlabel("similitud coseno con la plantilla de Marta")
    ax.grid(axis="x", alpha=0.2)
    ax.set_axisbelow(True)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    ax.barh([], [], color="#555555", edgecolor=INK, hatch="////", label="toma usada en el alta")
    ax.legend(handles=[plt.Rectangle((0, 0), 1, 1, fc="#555555", ec=INK, hatch="////", label="toma usada en el alta"),
                       plt.Rectangle((0, 0), 1, 1, fc="#9a9a9a", ec=INK, label="Marta, toma no usada en el alta"),
                       plt.Rectangle((0, 0), 1, 1, fc="white", ec=INK, label="otra persona")],
              fontsize=6.5, loc="lower right", frameon=False, bbox_to_anchor=(1.0, 0.0))
    fig.text(0.01, 0.01, "Las tomas usadas en el alta están dentro de la plantilla: su similitud es «en muestra» y sólo ilustra la escala.",
             fontsize=6.3, color=MID, ha="left", va="bottom")
    fig.tight_layout(rect=(0, 0.035, 1, 1))
    fig.savefig(OUT / "similitudes_demo.png")
    plt.close(fig)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    pipe = Pipeline(CFG, Gallery(tmp / "g.db", FileKeyProvider(tmp / "k")))
    tmpl = enrol_marta(pipe, ENROLL_SHOTS)
    fig_preproceso(pipe)
    fig_alineacion(pipe, tmpl)
    fig_similitudes(pipe, tmpl)
    (OUT / "figuras_informe.json").write_text(json.dumps(nums, indent=2, ensure_ascii=False))
    print(json.dumps(nums, indent=1, ensure_ascii=False))
    print(f"Figuras en {OUT}")


if __name__ == "__main__":
    main()
