"""Ablación de las etapas del pipeline sobre LFW (preprocesamiento y alineación) y sensibilidad al ancho de la banda.

Corre ``mnemo-eval`` (mismo protocolo y misma semilla) para cuatro configuraciones — completa, sin alineación
(``--no-align``), sin preprocesamiento (``--no-enhance``) y sin ambas — derivando τ en validación para el FPIR
objetivo y midiendo en prueba. Después repite la configuración completa con ``--band`` 0,04 / 0,08 / 0,12.

    .venv/bin/python scripts/ablacion.py [data/lfw]

Salidas: docs/eval/ablacion_lfw.json, docs/eval/ablacion_lfw.md y docs/eval/ablacion_lfw.png.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "lfw"
OUT = ROOT / "docs" / "eval"
TARGET_FPIR = 0.01
CONFIGS = [  # nombre, flags de mnemo-eval
    ("completa", []),
    ("sin alineación", ["--no-align"]),
    ("sin preprocesamiento", ["--no-enhance"]),
    ("sin ambas", ["--no-align", "--no-enhance"]),
]
BANDS = (0.04, 0.08, 0.12)
NS = ("N=10", "N=25", "N=50")


def run_eval(flags: list[str], tag: str) -> dict:
    """Ejecuta mnemo-eval y devuelve su reporte más lo que imprime sobre las imágenes sin rostro."""
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "rep.json"
        cmd = [str(ROOT / ".venv" / "bin" / "mnemo-eval"), str(DATA), "--target-fpir", str(TARGET_FPIR), "--seed", "0",
               "--dump-scores", "--out", str(out), *flags]
        print(f"[{tag}] {' '.join(cmd[1:])}", flush=True)
        log = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        rep = json.loads(out.read_text())
    m = re.search(r"(\d+) identidades útiles → validación (\d+), prueba (\d+)", log)
    s = re.search(r"(\d+) de (\d+) imágenes sin rostro detectado; (\d+) personas", log)
    rep["_poblacion"] = {"identidades_utiles": int(m[1]), "validacion": int(m[2]), "prueba": int(m[3]),
                         "imagenes": int(s[2]), "sin_rostro": int(s[1]), "personas_descartadas": int(s[3])}
    return rep


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Intervalo de Wilson al 95 % para una proporción k/n."""
    if n == 0:
        return float("nan"), float("nan")
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return float(max(0, c - h)), float(min(1, c + h))


def fnir_at_fixed_fpir(sc: dict, target: float) -> tuple[float, float]:
    """FNIR con τ ajustado sobre las propias impostoras de prueba (FPIR ≤ objetivo): aísla el efecto de la etapa
    de la variabilidad de derivar τ en validación. Devuelve (τ, FNIR)."""
    imp = np.sort(np.array(sc["impostoras"]))[::-1]
    k = int(np.floor(target * len(imp)))
    tau = float(np.nextafter(imp[k], np.inf))
    n_gen = len(sc["genuinas_rango1"]) + len(sc["errores_identidad"])
    hits = int((np.array(sc["genuinas_rango1"]) >= tau).sum())
    return tau, 1 - hits / n_gen


def summarize(rep: dict) -> dict:
    out = {"poblacion": rep["_poblacion"], "por_N": {}}
    for n in NS:
        r = rep.get(n)
        if r is None:
            continue
        sc = r["scores"]
        gen = len(sc["genuinas_rango1"]) + len(sc["errores_identidad"])
        imp = np.array(sc["impostoras"])
        th, tl = r["tau_high"], r["tau_low"]
        k_fn = int(round(r["FNIR@tau_high"] * gen))
        k_fp = int(round(r["FPIR@tau_high"] * len(imp)))
        tau_fix, fnir_fix = fnir_at_fixed_fpir(sc, TARGET_FPIR)
        gen_all = np.r_[sc["genuinas_rango1"], sc["errores_identidad"]]
        err = np.array(sc["errores_identidad"])
        out["por_N"][n] = {
            "tau_alta": th, "tau_baja": tl,
            "FPIR": r["FPIR@tau_high"], "FPIR_ic95": wilson(k_fp, len(imp)),
            "FNIR": r["FNIR@tau_high"], "FNIR_ic95": wilson(k_fn, gen),
            "rank1": r["rank1"], "rank1_ic95": wilson(int(round(r["rank1"] * gen)), gen),
            "abstencion": r["abstencion"],
            "abstencion_impostoras": float(((imp >= tl) & (imp < th)).mean()),
            "abstencion_genuinas": float(((gen_all >= tl) & (gen_all < th)).mean()),
            "errores_identidad": int(len(err)), "errores_identidad_sobre_tau_alta": int((err >= th).sum()),
            "n_genuinas": gen, "n_impostoras": int(len(imp)),
            "tau_prueba_para_FPIR_1pct": tau_fix, "FNIR_a_FPIR_1pct_tau_prueba": fnir_fix,
        }
    return out


def pc(v: float, d: int = 2) -> str:
    return f"{v * 100:.{d}f}".replace(".", ",") + " %"


def es(v: float, d: int = 3) -> str:
    return f"{v:.{d}f}".replace(".", ",")


