"""FPIR y FNIR en función del umbral τ, con la banda de abstención: lo que hace la perilla de P-06.

    .venv/bin/python scripts/plot_threshold.py eval_report.json umbral.png [N=50]
"""
import json
import sys

import matplotlib.pyplot as plt

rep = json.load(open(sys.argv[1]))
out = sys.argv[2] if len(sys.argv) > 2 else "umbral.png"
key = sys.argv[3] if len(sys.argv) > 3 else "N=50"
r = rep[key]
tau, fp, fn = r["det"]["tau"], r["det"]["fpir"], r["det"]["fnir"]

fig, ax = plt.subplots(figsize=(7, 4.2), dpi=160)
ax.axvspan(r["tau_low"], r["tau_high"], color="#d9d9d9", label="banda de abstención («no estoy seguro»)")
ax.plot(tau, [v * 100 for v in fp], color="#111", lw=2, label="FPIR · nombra a la persona equivocada")
ax.plot(tau, [v * 100 for v in fn], color="#111", lw=2, ls="--", label="FNIR · calla ante alguien conocido")
ax.axvline(r["tau_high"], color="#111", lw=0.8)
ax.annotate(f"τ = {r['tau_high']:.2f}\nFPIR {r['FPIR@tau_high']*100:.1f} % · FNIR {r['FNIR@tau_high']*100:.1f} %",
            (r["tau_high"], 55), xytext=(8, 0), textcoords="offset points", fontsize=8)
ax.set_xlim(0.0, 0.8)
ax.set_ylim(0, 100)
ax.set_xlabel("umbral τ  ←  permisivo · estricto  →")
ax.set_ylabel("% de errores")
ax.set_title(f"Qué hace la perilla · LFW, galería {key}", fontsize=10)
ax.legend(fontsize=7.5, loc="upper right", frameon=False)
ax.grid(alpha=0.2)
fig.tight_layout()
fig.savefig(out)
print(out)
