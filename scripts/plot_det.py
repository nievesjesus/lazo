"""DET curve (FNIR vs. FPIR) from mnemo-eval's eval_report.json, with the operating point of each N.

A log axis cannot draw FPIR = 0. Those points (threshold so high that no impostor exceeds it) rest on the floor
1/(n_impostors + 1), the smallest FPIR the sample can tell apart from zero, and are marked with "≤" and a dotted
line: there the true FPIR is "less than or equal to the floor", not equal to it.

    .venv/bin/python scripts/plot_det.py eval_report.json det.png
"""
import json
import sys

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter

rep = json.load(open(sys.argv[1]))
out = sys.argv[2] if len(sys.argv) > 2 else "det.png"
plt.rcParams.update({"font.size": 7.5, "axes.labelsize": 7.5, "axes.titlesize": 8, "axes.linewidth": 0.6})

num = lambda v, d=2: f"{v:.{d}f}"
STYLE = {  # gray and marker per N
    "N=10": ("#9a9a9a", "o"),
    "N=25": ("#555555", "s"),
    "N=50": ("#111111", "^"),
}

fig, ax = plt.subplots(figsize=(3.55, 3.2), dpi=200)
floors, handles = {}, []
for key in rep:
    r = rep[key]
    color, marker = STYLE.get(key, ("#333333", "o"))
    fp, fn = np.array(r["det"]["fpir"]), np.array(r["det"]["fnir"])
    floor = 1 / (r["n_impostoras"] + 1)
    floors[key] = floor
    at_floor = fp <= 0
    fp_plot = np.where(at_floor, floor, fp)
    ok = fn > 0                                             # FNIR = 0 is not plotted (never happens: the floor is 1 − rank-1)
    solid = ok & ~at_floor
    # Real segment (FPIR > 0) and segment resting on the floor: the first solid, the second dotted.
    last = np.flatnonzero(solid)[-1]                        # last point with FPIR > 0 (highest τ)
    ax.plot(fp_plot[solid], fn[solid], color=color, lw=1.4)
    ax.plot(np.r_[fp_plot[last], fp_plot[at_floor & ok]], np.r_[fn[last], fn[at_floor & ok]], color=color, lw=1.1,
            ls=(0, (1.5, 1.5)))
    ax.plot(r["FPIR@tau_high"], r["FNIR@tau_high"], marker, color=color, mec="white", mew=0.6, ms=6.2, zorder=5)
    handles.append(Line2D([], [], color=color, lw=1.4, marker=marker, ms=5.2, mec="white", mew=0.5,
                          label=f"{key.replace('=', ' = ')} · τ = {num(r['tau_high'])}"))

ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlim(min(floors.values()) * 0.55, 1.2)
ax.set_ylim(1.2e-2, 1.3)
ax.xaxis.set_major_locator(LogLocator(base=10, numticks=6))
ax.xaxis.set_minor_formatter(NullFormatter())
ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v * 100:g}%"))
ax.yaxis.set_minor_formatter(FuncFormatter(lambda v, _: f"{v * 100:g}%" if v in (0.02, 0.03, 0.05, 0.2, 0.3, 0.5) else ""))
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v * 100:g}%"))
ax.tick_params(axis="both", which="both", labelsize=6.5)
ax.annotate("≤ floor", (max(floors.values()) * 1.25, 0.45), fontsize=6.8, ha="left", va="center")
ax.set_xlabel("FPIR · names the wrong person (log)")
ax.set_ylabel("FNIR · misses a known person (log)")
ax.set_title("DET curve · LFW", fontsize=8, loc="left")
ax.grid(True, which="major", alpha=0.3, lw=0.5)
ax.grid(True, which="minor", alpha=0.12, lw=0.4)
ax.legend(handles=handles, title="gallery and threshold τ_high", fontsize=6.5, title_fontsize=6.5, loc="upper right",
          frameon=False, handlelength=2.2)
fig.text(0.02, 0.012, "● operating point (τ_high, target FPIR 1%).  Dotted and \"≤\": FPIR = 0 in the sample,\n"
         "set at the floor 1/(n_impostors + 1) = " + " · ".join(f"{num(v * 100, 3)}% ({k})" for k, v in floors.items()),
         fontsize=5.3, color="#555555", va="bottom")
fig.tight_layout(rect=(0, 0.075, 1, 1))
fig.savefig(out)
print(out)
