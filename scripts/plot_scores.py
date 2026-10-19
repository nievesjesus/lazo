"""Observed s_max distributions for impostors and genuine probes, with the abstention band and the FPIR and FNIR areas.

Requires a report generated with ``mnemo-eval --dump-scores``.

    .venv/bin/python scripts/plot_scores.py eval_report.json distribuciones.png [N=50]
"""
import json
import sys

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch
from matplotlib.ticker import FuncFormatter

rep = json.load(open(sys.argv[1]))
out = sys.argv[2] if len(sys.argv) > 2 else "distribuciones.png"
key = sys.argv[3] if len(sys.argv) > 3 else "N=50"
r = rep[key]
if "scores" not in r:
    sys.exit("The report has no scores: run mnemo-eval with --dump-scores")
imp = np.array(r["scores"]["impostoras"])
ok = np.array(r["scores"]["genuinas_rango1"])
err = np.array(r["scores"]["errores_identidad"])
gen = np.r_[ok, err]
lo, hi = r["tau_low"], r["tau_high"]
plt.rcParams.update({"font.size": 7.5, "axes.labelsize": 7.5, "axes.titlesize": 8, "axes.linewidth": 0.6})
num = lambda v, d=2: f"{v:.{d}f}"

edges = np.arange(-0.15, 1.0001, 0.025)
fig, (a1, a2) = plt.subplots(2, 1, figsize=(3.55, 3.75), dpi=200, sharex=True, gridspec_kw={"hspace": 0.1})

# Densities: each class has area 1, so FPIR and FNIR read as areas even though there are 5 times more impostors.
d_imp, _ = np.histogram(imp, edges, density=True)
d_gen, _ = np.histogram(gen, edges, density=True)
d_err = np.histogram(err, edges)[0] / (len(gen) * np.diff(edges))        # contribution of the identity errors to d_gen
for ax in (a1, a2):
    ax.axvspan(lo, hi, color="#d9d9d9", lw=0, zorder=0)
    ax.axvline(hi, color="#111", lw=0.9, zorder=1)
    ax.set_xlim(-0.15, 1.0)
    ax.grid(alpha=0.2, lw=0.4)
    ax.set_axisbelow(True)
    ax.set_ylabel("density")

# --- impostors: FPIR = area with s ≥ τ_high -----------------------------------------------------
a1.stairs(d_imp, edges, fill=True, color="#f2f2f2", zorder=2)
a1.stairs(d_imp, edges, color="#7a7a7a", lw=1.1, ls=(0, (3, 1.6)), zorder=3)
fp_mask = edges[:-1] >= hi - 1e-9
a1.stairs(np.where(fp_mask, d_imp, 0), edges, fill=True, facecolor="none", edgecolor="#111", hatch="////", lw=0, zorder=5)
n_imp_fp = int((imp >= hi).sum())
y1 = d_imp.max() * 1.25
a1.set_ylim(0, y1)
a1.text((lo + hi) / 2, y1 * 0.97, "abstention", ha="center", va="top", fontsize=6.3, rotation=90)
a1.text(hi + 0.014, y1 * 0.97, f"τ_high = {num(hi)}", ha="left", va="top", fontsize=6.8, fontweight="bold")
a1.text(-0.13, y1 * 0.97, f"impostors\n(not enrolled, {len(imp)})", ha="left", va="top", fontsize=6.8, color="#444")
tail = d_imp[fp_mask]
a1.annotate(f"FPIR = {num(r['FPIR@tau_high'] * 100)}%\n{n_imp_fp} of {len(imp)} impostors\nnamed (s ≥ τ_high)",
            xy=(imp[imp >= hi].min() if n_imp_fp else hi + 0.04, y1 * 0.01), xytext=(0.62, y1 * 0.5),
            fontsize=6.6, ha="left", va="center",
            arrowprops=dict(arrowstyle="-", lw=0.6, color="#111", shrinkA=2, shrinkB=0))

# --- genuine: FNIR = area with s < τ_high + identity errors ---------------------------------
a2.stairs(d_gen, edges, fill=True, color="#c9c9c9", alpha=0.9, zorder=2)
a2.stairs(d_gen, edges, color="#111", lw=1.2, zorder=4)
a2.stairs(d_err, edges, fill=True, facecolor="none", edgecolor="#111", hatch="xxxx", lw=0, zorder=5)
fn_mask = edges[1:] <= hi + 1e-9
a2.stairs(np.where(fn_mask, d_gen, 0), edges, fill=True, facecolor="none", edgecolor="#333", hatch="\\\\\\\\", lw=0, zorder=5)
n_gen_fn = int(round(r["FNIR@tau_high"] * len(gen)))
y2 = d_gen.max() * 1.25
a2.set_ylim(0, y2)
a2.text(0.98, y2 * 0.97, f"genuine ({len(gen)})", ha="right", va="top", fontsize=6.8, color="#444")
below = d_gen[fn_mask]
centers = (edges[:-1] + edges[1:]) / 2
a2.annotate(f"FNIR = {num(r['FNIR@tau_high'] * 100)}%\n{n_gen_fn} of {len(gen)} genuine probes\nnot named: below τ_high\nor wrong identity",
            xy=(centers[np.argmax(np.where(fn_mask, d_gen, 0))], max(below.max(), y2 * 0.01) * 0.9), xytext=(-0.13, y2 * 0.50),
            fontsize=6.6, ha="left", va="center",
            arrowprops=dict(arrowstyle="-", lw=0.6, color="#333", shrinkA=2, shrinkB=0))
a2.legend(handles=[
    Patch(fc="white", ec="#111", hatch="xxxx", label=f"identity error ({len(err)})"),
    Patch(fc="white", ec="#333", hatch="\\\\\\\\", label="genuine < τ_high"),
], fontsize=6.1, loc="upper left", bbox_to_anchor=(0.0, 1.0), frameon=False, handlelength=1.5)
a2.set_xlabel("maximum similarity to the gallery, s_max")
a1.set_title(f"Observed scores · LFW, gallery {key}", fontsize=8, loc="left")
a2.xaxis.set_major_formatter(FuncFormatter(lambda v, _: num(v, 1)))
fig.subplots_adjust(left=0.12, right=0.965, top=0.94, bottom=0.095)
fig.savefig(out)
print(out)
