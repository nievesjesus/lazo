"""Curva DET (FNIR vs. FPIR) a partir del eval_report.json de mnemo-eval.

    .venv/bin/python scripts/plot_det.py eval_report.json det.png
"""
import json
import sys

import matplotlib.pyplot as plt

rep = json.load(open(sys.argv[1]))
out = sys.argv[2] if len(sys.argv) > 2 else "det.png"
fig, ax = plt.subplots(figsize=(6.4, 4.8), dpi=150)
for key, color in zip(rep, ["#9a9a9a", "#555555", "#111111"]):
    r = rep[key]
    pts = [(fp, fn) for fp, fn in zip(r["det"]["fpir"], r["det"]["fnir"]) if fp > 0 and fn > 0]
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=1.8, label=f"{key}")
    ax.plot(r["FPIR@tau_high"], r["FNIR@tau_high"], "o", color=color, ms=6)
    ax.annotate(f"τ={r['tau_high']:.2f}", (r["FPIR@tau_high"], r["FNIR@tau_high"]),
                textcoords="offset points", xytext=(6, 6), fontsize=8, color=color)
ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlabel("FPIR · nombra a la persona equivocada")
ax.set_ylabel("FNIR · calla ante alguien conocido")
ax.set_title("Curva DET · LFW · punto de operación con FPIR objetivo 1 %", fontsize=10)
ax.grid(True, which="both", alpha=0.25)
ax.legend(title="Tamaño de galería", fontsize=8, title_fontsize=8)
fig.tight_layout()
fig.savefig(out)
print(out)