def markdown(res: dict) -> str:
    L = ["# Ablación de etapas del pipeline sobre LFW",
         "",
         f"Protocolo de `mnemo-eval` (semilla 0, partición por identidad, τ_alta derivado en validación para FPIR objetivo "
         f"{pc(TARGET_FPIR, 0)}, banda 0,08). Sondas de prueba por N en la columna «n»; los intervalos son de Wilson al 95 %.",
         ""]
    for n in NS:
        L += [f"## Galería {n}", "",
              "| Configuración | τ_alta | FPIR | FNIR [IC 95 %] | Rango 1 | Abstención | n (gen. / imp.) | FNIR a FPIR = 1 % (τ en prueba) |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
        for name, _ in CONFIGS:
            r = res["configuraciones"][name]["por_N"].get(n)
            if r is None:
                continue
            lo, hi = r["FNIR_ic95"]
            L.append(f"| {name} | {es(r['tau_alta'])} | {pc(r['FPIR'])} | {pc(r['FNIR'])} [{pc(lo, 1)}–{pc(hi, 1)}] | "
                     f"{pc(r['rank1'])} | {pc(r['abstencion'])} | {r['n_genuinas']} / {r['n_impostoras']} | "
                     f"{pc(r['FNIR_a_FPIR_1pct_tau_prueba'])} |")
        L.append("")
    L += ["## Población por configuración", "",
          "| Configuración | Identidades útiles | Validación / prueba | Imágenes sin rostro detectado | Personas con < 2 usables |",
          "|---|---:|---:|---:|---:|"]
    for name, _ in CONFIGS:
        p = res["configuraciones"][name]["poblacion"]
        L.append(f"| {name} | {p['identidades_utiles']} | {p['validacion']} / {p['prueba']} | "
                 f"{p['sin_rostro']} de {p['imagenes']} | {p['personas_descartadas']} |")
    L += ["", "## Sensibilidad al ancho de la banda de abstención (configuración completa, N = 50)", "",
          "FNIR, FPIR y rango 1 sólo dependen de τ_alta, que no cambia con la banda: lo que se mueve es τ_baja y, con él, "
          "cuántas sondas caen en «no estoy seguro» en lugar de descartarse en silencio.", "",
          "| Banda | τ_baja | τ_alta | Abstención (todas) | Abstención en impostoras | Abstención en genuinas | FNIR | FPIR |",
          "|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for b in BANDS:
        r = res["sensibilidad_banda"][f"{b:.2f}"]["por_N"]["N=50"]
        L.append(f"| {es(b, 2)} | {es(r['tau_baja'])} | {es(r['tau_alta'])} | {pc(r['abstencion'])} | "
                 f"{pc(r['abstencion_impostoras'])} | {pc(r['abstencion_genuinas'])} | {pc(r['FNIR'])} | {pc(r['FPIR'])} |")
    return "\n".join(L) + "\n"


def figure(res: dict) -> None:
    plt.rcParams.update({"font.size": 7.5, "axes.labelsize": 7.5, "axes.titlesize": 8, "axes.linewidth": 0.6})
    shades = ["#111111", "#555555", "#9a9a9a", "#d0d0d0"]
    fig, ax = plt.subplots(figsize=(3.6, 2.9), dpi=200)
    w = 0.2
    for i, (name, _) in enumerate(CONFIGS):
        xs, ys, lo, hi = [], [], [], []
        for j, n in enumerate(NS):
            r = res["configuraciones"][name]["por_N"].get(n)
            if r is None:
                continue
            xs.append(j + (i - 1.5) * w)
            ys.append(r["FNIR_a_FPIR_1pct_tau_prueba"] * 100)
        ax.bar(xs, ys, w * 0.92, color=shades[i], edgecolor="#111", lw=0.5, label=name)
        for x, y in zip(xs, ys):
            ax.text(x, y + 0.5, f"{y:.1f}".replace(".", ","), ha="center", va="bottom", fontsize=5.6)
    ax.set_xticks(range(len(NS)))
    ax.set_xticklabels([n.replace("=", " = ") for n in NS])
    ax.set_xlabel("tamaño de la galería")
    ax.set_ylabel("FNIR a FPIR = 1 % (%)")
    ax.set_title("Ablación · LFW · τ fijado en prueba", fontsize=8, loc="left")
    ax.legend(fontsize=6.3, frameon=False, loc="upper left", ncol=2, columnspacing=1.0, handlelength=1.2)
    ax.grid(axis="y", alpha=0.25, lw=0.4)
    ax.set_axisbelow(True)
    top = max(r["FNIR_a_FPIR_1pct_tau_prueba"] for c in res["configuraciones"].values() for r in c["por_N"].values()) * 100
    ax.set_ylim(0, top * 1.3)
    fig.tight_layout()
    fig.savefig(OUT / "ablacion_lfw.png")


def main() -> None:
    res = {"protocolo": {"semilla": 0, "target_fpir": TARGET_FPIR, "datos": str(DATA.relative_to(ROOT)) if DATA.is_relative_to(ROOT) else str(DATA)},
           "configuraciones": {}, "sensibilidad_banda": {}}
    for name, flags in CONFIGS:
        res["configuraciones"][name] = summarize(run_eval(flags, name))
    for b in BANDS:
        if b == 0.08:   # es el valor por defecto: la configuración completa ya lo corrió
            res["sensibilidad_banda"][f"{b:.2f}"] = res["configuraciones"]["completa"]
        else:
            res["sensibilidad_banda"][f"{b:.2f}"] = summarize(run_eval(["--band", str(b)], f"banda {b}"))
    (OUT / "ablacion_lfw.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
    (OUT / "ablacion_lfw.md").write_text(markdown(res))
    figure(res)
    print((OUT / "ablacion_lfw.md").read_text())


if __name__ == "__main__":
    main()
